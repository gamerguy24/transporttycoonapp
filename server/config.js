/**
 * Configuration, from an environment bag rather than process.env directly.
 *
 * Node reads process.env (plus a .env file); Cloudflare Workers pass their bindings
 * in via configure(env), since there is no process there. `config` is mutated in
 * place rather than replaced so modules holding a reference always see current
 * values — but read nested values as `config.x.y` at the point of use, never
 * destructured at import time, or you will capture a pre-configure snapshot.
 */

// Node can load a .env file natively. Absent everywhere else, and absent when
// there is no such file.
try {
  globalThis.process?.loadEnvFile?.();
} catch {
  /* no .env — fall back to defaults below */
}

const num = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const build = (env) => ({
  port: num(env.PORT, 3000),

  /**
   * Unlocks the engine diagnostics — data source, API charge balance, manual tick.
   * When unset, those are visible only to requests coming from localhost, so a
   * public deployment hides them by default and local development still shows them.
   */
  adminKey: env.ADMIN_KEY ?? '',

  dataFile: env.DATA_FILE ?? 'data/store.json',

  /** How often the crypto engine polls the game API and re-prices every coin. */
  tickMs: num(env.TICK_MS, 30_000),

  /** 'mock' generates a synthetic Transport Tycoon economy. 'tycoon' polls the real API. */
  source: env.DATA_SOURCE ?? 'mock',

  tycoon: {
    baseUrl: env.TYCOON_API_URL ?? 'https://api.tycoon.community',
    key: env.TYCOON_API_KEY ?? '',
    timeoutMs: num(env.TYCOON_TIMEOUT_MS, 15_000),

    /**
     * economy.csv is a 3 MB full-history download that only gains a row every
     * 15 minutes, so polling it faster wastes bandwidth for identical data.
     */
    economyPollMs: num(env.TYCOON_ECONOMY_POLL_MS, 15 * 60_000),

    /**
     * Sector leaderboards, one distinctive stat per coin type. Each poll costs an
     * API charge and they rotate, so a shorter list means every stat refreshes
     * sooner at the same burn rate — not a cheaper one. Keep it tight.
     * Others worth trying: quarry_coop, quarry_solo, quarry_excavate,
     * ems_deliveries, vehicles_crafted.
     */
    stats: (env.TYCOON_STATS ??
      'quarry_deliver,airline_trips,toll_paid,houses_crafted,conductor_freight_routes')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    /** How often to spend one charge on the next stat in the rotation. */
    statPollMs: num(env.TYCOON_STAT_POLL_MS, 15 * 60_000),

    /**
     * Buy a baseline for every stat at startup so sector coins differentiate
     * quickly. Baselines are normally persisted, making this a one-off cost — but
     * on a host with no persistent disk it is re-spent on every restart, and a
     * free instance that sleeps when idle restarts a lot. Set false there.
     */
    primeStats: (env.TYCOON_PRIME_STATS ?? 'true') !== 'false',

    /** Stop spending charges once this many remain, so the key is never drained. */
    chargeFloor: num(env.TYCOON_CHARGE_FLOOR, 100),
  },

  economy: {
    /** Every new coin lists at exactly $1,000,000. */
    startingPrice: 1_000_000,
    /** Cash handed to a brand new player wallet. */
    startingCash: 25_000_000,
    /** Price can never fall below this. */
    floorPrice: 1_000,
    /** Round-trip spread charged on market orders (0.4%). */
    spread: 0.004,
  },

  market: {
    /**
     * Coins are issued and sold by players, and buyers need the issuer's approval.
     * A pending request holds both the buyer's money and the issuer's coins, so it
     * expires rather than tying either up forever.
     */
    requestTtlMs: num(env.REQUEST_TTL_MS, 15 * 60_000),
  },

  pricing: {
    /** Biggest move a single tick may produce, up or down. */
    maxMove: 0.25,
    /** Weight of game-economy fundamentals in the per-tick drift. */
    fundamentalWeight: 0.55,
    /** Weight of player buy/sell pressure in the per-tick drift. */
    pressureWeight: 0.35,
    /** Random walk component so charts are never flat. */
    noise: 0.012,
    /** Strength of the pull back toward a coin's anchor price each tick. */
    anchorWeight: 0.06,
    /** How fast the anchor follows the price. Small = a long memory. */
    anchorAlpha: 0.02,
    /** Share of the anchor that is the original listing price rather than recent trade history. */
    listingPull: 0.25,
    /** Smoothing factor for the rolling baseline each metric is compared against. */
    baselineAlpha: 0.15,
    /** Price impact of a market order, as a multiple of (qty / circulating supply). */
    impact: 0.6,
    /** Chance per tick that a market-wide event fires. */
    eventChance: 0.04,
    /** Price points retained per coin. */
    historyLimit: 5_000,
  },

  identity: {
    /**
     * A player proves they own an account by typing their current wallet balance.
     * Their wallet moves while they read it, so allow the greater of this and 2%.
     */
    balanceTolerance: num(env.IDENTITY_BALANCE_TOLERANCE, 25_000),
    /** Re-read a linked player's real balance at most this often (1 charge each). */
    wealthTtlMs: num(env.IDENTITY_WEALTH_TTL_MS, 60_000),
    /**
     * Trust an ?id= / ?vrp= URL parameter to claim a session without the balance
     * challenge. Only enable if the F1 menu templates the id server-side — a player
     * who can edit the URL by hand could otherwise claim anyone's account.
     */
    trustUrlId: (env.IDENTITY_TRUST_URL_ID ?? 'false') === 'true',
  },

  staking: {
    /** 100 coins staked for 30 days pays 5 coins — 5% per 30 days. */
    ratePer30Days: 0.05,
    allowedDurations: [7, 14, 30, 90],
    /** Length of a "staking day". Compress it to demo a 30-day stake quickly. */
    dayMs: num(env.STAKE_DAY_MS, 24 * 60 * 60 * 1000),
  },

  limits: {
    news: 300,
    trades: 2_000,
    requests: 1_000,
  },
});

/** Populated by configure(); mutated in place so imported references stay valid. */
export const config = {};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Copy `next` over `target` without replacing any nested object, so that a module
 * which did `const { pricing } = config` at import time still sees updated values.
 * Replacing config.pricing wholesale would leave such a module holding the defaults
 * forever — a silent, miserable class of bug on Workers, where configure() cannot
 * run until the first request arrives.
 */
function mergeInPlace(target, next) {
  for (const [key, value] of Object.entries(next)) {
    if (isPlainObject(value) && isPlainObject(target[key])) mergeInPlace(target[key], value);
    else target[key] = value;
  }
  return target;
}

/** Merge an environment bag (Worker bindings, process.env) and rebuild config. */
export function configure(env = {}) {
  return mergeInPlace(config, build({ ...(globalThis.process?.env ?? {}), ...env }));
}

configure();
