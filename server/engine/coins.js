import { config } from '../config.js';
import { state } from '../store.js';
import { bad, money } from '../util.js';
import { newsFromListing } from './news.js';

/**
 * What each backing type reads off the game economy, and how heavily.
 *
 * These keys are the ones api.tycoon.community actually exposes: server-wide
 * figures from economy.csv and players.json (free), plus sector leaderboards from
 * /top10 (one charge each). Weights may be negative — rising debt is bearish.
 */
export const BACKINGS = {
  // Each sector is led by its own leaderboard stat. Sharing a heavy weight on
  // players-online across sectors makes every coin move in lockstep, which
  // defeats the point of having coin types at all.
  freight: {
    label: 'Freight / hauling',
    emoji: '🚛',
    drivers: {
      'stat.quarry_deliver': 0.4,
      'stat.conductor_freight_routes': 0.2,
      'economy.playersOnline': 0.25,
      'economy.money': 0.15,
    },
  },
  aero: {
    label: 'Aviation',
    emoji: '✈️',
    drivers: {
      'stat.airline_trips': 0.55,
      'economy.playersOnline': 0.3,
      'economy.userGrowth': 0.15,
    },
  },
  business: {
    label: 'Business & property',
    emoji: '🏢',
    drivers: {
      'stat.houses_crafted': 0.45,
      'economy.millionaires': 0.25,
      'economy.money': 0.2,
      'economy.userGrowth': 0.1,
    },
  },
  fuel: {
    label: 'Road use & vehicles',
    emoji: '⛽',
    drivers: {
      'stat.toll_paid': 0.55,
      'economy.playersOnline': 0.3,
      'economy.millionaires': 0.15,
    },
  },
  economy: {
    label: 'Whole server economy',
    emoji: '🌍',
    drivers: {
      'economy.money': 0.3,
      'economy.playersOnline': 0.25,
      'economy.millionaires': 0.2,
      'economy.userGrowth': 0.15,
      'economy.debt': -0.1, // more debt on the server drags the index down
    },
  },
};

/**
 * A company-backed coin tracks one company's own numbers. The live API exposes no
 * per-company feed, so it also carries its sector's drivers at reduced weight —
 * otherwise such a coin would have no signal at all against the real server and
 * would drift on noise alone.
 */
export function companyDrivers(companyId, backing = 'freight') {
  const sector = BACKINGS[backing]?.drivers ?? BACKINGS.freight.drivers;
  const blended = {
    [`company.${companyId}.deliveries`]: 0.22,
    [`company.${companyId}.revenue`]: 0.22,
    [`company.${companyId}.vehicles`]: 0.14,
    [`company.${companyId}.players`]: 0.1,
    [`company.${companyId}.driverUptime`]: 0.02,
  };
  for (const [key, weight] of Object.entries(sector)) blended[key] = weight * 0.3;
  return blended;
}

const SYMBOL_RE = /^[A-Z0-9]{2,6}$/;

export function createCoin({
  symbol,
  name,
  backing,
  supply,
  companyId,
  issuerId,
  issuerName,
  requireApproval = true,
}) {
  const sym = String(symbol ?? '').trim().toUpperCase();
  if (!SYMBOL_RE.test(sym)) throw bad('Symbol must be 2–6 letters or digits, e.g. WLC.');
  if (state.coins[sym]) throw bad(`${sym} is already listed.`);

  const coinName = String(name ?? '').trim().slice(0, 48);
  if (coinName.length < 3) throw bad('Coin name must be at least 3 characters.');

  const totalSupply = Number(supply);
  if (!Number.isInteger(totalSupply) || totalSupply < 100 || totalSupply > 1_000_000) {
    throw bad('Total supply must be a whole number between 100 and 1,000,000.');
  }

  if (companyId && !BACKINGS[backing]) backing = 'freight';
  if (!BACKINGS[backing]) throw bad(`Backing must be one of: ${Object.keys(BACKINGS).join(', ')}.`);

  const price = config.economy.startingPrice;
  const now = Date.now();

  const coin = {
    symbol: sym,
    name: coinName,
    backing,
    companyId: companyId ?? null,
    emoji: BACKINGS[backing].emoji,
    drivers: companyId ? companyDrivers(companyId, backing) : { ...BACKINGS[backing].drivers },
    supply: totalSupply,

    /**
     * Coins the issuer still holds and is selling. Every purchase comes out of here
     * and the money goes to the issuer, so there is no house acting as counterparty.
     */
    treasury: totalSupply,
    raised: 0,
    sold: 0,

    price,
    startPrice: price,
    ath: price,
    atl: price,
    marketCap: money(price * totalSupply),
    score: 0,
    confidence: 'NEUTRAL',
    signals: [],
    pressure: 0,
    change24h: 0,
    change1h: 0,

    issuerId: issuerId ?? null,
    issuerName: issuerName ?? null,
    /** Every purchase needs the issuer to approve the buyer. */
    requireApproval: requireApproval !== false,
    status: 'active',

    createdAt: now,
    history: [{ t: now, p: price }],
  };

  state.coins[sym] = coin;
  newsFromListing(coin);
  return coin;
}
