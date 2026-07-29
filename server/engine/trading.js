import { config } from '../config.js';
import { state } from '../store.js';
import { bad, id, money, notFound } from '../util.js';
import {
  addPosition,
  availableCash,
  freeQty,
  releaseCash,
  releaseCoins,
  removePosition,
  reserveCash,
  reserveCoins,
} from './players.js';
import { newsFromTrade } from './news.js';
import { availableTreasury, createRequest } from './requests.js';

const { spread, startingPrice } = config.economy;

export function requireCoin(symbol) {
  const coin = state.coins[String(symbol ?? '').toUpperCase()];
  if (!coin) throw notFound(`No coin listed with symbol ${symbol}`);
  return coin;
}

function requireQty(qty) {
  const n = Number(qty);
  if (!Number.isInteger(n) || n <= 0) throw bad('Quantity must be a whole number of coins, at least 1.');
  if (n > 1_000_000) throw bad('Quantity too large.');
  return n;
}

/**
 * Price impact of an order, as a fraction. Large orders relative to supply cost more,
 * which is what stops a whale from buying an entire book at the sticker price.
 */
function impactOf(coin, qty) {
  return (config.pricing.impact * qty) / Math.max(1, coin.supply);
}

/** What a market order would cost right now, including spread and slippage. */
export function quote(coin, side, qtyRaw) {
  const qty = requireQty(qtyRaw);

  const half = spread / 2;
  const slip = impactOf(coin, qty) / 2; // average fill sits halfway up the impact curve
  const unitPrice =
    side === 'buy' ? money(coin.price * (1 + half + slip)) : money(coin.price * (1 - half - slip));

  return {
    symbol: coin.symbol,
    side,
    qty,
    unitPrice,
    total: money(qty * unitPrice),
    impact: slip * 2,
  };
}

function recordTrade(player, coin, side, qty, unitPrice, kind) {
  const trade = {
    id: id(),
    ts: Date.now(),
    playerId: player.id,
    playerName: player.name,
    symbol: coin.symbol,
    side,
    qty,
    price: unitPrice,
    total: money(qty * unitPrice),
    kind,
  };
  state.trades.unshift(trade);
  if (state.trades.length > config.limits.trades) state.trades.length = config.limits.trades;
  newsFromTrade(coin, trade);
  return trade;
}

/**
 * Buying is a request to the issuer, not a fill — see requests.js. Selling is
 * immediate: a holder must always be able to get out, otherwise an issuer who stops
 * answering could trap everyone who bought in. Sold coins go back to the issuer's
 * treasury for them to sell again.
 */
export function executeMarket(player, coin, side, qtyRaw) {
  if (side === 'buy') {
    throw bad(`Buying ${coin.symbol} needs the issuer's approval — send a purchase request instead.`);
  }

  const q = quote(coin, side, qtyRaw);
  const qty = q.qty;

  const free = freeQty(player, coin.symbol);
  if (free < qty) throw bad(`You only have ${free} ${coin.symbol} available to sell.`);

  removePosition(player, coin.symbol, qty, q.total);
  coin.treasury += qty;
  coin.pressure -= qty;

  const trade = recordTrade(player, coin, side, qty, q.unitPrice, 'market');
  return { trade, quote: q };
}

export function placeLimit(player, coin, side, qtyRaw, limitPriceRaw) {
  const qty = requireQty(qtyRaw);
  const limitPrice = money(Number(limitPriceRaw));
  if (!Number.isFinite(limitPrice) || limitPrice <= 0) throw bad('Limit price must be a positive number.');

  if (side === 'buy') {
    const cost = money(qty * limitPrice);
    const funds = availableCash(player);
    if (funds < cost) throw bad(`Not enough buying power to reserve $${cost.toLocaleString('en-US')}.`);
    reserveCash(player, cost); // held until fill or cancel
  } else {
    const free = freeQty(player, coin.symbol);
    if (free < qty) throw bad(`You only have ${free} ${coin.symbol} available to sell.`);
    reserveCoins(player, coin.symbol, qty);
  }

  const order = {
    id: id(),
    playerId: player.id,
    playerName: player.name,
    symbol: coin.symbol,
    side,
    qty,
    limitPrice,
    status: 'open',
    createdAt: Date.now(),
  };
  state.orders.unshift(order);
  return order;
}

export function cancelOrder(player, orderId) {
  const order = state.orders.find((o) => o.id === orderId && o.playerId === player.id);
  if (!order) throw notFound('Order not found.');
  if (order.status !== 'open') throw bad(`Order is already ${order.status}.`);

  if (order.side === 'buy') releaseCash(player, money(order.qty * order.limitPrice));
  else releaseCoins(player, order.symbol, order.qty);

  order.status = 'cancelled';
  order.closedAt = Date.now();
  return order;
}

/**
 * Fill any open limit orders the new price has crossed. Runs once per coin per tick,
 * after the price moves.
 */
export function matchOrders(coin) {
  const filled = [];

  for (const order of state.orders) {
    if (order.status !== 'open' || order.symbol !== coin.symbol) continue;

    const crossed = order.side === 'buy' ? coin.price <= order.limitPrice : coin.price >= order.limitPrice;
    if (!crossed) continue;

    const player = state.players[order.playerId];
    if (!player) continue;

    if (order.side === 'buy') {
      // A crossing buy cannot simply fill — it still needs the issuer to approve the
      // buyer, so it becomes a request at the crossed price and waits.
      if (availableTreasury(coin) < order.qty) continue;
      const fillPrice = Math.min(coin.price, order.limitPrice); // improvement to the taker
      try {
        createRequest(
          player,
          coin,
          order.qty,
          { unitPrice: fillPrice, total: money(order.qty * fillPrice), note: 'Triggered by a limit order' },
          { orderId: order.id },
        );
        order.status = 'awaiting-approval';
        order.triggeredAt = Date.now();
      } catch {
        // Sold out or otherwise unfillable — leave the order resting.
      }
      continue;
    }

    const fillPrice = coin.price;
    releaseCoins(player, coin.symbol, order.qty);
    removePosition(player, coin.symbol, order.qty, money(order.qty * fillPrice));
    coin.treasury += order.qty;
    coin.pressure -= order.qty;
    order.filledPrice = fillPrice;
    order.status = 'filled';
    order.closedAt = Date.now();
    filled.push(order);
    recordTrade(player, coin, order.side, order.qty, order.filledPrice, 'limit');
  }

  return filled;
}
