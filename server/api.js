import { config } from './config.js';
import { state } from './store.js';
import { markDirty } from './store.js';
import { bad, HttpError, money } from './util.js';
import { BACKINGS, createCoin } from './engine/coins.js';
import { availableCash, createPlayer, leaderboard, playerByKey, portfolio, whales } from './engine/players.js';
import {
  applyWealth,
  onlinePlayers,
  refreshWealth,
  requireOnlineProfile,
  verifyByBalance,
} from './engine/identity.js';
import { cancelOrder, executeMarket, placeLimit, quote, requireCoin } from './engine/trading.js';
import { claim, listStakes, rewardFor, stake, unstake, stakeDayMs } from './engine/staking.js';
import { activeEvents, eventCatalog } from './engine/events.js';
import {
  approveRequest,
  availableTreasury,
  cancelRequest,
  createRequest,
  declineRequest,
  pendingFor,
  requestsForBuyer,
  requestsForIssuer,
} from './engine/requests.js';
import { source, discoveredKeys } from './sources/index.js';
import { clientMeta, hasKey } from './sources/client.js';
import { tick } from './engine/tick.js';

const RANGES = { '1h': 3_600_000, '6h': 21_600_000, '24h': 86_400_000, '7d': 604_800_000, all: Infinity };

function summarise(coin) {
  const spark = coin.history.slice(-48).map((p) => p.p);
  return {
    symbol: coin.symbol,
    name: coin.name,
    emoji: coin.emoji,
    backing: coin.backing,
    backingLabel: BACKINGS[coin.backing]?.label ?? coin.backing,
    companyId: coin.companyId,
    ownerId: coin.ownerId,
    status: coin.status,
    createdAt: coin.createdAt,
    price: coin.price,
    startPrice: coin.startPrice,
    change1h: coin.change1h ?? 0,
    change24h: coin.change24h ?? 0,
    marketCap: coin.marketCap,
    supply: coin.supply,
    treasury: coin.treasury,
    available: availableTreasury(coin),
    pendingRequests: pendingFor(coin.symbol).length,
    circulating: coin.supply - coin.treasury,
    issuerId: coin.issuerId,
    issuerName: coin.issuerName,
    requireApproval: coin.requireApproval !== false,
    raised: coin.raised ?? 0,
    sold: coin.sold ?? 0,
    confidence: coin.confidence,
    score: coin.score ?? 0,
    signals: coin.signals ?? [],
    ath: coin.ath,
    atl: coin.atl,
    spark,
  };
}

