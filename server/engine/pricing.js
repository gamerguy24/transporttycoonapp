import { config } from '../config.js';
import { state } from '../store.js';
import { clamp, gaussian, money } from '../util.js';

const { pricing, economy } = config;

const LABELS = {
  'economy.money': 'Money in the economy',
  'economy.debt': 'Server debt',
  'economy.debtors': 'Players in debt',
  'economy.millionaires': 'Millionaires',
  'economy.billionaires': 'Billionaires',
  'economy.userGrowth': 'New player signups',
  'economy.playersOnline': 'Players online',
  'stat.quarry_deliver': 'Quarry deliveries',
  'stat.quarry_coop': 'Co-op hauling runs',
  'stat.quarry_solo': 'Solo hauling runs',
  'stat.quarry_excavate': 'Quarry excavation',
  'stat.airline_trips': 'Airline trips flown',
  'stat.conductor_freight_routes': 'Freight train routes',
  'stat.toll_paid': 'Road tolls paid',
  'stat.drops_collected': 'Air drops collected',
  'stat.ems_deliveries': 'EMS deliveries',
  'stat.vehicles_crafted': 'Vehicles built',
  'stat.houses_crafted': 'Houses built',
};

export function labelFor(key) {
  if (LABELS[key]) return LABELS[key];
  const company = key.match(/^company\.(.+)\.(\w+)$/);
  if (company) {
    const metric = {
      deliveries: 'Delivery activity',
      revenue: 'Company revenue',
      vehicles: 'Vehicles purchased',
      players: 'Players using company',
      driverUptime: 'Driver uptime',
    }[company[2]] ?? company[2];
    return metric;
  }
  return key;
}

/**
 * Compare each of a coin's driver metrics against its rolling baseline.
 * Returns a fundamentals score in [-1, 1] plus the per-driver breakdown the UI
 * uses to explain the move.
 */
export function scoreCoin(coin, metrics) {
  const signals = [];
  let weighted = 0;
  let totalWeight = 0;

  for (const [key, weight] of Object.entries(coin.drivers ?? {})) {
    const value = metrics[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;

    // Weights may be negative for drivers that are bad news when they rise.
    // Normalising by |weight| keeps the weighted mean in [-1, 1] either way.
    const magnitude = Math.abs(weight);
    const baseline = state.baselines[key];
    if (baseline === undefined) {
      // First sighting: no history to compare against, so it contributes nothing.
      signals.push({ key, label: labelFor(key), delta: 0, value, weight });
      totalWeight += magnitude;
      continue;
    }

    const change = clamp((value - baseline) / Math.max(Math.abs(baseline), 1), -1, 1);
    weighted += change * weight;
    totalWeight += magnitude;
    // `delta` is what the metric did; `effect` is which way that pushed the price.
    // They differ for inverted drivers, and conflating them makes the news read
    // backwards ("debt down" when debt actually rose).
    signals.push({
      key,
      label: labelFor(key),
      delta: change,
      effect: weight < 0 ? -change : change,
      value,
      weight,
    });
  }

  const score = totalWeight > 0 ? clamp(weighted / totalWeight, -1, 1) : 0;
  signals.sort((a, b) => Math.abs(b.delta * b.weight) - Math.abs(a.delta * a.weight));
  return { score, signals: signals.slice(0, 4) };
}

/** Roll every metric's baseline forward. Called once per tick, after all coins are scored. */
export function updateBaselines(metrics) {
  const a = pricing.baselineAlpha;
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const prev = state.baselines[key];
    state.baselines[key] = prev === undefined ? value : prev * (1 - a) + value * a;
  }
}

export function confidenceFor(score) {
  if (score > 0.05) return 'HIGH';
  if (score < -0.05) return 'LOW';
  return 'NEUTRAL';
}

/**
 * Net player buy/sell flow since the last tick, normalised against circulating supply.
 * The 5%-of-supply floor matters: a freshly listed coin has almost nothing in
 * circulation, and dividing by that would let a single 3-coin trade move the price 30%.
 */
function pressureOf(coin) {
  const base = Math.max(1, coin.supply * 0.05, coin.supply - coin.treasury);
  return clamp(coin.pressure / base, -1, 1);
}

/**
 * Re-price a single coin for this tick.
 * Returns the movement record; the caller decides what to do with it (news, orders).
 */
export function repriceCoin(coin, metrics, eventDrift = 0) {
  const { score, signals } = scoreCoin(coin, metrics);
  const pressure = pressureOf(coin);
  const previous = coin.price;

  // Without this the price is a pure random walk and wanders orders of magnitude
  // away from what the coin is actually backed by. The anchor is mostly the coin's
  // own slow-moving average, part its listing price — so trends are allowed, but
  // a 5x run-up feels a steady pull back.
  const slow = coin.anchor ?? previous;
  const anchor = slow * (1 - pricing.listingPull) + coin.startPrice * pricing.listingPull;
  const reversion = clamp((anchor - previous) / previous, -0.5, 0.5) * pricing.anchorWeight;

  const drift = clamp(
    pricing.fundamentalWeight * score +
      pricing.pressureWeight * pressure +
      reversion +
      eventDrift +
      pricing.noise * gaussian(),
    -pricing.maxMove,
    pricing.maxMove,
  );

  const next = Math.max(economy.floorPrice, money(previous * (1 + drift)));

  coin.price = next;
  coin.anchor = slow * (1 - pricing.anchorAlpha) + next * pricing.anchorAlpha;
  coin.score = score;
  coin.signals = signals;
  coin.confidence = confidenceFor(score);
  coin.pressure = 0; // consumed
  coin.marketCap = money(next * coin.supply);
  coin.ath = Math.max(coin.ath ?? next, next);
  coin.atl = Math.min(coin.atl ?? next, next);

  coin.history.push({ t: Date.now(), p: next });
  if (coin.history.length > pricing.historyLimit) {
    coin.history.splice(0, coin.history.length - pricing.historyLimit);
  }

  return {
    symbol: coin.symbol,
    previous,
    price: next,
    change: previous > 0 ? (next - previous) / previous : 0,
    drift,
    score,
    pressure,
    eventDrift,
    signals,
  };
}

/** Percentage change over a trailing window, computed from stored history. */
export function changeOver(coin, windowMs) {
  const cutoff = Date.now() - windowMs;
  const history = coin.history ?? [];
  if (history.length === 0) return 0;
  let reference = history[0];
  for (const point of history) {
    if (point.t <= cutoff) reference = point;
    else break;
  }
  if (!reference || reference.p <= 0) return 0;
  return (coin.price - reference.p) / reference.p;
}
