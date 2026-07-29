/**
 * Live adapter for api.tycoon.community.
 *
 * Verified against the real API. Three things shape this design:
 *
 *  1. `/economy.csv` and `/players.json` cost NO charges — they are the hot path.
 *  2. `/economy.csv` is a 3 MB full-history download with no gzip, no range support
 *     and no content-length, and it only gains a row every 15 minutes. So it is
 *     fetched on its own slow timer, not every tick, and cached in between.
 *  3. `/top10/<stat>` costs 1 charge per call, and a key only has so many. Sector
 *     stats are therefore polled one at a time, round-robin, on a slow timer, and
 *     stop entirely above a configurable charge floor.
 *
 * Cumulative counters (lifetime totals) are emitted as per-hour rates rather than
 * levels — a number that only ever grows would otherwise read as permanently bullish.
 */

import { config } from '../config.js';
import { state, markDirty } from '../store.js';
import { canSpend, clientMeta, get, noteSpend, refreshCharges } from './client.js';
import * as mock from './mock.js';

const { tycoon } = config;

const cache = {
  economy: { row: null, at: 0 },
  stats: new Map(), // stat -> per-hour rate
  lastError: null,
};

/**
 * Where the round-robin is up to. Persisted, so restarting the server resumes the
 * rotation instead of immediately buying another stat.
 */
const rotation = () => (state.meta.tycoonRotation ??= { lastStatAt: 0, cursor: 0 });

/**
 * Previous observation of each cumulative counter, for rate conversion. Persisted
 * in the store: priming a stat costs a charge, so a restart must not have to buy
 * those baselines all over again.
 */
const counters = {
  get: (key) => state.sourceCounters?.[key],
  set: (key, value) => {
    state.sourceCounters ??= {};
    state.sourceCounters[key] = value;
  },
};

/**
 * Convert a lifetime total into a per-hour rate. Returns null on the first
 * sighting (nothing to diff against) and ignores counter resets.
 */
function rateOf(key, value, now) {
  const previous = counters.get(key);
  counters.set(key, { value, at: now });
  markDirty();
  if (!previous || now <= previous.at) return null;
  const hours = (now - previous.at) / 3_600_000;
  const delta = value - previous.value;
  if (delta < 0) return null; // counter reset or leaderboard reshuffle
  return delta / Math.max(hours, 1 / 60);
}

// ---------------------------------------------------------------- economy.csv

/** Header: Time;Debt;Money;Debts;Millionaires;Billionaires;Users;Players */
function parseEconomy(csv) {
  const lines = csv.trim().split('\n');
  for (let i = lines.length - 1; i >= 1; i -= 1) {
    const parts = lines[i].trim().split(';').map(Number);
    if (parts.length >= 7 && Number.isFinite(parts[0]) && parts[0] > 0) {
      const [time, debt, money, debtors, millionaires, billionaires, users] = parts;
      return { time, debt, money, debtors, millionaires, billionaires, users };
    }
  }
  return null;
}

async function refreshEconomy() {
  if (cache.economy.row && Date.now() - cache.economy.at < tycoon.economyPollMs) return cache.economy.row;
  const csv = await get('economy.csv', { asText: true });
  const row = parseEconomy(csv);
  if (row) cache.economy = { row, at: Date.now() };
  return cache.economy.row;
}

// -------------------------------------------------------------- top10 stats

/** Fetch one leaderboard and fold it into the rate cache. Costs one charge. */
async function pollStat(stat, now) {
  try {
    const payload = await get(`top10/${stat}`);
    noteSpend();
    const total = (payload.top ?? []).reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
    if (total <= 0) {
      cache.lastError = `top10/${stat}: empty leaderboard — is that a valid stat name?`;
      return;
    }
    const rate = rateOf(`stat.${stat}`, total, now);
    if (rate !== null) cache.stats.set(stat, rate);
  } catch (err) {
    cache.lastError = `top10/${stat}: ${err.message}`;
  }
}

