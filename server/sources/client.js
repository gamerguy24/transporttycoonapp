/**
 * Shared api.tycoon.community client.
 *
 * Every call that costs an API charge goes through here, so the budget is counted
 * in one place rather than being tracked separately by the price engine and the
 * player-identity code.
 *
 * Free endpoints (measured, not assumed): /alive, /charges.json, /economy.csv,
 * /players.json. Everything else — /wealth, /stats, /top10 — costs one charge.
 */

import { config } from '../config.js';

const { tycoon } = config;

const state = {
  charges: null,
  chargesAt: 0,
  exhausted: false,
  spent: 0,
  lastError: null,
};

const url = (path) => `${tycoon.baseUrl.replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;

function headers(publicKey) {
  const h = { accept: 'application/json' };
  if (tycoon.key) h['X-Tycoon-Key'] = tycoon.key;
  if (publicKey) h['X-Tycoon-Public-Key'] = publicKey;
  return h;
}

export async function get(path, { asText = false, publicKey = null, timeoutMs } = {}) {
  const res = await fetch(url(path), {
    headers: headers(publicKey),
    signal: AbortSignal.timeout(timeoutMs ?? tycoon.timeoutMs),
  });
  const body = asText ? await res.text() : await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof body === 'object' ? body.error ?? body.description ?? '' : '';
    const err = new Error(`${path} -> HTTP ${res.status}${detail ? ` (${detail})` : ''}`);
    err.status = res.status;
    err.payload = body;
    throw err;
  }
  return body;
}

/** Free. Refreshed at most every 5 minutes unless forced. */
export async function refreshCharges(force = false) {
  if (!force && Date.now() - state.chargesAt < 5 * 60_000) return state.charges;
  try {
    const text = await get('charges.json', { asText: true });
    const parsed = JSON.parse(text);
    state.charges = Array.isArray(parsed) ? Number(parsed[0]) : Number(parsed.charges ?? parsed);
    state.chargesAt = Date.now();
  } catch (err) {
    state.lastError = `charges.json: ${err.message}`;
  }
  return state.charges;
}

/**
 * Whether a charged call is allowed right now. Keeps a reserve so the key is never
 * drained to zero by background polling.
 */
export async function canSpend() {
  if (!tycoon.key) return false;
  const charges = await refreshCharges();
  if (charges !== null && charges <= tycoon.chargeFloor) {
    if (!state.exhausted) {
      state.exhausted = true;
      console.warn(
        `[tycoon] ${charges} charges left, at or below the floor of ${tycoon.chargeFloor} — ` +
          `pausing charged calls. Refill in game with "/api private refill", or lower TYCOON_CHARGE_FLOOR.`,
      );
    }
    return false;
  }
  state.exhausted = false;
  return true;
}

/** Call after a charged request so the local count tracks without re-polling. */
export function noteSpend(n = 1) {
  if (state.charges !== null) state.charges -= n;
  state.spent += n;
}

export function clientMeta() {
  return {
    charges: state.charges,
    chargeFloor: tycoon.chargeFloor,
    spentThisRun: state.spent,
    paused: state.exhausted,
    lastError: state.lastError,
  };
}

export const hasKey = () => Boolean(tycoon.key);
