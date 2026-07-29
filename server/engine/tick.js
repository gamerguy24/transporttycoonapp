import { config } from '../config.js';
import { state, markDirty } from '../store.js';
import { source } from '../sources/index.js';
import { changeOver, repriceCoin, updateBaselines } from './pricing.js';
import { ageEvents, driftFor, maybeStartEvent } from './events.js';
import { newsFromAth, newsFromEvent, newsFromMovement } from './news.js';
import { matchOrders } from './trading.js';
import { expireStaleRequests } from './requests.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

let running = false;
let timer = null;

export async function tick() {
  if (running) return null; // a slow API poll must not overlap the next tick
  running = true;
  try {
    const snapshot = await source.fetchSnapshot();
    const metrics = snapshot.metrics ?? {};

    const event = maybeStartEvent();
    if (event) newsFromEvent(event);

    // Give buyers their money back if an issuer never answered.
    expireStaleRequests();

    const moves = [];
    for (const coin of Object.values(state.coins)) {
      const previousAth = coin.ath ?? coin.price;
      const move = repriceCoin(coin, metrics, driftFor(coin));
      matchOrders(coin);

      coin.change1h = changeOver(coin, HOUR);
      coin.change24h = changeOver(coin, DAY);

      newsFromMovement(coin, move);
      // A coin grinding upward sets a new ATH every single tick — only report one
      // when it has been a while and the record actually moved meaningfully.
      if (coin.price > previousAth && state.meta.tickCount > 5) {
        const rested = !coin.athNewsAt || Date.now() - coin.athNewsAt > 15 * 60_000;
        const meaningful = !coin.athNewsPrice || coin.price > coin.athNewsPrice * 1.03;
        if (rested && meaningful) {
          newsFromAth(coin);
          coin.athNewsAt = Date.now();
          coin.athNewsPrice = coin.price;
        }
      }

      moves.push(move);
    }

    updateBaselines(metrics);
    ageEvents();

    state.meta.lastTick = Date.now();
    state.meta.tickCount = (state.meta.tickCount ?? 0) + 1;
    state.meta.sourceOk = snapshot.ok !== false;
    state.meta.sourceName = snapshot.source ?? source.name;
    state.meta.sourceErrors = snapshot.errors ?? [];
    state.meta.sourceInfo = snapshot.meta ?? null;
    state.meta.metricCount = Object.keys(metrics).length;
    markDirty();

    return { moves, event, snapshot: { ts: snapshot.ts, source: snapshot.source, ok: snapshot.ok } };
  } catch (err) {
    console.error(`[tick] failed: ${err.stack ?? err.message}`);
    state.meta.sourceOk = false;
    state.meta.sourceErrors = [err.message];
    return null;
  } finally {
    running = false;
  }
}

export function startEngine() {
  if (timer) return;
  tick();
  timer = setInterval(tick, config.tickMs);
}

export function stopEngine() {
  if (timer) clearInterval(timer);
  timer = null;
}
