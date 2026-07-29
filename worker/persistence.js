/**
 * Durable Object persistence.
 *
 * Two problems shape this:
 *
 *  1. A stored value has a size cap well below what this state reaches — a handful
 *     of coins with full price history is megabytes. So everything is written as
 *     JSON split across numbered chunks, with a manifest recording how many.
 *
 *  2. Price history dominates that size but only changes on a tick, whereas wallets
 *     and orders change on requests. Serialising history on every request would
 *     burn milliseconds of CPU per call for data that did not change. So the state
 *     is split: `core` (everything else) is written whenever a request dirties it,
 *     and `history` is written only by the tick that actually moves prices.
 */

const CHUNK_BYTES = 96 * 1024; // comfortably under the per-value limit
const MAX_KEYS_PER_PUT = 100; // storage.put() takes a bounded number of pairs

async function writeChunked(storage, prefix, value) {
  const json = JSON.stringify(value);
  const count = Math.max(1, Math.ceil(json.length / CHUNK_BYTES));

  const entries = { [`${prefix}:manifest`]: { count, bytes: json.length, savedAt: Date.now() } };
  for (let i = 0; i < count; i += 1) {
    entries[`${prefix}:${i}`] = json.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
  }

  const keys = Object.entries(entries);
  for (let i = 0; i < keys.length; i += MAX_KEYS_PER_PUT) {
    await storage.put(Object.fromEntries(keys.slice(i, i + MAX_KEYS_PER_PUT)));
  }

  // A shrinking state leaves orphaned chunks behind, which would corrupt the next
  // read if the count ever grew back past them.
  const previous = await storage.get(`${prefix}:chunkCount`);
  if (typeof previous === 'number' && previous > count) {
    const stale = [];
    for (let i = count; i < previous; i += 1) stale.push(`${prefix}:${i}`);
    if (stale.length) await storage.delete(stale);
  }
  await storage.put(`${prefix}:chunkCount`, count);
}

async function readChunked(storage, prefix) {
  const manifest = await storage.get(`${prefix}:manifest`);
  if (!manifest || typeof manifest.count !== 'number') return null;

  const keys = [];
  for (let i = 0; i < manifest.count; i += 1) keys.push(`${prefix}:${i}`);

  let json = '';
  for (let i = 0; i < keys.length; i += MAX_KEYS_PER_PUT) {
    const batch = await storage.get(keys.slice(i, i + MAX_KEYS_PER_PUT));
    for (const key of keys.slice(i, i + MAX_KEYS_PER_PUT)) {
      const part = batch.get(key);
      if (part === undefined) throw new Error(`missing chunk ${key}`);
      json += part;
    }
  }
  return JSON.parse(json);
}

export function durablePersistence(storage) {
  // Set by the tick, which is the only thing that appends price history.
  let historyDue = true;

  return {
    describe: () => 'durable object storage',

    /** Tell the next save to include price history as well as the core state. */
    markHistoryDirty() {
      historyDue = true;
    },

    async load() {
      const core = await readChunked(storage, 'core');
      if (!core) return null;

      const histories = (await readChunked(storage, 'history')) ?? {};
      for (const [symbol, coin] of Object.entries(core.coins ?? {})) {
        coin.history = histories[symbol] ?? coin.history ?? [];
      }
      return core;
    },

    async save(state) {
      // Shallow-copy the coins so history can be stripped without touching the
      // live objects the engine is still using.
      const coins = {};
      const histories = {};
      for (const [symbol, coin] of Object.entries(state.coins ?? {})) {
        const { history, ...rest } = coin;
        coins[symbol] = rest;
        histories[symbol] = history ?? [];
      }

      await writeChunked(storage, 'core', { ...state, coins });
      if (historyDue) {
        await writeChunked(storage, 'history', histories);
        historyDue = false;
      }
    },
  };
}
