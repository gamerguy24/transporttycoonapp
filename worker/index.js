/**
 * Cloudflare Workers entry point.
 *
 * A Worker is request-scoped: no filesystem, no memory between requests, no
 * background timers. The exchange needs all three, so everything lives in a single
 * Durable Object — one instance globally, which also makes it the serialisation
 * point that keeps the ledger consistent under concurrent trades.
 *
 * This Worker is only a router: static files come from the assets binding, and
 * anything under /api goes to that one object.
 */

export { Exchange } from './exchange.js';

const SINGLETON = 'exchange';

const exchangeStub = (env) => env.EXCHANGE.get(env.EXCHANGE.idFromName(SINGLETON));

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return exchangeStub(env).fetch(request);
    }

    // Everything else is the website. `not_found_handling` in wrangler.toml serves
    // index.html for unknown paths so the single-page router keeps working.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },

  /**
   * Cron trigger. The Durable Object drives its own tick through an alarm, which is
   * finer-grained than cron's one-minute floor; this just makes sure the object is
   * awake and its alarm is armed after a period with no traffic.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(exchangeStub(env).fetch('https://exchange/api/internal/wake', { method: 'POST' }));
  },
};
