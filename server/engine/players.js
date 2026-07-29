import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { state } from '../store.js';
import { id, money, unauthorized } from '../util.js';

/**
 * Paper trading against real money.
 *
 * The game API is read-only, so the exchange can never move a player's in-game
 * dollars. Instead their real net worth (wallet + bank - loan) IS their buying
 * power, and positions live in this ledger:
 *
 *     available = netWorth + realisedPnl - committed - reservedCash
 *
 * `committed` is the cost basis of open positions and `realisedPnl` is booked on
 * every sale, so the identity holds without ever mutating a balance the game owns.
 * When a player earns money in game their buying power rises here automatically.
 *
 * Guests (no linked account) get a virtual grant as their netWorth, so both kinds
 * of account run through exactly the same arithmetic.
 */

export function createPlayer(name, { vrpId = null, verified = false } = {}) {
  const player = {
    id: id(),
    name: String(name).trim().slice(0, 24) || 'Anonymous',
    key: randomBytes(16).toString('hex'),
    vrpId,
    verified,
    bot: false,

    // Real in-game figures, refreshed from /wealth while the player is online.
    netWorth: config.economy.startingCash,
    realWallet: 0,
    realBank: 0,
    realLoan: 0,
    wealthAt: 0,
    offline: false,

    // Exchange-side ledger.
    committed: 0,
    reservedCash: 0,
    realisedPnl: 0,
    holdings: {},
    basis: {}, // symbol -> cost basis of the coins currently held
    reservedCoins: {}, // symbol -> coins locked in open sell orders

    createdAt: Date.now(),
  };
  state.players[player.id] = player;
  return player;
}

export function playerByKey(key) {
  if (!key) throw unauthorized('Missing player key — open the exchange and sign in first.');
  const player = Object.values(state.players).find((p) => p.key === key);
  if (!player) throw unauthorized('Unknown player key.');
  return migrate(player);
}

/** Older stored players predate the real-wealth ledger. Bring them up to date. */
export function migrate(player) {
  if (player.netWorth === undefined) {
    player.netWorth = player.cash ?? config.economy.startingCash;
    player.committed = 0;
    player.realisedPnl = 0;
    player.reservedCash = 0;
    player.basis ??= {};
    player.reservedCoins ??= {};
    for (const [symbol, qty] of Object.entries(player.holdings ?? {})) {
      const coin = state.coins[symbol];
      const cost = money(qty * (coin?.price ?? 0));
      player.basis[symbol] = cost;
      player.committed += cost;
    }
    player.committed = money(player.committed);
    delete player.cash;
  }
  player.basis ??= {};
  player.reservedCoins ??= {};
  return player;
}

/** Spendable buying power right now. */
export function availableCash(player) {
  return money(player.netWorth + player.realisedPnl - player.committed - player.reservedCash);
}

export function heldQty(player, symbol) {
  return player.holdings[symbol] ?? 0;
}

export function reservedQty(player, symbol) {
  return player.reservedCoins[symbol] ?? 0;
}

/**
 * Coins the player can actually sell or stake: owned, minus those locked in open
 * sell orders or in a stake. Staked coins stay in `holdings` so their cost basis
 * survives the lock-up untouched.
 */
export function freeQty(player, symbol) {
  return heldQty(player, symbol) - reservedQty(player, symbol) - stakedQty(player.id, symbol);
}

export function credit(player, symbol, qty) {
  player.holdings[symbol] = heldQty(player, symbol) + qty;
  if (player.holdings[symbol] <= 0) {
    delete player.holdings[symbol];
    delete player.basis[symbol];
  }
}

/** Record a purchase: cost joins the committed capital and the position's basis. */
export function addPosition(player, symbol, qty, cost) {
  credit(player, symbol, qty);
  player.basis[symbol] = money((player.basis[symbol] ?? 0) + cost);
  player.committed = money(player.committed + cost);
}

/**
 * Record a sale. The basis leaves proportionally and the difference between
 * proceeds and basis is booked as realised profit or loss.
 */
export function removePosition(player, symbol, qty, proceeds) {
  const held = heldQty(player, symbol);
  const basis = player.basis[symbol] ?? 0;
  const basisOut = held > 0 ? money((basis * qty) / held) : 0;

  credit(player, symbol, -qty);
  if (player.holdings[symbol]) player.basis[symbol] = money(basis - basisOut);
  player.committed = money(player.committed - basisOut);
  player.realisedPnl = money(player.realisedPnl + (proceeds - basisOut));
  return { basisOut, pnl: money(proceeds - basisOut) };
}

