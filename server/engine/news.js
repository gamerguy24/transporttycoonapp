import { config } from '../config.js';
import { state } from '../store.js';
import { id } from '../util.js';

const WHALE_TRADE_USD = 50_000_000;
const HEADLINE_MOVE = 0.08;

export function addNews(entry) {
  const item = { id: id(), ts: Date.now(), level: 'info', ...entry };
  state.news.unshift(item);
  if (state.news.length > config.limits.news) state.news.length = config.limits.news;
  return item;
}

/**
 * Explain a move using a driver that actually pushed it that way. Quoting the
 * strongest signal regardless of sign produces nonsense like "surges 10% —
 * players down 7%", so only signals agreeing with the direction qualify.
 */
function reasonFor(move) {
  const up = move.change > 0;
  // Match on effect (which way the driver pushed price) but word it with delta
  // (what the driver itself did) — they are opposite for inverted drivers.
  const agreeing = (move.signals ?? []).filter((s) => (s.effect > 0) === up && Math.abs(s.delta) > 0.02);
  if (agreeing.length > 0) {
    const top = agreeing[0];
    return `${top.label} ${top.delta > 0 ? 'up' : 'down'} ${Math.abs(top.delta * 100).toFixed(1)}%.`;
  }
  if (Math.abs(move.eventDrift) > 0.01 && move.eventDrift > 0 === up) {
    return 'Traders repricing around the active market event.';
  }
  if (Math.abs(move.pressure) > 0.02 && move.pressure > 0 === up) {
    return up ? 'Heavy buying pressure on the order book.' : 'Sustained selling on the order book.';
  }
  return 'Market repricing on the latest server data.';
}

export function newsFromMovement(coin, move) {
  if (Math.abs(move.change) < HEADLINE_MOVE) return null;
  const up = move.change > 0;
  return addNews({
    level: 'alert',
    emoji: up ? '🚨' : '📉',
    title: `${coin.name} ${up ? 'surges' : 'slides'} ${(move.change * 100).toFixed(1)}%`,
    body: reasonFor(move),
    symbol: coin.symbol,
    from: move.previous,
    to: move.price,
    change: move.change,
  });
}

export function newsFromEvent(event) {
  return addNews({
    level: 'event',
    emoji: event.emoji,
    title: `MARKET EVENT — ${event.name}`,
    body: event.body,
  });
}

export function newsFromTrade(coin, trade) {
  if (trade.total < WHALE_TRADE_USD) return null;
  return addNews({
    level: 'whale',
    emoji: '🐋',
    title: `Whale ${trade.side === 'buy' ? 'buys' : 'dumps'} ${trade.qty} ${coin.symbol}`,
    body: `${trade.playerName} moved $${Math.round(trade.total).toLocaleString('en-US')} through the ${coin.symbol} book.`,
    symbol: coin.symbol,
  });
}

export function newsFromListing(coin) {
  return addNews({
    level: 'listing',
    emoji: '🪙',
    title: `NEW COIN — ${coin.name} (${coin.symbol})`,
    body:
      `${coin.issuerName ?? 'A trader'} issued ${coin.supply.toLocaleString('en-US')} coins at ` +
      `$${config.economy.startingPrice.toLocaleString('en-US')} each` +
      `${coin.requireApproval === false ? '.' : ' — buyers need their approval.'}`,
    symbol: coin.symbol,
  });
}

export function newsFromAth(coin) {
  return addNews({
    level: 'alert',
    emoji: '🏔️',
    title: `${coin.symbol} hits a new all-time high`,
    body: `$${Math.round(coin.price).toLocaleString('en-US')} per coin.`,
    symbol: coin.symbol,
    change: 0,
  });
}
