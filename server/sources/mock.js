/**
 * Synthetic Transport Tycoon economy.
 *
 * Emits exactly the same metric keys as the live adapter — seeded with values in
 * the same ballpark as the real server — so switching DATA_SOURCE changes where
 * the numbers come from and nothing else. Each metric is a mean-reverting random
 * walk with occasional shocks (a quarry rush, a quiet night, a fleet purchase).
 */

const METRIC_SEEDS = {
  // Server economy levels, roughly matching live economy.csv.
  'economy.money': 15_550_000_000_000,
  'economy.debt': 45_600_000_000,
  'economy.debtors': 2_019,
  'economy.millionaires': 17_800,
  'economy.billionaires': 858,
  'economy.userGrowth': 12, // new registrations per hour
  'economy.playersOnline': 40,

  // Sector activity, expressed as per-hour rates like the live top10 adapter.
  'stat.quarry_deliver': 22,
  'stat.quarry_coop': 14,
  'stat.quarry_solo': 18,
  'stat.quarry_excavate': 60,
  'stat.toll_paid': 950_000,
  'stat.drops_collected': 35,
  'stat.ems_deliveries': 26,
  'stat.vehicles_crafted': 9,
  'stat.houses_crafted': 6,
};

/** Volatility per metric — big aggregates barely move, activity rates swing hard. */
const VOLATILITY = {
  'economy.money': 0.004,
  'economy.debt': 0.003,
  'economy.debtors': 0.01,
  'economy.millionaires': 0.004,
  'economy.billionaires': 0.004,
  'economy.playersOnline': 0.08,
};
const DEFAULT_VOLATILITY = 0.07;

const COMPANIES = [
  { id: 'wallis-logistics', name: 'Wallis Logistics', scale: 1.0 },
  { id: 'redline-haulage', name: 'Redline Haulage', scale: 0.72 },
  { id: 'skybridge-air', name: 'Skybridge Air', scale: 0.55 },
  { id: 'northgate-fuel', name: 'Northgate Fuel', scale: 0.63 },
];

const walk = new Map();

function nextValue(key, seed, volatility) {
  const current = walk.get(key) ?? seed;
  const meanReversion = (seed - current) * 0.06;
  const drift = (Math.random() - 0.5) * 2 * volatility * seed;
  // ~4% of ticks get a shock — this is what produces the big headline moves.
  const shock = Math.random() < 0.04 ? (Math.random() - 0.45) * 0.35 * seed : 0;
  const next = Math.max(seed * 0.15, current + meanReversion + drift + shock);
  walk.set(key, next);
  return next;
}

export const name = 'mock';

export function sourceMeta() {
  return { charges: null, statsPaused: false, economyAge: 0 };
}

export async function fetchSnapshot() {
  const metrics = {};
  for (const [key, seed] of Object.entries(METRIC_SEEDS)) {
    metrics[key] = nextValue(key, seed, VOLATILITY[key] ?? DEFAULT_VOLATILITY);
  }
  metrics['economy.playersOnline'] = Math.round(metrics['economy.playersOnline']);

  // The live API exposes no per-company feed, so company-backed coins only get
  // these metrics in mock mode. See companyDrivers() for how they degrade live.
  const companies = COMPANIES.map((company) => {
    const s = company.scale;
    const row = {
      id: company.id,
      name: company.name,
      deliveries: Math.round(nextValue(`${company.id}.deliveries`, 2_400 * s, 0.08)),
      revenue: Math.round(nextValue(`${company.id}.revenue`, 48_000_000 * s, 0.07)),
      vehicles: Math.round(nextValue(`${company.id}.vehicles`, 180 * s, 0.05)),
      players: Math.round(nextValue(`${company.id}.players`, 95 * s, 0.06)),
      inactiveDrivers: Math.round(nextValue(`${company.id}.inactive`, 22 * s, 0.12)),
    };
    metrics[`company.${company.id}.deliveries`] = row.deliveries;
    metrics[`company.${company.id}.revenue`] = row.revenue;
    metrics[`company.${company.id}.vehicles`] = row.vehicles;
    metrics[`company.${company.id}.players`] = row.players;
    // Inverted: more idle drivers is bearish, so feed the engine its reciprocal.
    metrics[`company.${company.id}.driverUptime`] = 1_000 / Math.max(1, row.inactiveDrivers);
    return row;
  });

  return { ts: Date.now(), source: 'mock', ok: true, metrics, companies, meta: sourceMeta() };
}