export function reserveCash(player, amount) {
  player.reservedCash = money(player.reservedCash + amount);
}

export function releaseCash(player, amount) {
  player.reservedCash = money(Math.max(0, player.reservedCash - amount));
}

export function reserveCoins(player, symbol, qty) {
  player.reservedCoins[symbol] = reservedQty(player, symbol) + qty;
}

export function releaseCoins(player, symbol, qty) {
  const next = reservedQty(player, symbol) - qty;
  if (next > 0) player.reservedCoins[symbol] = next;
  else delete player.reservedCoins[symbol];
}

/** Coins locked in an active stake — owned, but not spendable. */
export function stakedQty(playerId, symbol) {
  return state.stakes
    .filter((s) => s.playerId === playerId && s.symbol === symbol && !s.claimed)
    .reduce((sum, s) => sum + s.qty, 0);
}

export function portfolio(player) {
  const symbols = new Set([
    ...Object.keys(player.holdings),
    ...state.stakes.filter((s) => s.playerId === player.id && !s.claimed).map((s) => s.symbol),
  ]);

  const positions = [];
  let cryptoValue = 0;

  for (const symbol of symbols) {
    const coin = state.coins[symbol];
    if (!coin) continue;
    const held = heldQty(player, symbol); // includes staked coins
    const staked = stakedQty(player.id, symbol);
    const qty = held;
    if (qty <= 0) continue;

    const value = money(qty * coin.price);
    const basis = player.basis[symbol] ?? 0;
    cryptoValue += value;
    positions.push({
      symbol,
      name: coin.name,
      qty,
      free: freeQty(player, symbol),
      reserved: reservedQty(player, symbol),
      staked,
      price: coin.price,
      value,
      basis: money(basis),
      avgCost: held > 0 ? money(basis / held) : 0,
      unrealised: money(money(held * coin.price) - basis),
      change24h: coin.change24h ?? 0,
    });
  }

  positions.sort((a, b) => b.value - a.value);
  const unrealised = money(positions.reduce((sum, p) => sum + p.unrealised, 0));

  return {
    id: player.id,
    name: player.name,
    vrpId: player.vrpId,
    verified: Boolean(player.verified),
    offline: Boolean(player.offline),

    netWorth: money(player.netWorth),
    realWallet: money(player.realWallet ?? 0),
    realBank: money(player.realBank ?? 0),
    realLoan: money(player.realLoan ?? 0),
    wealthAt: player.wealthAt ?? 0,

    cash: availableCash(player),
    committed: money(player.committed),
    reserved: money(player.reservedCash),
    realisedPnl: money(player.realisedPnl),
    unrealisedPnl: unrealised,
    cryptoValue: money(cryptoValue),
    // What the player is worth on the exchange: untouched buying power plus
    // whatever their coins are currently worth.
    total: money(availableCash(player) + player.reservedCash + cryptoValue),
    positions,
  };
}

export function leaderboard(limit = 25) {
  return Object.values(state.players)
    .map((p) => {
      const view = portfolio(migrate(p));
      return {
        id: p.id,
        name: p.name,
        bot: p.bot,
        verified: Boolean(p.verified),
        total: view.total,
        cash: view.cash,
        cryptoValue: view.cryptoValue,
        pnl: money(view.realisedPnl + view.unrealisedPnl),
      };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

/** Largest single-coin positions across the whole exchange. */
export function whales(limit = 20) {
  const rows = [];
  for (const player of Object.values(state.players)) {
    migrate(player);
    const symbols = new Set([
      ...Object.keys(player.holdings),
      ...state.stakes.filter((s) => s.playerId === player.id && !s.claimed).map((s) => s.symbol),
    ]);
    for (const symbol of symbols) {
      const coin = state.coins[symbol];
      if (!coin) continue;
      const qty = heldQty(player, symbol);
      if (qty <= 0) continue;
      rows.push({
        player: player.name,
        playerId: player.id,
        verified: Boolean(player.verified),
        symbol,
        qty,
        value: money(qty * coin.price),
        supplyShare: coin.supply > 0 ? qty / coin.supply : 0,
      });
    }
  }
  return rows.sort((a, b) => b.value - a.value).slice(0, limit);
}
