import { config } from './config.js';

/**
 * Exchange state, and a pluggable place to keep it.
 *
 * The state itself is a plain in-memory object on every platform. Only the
 * persistence differs: a JSON file on Node, Durable Object storage on Cloudflare.
 * Nothing here may import node:fs — that module does not exist on Workers, and an
 * import at the top of this file would break the whole bundle.
 */

const emptyState = () => ({
  meta: { version: 1, createdAt: Date.now(), lastTick: 0, tickCount: 0, source: config.source },
  coins: {},
  players: {},
  orders: [],
  /** Purchase requests awaiting a coin issuer's approval. */
  requests: [],
  trades: [],
  news: [],
  events: [],
  stakes: [],
  baselines: {},
  /** Last reading of each cumulative game counter, so restarts don't re-spend charges. */
  sourceCounters: {},
});

export const state = emptyState();

let dirty = false;
let flushTimer = null;
let persistenceBroken = false;

/**
 * @typedef {{ load(): Promise<object|null>, save(state: object): Promise<void>, describe(): string }} Persistence
 */
let adapter = {
  async load() {
    return null;
  },
  async save() {},
  describe: () => 'memory only (no persistence configured)',
};

export function setPersistence(next) {
  adapter = next;
}

export const describeStorage = () => adapter.describe();

function replaceState(next) {
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, next);
}

export async function load() {
  try {
    const saved = await adapter.load();
    if (!saved) return false;
    replaceState({ ...emptyState(), ...saved });
    return true;
  } catch (err) {
    console.error(`[store] could not read saved state: ${err.message} — starting fresh`);
    return false;
  }
}

/**
 * Persist the exchange. Never throws.
 *
 * On Node this runs before the HTTP server starts listening, so an unwritable data
 * directory — a DATA_FILE pointing at a disk that was never mounted, say — would
 * otherwise kill the process before it opened a port, which looks like a connection
 * reset rather than a storage problem. Losing persistence is bad; refusing to serve
 * the site because of it is worse.
 */
export async function save() {
  try {
    await adapter.save(state);
    dirty = false;
    if (persistenceBroken) {
      persistenceBroken = false;
      console.log(`[store] persistence recovered — writing to ${adapter.describe()} again`);
    }
    return true;
  } catch (err) {
    if (!persistenceBroken) {
      persistenceBroken = true;
      console.error(
        `[store] CANNOT WRITE ${adapter.describe()}: ${err.message}\n` +
          `[store] The exchange is running from memory — every coin, wallet and price\n` +
          `[store] history will be lost when this process restarts.\n` +
          `[store] On Render: attach a disk and point DATA_FILE at its mount path, or\n` +
          `[store] unset DATA_FILE to use the (ephemeral) working directory.`,
      );
    }
    return false;
  }
}

export const persistenceHealthy = () => !persistenceBroken;

/** Mark the state as changed; it gets flushed on the next beat. */
export function markDirty() {
  dirty = true;
}

export const isDirty = () => dirty;

/** Node only. Workers flush from the Durable Object instead. */
export function startAutosave(intervalMs = 5_000) {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (dirty) save();
  }, intervalMs);
  flushTimer.unref?.();
}

export function stopAutosave() {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
}
