/**
 * Real Tycoon player identity and wealth.
 *
 * Players reach the exchange through the server's F1 menu, which opens a URL in an
 * in-game browser. That request carries no game identity — no name, no vRP id — so
 * the site cannot simply "see" who opened it. Two flows cover it:
 *
 *   1. If the menu can template the player's id into the URL (?id=785364), the
 *      session is claimed automatically.
 *   2. Otherwise the player picks their name from the live online list and proves
 *      ownership by entering their current wallet balance, which only they can see
 *      in game. That check costs one API charge.
 *
 * /wealth only works for players who are currently online, which is also what makes
 * the balance challenge safe: a stale figure can't be replayed later.
 */

import { config } from '../config.js';
import { state } from '../store.js';
import { bad, notFound } from '../util.js';
import { canSpend, get, hasKey, noteSpend } from '../sources/client.js';

const ONLINE_TTL_MS = 20_000;
const WEALTH_TTL_MS = config.identity.wealthTtlMs;

const cache = {
  online: { list: [], at: 0 },
  wealth: new Map(), // vrpId -> { wallet, bank, loan, at }
};

/** players.json entries are [name, serverId, vrpId]. Free endpoint. */
export async function onlinePlayers() {
  if (Date.now() - cache.online.at < ONLINE_TTL_MS) return cache.online.list;
  if (!hasKey()) return cache.online.list;

  try {
    const payload = await get('players.json');
    const list = (payload.players ?? [])
      .filter((entry) => Array.isArray(entry) && entry.length >= 3)
      .map(([name, serverId, vrpId]) => ({ name: String(name), serverId: Number(serverId), vrpId: Number(vrpId) }))
      .filter((p) => Number.isFinite(p.vrpId) && p.vrpId > 0);
    cache.online = { list, at: Date.now() };
  } catch (err) {
    console.warn(`[identity] players.json failed: ${err.message}`);
  }
  return cache.online.list;
}

export async function findOnline({ vrpId, name }) {
  const list = await onlinePlayers();
  if (vrpId !== undefined && vrpId !== null && `${vrpId}`.length > 0) {
    const id = Number(vrpId);
    return list.find((p) => p.vrpId === id) ?? null;
  }
  if (name) {
    const wanted = String(name).trim().toLowerCase();
    return list.find((p) => p.name.toLowerCase() === wanted) ?? null;
  }
  return null;
}

/**
 * Real wallet/bank for a vRP id. Costs one charge, so results are cached and the
 * charge floor is respected. Returns null when unavailable rather than throwing,
 * except for the explicit "not online" case which the caller needs to explain.
 */
export async function fetchWealth(vrpId, { force = false } = {}) {
  const id = Number(vrpId);
  if (!Number.isFinite(id)) throw bad('Invalid player id.');

  const cached = cache.wealth.get(id);
  if (!force && cached && Date.now() - cached.at < WEALTH_TTL_MS) return cached;

  if (!(await canSpend())) {
    if (cached) return cached; // stale is better than nothing when the budget is out
    throw bad('The exchange is out of game-API charges right now. Try again later.');
  }

  try {
    const payload = await get(`wealth/${id}`);
    noteSpend();
    const wealth = {
      wallet: Number(payload.wallet) || 0,
      bank: Number(payload.bank) || 0,
      loan: Number(payload.loan) || 0,
      at: Date.now(),
    };
    wealth.netWorth = wealth.wallet + wealth.bank - wealth.loan;
    cache.wealth.set(id, wealth);
    return wealth;
  } catch (err) {
    noteSpend(); // a 412 still consumed the charge
    if (err.status === 412 || err.payload?.code === '412') {
      throw bad('You need to be online in game for the exchange to read your balance.');
    }
    if (cached) return cached;
    throw bad(`Could not read your in-game balance: ${err.message}`);
  }
}

/** Link an exchange account to a real vRP id and snapshot their net worth. */
export async function linkPlayer(player, profile) {
  const alreadyLinked = Object.values(state.players).find(
    (p) => p.vrpId === profile.vrpId && p.id !== player.id,
  );
  if (alreadyLinked) throw bad(`${profile.name} is already linked to another exchange wallet.`);

  const wealth = await fetchWealth(profile.vrpId, { force: true });
  player.vrpId = profile.vrpId;
  player.name = profile.name;
  player.verified = true;
  player.linkedAt = Date.now();
  applyWealth(player, wealth);
  return player;
}

export function applyWealth(player, wealth) {
  player.realWallet = wealth.wallet;
  player.realBank = wealth.bank;
  player.realLoan = wealth.loan;
  player.netWorth = wealth.netWorth ?? wealth.wallet + wealth.bank - wealth.loan;
  player.wealthAt = wealth.at;
  return player;
}

/**
 * Refresh a linked player's real balance if the cached figure is stale. Silently
 * leaves the old figure in place on failure — a player going offline must not
 * break their session.
 */
export async function refreshWealth(player, { force = false } = {}) {
  if (!player.vrpId) return player;
  if (!force && Date.now() - (player.wealthAt ?? 0) < WEALTH_TTL_MS) return player;
  try {
    const wealth = await fetchWealth(player.vrpId, { force });
    applyWealth(player, wealth);
    player.offline = false;
  } catch {
    player.offline = true;
  }
  return player;
}

/**
 * Failed verification attempts per vRP id. Each attempt reads /wealth, which costs
 * a charge — so without a cap, guessing at someone's balance would both brute-force
 * the challenge and drain the API key.
 */
const attempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 10 * 60_000;

function guardAttempts(vrpId) {
  const record = attempts.get(vrpId);
  if (!record) return;
  if (Date.now() - record.at > LOCKOUT_MS) {
    attempts.delete(vrpId);
    return;
  }
  if (record.count >= MAX_ATTEMPTS) {
    throw bad(
      `Too many failed attempts for that account. Wait ${Math.ceil(
        (LOCKOUT_MS - (Date.now() - record.at)) / 60_000,
      )} minutes and try again.`,
    );
  }
}

function noteFailure(vrpId) {
  const record = attempts.get(vrpId) ?? { count: 0, at: Date.now() };
  record.count += 1;
  record.at = Date.now();
  attempts.set(vrpId, record);
}

/**
 * Verify a claimed balance. The tolerance exists because a player's wallet moves
 * while they read the number off their screen.
 */
export async function verifyByBalance(profile, claimed) {
  guardAttempts(profile.vrpId);

  const amount = Number(claimed);
  if (!Number.isFinite(amount) || amount < 0) throw bad('Enter your current wallet balance as a number.');

  const wealth = await fetchWealth(profile.vrpId, { force: true });
  const tolerance = Math.max(config.identity.balanceTolerance, wealth.wallet * 0.02);
  if (Math.abs(wealth.wallet - amount) > tolerance) {
    noteFailure(profile.vrpId);
    const left = MAX_ATTEMPTS - (attempts.get(profile.vrpId)?.count ?? 0);
    throw bad(
      `That does not match ${profile.name}'s wallet. Open your wallet in game and enter the exact amount. ` +
        `${left} attempt${left === 1 ? '' : 's'} left.`,
    );
  }
  attempts.delete(profile.vrpId);
  return wealth;
}

export async function requireOnlineProfile({ vrpId, name }) {
  const profile = await findOnline({ vrpId, name });
  if (!profile) {
    throw notFound(
      'That player is not online right now. The exchange can only link accounts while you are in game.',
    );
  }
  return profile;
}