async function refreshStats(now) {
  if (tycoon.stats.length === 0) return;

  // Prime every stat once at startup. A rate needs two observations, so without
  // this the first full rotation produces nothing at all and the sector coins sit
  // undifferentiated for hours.
  if (!cache.primed) {
    cache.primed = true;
    // Only stats with no persisted baseline need buying — a restart re-primes nothing.
    const cold = tycoon.stats.filter((s) => !counters.get(`stat.${s}`));

    if (cold.length > 0 && !tycoon.primeStats) {
      console.log(
        `[tycoon] TYCOON_PRIME_STATS=false — not buying ${cold.length} baseline(s) at startup. ` +
          `Sector stats will fill in one per ${Math.round(tycoon.statPollMs / 60_000)}m instead.`,
      );
      // Start the rotation clock now rather than firing immediately, so a cold
      // boot costs nothing at all. On a host that restarts more often than the
      // poll interval, sector stats simply never come up — which is the honest
      // outcome, rather than quietly spending a charge on every wake.
      rotation().lastStatAt = now;
    } else if (cold.length > 0 && (await canSpend())) {
      console.log(`[tycoon] priming ${cold.length} sector stat(s): ${cold.join(', ')} (${cold.length} charges)`);
      for (const stat of cold) await pollStat(stat, now);
      rotation().lastStatAt = now;
      markDirty();
      return;
    }
    if (cold.length === 0) {
      const due = Math.max(0, tycoon.statPollMs - (now - rotation().lastStatAt));
      console.log(
        `[tycoon] ${tycoon.stats.length} sector stat baseline(s) restored from store — no charges spent` +
          `, next poll in ${Math.round(due / 60_000)}m`,
      );
    }
  }

  const r = rotation();
  if (now - r.lastStatAt < tycoon.statPollMs) return;
  if (!(await canSpend())) return;

  // One stat per interval, round-robin.
  const stat = tycoon.stats[r.cursor % tycoon.stats.length];
  r.cursor += 1;
  r.lastStatAt = now;
  markDirty();
  await pollStat(stat, now);
}

// -------------------------------------------------------------------- public

export const name = 'tycoon';

export function sourceMeta() {
  const client = clientMeta();
  return {
    ...client,
    statsPaused: client.paused,
    economyAge: cache.economy.at ? Date.now() - cache.economy.at : null,
    statsTracked: [...cache.stats.keys()],
    nextStat: tycoon.stats[rotation().cursor % tycoon.stats.length] ?? null,
    nextStatInMs: Math.max(0, tycoon.statPollMs - (Date.now() - rotation().lastStatAt)),
  };
}

export function discoveredKeys() {
  return [
    'economy.money',
    'economy.debt',
    'economy.debtors',
    'economy.millionaires',
    'economy.billionaires',
    'economy.userGrowth',
    'economy.playersOnline',
    ...[...cache.stats.keys()].map((s) => `stat.${s}`),
  ];
}

export async function fetchSnapshot() {
  const now = Date.now();
  const metrics = {};
  const errors = [];

  // Checking charges is free, so make sure the dashboard always has a number —
  // otherwise it stays blank until the first stat poll comes due.
  if (clientMeta().charges === null && tycoon.key) await refreshCharges(true);

  // players.json — small, free, and the one number that changes every tick.
  try {
    const payload = await get('players.json');
    if (Array.isArray(payload.players)) metrics['economy.playersOnline'] = payload.players.length;
  } catch (err) {
    errors.push(`players.json: ${err.message}`);
  }

  try {
    const row = await refreshEconomy();
    if (row) {
      metrics['economy.money'] = row.money;
      metrics['economy.debt'] = row.debt;
      metrics['economy.debtors'] = row.debtors;
      metrics['economy.millionaires'] = row.millionaires;
      metrics['economy.billionaires'] = row.billionaires;
      // Total registered users only ever climbs, so signup *rate* is the real signal.
      const growth = rateOf('economy.users', row.users, row.time * 1000);
      if (growth !== null) metrics['economy.userGrowth'] = growth;
    }
  } catch (err) {
    errors.push(`economy.csv: ${err.message}`);
  }

  await refreshStats(now);
  for (const [stat, rate] of cache.stats) metrics[`stat.${stat}`] = rate;

  if (Object.keys(metrics).length === 0) {
    console.error(`[tycoon] no live metrics this tick (${errors.join('; ')}) — using mock data`);
    const fallback = await mock.fetchSnapshot();
    return { ...fallback, source: 'tycoon:fallback', ok: false, errors, meta: sourceMeta() };
  }

  return {
    ts: now,
    source: 'tycoon',
    ok: errors.length === 0,
    metrics,
    companies: [],
    errors,
    meta: sourceMeta(),
  };
}
