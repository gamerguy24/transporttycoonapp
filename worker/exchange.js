import { config, configure } from '../server/config.js';
import { dispatch } from '../server/api.js';
import { isDirty, load, markDirty, save, setPersistence, state } from '../server/store.js';
import { seed } from '../server/seed.js';
import { tick } from '../server/engine/tick.js';
import { durablePersistence } from './persistence.js';

/**
 * The whole exchange, as one Durable Object.
 *
 * Durable Objects are single-threaded and strongly consistent, which is exactly what
 * a ledger wants: two players cannot approve the same request concurrently, and the
 * in-memory `state` the engine already uses stays correct without locks.
 *
 * Persistence is a single stored key rather than a table per entity. The state is a
 * few hundred KB at most, it is written whole on every flush anyway, and keeping it
 * as one blob means the Node and Workers builds share identical engine code.
 */
export class Exchange {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.ready = null;

    // No process.env here — configuration arrives as bindings.
    configure(env);
  }

  /** Load state once per isolate, then keep it in memory. */
  async init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      this.persistence = durablePersistence(this.ctx.storage);
      setPersistence(this.persistence);

      const existed = await load();
      if (!existed || Object.keys(state.coins).length === 0) {
        seed();
        await save();
      }
      await this.armAlarm();
    })();
    return this.ready;
  }

  /** Keep the pricing alarm scheduled. Cheap and idempotent. */
  async armAlarm() {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) await this.ctx.storage.setAlarm(Date.now() + config.tickMs);
  }

  /**
   * The engine tick. Alarms are the Workers equivalent of setInterval, and unlike
   * cron they can run faster than once a minute.
   */
  async alarm() {
    await this.init();
    try {
      await tick();
    } catch (err) {
      console.error(`[worker] tick failed: ${err.stack ?? err.message}`);
    }
    // Re-arm first so a failure in save() cannot stop the market.
    await this.ctx.storage.setAlarm(Date.now() + config.tickMs);
    // The tick is the only thing that appends price history, so this is the only
    // save that needs to write it.
    this.persistence.markHistoryDirty();
    await save();
  }

  async fetch(request) {
    await this.init();

    const url = new URL(request.url);

    // Woken by cron after an idle period: just make sure the alarm is armed.
    if (url.pathname === '/api/internal/wake') {
      await this.armAlarm();
      return Response.json({ ok: true, coins: Object.keys(state.coins).length });
    }

    let body = {};
    if (request.method !== 'GET' && request.method !== 'DELETE') {
      const text = await request.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
        }
      }
    }

    const { status, payload } = await dispatch({
      method: request.method,
      url,
      headers: Object.fromEntries(request.headers),
      body,
      // Cloudflare terminates TLS at the edge, so there is no loopback client here.
      // The localhost fallback for admin never applies: ADMIN_KEY is the only way in.
      remoteAddress: request.headers.get('cf-connecting-ip') ?? '',
    });

    // Flush synchronously when a request changed anything, so a crash between
    // requests cannot lose a trade.
    if (isDirty()) await save();

    return Response.json(payload, {
      status,
      headers: { 'cache-control': 'no-store' },
    });
  }
}
