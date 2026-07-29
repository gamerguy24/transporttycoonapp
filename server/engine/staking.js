import { config } from '../config.js';
import { state } from '../store.js';
import { bad, id, notFound } from '../util.js';
import { credit, freeQty } from './players.js';

/** Read through config: there is no process.env on Cloudflare Workers. */
const dayMs = () => config.staking.dayMs;

export function rewardFor(qty, days) {
  return Math.floor(qty * config.staking.ratePer30Days * (days / 30));
}

export function stake(player, coin, qtyRaw, daysRaw) {
  const qty = Number(qtyRaw);
  const days = Number(daysRaw);
  if (!Number.isInteger(qty) || qty <= 0) throw bad('Stake amount must be a whole number of coins.');
  if (!config.staking.allowedDurations.includes(days)) {
    throw bad(`Duration must be one of ${config.staking.allowedDurations.join(', ')} days.`);
  }
  const free = freeQty(player, coin.symbol);
  if (free < qty) throw bad(`You only have ${free} ${coin.symbol} available to stake.`);

  const reward = rewardFor(qty, days);
  if (reward <= 0) throw bad(`Too small to earn a reward — stake at least ${Math.ceil(30 / (config.staking.ratePer30Days * days))} coins for ${days} days.`);

  // The coins stay in holdings and simply become unavailable, so the position's
  // cost basis is untouched by the lock-up.
  const entry = {
    id: id(),
    playerId: player.id,
    symbol: coin.symbol,
    qty,
    days,
    reward,
    startedAt: Date.now(),
    endsAt: Date.now() + days * dayMs(),
    claimed: false,
  };
  state.stakes.unshift(entry);
  return entry;
}

export function listStakes(playerId) {
  return state.stakes
    .filter((s) => s.playerId === playerId)
    .map((s) => ({ ...s, matured: Date.now() >= s.endsAt, price: state.coins[s.symbol]?.price ?? 0 }));
}

/** Claim a matured stake: principal plus reward. */
export function claim(player, stakeId) {
  const entry = state.stakes.find((s) => s.id === stakeId && s.playerId === player.id);
  if (!entry) throw notFound('Stake not found.');
  if (entry.claimed) throw bad('Already claimed.');
  if (Date.now() < entry.endsAt) throw bad('Stake has not matured yet — unstake early to get your principal back without the reward.');

  const coin = state.coins[entry.symbol];
  if (!coin) throw bad('That coin is no longer listed.');

  // Only the reward is new — the principal never left the wallet. Reward coins cost
  // nothing, so they carry no basis and show up as pure profit.
  credit(player, entry.symbol, entry.reward);
  coin.supply += entry.reward; // newly minted, so market cap stays honest
  entry.claimed = true;
  entry.claimedAt = Date.now();
  return entry;
}

/** Break a stake early: coins unlock immediately, reward forfeited. */
export function unstake(player, stakeId) {
  const entry = state.stakes.find((s) => s.id === stakeId && s.playerId === player.id);
  if (!entry) throw notFound('Stake not found.');
  if (entry.claimed) throw bad('Already claimed.');

  // The principal never left holdings — closing the stake simply frees it again.
  entry.claimed = true;
  entry.claimedAt = Date.now();
  entry.forfeited = entry.reward;
  entry.reward = 0;
  return entry;
}

export const stakeDayMs = dayMs;
