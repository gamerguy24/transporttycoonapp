import { config } from '../config.js';
import { state } from '../store.js';
import { id, pick } from '../util.js';

/**
 * Market-wide events. Each one carries a *total* percentage effect that is spread
 * across its lifetime, so a "+50% fuel shortage" ramps in over a few ticks instead
 * of teleporting the chart.
 */
const CATALOG = [
  {
    key: 'fuel-shortage',
    name: 'Fuel Shortage',
    emoji: '⛽',
    body: 'Refineries across the map are running dry. Fuel prices spike; hauliers eat the cost.',
    ticks: 3,
    backing: { fuel: 0.5, freight: -0.1 },
  },
  {
    key: 'shipping-boom',
    name: 'Shipping Boom',
    emoji: '📦',
    body: 'Contract volume is through the roof — every freight yard on the server is backed up.',
    ticks: 3,
    backing: { freight: 0.35 },
  },
  {
    key: 'economic-crash',
    name: 'Economic Crash',
    emoji: '🔻',
    body: 'Server-wide liquidity crunch. Every market is bleeding.',
    ticks: 4,
    all: -0.2,
  },
  {
    key: 'aviation-surge',
    name: 'Aviation Surge',
    emoji: '✈️',
    body: 'Passenger demand is at a record high and charter slots are sold out.',
    ticks: 3,
    backing: { aero: 0.25 },
  },
  {
    key: 'business-expansion',
    name: 'Business Expansion',
    emoji: '🏢',
    body: 'New storefronts opening across the city — payroll and footfall both climbing.',
    ticks: 3,
    backing: { business: 0.2 },
  },
  {
    key: 'driver-strike',
    name: 'Driver Strike',
    emoji: '🛑',
    body: 'Drivers have parked up over pay. Freight capacity collapses overnight.',
    ticks: 3,
    backing: { freight: -0.25, fuel: -0.1 },
  },
  {
    key: 'bull-run',
    name: 'Tycoon Bull Run',
    emoji: '🐂',
    body: 'Capital is flooding into every listed token on the exchange.',
    ticks: 3,
    all: 0.15,
  },
];

export function activeEvents() {
  return state.events.filter((e) => e.ticksLeft > 0);
}

/** Roll for a new event. Returns the event if one fired, otherwise null. */
export function maybeStartEvent() {
  if (Math.random() >= config.pricing.eventChance) return null;
  if (activeEvents().length >= 2) return null; // don't stack the whole catalog at once

  const active = new Set(activeEvents().map((e) => e.key));
  const candidates = CATALOG.filter((c) => !active.has(c.key));
  if (candidates.length === 0) return null;

  const template = pick(candidates);
  const event = {
    id: id(),
    key: template.key,
    name: template.name,
    emoji: template.emoji,
    body: template.body,
    startedAt: Date.now(),
    ticksTotal: template.ticks,
    ticksLeft: template.ticks,
    all: template.all ?? 0,
    backing: template.backing ?? {},
  };
  state.events.unshift(event);
  state.events = state.events.slice(0, 50);
  return event;
}

/** Per-tick drift a coin inherits from every active event. */
export function driftFor(coin) {
  let drift = 0;
  for (const event of activeEvents()) {
    const total = (event.all ?? 0) + (event.backing?.[coin.backing] ?? 0) + (event.symbols?.[coin.symbol] ?? 0);
    if (total !== 0) drift += total / event.ticksTotal;
  }
  return drift;
}

export function ageEvents() {
  for (const event of state.events) {
    if (event.ticksLeft > 0) event.ticksLeft -= 1;
  }
  // Keep finished events around briefly so the UI can show what just happened.
  state.events = state.events.filter((e) => Date.now() - e.startedAt < 60 * 60_000);
}

export const eventCatalog = CATALOG;