function downsample(points, max) {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out = [];
  for (let i = 0; i < max; i += 1) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

/** Equal-weighted index of every listed coin, rebased to 1000 at the earliest common point. */
function marketIndex() {
  const coins = Object.values(state.coins);
  if (coins.length === 0) return { value: 1000, change24h: 0 };
  const ratios = coins.map((c) => c.price / c.startPrice);
  const value = money((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 1000);
  const change24h = coins.reduce((sum, c) => sum + (c.change24h ?? 0), 0) / coins.length;
  return { value, change24h };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Engine internals (data source, API charge balance, manual tick) are for the
 * operator, not for players. With ADMIN_KEY set only that key opens them; without
 * it, only localhost does — so a hosted deployment is closed by default rather than
 * relying on someone remembering to set a variable.
 */
function isAdmin(req) {
  const supplied = req.headers['x-admin-key'];
  if (config.adminKey) {
    return typeof supplied === 'string' && supplied.length === config.adminKey.length && supplied === config.adminKey;
  }
  return LOOPBACK.has(req.socket?.remoteAddress ?? '');
}

const routes = [];
const route = (method, path, handler, opts = {}) => {
  const names = [];
  const pattern = new RegExp(
    `^${path.replace(/:([A-Za-z]+)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    })}$`,
  );
  routes.push({ method, pattern, names, handler, auth: opts.auth ?? false });
};

// ---------------------------------------------------------------- public data

route('GET', '/api/status', ({ req }) => {
  const lastTick = state.meta.lastTick ?? 0;
  const healthy = state.meta.sourceOk !== false && Date.now() - lastTick < config.tickMs * 3;

  // What any visitor may see: enough to render the site, nothing about the backend.
  const status = {
    now: Date.now(),
    tickMs: config.tickMs,
    lastTick,
    healthy,
    coins: Object.keys(state.coins).length,
    players: Object.keys(state.players).length,
    startingPrice: config.economy.startingPrice,
    startingCash: config.economy.startingCash,
    spread: config.economy.spread,
    impact: config.pricing.impact,
    requestTtlMs: config.market.requestTtlMs,
    floorPrice: config.economy.floorPrice,
    staking: { ...config.staking, dayMs: stakeDayMs() },
    identity: {
      // Linking to a real game account needs a working API key.
      available: hasKey() && config.source === 'tycoon',
      trustUrlId: config.identity.trustUrlId,
    },
    adminAvailable: Boolean(config.adminKey),
  };

  if (!isAdmin(req)) return status;

  return {
    ...status,
    admin: true,
    tickCount: state.meta.tickCount ?? 0,
    source: state.meta.sourceName ?? source.name,
    sourceOk: state.meta.sourceOk !== false,
    sourceErrors: state.meta.sourceErrors ?? [],
    sourceInfo: state.meta.sourceInfo ?? null,
    metricCount: state.meta.metricCount ?? 0,
  };
});

/** Check an operator key without leaking anything when it is wrong. */
route('POST', '/api/admin/verify', ({ req }) => ({ admin: isAdmin(req) }));

route('GET', '/api/market', () => ({
  coins: Object.values(state.coins)
    .map(summarise)
    .sort((a, b) => b.marketCap - a.marketCap),
  index: marketIndex(),
}));

route('GET', '/api/coins/:symbol', ({ params }) => {
  const coin = requireCoin(params.symbol);
  const recent = state.trades.filter((t) => t.symbol === coin.symbol).slice(0, 25);
  const book = state.orders
    .filter((o) => o.symbol === coin.symbol && o.status === 'open')
    .map((o) => ({ id: o.id, side: o.side, qty: o.qty, limitPrice: o.limitPrice, player: o.playerName }))
    .sort((a, b) => b.limitPrice - a.limitPrice);
  return { coin: summarise(coin), trades: recent, book };
});

route('GET', '/api/coins/:symbol/history', ({ params, url }) => {
  const coin = requireCoin(params.symbol);
  const range = url.searchParams.get('range') ?? '24h';
  const windowMs = RANGES[range] ?? RANGES['24h'];
  const cutoff = Date.now() - windowMs;
  const points = coin.history.filter((p) => p.t >= cutoff);
  const max = Math.min(Number(url.searchParams.get('points')) || 300, 1000);
  return { symbol: coin.symbol, range, points: downsample(points.length ? points : coin.history.slice(-2), max) };
});

route('GET', '/api/backings', () => ({
  backings: Object.entries(BACKINGS).map(([key, value]) => ({ key, ...value })),
  startingPrice: config.economy.startingPrice,
  icoDurationMs: config.economy.icoDurationMs,
}));

route('GET', '/api/news', ({ url }) => ({
  news: state.news.slice(0, Math.min(Number(url.searchParams.get('limit')) || 60, 200)),
}));

route('GET', '/api/events', () => ({ active: activeEvents(), recent: state.events.slice(0, 20), catalog: eventCatalog }));

route('GET', '/api/trades', ({ url }) => ({
  trades: state.trades.slice(0, Math.min(Number(url.searchParams.get('limit')) || 40, 200)),
}));

route('GET', '/api/whales', () => ({ whales: whales(20) }));

route('GET', '/api/leaderboard', () => ({ leaderboard: leaderboard(25) }));

route('GET', '/api/dashboard', () => {
  const coins = Object.values(state.coins).map(summarise);
  const listed = coins;
  const byChange = [...listed].sort((a, b) => b.change24h - a.change24h);
  return {
    index: marketIndex(),
    totalMarketCap: money(coins.reduce((sum, c) => sum + c.marketCap, 0)),
    coins: listed.length,
    newest: [...coins].sort((a, b) => b.createdAt - a.createdAt).slice(0, 3),
    // Only genuinely negative coins are losers — otherwise a green market renders
    // a "top losers" board full of coins that are up.
    gainers: byChange.filter((c) => c.change24h > 0).slice(0, 3),
    losers: byChange.filter((c) => c.change24h < 0).slice(-3).reverse(),
    news: state.news.slice(0, 6),
    events: activeEvents(),
    trades: state.trades.slice(0, 8),
  };
});

route('GET', '/api/source/keys', ({ req }) => {
  if (!isAdmin(req)) throw new HttpError(403, 'Not available.');
  return { source: source.name, keys: discoveredKeys() };
});

// --------------------------------------------------------------------- coins

route('POST', '/api/coins', ({ body, player }) => {
  const coin = createCoin({
    symbol: body.symbol,
    name: body.name,
    backing: body.backing,
    companyId: body.companyId || null,
    supply: Number(body.supply),
    issuerId: player.id,
    issuerName: player.name,
    requireApproval: body.requireApproval !== false,
  });
  markDirty();
  return { coin: summarise(coin) };
}, { auth: true });

// ------------------------------------------------------------------ identity

route('POST', '/api/session', ({ body }) => {
  const name = String(body.name ?? '').trim();
  if (name.length < 2) throw bad('Pick a trader name of at least 2 characters.');
  const player = createPlayer(name);
  markDirty();
  return { player: { id: player.id, name: player.name, key: player.key, cash: availableCash(player) } };
});

// ------------------------------------------------- linking a real game account

/** Who is in game right now. Free endpoint, so this costs nothing to call. */
route('GET', '/api/players/online', async () => {
  const players = await onlinePlayers();
  return {
    players: players.map((p) => ({ name: p.name, vrpId: p.vrpId })),
    count: players.length,
    linked: Object.values(state.players)
      .filter((p) => p.vrpId)
      .map((p) => p.vrpId),
  };
});

/**
 * Step 1 of linking: confirm the player is online and tell the client what proof
 * is needed. Costs nothing — the balance read only happens on confirm.
 */
route('POST', '/api/link/start', async ({ body }) => {
  const profile = await requireOnlineProfile({ vrpId: body.vrpId, name: body.name });
  const taken = Object.values(state.players).find((p) => p.vrpId === profile.vrpId);
  return {
    profile: { name: profile.name, vrpId: profile.vrpId },
    alreadyLinked: Boolean(taken),
    challenge: 'wallet-balance',
    hint: 'Open your wallet in game and enter your current cash on hand.',
  };
});

/**
 * Step 2: prove ownership by stating the wallet balance, then mint the session.
 * Only the account owner can read that number off their own screen.
 */
route('POST', '/api/link/confirm', async ({ body }) => {
  const profile = await requireOnlineProfile({ vrpId: body.vrpId, name: body.name });
  const wealth = await verifyByBalance(profile, body.wallet);

  const existing = Object.values(state.players).find((p) => p.vrpId === profile.vrpId);
  const player = existing ?? createPlayer(profile.name, { vrpId: profile.vrpId, verified: true });
  player.name = profile.name;
  player.vrpId = profile.vrpId;
  player.verified = true;
  player.linkedAt ??= Date.now();
  applyWealth(player, wealth);
  markDirty();

  return {
    player: { id: player.id, name: player.name, key: player.key, vrpId: player.vrpId, verified: true },
    wallet: portfolio(player),
    returning: Boolean(existing),
  };
});

/**
 * Auto-claim from a URL parameter, for F1 menus that can template the player's id
 * into the link. Disabled unless IDENTITY_TRUST_URL_ID=true, because a player who
 * can edit the URL by hand could otherwise claim someone else's account.
 */
route('POST', '/api/link/auto', async ({ body }) => {
  if (!config.identity.trustUrlId) {
    throw bad('URL auto-login is disabled. Set IDENTITY_TRUST_URL_ID=true only if the F1 menu fills the id in for the player.');
  }
  const profile = await requireOnlineProfile({ vrpId: body.vrpId, name: body.name });
  const existing = Object.values(state.players).find((p) => p.vrpId === profile.vrpId);
  const player = existing ?? createPlayer(profile.name, { vrpId: profile.vrpId, verified: true });
  player.vrpId = profile.vrpId;
  player.name = profile.name;
  player.verified = true;
  await refreshWealth(player, { force: true });
  markDirty();
  return {
    player: { id: player.id, name: player.name, key: player.key, vrpId: player.vrpId, verified: true },
    wallet: portfolio(player),
    returning: Boolean(existing),
  };
});

/** Pull the player's real balance again on demand. Costs one charge. */
route('POST', '/api/wallet/refresh', async ({ player }) => {
  if (!player.vrpId) throw bad('This wallet is not linked to a game account.');
  await refreshWealth(player, { force: true });
  markDirty();
  return { wallet: portfolio(player) };
}, { auth: true });

route('GET', '/api/wallet', async ({ player }) => ({
  // Cached for a minute inside refreshWealth, so this does not spend a charge per poll.
  wallet: portfolio(await refreshWealth(player)),
  orders: state.orders.filter((o) => o.playerId === player.id).slice(0, 50),
  stakes: listStakes(player.id),
  trades: state.trades.filter((t) => t.playerId === player.id).slice(0, 25),
}), { auth: true });

// ------------------------------------------------------------------- trading

route('POST', '/api/quote', ({ body }) => {
  const coin = requireCoin(body.symbol);
  return { quote: quote(coin, body.side === 'sell' ? 'sell' : 'buy', body.qty) };
});

route('POST', '/api/trade', ({ body, player }) => {
  const coin = requireCoin(body.symbol);
  const side = body.side === 'sell' ? 'sell' : 'buy';
  const result = executeMarket(player, coin, side, body.qty);
  markDirty();
  return { trade: result.trade, wallet: portfolio(player), coin: summarise(coin) };
}, { auth: true });

// ------------------------------------------------- issuer-approved purchases

/** Ask the issuer to sell you coins. Reserves your funds and locks the price. */
route('POST', '/api/requests', ({ body, player }) => {
  const coin = requireCoin(body.symbol);
  const q = quote(coin, 'buy', body.qty);
  const request = createRequest(player, coin, q.qty, { ...q, note: body.note });
  markDirty();
  return { request, wallet: portfolio(player), coin: summarise(coin) };
}, { auth: true });

/** Requests waiting on me as an issuer, plus the ones I have sent as a buyer. */
route('GET', '/api/requests', ({ player }) => ({
  incoming: requestsForIssuer(player.id),
  outgoing: requestsForBuyer(player.id),
}), { auth: true });

route('POST', '/api/requests/:id/approve', ({ params, player }) => {
  const result = approveRequest(player, params.id);
  markDirty();
  return { request: result.request, trade: result.trade, wallet: portfolio(player) };
}, { auth: true });

route('POST', '/api/requests/:id/decline', ({ params, body, player }) => {
  const request = declineRequest(player, params.id, body.reason);
  markDirty();
  return { request, wallet: portfolio(player) };
}, { auth: true });

route('POST', '/api/requests/:id/cancel', ({ params, player }) => {
  const request = cancelRequest(player, params.id);
  markDirty();
  return { request, wallet: portfolio(player) };
}, { auth: true });

route('GET', '/api/orders', ({ player }) => ({
  orders: state.orders.filter((o) => o.playerId === player.id).slice(0, 100),
}), { auth: true });

route('POST', '/api/orders', ({ body, player }) => {
  const coin = requireCoin(body.symbol);
  const side = body.side === 'sell' ? 'sell' : 'buy';
  const order = placeLimit(player, coin, side, body.qty, body.limitPrice);
  markDirty();
  return { order, wallet: portfolio(player) };
}, { auth: true });

route('DELETE', '/api/orders/:id', ({ params, player }) => {
  const order = cancelOrder(player, params.id);
  markDirty();
  return { order, wallet: portfolio(player) };
}, { auth: true });

// ------------------------------------------------------------------- staking

route('GET', '/api/stakes', ({ player }) => ({ stakes: listStakes(player.id) }), { auth: true });

route('POST', '/api/stakes', ({ body, player }) => {
  const coin = requireCoin(body.symbol);
  const entry = stake(player, coin, Number(body.qty), Number(body.days));
  markDirty();
  return { stake: entry, wallet: portfolio(player) };
}, { auth: true });

route('POST', '/api/stakes/preview', ({ body }) => ({
  reward: rewardFor(Number(body.qty) || 0, Number(body.days) || 0),
}));

route('POST', '/api/stakes/:id/claim', ({ params, player }) => {
  const entry = claim(player, params.id);
  markDirty();
  return { stake: entry, wallet: portfolio(player) };
}, { auth: true });

route('POST', '/api/stakes/:id/unstake', ({ params, player }) => {
  const entry = unstake(player, params.id);
  markDirty();
  return { stake: entry, wallet: portfolio(player) };
}, { auth: true });

// ---------------------------------------------------------------------- admin

// Forcing a tick re-prices every coin, so it must not be reachable by visitors.
route('POST', '/api/tick', async ({ req }) => {
  if (!isAdmin(req)) throw new HttpError(403, 'Not available.');
  const result = await tick();
  return { ok: Boolean(result), moves: result?.moves?.length ?? 0 };
});

// -------------------------------------------------------------------- dispatch

/**
 * Platform-neutral dispatch.
 *
 * Takes a normalised request and returns `{ status, payload }` — no Node streams,
 * no ServerResponse — so the same routing table serves the Node HTTP server and a
 * Cloudflare Worker without either knowing about the other.
 *
 * @param {{ method: string, url: URL, headers: Record<string,string>, body?: object,
 *           remoteAddress?: string }} request
 */
export async function dispatch(request) {
  const { method, url, headers = {}, body = {}, remoteAddress = '' } = request;
  const match = routes.find((r) => r.method === method && r.pattern.test(url.pathname));

  if (!match) {
    const pathExists = routes.some((r) => r.pattern.test(url.pathname));
    return {
      status: pathExists ? 405 : 404,
      payload: { error: pathExists ? 'Method not allowed' : 'Not found' },
    };
  }

  // Handlers reach for req.headers / req.socket; give them a shape that satisfies
  // both platforms rather than making every handler platform-aware.
  const req = { method, headers, socket: { remoteAddress } };

  try {
    const values = url.pathname.match(match.pattern).slice(1);
    const params = Object.fromEntries(match.names.map((name, i) => [name, decodeURIComponent(values[i])]));
    const player = match.auth ? playerByKey(headers['x-player-key']) : null;
    const payload = await match.handler({ req, url, params, body, player });
    return { status: 200, payload };
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, payload: { error: err.message } };
    console.error(`[api] ${method} ${url.pathname}: ${err.stack ?? err.message}`);
    return { status: 500, payload: { error: 'Internal error' } };
  }
}

/** Node adapter: read the stream, dispatch, write the response. */
export async function handleApi(req, res, url) {
  let body = {};
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 256 * 1024) throw bad('Request body too large.');
        chunks.push(chunk);
      }
      if (chunks.length > 0) body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      const message = err instanceof HttpError ? err.message : 'Request body must be valid JSON.';
      return send(res, status, { error: message });
    }
  }

  const { status, payload } = await dispatch({
    method: req.method,
    url,
    headers: req.headers,
    body,
    remoteAddress: req.socket?.remoteAddress ?? '',
  });
  return send(res, status, payload);
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
