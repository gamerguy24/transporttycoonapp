import { config } from '../config.js';
import { state } from '../store.js';
import { bad, id, money, notFound } from '../util.js';
import { addPosition, availableCash, releaseCash, reserveCash } from './players.js';
import { addNews } from './news.js';

/**
 * Purchase requests.
 *
 * Coins are sold by the player who issued them, and no one gets in without that
 * issuer's say-so. A buyer's request reserves their funds and locks the quoted
 * price; the issuer then approves or declines.
 *
 * Locking the price matters: the engine re-prices every coin on a 30s tick, so
 * without a lock the buyer would be agreeing to one number and paying another
 * whenever the issuer got round to looking. Requests expire so a buyer's money is
 * never reserved indefinitely against an issuer who never responds.
 */

const TTL = () => config.market.requestTtlMs;

export function pendingFor(coinSymbol) {
  return state.requests.filter((r) => r.symbol === coinSymbol && r.status === 'pending');
}

/** Coins already spoken for by pending requests — can't be promised twice. */
export function reservedTreasury(coinSymbol) {
  return pendingFor(coinSymbol).reduce((sum, r) => sum + r.qty, 0);
}

export function availableTreasury(coin) {
  return Math.max(0, coin.treasury - reservedTreasury(coin.symbol));
}

/**
 * @param options.orderId  Set when a resting limit buy crossed and became a request.
 *   Those funds are already reserved by the order, so this must not reserve them twice.
 */
export function createRequest(player, coin, qty, quote, options = {}) {
  if (coin.issuerId === player.id) throw bad('You already own this coin — you are the one selling it.');

  const free = availableTreasury(coin);
  if (free < qty) {
    throw bad(
      free === 0
        ? `${coin.symbol} is sold out — the issuer has no coins left to sell.`
        : `Only ${free} ${coin.symbol} are available (the rest are held by pending requests).`,
    );
  }

  const escrow = options.orderId ? 0 : quote.total;
  if (escrow > 0) {
    const funds = availableCash(player);
    if (funds < escrow) {
      throw bad(
        `Not enough buying power. This request costs $${quote.total.toLocaleString('en-US')} and you have $${funds.toLocaleString('en-US')}.`,
      );
    }
    // Hold the money now so a buyer cannot promise the same funds to two issuers.
    reserveCash(player, escrow);
  }

  const request = {
    id: id(),
    symbol: coin.symbol,
    coinName: coin.name,
    issuerId: coin.issuerId,
    buyerId: player.id,
    buyerName: player.name,
    buyerVrpId: player.vrpId ?? null,
    qty,
    price: quote.unitPrice,
    total: quote.total,
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL(),
    note: String(quote.note ?? '').slice(0, 140),
    orderId: options.orderId ?? null,
    /** What this request is holding in escrow itself, vs what its order holds. */
    escrow,
  };

  state.requests.unshift(request);
  if (state.requests.length > config.limits.requests) state.requests.length = config.limits.requests;
  return request;
}

function settle(request, status) {
  request.status = status;
  request.decidedAt = Date.now();
  return request;
}

/** Give the buyer back whatever this request was holding, from wherever it was held. */
function releaseEscrow(request) {
  const buyer = state.players[request.buyerId];
  if (!buyer) return;

  if (request.orderId) {
    const order = state.orders.find((o) => o.id === request.orderId);
    if (order && order.status === 'awaiting-approval') {
      releaseCash(buyer, money(order.qty * order.limitPrice));
      order.status = 'cancelled';
      order.closedAt = Date.now();
    }
    return;
  }
  releaseCash(buyer, request.escrow ?? request.total);
}

/** Issuer accepts: coins leave the treasury, the money leaves escrow and lands with them. */
export function approveRequest(issuer, requestId) {
  const request = state.requests.find((r) => r.id === requestId);
  if (!request) throw notFound('Request not found.');
  if (request.issuerId !== issuer.id) throw bad('Only the coin issuer can decide this request.');
  if (request.status !== 'pending') throw bad(`That request is already ${request.status}.`);
  if (Date.now() > request.expiresAt) {
    expireRequest(request);
    throw bad('That request expired before it was approved. The buyer will need to ask again.');
  }

  const coin = state.coins[request.symbol];
  if (!coin) throw bad('That coin no longer exists.');
  if (coin.treasury < request.qty) throw bad(`You only have ${coin.treasury} ${coin.symbol} left to sell.`);

  const buyer = state.players[request.buyerId];
  if (!buyer) throw bad('That buyer no longer exists.');

  // Money out of escrow and into the issuer's balance; coins the other way.
  if (request.orderId) {
    const order = state.orders.find((o) => o.id === request.orderId);
    if (order) {
      // The order reserved qty x limit; the fill costs the locked price, and the
      // difference goes back to the buyer as price improvement.
      releaseCash(buyer, money(order.qty * order.limitPrice));
      order.status = 'filled';
      order.filledPrice = request.price;
      order.closedAt = Date.now();
    }
  } else {
    releaseCash(buyer, request.escrow ?? request.total);
  }
  addPosition(buyer, coin.symbol, request.qty, request.total);
  issuer.realisedPnl = money(issuer.realisedPnl + request.total);

  coin.treasury -= request.qty;
  coin.sold += request.qty;
  coin.raised = money(coin.raised + request.total);
  coin.pressure += request.qty; // real demand, so it feeds the price engine

  const trade = {
    id: id(),
    ts: Date.now(),
    playerId: buyer.id,
    playerName: buyer.name,
    symbol: coin.symbol,
    side: 'buy',
    qty: request.qty,
    price: request.price,
    total: request.total,
    kind: 'issuer-approved',
  };
  state.trades.unshift(trade);
  if (state.trades.length > config.limits.trades) state.trades.length = config.limits.trades;

  settle(request, 'approved');
  request.tradeId = trade.id;

  addNews({
    level: 'listing',
    emoji: '✅',
    title: `${issuer.name} approved ${buyer.name} for ${request.qty} ${coin.symbol}`,
    body: `$${Math.round(request.total).toLocaleString('en-US')} at $${Math.round(request.price).toLocaleString('en-US')} per coin.`,
    symbol: coin.symbol,
  });

  return { request, trade };
}

export function declineRequest(issuer, requestId, reason = '') {
  const request = state.requests.find((r) => r.id === requestId);
  if (!request) throw notFound('Request not found.');
  if (request.issuerId !== issuer.id) throw bad('Only the coin issuer can decide this request.');
  if (request.status !== 'pending') throw bad(`That request is already ${request.status}.`);

  releaseEscrow(request);
  request.reason = String(reason).slice(0, 140);
  return settle(request, 'declined');
}

/** A buyer can withdraw while the issuer has not answered. */
export function cancelRequest(player, requestId) {
  const request = state.requests.find((r) => r.id === requestId);
  if (!request) throw notFound('Request not found.');
  if (request.buyerId !== player.id) throw bad('That is not your request.');
  if (request.status !== 'pending') throw bad(`That request is already ${request.status}.`);

  releaseEscrow(request);
  return settle(request, 'cancelled');
}

function expireRequest(request) {
  releaseEscrow(request);
  return settle(request, 'expired');
}

/** Release the funds behind any request the issuer left unanswered. Runs each tick. */
export function expireStaleRequests() {
  const now = Date.now();
  const expired = [];
  for (const request of state.requests) {
    if (request.status === 'pending' && now > request.expiresAt) {
      expireRequest(request);
      expired.push(request);
    }
  }
  return expired;
}

export function requestsForIssuer(issuerId, { limit = 60 } = {}) {
  return state.requests.filter((r) => r.issuerId === issuerId).slice(0, limit);
}

export function requestsForBuyer(buyerId, { limit = 60 } = {}) {
  return state.requests.filter((r) => r.buyerId === buyerId).slice(0, limit);
}
