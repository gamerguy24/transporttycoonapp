/* Tycoon Crypto Exchange — front end.
   Views render to HTML strings, then mount() wires up their interactions.
   Everything re-polls on a timer; renders are skipped while a field has focus. */

const SESSION_KEY = 'tycoon.session';
const ADMIN_KEY_STORE = 'tycoon.admin';
const REFRESH_MS = 5000;

let session = loadSession();
/** Operator key, if this browser has unlocked the engine diagnostics. */
let adminKey = localStorage.getItem(ADMIN_KEY_STORE);
/**
 * State of the in-game User Applications bridge. Declared up here because helpers
 * defined above the bridge itself read it — a `const` further down would sit in the
 * temporal dead zone and throw rather than read as undefined.
 */
const game = { active: false, data: {}, linking: false, linked: false };
const cache = { status: null, market: null, wallet: null, dashboard: null };
const draft = { qty: 1, limitPrice: '', side: 'buy', range: '24h', newsFilter: 'all' };

/* ------------------------------------------------------------------ helpers */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

function saveSession(next) {
  session = next;
  if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
  else localStorage.removeItem(SESSION_KEY);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(session?.key ? { 'x-player-key': session.key } : {}),
      ...(adminKey ? { 'x-admin-key': adminKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({ error: 'Bad response from server' }));
  if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`);
  return payload;
}

const usd = (n, digits = 0) =>
  `$${Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

function compact(n) {
  const v = Number(n ?? 0);
  const abs = Math.abs(v);
  if (abs >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return usd(v);
}

const pct = (n) => `${n > 0 ? '+' : ''}${(Number(n ?? 0) * 100).toFixed(2)}%`;
const dir = (n) => (n > 0.0001 ? 'up' : n < -0.0001 ? 'down' : 'flat');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function countdown(ts) {
  const ms = ts - Date.now();
  if (ms <= 0) return 'ready';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  $('#toast-host').append(node);
  setTimeout(() => node.remove(), 4200);
  // Mirror it onto the game HUD, so it is readable even with the app pinned.
  if (game.active && kind) window.parent.postMessage({ type: 'info', text: message, time: 6 }, '*');
}

function spark(values, positive) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map((v, i) => `${((i / (values.length - 1)) * 92).toFixed(1)},${(25 - ((v - min) / range) * 23).toFixed(1)}`)
    .join(' ');
  return `<svg class="spark" viewBox="0 0 92 26" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${points}" fill="none" stroke="${positive ? '#22c55e' : '#f4525f'}" stroke-width="1.5" stroke-linejoin="round" />
  </svg>`;
}

const coinBySymbol = (symbol) => cache.market?.coins.find((c) => c.symbol === symbol);

/* -------------------------------------------------------------------- chart */

function drawChart(canvas, points) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (!points || points.length < 2) {
    ctx.fillStyle = '#8496a9';
    ctx.font = '13px system-ui';
    ctx.fillText('Not enough price history yet — check back after a few ticks.', 14, h / 2);
    return null;
  }

  const padL = 68;
  const padR = 14;
  const padT = 14;
  const padB = 26;
  const prices = points.map((p) => p.p);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || max * 0.02 || 1;
  const lo = min - span * 0.12;
  const hi = max + span * 0.12;

  const x = (i) => padL + (i / (points.length - 1)) * (w - padL - padR);
  const y = (p) => padT + (1 - (p - lo) / (hi - lo)) * (h - padT - padB);

  // horizontal grid + price axis
  ctx.strokeStyle = 'rgba(30,43,58,0.8)';
  ctx.fillStyle = '#8496a9';
  ctx.font = '11px ui-monospace, monospace';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const price = lo + ((hi - lo) * i) / 4;
    const py = Math.round(y(price)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, py);
    ctx.lineTo(w - padR, py);
    ctx.stroke();
    ctx.fillText(compact(price), 8, py + 3.5);
  }

  const rising = points.at(-1).p >= points[0].p;
  const stroke = rising ? '#22c55e' : '#f4525f';

  const gradient = ctx.createLinearGradient(0, padT, 0, h - padB);
  gradient.addColorStop(0, rising ? 'rgba(34,197,94,0.28)' : 'rgba(244,82,95,0.28)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');

  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(x(i), y(p.p)) : ctx.lineTo(x(i), y(p.p))));
  ctx.lineTo(x(points.length - 1), h - padB);
  ctx.lineTo(x(0), h - padB);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(x(i), y(p.p)) : ctx.lineTo(x(i), y(p.p))));
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // time axis
  ctx.fillStyle = '#8496a9';
  const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  ctx.fillText(fmtTime(points[0].t), padL, h - 8);
  const lastLabel = fmtTime(points.at(-1).t);
  ctx.fillText(lastLabel, w - padR - ctx.measureText(lastLabel).width, h - 8);

  // last price marker
  const lastX = x(points.length - 1);
  const lastY = y(points.at(-1).p);
  ctx.beginPath();
  ctx.arc(lastX, lastY, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = stroke;
  ctx.fill();

  return { x, y, points, padL, padR, w, h };
}

function attachChartHover(wrap, geometry) {
  const tip = $('.chart-tip', wrap);
  if (!geometry || !tip) return;
  const canvas = $('canvas', wrap);

  canvas.onmousemove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const relative = event.clientX - rect.left;
    const usable = geometry.w - geometry.padL - geometry.padR;
    const ratio = Math.min(1, Math.max(0, (relative - geometry.padL) / usable));
    const index = Math.round(ratio * (geometry.points.length - 1));
    const point = geometry.points[index];
    if (!point) return;
    tip.style.opacity = '1';
    tip.style.left = `${geometry.x(index)}px`;
    tip.style.top = `${geometry.y(point.p)}px`;
    tip.innerHTML = `${usd(point.p)}<br /><span class="muted">${new Date(point.t).toLocaleString()}</span>`;
  };
  canvas.onmouseleave = () => {
    tip.style.opacity = '0';
  };
}

/* -------------------------------------------------------------- shared bits */

function confidencePill(coin) {
  const cls = coin.confidence === 'HIGH' ? 'high' : coin.confidence === 'LOW' ? 'low' : '';
  return `<span class="pill ${cls}">${coin.confidence ?? 'NEUTRAL'}</span>`;
}

function coinCell(coin) {
  return `<div class="coin-cell">
    <span style="font-size:18px">${coin.emoji ?? '🪙'}</span>
    <div><div class="sym">${esc(coin.symbol)}</div><div class="nm">${esc(coin.name)}</div></div>
  </div>`;
}

function newsItem(item) {
  const move =
    item.from && item.to
      ? `<span class="mono ${dir(item.change)}">${usd(item.from)} → ${usd(item.to)} (${pct(item.change)})</span>`
      : '';
  return `<div class="news-item ${item.level}">
    <div class="emoji">${item.emoji ?? '📰'}</div>
    <div style="min-width:0">
      <div class="title">${esc(item.title)}</div>
      <div class="meta">${esc(item.body)} ${move}</div>
      <div class="meta">${timeAgo(item.ts)}${item.symbol ? ` · <a href="#/trade/${item.symbol}">${item.symbol}</a>` : ''}</div>
    </div>
  </div>`;
}

/** Mirrors the server's fill maths so the cost updates as you type, before you commit. */
function quoteFor(coin, qty) {
  const half = cache.status.spread / 2;
  const slip = (cache.status.impact * qty) / Math.max(1, coin.supply) / 2;
  return {
    fee: half + slip,
    buyUnit: coin.price * (1 + half + slip),
    sellUnit: coin.price * (1 - half - slip),
  };
}

function quoteRows(coin, qty) {
  const q = quoteFor(coin, qty);
  return `
    <div class="row between small"><span class="muted">Buy price / coin</span><span class="mono">${usd(q.buyUnit)}</span></div>
    <div class="row between small"><span class="muted">Total cost</span><span class="mono">${usd(qty * q.buyUnit)}</span></div>
    <div class="row between small"><span class="muted">Sell price / coin</span><span class="mono">${usd(q.sellUnit)}</span></div>
    <div class="row between small"><span class="muted">You receive</span><span class="mono">${usd(qty * q.sellUnit)}</span></div>
    <div class="row between small"><span class="muted">Spread + slippage</span><span class="mono">${(q.fee * 200).toFixed(2)}%</span></div>`;
}

function statCard(label, value, sub = '') {
  return `<div class="card stat tight">
    <span class="label">${label}</span>
    <span class="value">${value}</span>
    ${sub ? `<span class="small muted">${sub}</span>` : ''}
  </div>`;
}

function requireSession() {
  if (session?.key) return true;
  toast('Create a trader wallet first — use the Sign in button.', 'err');
  openSignin();
  return false;
}

/* -------------------------------------------------------------------- views */

const views = {};

views.dashboard = {
  async load() {
    cache.dashboard = await api('/dashboard');
  },
  render() {
    const d = cache.dashboard;
    const events = d.events
      .map(
        (e) => `<div class="event-banner">
          <span class="emoji">${e.emoji}</span>
          <div><strong>${esc(e.name)}</strong><div class="small muted">${esc(e.body)} · ${e.ticksLeft} tick(s) remaining</div></div>
        </div>`,
      )
      .join('');

    const movers = (list, title, emptyText) => `<div class="card">
      <h3>${title}</h3>
      ${list
        .map(
          (c) => `<a href="#/trade/${c.symbol}" class="row between" style="padding:7px 0">
            ${coinCell(c)}
            <div style="text-align:right">
              <div class="mono">${usd(c.price)}</div>
              <div class="delta ${dir(c.change24h)}">${pct(c.change24h)}</div>
            </div>
          </a>`,
        )
        .join('') || `<div class="empty">${emptyText}</div>`}
    </div>`;

    return `
      <div class="row between wrap gap">
        <div><h1>Dashboard</h1><p class="muted small">Prices are driven by live Transport Tycoon server data.</p></div>
        <a class="btn btn-primary" href="#/trade">Start trading</a>
      </div>

      ${events}

      <div class="grid cols-4">
        ${statCard('Tycoon Index', d.index.value.toLocaleString('en-US'), `${pct(d.index.change24h)} over 24h`)}
        ${statCard('Total Market Cap', compact(d.totalMarketCap), `${d.coins} listed coins`)}
        ${statCard('Newest coins', d.newest.map((c) => c.symbol).join(', ') || '—', d.newest.length ? `latest issued by ${esc(d.newest[0].issuerName ?? '—')}` : 'nobody has issued one yet')}
        ${statCard('Your Portfolio', cache.wallet ? compact(cache.wallet.wallet.total) : '—', session ? 'across cash and crypto' : 'sign in to trade')}
      </div>

      <div class="grid cols-2">
        ${movers(d.gainers, '📈 Top gainers · 24h', 'Nothing in the green right now.')}
        ${movers(d.losers, '📉 Top losers · 24h', 'Nothing in the red right now.')}
      </div>

      <div class="grid cols-2">
        <div class="card">
          <div class="row between"><h2>📰 Market news</h2><a class="small muted" href="#/news">See all</a></div>
          ${d.news.map(newsItem).join('') || '<div class="empty">No headlines yet — the engine is warming up.</div>'}
        </div>
        <div class="card">
          <div class="row between"><h2>Recent trades</h2><a class="small muted" href="#/markets">Markets</a></div>
          <div class="table-wrap"><table>
            <thead><tr><th>Trader</th><th>Coin</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th></tr></thead>
            <tbody>${
              d.trades
                .map(
                  (t) => `<tr>
                    <td>${esc(t.playerName)}</td>
                    <td><span class="${t.side === 'buy' ? 'up' : 'down'}">${t.side.toUpperCase()}</span> ${t.symbol}</td>
                    <td class="num">${t.qty}</td>
                    <td class="num">${usd(t.price)}</td>
                    <td class="num">${compact(t.total)}</td>
                  </tr>`,
                )
                .join('') || '<tr><td colspan="5" class="empty">No trades yet.</td></tr>'
            }</tbody>
          </table></div>
        </div>
      </div>`;
  },
};

views.markets = {
  render() {
    const rows = cache.market.coins
      .map((c) => {
        const soldPct = c.supply > 0 ? ((c.sold / c.supply) * 100).toFixed(0) : 0;
        return `<tr data-symbol="${c.symbol}">
          <td>${coinCell(c)}
            <div class="small muted">by ${esc(c.issuerName ?? '—')}${c.requireApproval ? ' · approval required' : ''}</div>
          </td>
          <td class="num">${usd(c.price)}</td>
          <td class="num ${dir(c.change1h)}">${pct(c.change1h)}</td>
          <td class="num ${dir(c.change24h)}">${pct(c.change24h)}</td>
          <td class="num">${compact(c.marketCap)}</td>
          <td class="num">${c.available.toLocaleString('en-US')}
            <div class="small muted">${soldPct}% sold${c.pendingRequests ? ` · ${c.pendingRequests} pending` : ''}</div>
          </td>
          <td>${confidencePill(c)}</td>
          <td>${spark(c.spark, c.spark.at(-1) >= c.spark[0])}</td>
          <td class="num"><a class="btn btn-sm" href="#/trade/${c.symbol}">Trade</a></td>
        </tr>`;
      })
      .join('');

    return `
      <div class="row between wrap gap">
        <div><h1>📈 Markets</h1><p class="muted small">Every coin listed on the Tycoon exchange.</p></div>
        <div class="row gap">
          <span class="pill">Index ${cache.market.index.value.toLocaleString('en-US')}</span>
          <a class="btn" href="#/create">🪙 Create coin</a>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap"><table>
          <thead><tr>
            <th>Coin</th><th class="num">Price</th><th class="num">1h</th><th class="num">24h</th>
            <th class="num">Market cap</th><th class="num">Available</th><th>Confidence</th><th>Trend</th><th></th>
          </tr></thead>
          <tbody>${
            rows ||
            '<tr><td colspan="9" class="empty">No coins yet. Every coin here is issued by a player — <a href="#/create">create the first one</a>.</td></tr>'
          }</tbody>
        </table></div>
      </div>`;
  },
  mount(root) {
    $$('tbody tr[data-symbol]', root).forEach((tr) => {
      tr.onclick = (event) => {
        if (event.target.closest('a')) return;
        location.hash = `#/trade/${tr.dataset.symbol}`;
      };
    });
  },
};

views.trade = {
  async load(symbol) {
    const target = symbol ?? cache.market.coins[0]?.symbol;
    if (!target) return;
    this.detail = await api(`/coins/${target}`);
    this.history = await api(`/coins/${target}/history?range=6h&points=200`);
  },
  render(symbol) {
    if (!this.detail) {
      return `<h1>💱 Trade</h1><div class="card"><p class="muted">No coins exist yet — the exchange is empty
        until a player issues one.</p><div><a class="btn btn-primary" href="#/create">🪙 Create the first coin</a></div></div>`;
    }
    const coin = this.detail.coin;
    const mine = session && coin.issuerId === session.id;
    const qty = Math.max(1, Number(draft.qty) || 1);

    const options = cache.market.coins
      .map((c) => `<option value="${c.symbol}" ${c.symbol === coin.symbol ? 'selected' : ''}>${c.symbol} — ${esc(c.name)}</option>`)
      .join('');

    const signals = (coin.signals ?? [])
      .map(
        // Coloured by its effect on price, labelled with what the metric did —
        // an inverted driver like server debt shows "up" in red.
        (s) => `<div class="row between small"><span class="muted">${esc(s.label)}</span>
          <span class="mono ${dir(s.effect ?? s.delta)}">${pct(s.delta)}</span></div>`,
      )
      .join('') || '<div class="small muted">Waiting for the next data tick…</div>';

    const myOrders = (cache.wallet?.orders ?? []).filter((o) => o.symbol === coin.symbol && o.status === 'open');

    return `
      <div class="row between wrap gap">
        <div class="row gap">
          <span style="font-size:30px">${coin.emoji}</span>
          <div>
            <h1>${esc(coin.name)} <span class="muted">${coin.symbol}</span></h1>
            <p class="small muted">Issued by <strong>${esc(coin.issuerName ?? 'unknown')}</strong> · ${coin.backingLabel}
              · ${coin.available.toLocaleString('en-US')} of ${coin.supply.toLocaleString('en-US')} available to buy
              ${coin.pendingRequests ? `· ${coin.pendingRequests} request(s) pending` : ''}</p>
          </div>
        </div>
        <div style="text-align:right">
          <div class="mono" style="font-size:26px">${usd(coin.price)}</div>
          <div class="delta ${dir(coin.change24h)}">${pct(coin.change24h)} · 24h ${confidencePill(coin)}</div>
        </div>
      </div>

      <div class="row gap wrap">
        <select id="coin-select" style="max-width:320px">${options}</select>
        <a class="btn btn-sm" href="#/charts/${coin.symbol}">📊 Full chart</a>
      </div>

      <div class="grid cols-2">
        <div class="card">
          <div class="chart-wrap"><canvas id="trade-chart"></canvas><div class="chart-tip"></div></div>
        </div>

        <div class="card">
          <h2>💱 Buy or sell</h2>
          <label>Amount (coins)<input id="qty" class="mono" type="number" min="1" step="1" value="${qty}" /></label>
          <div class="row gap">
            ${[1, 5, 10, 25].map((n) => `<button class="btn btn-sm qty-preset" data-qty="${n}">${n}</button>`).join('')}
          </div>
          <div id="quote-box" class="card tight" style="background:var(--panel-2)">${quoteRows(coin, qty)}</div>
          <div class="row gap">
            <button id="buy" class="btn btn-buy" style="flex:1" ${mine ? 'disabled' : ''}>
              ${mine ? 'You issued this coin' : `Request ${qty} ${coin.symbol}`}
            </button>
            <button id="sell" class="btn btn-sell" style="flex:1">Sell ${qty} ${coin.symbol}</button>
          </div>
          <div class="small muted">${
            mine
              ? 'Buyers send you requests — approve them on the Requests page.'
              : `A request reserves your funds and locks this price. ${esc(coin.issuerName ?? 'The issuer')} decides.`
          }</div>
          <div class="small muted">${
            cache.wallet
              ? `Cash ${usd(cache.wallet.wallet.cash)} · holding ${cache.wallet.wallet.positions.find((p) => p.symbol === coin.symbol)?.free ?? 0} ${coin.symbol}`
              : 'Sign in to place orders.'
          }</div>
        </div>
      </div>

      <div class="grid cols-3">
        <div class="card">
          <h2>📌 Limit order</h2>
          ${
            mine
              ? '<div class="small muted">You issued this coin, so you cannot place orders on it.</div>'
              : `<label>Side<select id="limit-side">
                   <option value="buy" ${draft.side === 'buy' ? 'selected' : ''}>Buy when price falls to…</option>
                   <option value="sell" ${draft.side === 'sell' ? 'selected' : ''}>Sell when price rises to…</option>
                 </select></label>
                 <label>Amount<input id="limit-qty" class="mono" type="number" min="1" step="1" value="${qty}" /></label>
                 <label>Limit price<input id="limit-price" class="mono" type="number" min="1" step="1000" value="${draft.limitPrice || Math.round(coin.price)}" /></label>
                 <button id="place-limit" class="btn btn-primary">Place order</button>
                 <div class="small muted">Cash (or coins) is reserved until the order fills or you cancel it.
                   A buy order that hits its price becomes a purchase request for the issuer to approve.</div>`
          }
        </div>

        <div class="card">
          <h2>📊 Why it's moving</h2>
          ${signals}
          <div class="row between small" style="margin-top:6px">
            <span class="muted">Fundamentals score</span>
            <span class="mono ${dir(coin.score)}">${(coin.score * 100).toFixed(1)}</span>
          </div>
          <div class="row between small"><span class="muted">All-time high</span><span class="mono">${usd(coin.ath)}</span></div>
          <div class="row between small"><span class="muted">All-time low</span><span class="mono">${usd(coin.atl)}</span></div>
        </div>

        <div class="card">
          <h2>📖 Open order book</h2>
          <div class="table-wrap"><table>
            <thead><tr><th>Side</th><th class="num">Qty</th><th class="num">Limit</th><th>Trader</th></tr></thead>
            <tbody>${
              this.detail.book
                .map(
                  (o) => `<tr><td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side.toUpperCase()}</td>
                    <td class="num">${o.qty}</td><td class="num">${usd(o.limitPrice)}</td><td>${esc(o.player)}</td></tr>`,
                )
                .join('') || '<tr><td colspan="4" class="empty">No resting orders.</td></tr>'
            }</tbody>
          </table></div>
        </div>
      </div>

      ${
        myOrders.length
          ? `<div class="card"><h2>Your open ${coin.symbol} orders</h2>
              <div class="table-wrap"><table>
                <thead><tr><th>Side</th><th class="num">Qty</th><th class="num">Limit</th><th>Placed</th><th></th></tr></thead>
                <tbody>${myOrders
                  .map(
                    (o) => `<tr><td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side.toUpperCase()}</td>
                      <td class="num">${o.qty}</td><td class="num">${usd(o.limitPrice)}</td>
                      <td class="small muted">${timeAgo(o.createdAt)}</td>
                      <td class="num"><button class="btn btn-sm cancel-order" data-id="${o.id}">Cancel</button></td></tr>`,
                  )
                  .join('')}</tbody>
              </table></div></div>`
          : ''
      }

      <div class="card">
        <h2>Recent ${coin.symbol} trades</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Trader</th><th>Side</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th><th>When</th></tr></thead>
          <tbody>${
            this.detail.trades
              .map(
                (t) => `<tr><td>${esc(t.playerName)}</td>
                  <td class="${t.side === 'buy' ? 'up' : 'down'}">${t.side.toUpperCase()}</td>
                  <td class="num">${t.qty}</td><td class="num">${usd(t.price)}</td>
                  <td class="num">${compact(t.total)}</td><td class="small muted">${timeAgo(t.ts)}</td></tr>`,
              )
              .join('') || '<tr><td colspan="6" class="empty">No trades yet.</td></tr>'
          }</tbody>
        </table></div>
      </div>`;
  },
  mount(root) {
    if (!this.detail) return;
    const symbol = this.detail.coin.symbol;

    const canvas = $('#trade-chart', root);
    if (canvas) attachChartHover(canvas.parentElement, drawChart(canvas, this.history?.points));

    $('#coin-select', root).onchange = (e) => {
      location.hash = `#/trade/${e.target.value}`;
    };

    // Update the quote in place rather than re-rendering — a full render steals focus.
    const qtyInput = $('#qty', root);
    const mine = session && this.detail.coin.issuerId === session.id;
    const syncQuote = () => {
      draft.qty = Math.max(1, Math.floor(Number(qtyInput.value) || 1));
      $('#quote-box', root).innerHTML = quoteRows(this.detail.coin, draft.qty);
      if (!mine) $('#buy', root).textContent = `Request ${draft.qty} ${symbol}`;
      $('#sell', root).textContent = `Sell ${draft.qty} ${symbol}`;
    };
    qtyInput.oninput = syncQuote;
    $$('.qty-preset', root).forEach((btn) => {
      btn.onclick = () => {
        qtyInput.value = btn.dataset.qty;
        syncQuote();
      };
    });

    $('#buy', root).onclick = async () => {
      if (!requireSession()) return;
      try {
        const result = await api('/requests', { method: 'POST', body: { symbol, qty: draft.qty } });
        toast(
          `Request sent to ${this.detail.coin.issuerName} for ${result.request.qty} ${symbol}. ` +
            `${usd(result.request.total)} is reserved until they answer.`,
          'ok',
        );
        await refresh(true);
      } catch (err) {
        toast(err.message, 'err');
      }
    };

    $('#sell', root).onclick = async () => {
      if (!requireSession()) return;
      try {
        const result = await api('/trade', { method: 'POST', body: { symbol, side: 'sell', qty: draft.qty } });
        toast(`Sold ${result.trade.qty} ${symbol} for ${usd(result.trade.total)}`, 'ok');
        await refresh(true);
      } catch (err) {
        toast(err.message, 'err');
      }
    };

    const placeBtn = $('#place-limit', root);
    if (placeBtn) {
      $('#limit-side', root).onchange = (e) => {
        draft.side = e.target.value;
      };
      $('#limit-price', root).oninput = (e) => {
        draft.limitPrice = e.target.value;
      };
      placeBtn.onclick = async () => {
        if (!requireSession()) return;
        try {
          await api('/orders', {
            method: 'POST',
            body: {
              symbol,
              side: $('#limit-side', root).value,
              qty: Number($('#limit-qty', root).value),
              limitPrice: Number($('#limit-price', root).value),
            },
          });
          toast('Limit order placed — it fills when the price crosses.', 'ok');
          await refresh(true);
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    }

    $$('.cancel-order', root).forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api(`/orders/${btn.dataset.id}`, { method: 'DELETE' });
          toast('Order cancelled.', 'ok');
          await refresh(true);
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    });
  },
};

function requestRow(r, role) {
  const pending = r.status === 'pending';
  const left = Math.max(0, r.expiresAt - Date.now());
  return `<div class="req">
    <div style="min-width:0">
      <div class="who">${role === 'incoming' ? esc(r.buyerName) : esc(r.coinName)}
        <span class="muted small">${role === 'incoming' ? `wants ${r.qty} ${r.symbol}` : `· ${r.qty} ${r.symbol}`}</span>
      </div>
      <div class="small muted mono">${usd(r.total)} · ${usd(r.price)} per coin · ${timeAgo(r.createdAt)}${
        r.orderId ? ' · from a limit order' : ''
      }</div>
      ${r.reason ? `<div class="small down">“${esc(r.reason)}”</div>` : ''}
      ${r.note && role === 'incoming' ? `<div class="small muted">“${esc(r.note)}”</div>` : ''}
    </div>
    <div class="spacer"></div>
    <span class="status ${r.status}">${r.status}</span>
    ${pending ? `<span class="small muted mono">${Math.ceil(left / 60000)}m left</span>` : ''}
    ${
      pending && role === 'incoming'
        ? `<button class="btn btn-sm btn-buy req-approve" data-id="${r.id}">Approve</button>
           <button class="btn btn-sm btn-sell req-decline" data-id="${r.id}">Decline</button>`
        : ''
    }
    ${pending && role === 'outgoing' ? `<button class="btn btn-sm req-cancel" data-id="${r.id}">Withdraw</button>` : ''}
  </div>`;
}

function wireRequestButtons(root) {
  const act = (selector, path, message, withReason = false) =>
    $$(selector, root).forEach((btn) => {
      btn.onclick = async () => {
        const reason = withReason ? prompt('Reason (optional, shown to the buyer):') ?? '' : undefined;
        btn.disabled = true;
        try {
          await api(`/requests/${btn.dataset.id}/${path}`, { method: 'POST', body: { reason } });
          toast(message, 'ok');
          await refresh(true);
        } catch (err) {
          btn.disabled = false;
          toast(err.message, 'err');
        }
      };
    });
  act('.req-approve', 'approve', 'Approved — the coins are theirs and the money is yours.');
  act('.req-decline', 'decline', 'Declined. Their funds were released.', true);
  act('.req-cancel', 'cancel', 'Request withdrawn.');
}

views.requests = {
  async load() {
    if (!session) return;
    this.data = await api('/requests');
  },
  render() {
    if (!session) {
      return `<h1>📥 Requests</h1><div class="card"><p class="muted">Sign in to send or approve purchase requests.</p>
        <div><button class="btn btn-primary" data-signin>Sign in</button></div></div>`;
    }
    const incoming = this.data?.incoming ?? [];
    const outgoing = this.data?.outgoing ?? [];
    const pendingIn = incoming.filter((r) => r.status === 'pending');

    return `
      <div><h1>📥 Requests</h1>
        <p class="muted small">Nobody buys a coin you issued without your say-so.</p></div>

      <div class="card">
        <div class="row between">
          <h2>Waiting on you</h2>
          ${pendingIn.length ? `<span class="pill ico">${pendingIn.length} pending</span>` : ''}
        </div>
        ${
          incoming.length
            ? incoming.map((r) => requestRow(r, 'incoming')).join('')
            : '<div class="empty">No one has asked to buy your coins yet.</div>'
        }
      </div>

      <div class="card">
        <h2>Your purchase requests</h2>
        ${
          outgoing.length
            ? outgoing.map((r) => requestRow(r, 'outgoing')).join('')
            : '<div class="empty">You have not asked to buy anything yet.</div>'
        }
      </div>`;
  },
  mount(root) {
    wireRequestButtons(root);
  },
};

views.wallet = {
  render() {
    if (!session) {
      return `<h1>👛 Wallet</h1>
        <div class="card"><p>Create a trader wallet to start with ${usd(cache.status.startingCash)} in cash.</p>
        <div><button class="btn btn-primary" data-signin>Create wallet</button></div></div>`;
    }
    if (!cache.wallet) return '<div class="empty">Loading wallet…</div>';

    const w = cache.wallet.wallet;
    const positions = w.positions
      .map(
        (p) => `<tr>
          <td>${coinCell({ symbol: p.symbol, name: p.name, emoji: coinBySymbol(p.symbol)?.emoji ?? '🪙' })}</td>
          <td class="num">${p.qty.toLocaleString('en-US')}${p.staked ? `<div class="small muted">${p.staked} staked</div>` : ''}${p.reserved ? `<div class="small muted">${p.reserved} in orders</div>` : ''}</td>
          <td class="num">${usd(p.price)}<div class="small muted">avg ${usd(p.avgCost)}</div></td>
          <td class="num ${dir(p.change24h)}">${pct(p.change24h)}</td>
          <td class="num">${compact(p.value)}<div class="small ${dir(p.unrealised)}">${p.unrealised >= 0 ? '+' : ''}${compact(p.unrealised)}</div></td>
          <td class="num"><a class="btn btn-sm" href="#/trade/${p.symbol}">Trade</a></td>
        </tr>`,
      )
      .join('');

    const orders = cache.wallet.orders
      .filter((o) => o.status === 'open')
      .map(
        (o) => `<tr>
          <td>${o.symbol}</td>
          <td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side.toUpperCase()}</td>
          <td class="num">${o.qty}</td>
          <td class="num">${usd(o.limitPrice)}</td>
          <td class="small muted">${timeAgo(o.createdAt)}</td>
          <td class="num"><button class="btn btn-sm cancel-order" data-id="${o.id}">Cancel</button></td>
        </tr>`,
      )
      .join('');

    const stakes = cache.wallet.stakes
      .filter((s) => !s.claimed)
      .map(
        (s) => `<tr>
          <td>${s.symbol}</td>
          <td class="num">${s.qty}</td>
          <td class="num">${s.days}d</td>
          <td class="num up">+${s.reward}</td>
          <td class="small muted">${s.matured ? 'matured' : countdown(s.endsAt)}</td>
          <td class="num">
            <button class="btn btn-sm ${s.matured ? 'btn-primary' : ''} claim-stake" data-id="${s.id}" ${s.matured ? '' : 'disabled'}>Claim</button>
            <button class="btn btn-sm unstake" data-id="${s.id}">Unstake</button>
          </td>
        </tr>`,
      )
      .join('');

    const stakeable = w.positions.filter((p) => p.free > 0);

    return `
      <div class="row between wrap gap">
        <div>
          <h1>👛 Wallet</h1>
          <p class="muted small">
            ${
              w.verified
                ? `Linked to <strong>${esc(w.name)}</strong> (vRP ${w.vrpId}) · balance read ${w.wealthAt ? timeAgo(w.wealthAt) : 'never'}${w.offline ? ' · <span class="down">you appear to be offline in game</span>' : ''}`
                : 'Demo wallet — not linked to a game account.'
            }
          </p>
        </div>
        ${w.verified ? '<button id="refresh-wealth" class="btn btn-sm">Refresh in-game balance</button>' : ''}
      </div>

      ${
        w.verified
          ? `<div class="card tight">
              <h3>Your real in-game money</h3>
              <div class="grid cols-4">
                <div><span class="label muted small">Wallet</span><div class="mono">${usd(w.realWallet)}</div></div>
                <div><span class="label muted small">Bank</span><div class="mono">${usd(w.realBank)}</div></div>
                <div><span class="label muted small">Loan</span><div class="mono ${w.realLoan > 0 ? 'down' : ''}">${usd(w.realLoan)}</div></div>
                <div><span class="label muted small">Net worth</span><div class="mono up">${usd(w.netWorth)}</div></div>
              </div>
              <p class="small muted">Your in-game net worth is your buying power here. The exchange can only read it —
                trades never move real money, so nothing you do on this site can cost you anything in game.</p>
            </div>`
          : ''
      }

      <div class="grid cols-4">
        ${statCard('Buying power', compact(w.cash), w.verified ? 'from your in-game net worth' : 'virtual demo funds')}
        ${statCard('Crypto value', compact(w.cryptoValue), `${w.positions.length} position(s)`)}
        ${statCard('Invested', compact(w.committed), `${compact(w.reserved)} reserved in orders`)}
        ${statCard(
          'Profit / loss',
          `${w.realisedPnl + w.unrealisedPnl >= 0 ? '+' : ''}${compact(w.realisedPnl + w.unrealisedPnl)}`,
          `${compact(w.realisedPnl)} realised · ${compact(w.unrealisedPnl)} on paper`,
        )}
      </div>

      <div class="card">
        <h2>Holdings</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Coin</th><th class="num">Qty</th><th class="num">Price</th><th class="num">24h</th><th class="num">Value</th><th></th></tr></thead>
          <tbody>${positions || '<tr><td colspan="6" class="empty">No coins yet — head to Markets.</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="grid cols-2">
        <div class="card">
          <h2>Open orders</h2>
          <div class="table-wrap"><table>
            <thead><tr><th>Coin</th><th>Side</th><th class="num">Qty</th><th class="num">Limit</th><th>Placed</th><th></th></tr></thead>
            <tbody>${orders || '<tr><td colspan="6" class="empty">No open orders.</td></tr>'}</tbody>
          </table></div>
        </div>

        <div class="card">
          <h2>🔒 Staking</h2>
          <p class="small muted">Lock coins to earn more coins — ${(cache.status.staking.ratePer30Days * 100).toFixed(0)}% per 30 days.</p>
          <div class="row gap wrap">
            <label style="flex:1;min-width:120px">Coin<select id="stake-symbol">
              ${stakeable.map((p) => `<option value="${p.symbol}">${p.symbol} (${p.free} free)</option>`).join('') || '<option value="">No free coins</option>'}
            </select></label>
            <label style="flex:1;min-width:100px">Amount<input id="stake-qty" class="mono" type="number" min="1" step="1" value="10" /></label>
            <label style="flex:1;min-width:100px">Duration<select id="stake-days">
              ${cache.status.staking.allowedDurations.map((d) => `<option value="${d}" ${d === 30 ? 'selected' : ''}>${d} days</option>`).join('')}
            </select></label>
          </div>
          <button id="do-stake" class="btn btn-primary" ${stakeable.length ? '' : 'disabled'}>Stake</button>
          <div class="table-wrap"><table>
            <thead><tr><th>Coin</th><th class="num">Qty</th><th class="num">Term</th><th class="num">Reward</th><th>Matures</th><th></th></tr></thead>
            <tbody>${stakes || '<tr><td colspan="6" class="empty">Nothing staked.</td></tr>'}</tbody>
          </table></div>
        </div>
      </div>

      <div class="card">
        <h2>Your trade history</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>When</th><th>Coin</th><th>Side</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th></tr></thead>
          <tbody>${
            cache.wallet.trades
              .map(
                (t) => `<tr><td class="small muted">${timeAgo(t.ts)}</td><td>${t.symbol}</td>
                  <td class="${t.side === 'buy' ? 'up' : 'down'}">${t.side.toUpperCase()}</td>
                  <td class="num">${t.qty}</td><td class="num">${usd(t.price)}</td><td class="num">${compact(t.total)}</td></tr>`,
              )
              .join('') || '<tr><td colspan="6" class="empty">No trades yet.</td></tr>'
          }</tbody>
        </table></div>
      </div>`;
  },
  mount(root) {
    $$('.cancel-order', root).forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api(`/orders/${btn.dataset.id}`, { method: 'DELETE' });
          toast('Order cancelled.', 'ok');
          await refresh(true);
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    });

    const refreshBtn = $('#refresh-wealth', root);
    if (refreshBtn) {
      refreshBtn.onclick = async () => {
        try {
          const result = await api('/wallet/refresh', { method: 'POST' });
          toast(`In-game net worth: ${usd(result.wallet.netWorth)}`, 'ok');
          await refresh(true);
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    }

    const stakeBtn = $('#do-stake', root);
    if (stakeBtn) {
      stakeBtn.onclick = async () => {
        try {
          const result = await api('/stakes', {
            method: 'POST',
            body: {
              symbol: $('#stake-symbol', root).value,
              qty: Number($('#stake-qty', root).value),
              days: Number($('#stake-days', root).value),
            },
          });
          toast(`Staked ${result.stake.qty} ${result.stake.symbol} for +${result.stake.reward} coins.`, 'ok');
          await refresh(true);
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    }

    const stakeAction = (selector, path, message) =>
      $$(selector, root).forEach((btn) => {
        btn.onclick = async () => {
          try {
            await api(`/stakes/${btn.dataset.id}/${path}`, { method: 'POST' });
            toast(message, 'ok');
            await refresh(true);
          } catch (err) {
            toast(err.message, 'err');
          }
        };
      });
    stakeAction('.claim-stake', 'claim', 'Stake claimed with rewards.');
    stakeAction('.unstake', 'unstake', 'Unstaked early — reward forfeited.');
  },
};

views.create = {
  async load() {
    this.backings = await api('/backings');
  },
  render() {
    const mine = cache.market.coins.filter((c) => session && c.issuerId === session.id);
    return `
      <div><h1>🪙 Create Coin</h1><p class="muted small">Issue your own coin at ${usd(this.backings.startingPrice)} each.
        You hold the whole supply and decide who is allowed to buy in.</p></div>

      <div class="grid cols-2">
        <div class="card">
          <h2>New coin</h2>
          <label>Coin name<input id="c-name" maxlength="48" placeholder="Wallis Logistics Coin" /></label>
          <label>Symbol<input id="c-symbol" class="mono" maxlength="6" placeholder="WLC" style="text-transform:uppercase" /></label>
          <label>Backed by<select id="c-backing">
            ${this.backings.backings.map((b) => `<option value="${b.key}">${b.emoji} ${b.label}</option>`).join('')}
          </select></label>
          <label>Total supply<input id="c-supply" class="mono" type="number" min="100" max="1000000" step="100" value="1000" /></label>
          <label>Company ID (optional)<input id="c-company" placeholder="wallis-logistics" /></label>
          <p class="small muted">Give a company ID to price the coin off that company's own deliveries, revenue, vehicles and player count instead of the whole sector.</p>
          <label class="row gap" style="align-items:center">
            <input type="checkbox" id="c-approval" checked style="width:auto;margin:0" />
            <span>Approve every buyer myself</span>
          </label>
          <button id="c-create" class="btn btn-primary">Issue coin</button>
        </div>

        <div class="card">
          <h2>Launch preview</h2>
          <div class="row between"><span class="muted">Starting price</span><span class="mono" id="p-price">${usd(this.backings.startingPrice)}</span></div>
          <div class="row between"><span class="muted">Total supply</span><span class="mono" id="p-supply">1,000</span></div>
          <div class="row between"><span class="muted">Starting market cap</span><span class="mono" id="p-cap">${usd(this.backings.startingPrice * 1000)}</span></div>
          <div class="row between"><span class="muted">You could raise</span><span class="mono" id="p-goal">${usd(this.backings.startingPrice * 1000)}</span></div>
          <p class="small muted">You start holding every coin. Buyers send you a purchase request that reserves their
            money and locks the price; you approve or decline it, and approved sales pay straight into your balance.
            Unanswered requests expire after ${Math.round((cache.status?.requestTtlMs ?? 900000) / 60000)} minutes so
            nobody's funds stay locked up. The price itself follows live server data for whichever sector backs it.</p>
        </div>
      </div>

      <div class="card">
        <h2>Coins you launched</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Coin</th><th class="num">Price</th><th class="num">Sold</th><th class="num">Left to sell</th><th class="num">Raised</th><th>Pending</th><th></th></tr></thead>
          <tbody>${
            mine
              .map(
                (c) => `<tr><td>${coinCell(c)}</td><td class="num">${usd(c.price)}</td>
                  <td class="num">${c.sold.toLocaleString('en-US')} / ${c.supply.toLocaleString('en-US')}</td>
                  <td class="num">${c.available.toLocaleString('en-US')}</td>
                  <td class="num">${compact(c.raised)}</td>
                  <td>${c.pendingRequests ? `<a class="pill ico" href="#/requests">${c.pendingRequests} waiting</a>` : '<span class="muted small">none</span>'}</td>
                  <td class="num"><a class="btn btn-sm" href="#/trade/${c.symbol}">Open</a></td></tr>`,
              )
              .join('') || '<tr><td colspan="7" class="empty">You have not issued a coin yet.</td></tr>'
          }</tbody>
        </table></div>
      </div>`;
  },
  mount(root) {
    const supply = $('#c-supply', root);
    const update = () => {
      const n = Math.max(0, Number(supply.value) || 0);
      const cap = n * this.backings.startingPrice;
      $('#p-supply', root).textContent = n.toLocaleString('en-US');
      $('#p-cap', root).textContent = usd(cap);
      $('#p-goal', root).textContent = usd(cap);
    };
    supply.oninput = update;
    update();

    $('#c-create', root).onclick = async () => {
      if (!requireSession()) return;
      try {
        const result = await api('/coins', {
          method: 'POST',
          body: {
            name: $('#c-name', root).value,
            symbol: $('#c-symbol', root).value,
            backing: $('#c-backing', root).value,
            supply: Number(supply.value),
            companyId: $('#c-company', root).value.trim() || null,
            requireApproval: $('#c-approval', root).checked,
          },
        });
        toast(`${result.coin.symbol} issued — you hold all ${result.coin.supply} coins.`, 'ok');
        location.hash = `#/trade/${result.coin.symbol}`;
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  },
};

views.charts = {
  async load(symbol) {
    this.symbol = symbol ?? cache.market.coins[0]?.symbol;
    if (!this.symbol) return;
    this.history = await api(`/coins/${this.symbol}/history?range=${draft.range}&points=400`);
  },
  render() {
    const coin = coinBySymbol(this.symbol);
    if (!coin) {
      return `<h1>📊 Charts</h1><div class="card"><p class="muted">No coins to chart yet — the exchange is empty
        until a player issues one.</p><div><a class="btn btn-primary" href="#/create">🪙 Create the first coin</a></div></div>`;
    }

    return `
      <div class="row between wrap gap">
        <div><h1>📊 Charts</h1><p class="muted small">${esc(coin.name)} · ${coin.backingLabel}</p></div>
        <div class="row gap">
          <select id="chart-coin" style="min-width:220px">
            ${cache.market.coins.map((c) => `<option value="${c.symbol}" ${c.symbol === coin.symbol ? 'selected' : ''}>${c.symbol} — ${esc(c.name)}</option>`).join('')}
          </select>
          <div class="seg" id="range">
            ${['1h', '6h', '24h', '7d', 'all'].map((r) => `<button data-range="${r}" class="${draft.range === r ? 'active' : ''}">${r}</button>`).join('')}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="row between wrap">
          <div class="row gap"><span style="font-size:26px">${coin.emoji}</span>
            <div><div class="mono" style="font-size:24px">${usd(coin.price)}</div>
            <div class="delta ${dir(coin.change24h)}">${pct(coin.change24h)} · 24h</div></div>
          </div>
          <a class="btn btn-sm btn-primary" href="#/trade/${coin.symbol}">Trade ${coin.symbol}</a>
        </div>
        <div class="chart-wrap" style="height:420px"><canvas id="big-chart"></canvas><div class="chart-tip"></div></div>
      </div>

      <div class="grid cols-4">
        ${statCard('Market cap', compact(coin.marketCap))}
        ${statCard('All-time high', usd(coin.ath))}
        ${statCard('All-time low', usd(coin.atl))}
        ${statCard('Since listing', pct(coin.price / coin.startPrice - 1))}
      </div>`;
  },
  mount(root) {
    const canvas = $('#big-chart', root);
    if (canvas) attachChartHover(canvas.parentElement, drawChart(canvas, this.history?.points));

    // On an empty exchange render() draws none of these controls.
    const picker = $('#chart-coin', root);
    if (!picker) return;
    picker.onchange = (e) => {
      location.hash = `#/charts/${e.target.value}`;
    };
    $$('#range button', root).forEach((btn) => {
      btn.onclick = () => {
        draft.range = btn.dataset.range;
        render();
      };
    });
  },
};

views.news = {
  async load() {
    this.news = (await api('/news?limit=120')).news;
    this.events = await api('/events');
  },
  render() {
    const filters = ['all', 'alert', 'event', 'whale', 'listing'];
    const items = this.news.filter((n) => draft.newsFilter === 'all' || n.level === draft.newsFilter);

    return `
      <div class="row between wrap gap">
        <div><h1>📰 Crypto News</h1><p class="muted small">Generated automatically from server activity and market moves.</p></div>
        <div class="seg" id="news-filter">
          ${filters.map((f) => `<button data-filter="${f}" class="${draft.newsFilter === f ? 'active' : ''}">${f}</button>`).join('')}
        </div>
      </div>

      ${this.events.active.map((e) => `<div class="event-banner"><span class="emoji">${e.emoji}</span>
        <div><strong>${esc(e.name)}</strong><div class="small muted">${esc(e.body)} · ${e.ticksLeft} tick(s) remaining</div></div></div>`).join('')}

      <div class="card">${items.map(newsItem).join('') || '<div class="empty">Nothing here yet.</div>'}</div>`;
  },
  mount(root) {
    $$('#news-filter button', root).forEach((btn) => {
      btn.onclick = () => {
        draft.newsFilter = btn.dataset.filter;
        render();
      };
    });
  },
};

views.whales = {
  async load() {
    this.whales = (await api('/whales')).whales;
  },
  render() {
    return `
      <div><h1>🐋 Whale Tracker</h1><p class="muted small">The biggest single-coin positions on the exchange.</p></div>
      <div class="card">
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Trader</th><th>Coin</th><th class="num">Coins held</th><th class="num">Share of supply</th><th class="num">Position value</th></tr></thead>
          <tbody>${
            this.whales
              .map(
                (w, i) => `<tr>
                  <td class="mono">${i + 1}</td>
                  <td><strong>${esc(w.player)}</strong></td>
                  <td><a href="#/trade/${w.symbol}">${w.symbol}</a></td>
                  <td class="num">${w.qty.toLocaleString('en-US')}</td>
                  <td class="num">${(w.supplyShare * 100).toFixed(1)}%</td>
                  <td class="num">${compact(w.value)}</td>
                </tr>`,
              )
              .join('') || '<tr><td colspan="6" class="empty">No holdings yet.</td></tr>'
          }</tbody>
        </table></div>
      </div>`;
  },
};

views.rankings = {
  async load() {
    this.rows = (await api('/leaderboard')).leaderboard;
  },
  render() {
    const medal = (i) => ['🥇', '🥈', '🥉'][i] ?? `#${i + 1}`;
    return `
      <div><h1>🏆 Rankings</h1><p class="muted small">Richest crypto investors, by cash plus holdings.</p></div>
      <div class="grid cols-3">
        ${this.rows
          .slice(0, 3)
          .map(
            (r, i) => `<div class="card stat tight">
              <span class="label">${medal(i)} ${esc(r.name)}</span>
              <span class="value">${compact(r.total)}</span>
              <span class="small muted">${compact(r.cryptoValue)} in crypto · ${compact(r.cash)} cash</span>
            </div>`,
          )
          .join('')}
      </div>
      <div class="card">
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Trader</th><th class="num">Crypto</th><th class="num">Cash</th><th class="num">Portfolio</th></tr></thead>
          <tbody>${this.rows
            .map(
              (r, i) => `<tr${session && r.id === session.id ? ' style="background:rgba(245,165,36,0.08)"' : ''}>
                <td class="mono">${medal(i)}</td>
                <td>${esc(r.name)}${r.bot ? ' <span class="pill">NPC</span>' : ''}</td>
                <td class="num">${compact(r.cryptoValue)}</td>
                <td class="num">${compact(r.cash)}</td>
                <td class="num">${compact(r.total)}</td>
              </tr>`,
            )
            .join('')}</tbody>
        </table></div>
      </div>`;
  },
};

/** Operator-only diagnostics. Never rendered for ordinary visitors. */
function adminPanel(s) {
  const info = s.sourceInfo ?? {};
  return `
    <div class="card">
      <div class="row between"><h2>🔧 Engine diagnostics</h2><span class="pill ico">operator only</span></div>
      <div class="grid cols-2">
        <div>
          <div class="row between"><span class="muted">Data source</span><span class="mono">${esc(s.source ?? '—')}</span></div>
          <div class="row between"><span class="muted">Source healthy</span><span class="mono ${s.sourceOk ? 'up' : 'down'}">${s.sourceOk ? 'yes' : 'no'}</span></div>
          <div class="row between"><span class="muted">Ticks run</span><span class="mono">${s.tickCount}</span></div>
          <div class="row between"><span class="muted">Last tick</span><span class="mono">${s.lastTick ? timeAgo(s.lastTick) : '—'}</span></div>
          <div class="row between"><span class="muted">Live metrics</span><span class="mono">${s.metricCount}</span></div>
        </div>
        <div>
          ${
            info.charges != null
              ? `<div class="row between"><span class="muted">API charges left</span>
                   <span class="mono ${info.statsPaused ? 'down' : 'up'}">${info.charges.toLocaleString('en-US')}</span></div>
                 <div class="row between"><span class="muted">Sector stats</span>
                   <span class="mono">${info.statsPaused ? 'paused — charges low' : `${info.statsTracked?.length ?? 0} tracked`}</span></div>
                 ${
                   info.nextStat
                     ? `<div class="row between"><span class="muted">Next stat poll</span>
                          <span class="mono">${esc(info.nextStat)} in ${Math.round((info.nextStatInMs ?? 0) / 60000)}m</span></div>`
                     : ''
                 }
                 ${info.economyAge != null ? `<div class="row between"><span class="muted">economy.csv age</span><span class="mono">${Math.round(info.economyAge / 60000)}m</span></div>` : ''}`
              : '<div class="small muted">No live source metadata.</div>'
          }
        </div>
      </div>
      ${(s.sourceErrors ?? []).length ? `<div class="small down">${s.sourceErrors.map(esc).join('<br />')}</div>` : ''}
      <div class="row gap">
        <button id="force-tick" class="btn btn-sm">Run a tick now</button>
        ${s.adminAvailable ? '<button id="admin-lock" class="btn btn-sm btn-ghost">Lock again</button>' : ''}
      </div>
    </div>`;
}

views.settings = {
  render() {
    const s = cache.status;
    return `
      <div><h1>⚙️ Settings</h1></div>
      <div class="grid cols-2">
        <div class="card">
          <h2>Your account</h2>
          ${
            session
              ? `<div class="row between"><span class="muted">Trader</span><strong>${esc(session.name)}</strong></div>
                 <div class="row between"><span class="muted">Player ID</span><span class="mono">${session.id}</span></div>
                 <label>Player key (keep this to restore your wallet)<input class="mono" readonly value="${session.key}" /></label>
                 <div class="row gap">
                   <button id="copy-key" class="btn btn-sm">Copy key</button>
                   <button id="sign-out" class="btn btn-sm btn-ghost">Sign out</button>
                 </div>`
              : `<p class="muted small">Not signed in.</p>
                 <button class="btn btn-primary" data-signin>Create wallet</button>`
          }
        </div>

        <div class="card">
          <h2>Exchange</h2>
          <div class="row between"><span class="muted">Status</span><span class="mono ${s.healthy ? 'up' : 'down'}">${s.healthy ? 'live' : 'reconnecting'}</span></div>
          <div class="row between"><span class="muted">Prices update every</span><span class="mono">${Math.round(s.tickMs / 1000)}s</span></div>
          <div class="row between"><span class="muted">Coins listed</span><span class="mono">${s.coins}</span></div>
          <div class="row between"><span class="muted">Traders</span><span class="mono">${s.players}</span></div>
          <div class="row between"><span class="muted">Market spread</span><span class="mono">${(s.spread * 100).toFixed(2)}%</span></div>
          <div class="row between"><span class="muted">Request window</span><span class="mono">${Math.round(s.requestTtlMs / 60000)}m</span></div>
          <div class="row between"><span class="muted">Staking reward</span><span class="mono">${(s.staking.ratePer30Days * 100).toFixed(0)}% / 30d</span></div>
        </div>
      </div>

      ${s.admin ? adminPanel(s) : ''}

      ${
        !s.admin && s.adminAvailable
          ? `<details class="card"><summary class="muted small">Operator access</summary>
              <label style="margin-top:10px">Admin key<input id="admin-key" type="password" placeholder="paste operator key" /></label>
              <button id="admin-go" class="btn btn-sm">Unlock diagnostics</button>
            </details>`
          : ''
      }`;
  },
  mount(root) {
    const copy = $('#copy-key', root);
    if (copy) {
      copy.onclick = async () => {
        await navigator.clipboard.writeText(session.key);
        toast('Key copied to clipboard.', 'ok');
      };
      $('#sign-out', root).onclick = () => {
        saveSession(null);
        cache.wallet = null;
        toast('Signed out.');
        render();
      };
    }
    const tickBtn = $('#force-tick', root);
    if (tickBtn) {
      tickBtn.onclick = async () => {
        try {
          await api('/tick', { method: 'POST' });
          toast('Tick executed.', 'ok');
          await refresh(true);
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    }

    const unlock = $('#admin-go', root);
    if (unlock) {
      unlock.onclick = async () => {
        const key = $('#admin-key', root).value.trim();
        if (!key) return;
        adminKey = key;
        const ok = await api('/admin/verify', { method: 'POST' }).then((r) => r.admin).catch(() => false);
        if (!ok) {
          adminKey = null;
          localStorage.removeItem(ADMIN_KEY_STORE);
          toast('That key was not recognised.', 'err');
          return;
        }
        localStorage.setItem(ADMIN_KEY_STORE, key);
        toast('Diagnostics unlocked.', 'ok');
        await refresh(true);
      };
    }

    const lock = $('#admin-lock', root);
    if (lock) {
      lock.onclick = async () => {
        adminKey = null;
        localStorage.removeItem(ADMIN_KEY_STORE);
        toast('Diagnostics hidden.');
        await refresh(true);
      };
    }
  },
};

/* ------------------------------------------------------------------ chrome */

function renderChrome() {
  const status = cache.status;
  const market = cache.market;

  if (market) {
    $('#index-value').textContent = market.index.value.toLocaleString('en-US');
    const change = $('#index-change');
    change.textContent = pct(market.index.change24h);
    change.className = `delta ${dir(market.index.change24h)}`;

    $('#ticker').innerHTML = market.coins
      .slice(0, 10)
      .map(
        (c) => `<a class="tick" href="#/trade/${c.symbol}">
          <b>${c.symbol}</b><span class="px">${usd(c.price)}</span>
          <span class="delta ${dir(c.change24h)}">${pct(c.change24h)}</span>
        </a>`,
      )
      .join('');
  }

  if (status) {
    const age = Date.now() - (status.lastTick || 0);
    const level = !status.healthy ? 'down' : age > status.tickMs * 2.5 ? 'stale' : 'live';
    $('#engine-status').className = `engine ${level}`;
    // Operators see which source is feeding it; players just see that it is running.
    $('#engine-text').textContent =
      level === 'live'
        ? status.admin
          ? `live · ${status.source}`
          : 'live'
        : level === 'stale'
          ? 'updating…'
          : 'reconnecting';
  }

  // Nudge issuers when somebody is waiting on them.
  const badge = $('#request-badge');
  const waiting = cache.requests?.incoming?.filter((r) => r.status === 'pending').length ?? 0;
  badge.textContent = waiting || '';
  badge.classList.toggle('on', waiting > 0);

  const info = $('#identity-info');
  const button = $('#identity-btn');
  if (session) {
    info.innerHTML = `<strong>${esc(session.name)}</strong><span>${cache.wallet ? compact(cache.wallet.wallet.total) : '—'}</span>`;
    button.textContent = 'Wallet';
    button.onclick = () => {
      location.hash = '#/wallet';
    };
  } else {
    info.innerHTML = '<span class="muted">Not signed in</span>';
    button.textContent = 'Sign in';
    button.onclick = () => openSignin();
  }
}

/* ------------------------------------------------------------------ routing */

function currentRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return {
    name: views[parts[0]] ? parts[0] : 'dashboard',
    arg: parts[1] ? decodeURIComponent(parts[1]).toUpperCase() : undefined,
  };
}

let rendering = false;

async function render() {
  if (rendering) return;
  rendering = true;
  const { name, arg } = currentRoute();
  const view = views[name];
  const root = $('#view');

  try {
    if (view.load) await view.load(arg);
    root.innerHTML = view.render(arg);
    view.mount?.(root);
  } catch (err) {
    root.innerHTML = `<div class="card"><h2>Something went wrong</h2><p class="muted small">${esc(err.message)}</p></div>`;
  } finally {
    rendering = false;
  }

  $$('[data-signin]', root).forEach((btn) => {
    btn.onclick = openSignin;
  });
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  renderChrome();
}

/** True while the user is mid-input — re-rendering would eat their keystrokes. */
function busy() {
  const active = document.activeElement;
  return Boolean(active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) || $('#signin').open;
}

async function refresh(force = false) {
  try {
    const [status, market] = await Promise.all([api('/status'), api('/market')]);
    cache.status = status;
    cache.market = market;
    if (session) {
      cache.wallet = await api('/wallet').catch(() => null);
      if (!cache.wallet) saveSession(null); // stale key from a reset store
      else cache.requests = await api('/requests').catch(() => null);
    }
  } catch {
    if (cache.status) cache.status.sourceOk = false;
  }

  if (force || !busy()) await render();
  else renderChrome();
}

/* -------------------------------------------------------------------- boot */

/* ------------------------------------------------------------------ sign in */

const signin = { step: 'choose', profile: null, online: [], filter: '' };

function openSignin() {
  // In game the player never picks anyone — the client tells us who they are.
  signin.step = game.active ? 'ingame' : cache.status?.identity?.available ? 'choose' : 'guest';
  signin.profile = null;
  signin.filter = '';
  renderSignin();
  $('#signin').showModal();
  if (signin.step === 'choose') loadOnline();
  if (signin.step === 'ingame') {
    toGame({ type: 'getData' });
    tryGameLogin();
  }
}

async function loadOnline() {
  try {
    const payload = await api('/players/online');
    signin.online = payload.players;
    renderSignin();
  } catch (err) {
    signin.error = err.message;
    renderSignin();
  }
}

function renderSignin() {
  const body = $('#signin-body');

  if (signin.step === 'ingame') {
    const known = game.data.name || game.data.user_id;
    body.innerHTML = `
      <h2>Signing you in</h2>
      <p class="muted small">${
        known
          ? `The game says you are <strong>${esc(String(game.data.name ?? game.data.user_id))}</strong>. Linking your wallet…`
          : 'Waiting for your character details from the game client…'
      }</p>
      <div class="row gap">
        <button class="btn btn-ghost" data-close>Close</button>
        <button class="btn btn-primary" id="ingame-retry">Retry</button>
      </div>`;
    $('#ingame-retry', body).onclick = () => {
      toGame({ type: 'getData' });
      tryGameLogin();
    };
  } else if (signin.step === 'guest') {
    body.innerHTML = `
      <h2>Create a demo wallet</h2>
      <p class="muted small">The exchange is not linked to a live game server right now, so this is a
        practice wallet with ${usd(cache.status?.startingCash ?? 25000000)} of virtual buying power.</p>
      <label>Trader name<input id="guest-name" maxlength="24" placeholder="e.g. David" /></label>
      <div class="row gap">
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn btn-primary" id="guest-go">Create wallet</button>
      </div>
      <details><summary>I already have a player key</summary>
        <label>Player key<input id="restore-key" placeholder="paste your key" /></label>
        <button class="btn btn-sm" id="restore-go">Restore</button>
      </details>`;
    $('#guest-go', body).onclick = () => createGuest($('#guest-name', body).value);
    $('#restore-go', body).onclick = () => restoreKey($('#restore-key', body).value);
  } else if (signin.step === 'choose') {
    const term = signin.filter.toLowerCase();
    const matches = signin.online.filter((p) => p.name.toLowerCase().includes(term)).slice(0, 60);
    body.innerHTML = `
      <h2>Sign in with your game account</h2>
      <p class="muted small">Pick your character from the players online right now. You must be in game to link.</p>
      <label>Search<input id="online-filter" placeholder="type your name" value="${esc(signin.filter)}" /></label>
      <div id="online-list" style="max-height:260px;overflow:auto;display:flex;flex-direction:column;gap:4px">
        ${
          signin.online.length === 0
            ? `<div class="empty">${signin.error ? esc(signin.error) : 'Loading players online…'}</div>`
            : matches
                .map(
                  (p) => `<button class="btn btn-sm pick-player" data-id="${p.vrpId}" data-name="${esc(p.name)}"
                    style="justify-content:flex-start;text-align:left">${esc(p.name)}
                    <span class="muted mono" style="float:right">${p.vrpId}</span></button>`,
                )
                .join('') || '<div class="empty">No online player matches that name.</div>'
        }
      </div>
      <div class="row gap">
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn btn-ghost btn-sm" id="go-guest">Use a demo wallet instead</button>
      </div>`;

    const filter = $('#online-filter', body);
    filter.oninput = () => {
      signin.filter = filter.value;
      renderSignin();
      const again = $('#online-filter', body);
      again.focus();
      again.setSelectionRange(again.value.length, again.value.length);
    };
    $$('.pick-player', body).forEach((btn) => {
      btn.onclick = () => {
        signin.profile = { vrpId: Number(btn.dataset.id), name: btn.dataset.name };
        signin.step = 'verify';
        renderSignin();
      };
    });
    $('#go-guest', body).onclick = () => {
      signin.step = 'guest';
      renderSignin();
    };
  } else {
    body.innerHTML = `
      <h2>Prove it's you</h2>
      <p class="muted small">Signing in as <strong>${esc(signin.profile.name)}</strong>. Open your wallet in game
        and enter your <strong>cash on hand</strong> — only you can see that number.</p>
      <label>Wallet balance<input id="verify-wallet" class="mono" type="number" placeholder="e.g. 22178554" /></label>
      <div class="row gap">
        <button class="btn btn-ghost" id="verify-back">Back</button>
        <button class="btn btn-primary" id="verify-go">Link account</button>
      </div>`;
    $('#verify-back', body).onclick = () => {
      signin.step = 'choose';
      renderSignin();
    };
    $('#verify-go', body).onclick = () => confirmLink($('#verify-wallet', body).value);
    $('#verify-wallet', body).focus();
  }

  $$('[data-close]', body).forEach((btn) => {
    btn.onclick = () => $('#signin').close();
  });
}

async function createGuest(name) {
  try {
    const { player } = await api('/session', { method: 'POST', body: { name } });
    saveSession({ key: player.key, name: player.name, id: player.id });
    $('#signin').close();
    toast(`Demo wallet created with ${usd(player.cash)} to trade.`, 'ok');
    await refresh(true);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function restoreKey(key) {
  const trimmed = key.trim();
  if (!trimmed) return;
  saveSession({ key: trimmed, name: 'restoring…', id: '' });
  const wallet = await api('/wallet').catch(() => null);
  if (!wallet) {
    saveSession(null);
    toast('That key was not recognised.', 'err');
    return;
  }
  saveSession({ key: trimmed, name: wallet.wallet.name, id: wallet.wallet.id });
  $('#signin').close();
  toast(`Welcome back, ${wallet.wallet.name}.`, 'ok');
  await refresh(true);
}

async function confirmLink(wallet) {
  try {
    const result = await api('/link/confirm', {
      method: 'POST',
      body: { vrpId: signin.profile.vrpId, wallet: Number(wallet) },
    });
    saveSession({ key: result.player.key, name: result.player.name, id: result.player.id });
    $('#signin').close();
    toast(
      result.returning
        ? `Welcome back, ${result.player.name}.`
        : `Linked. Your buying power is your in-game net worth: ${compact(result.wallet.netWorth)}.`,
      'ok',
    );
    await refresh(true);
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ------------------------------------------------------- in-game user app */

/**
 * Tycoon's F1 "User Applications" system loads this page in an iframe inside the
 * game and streams the player's live state to it via postMessage — including
 * user_id, name, wallet and bank.
 *
 * That solves identity for free: the game itself says who is playing, so there is
 * no name to pick and no balance to type. The wallet figure still goes to the
 * server to be checked against the game API, because a plain browser could post
 * anything to that endpoint — and only the real client knows a player's live
 * balance. Same guarantee as the manual flow, no typing.
 */
/** Send a command to the game client. No-op in a normal browser. */
function toGame(message) {
  if (!game.active) return;
  window.parent.postMessage(message, '*');
}

function gameNotify(text) {
  toGame({ type: 'notification', text });
}

async function tryGameLogin() {
  const vrpId = Number(game.data.user_id);
  const wallet = Number(game.data.wallet);
  if (!Number.isFinite(vrpId) || vrpId <= 0 || !Number.isFinite(wallet)) return;
  if (game.linking || game.linked || session) return;

  game.linking = true;
  try {
    const result = await api('/link/confirm', {
      method: 'POST',
      body: { vrpId, wallet, name: game.data.name },
    });
    saveSession({ key: result.player.key, name: result.player.name, id: result.player.id });
    game.linked = true;
    $('#signin')?.close();
    toast(`Signed in as ${result.player.name}.`, 'ok');
    gameNotify(`Tycoon Exchange: signed in as ${result.player.name}`);
    await refresh(true);
  } catch (err) {
    // Balance drift between the client and the API is the usual cause; the next
    // wallet update from the game retries automatically.
    console.warn('[game] auto sign-in failed:', err.message);
  } finally {
    game.linking = false;
  }
}

function startGameBridge() {
  // Inside the F1 app this page is framed by the game client.
  if (window.parent === window) return;
  game.active = true;
  document.body.classList.add('in-game');

  window.addEventListener('message', (event) => {
    const payload = event.data?.data;
    if (!payload || typeof payload !== 'object') return;

    let identityChanged = false;
    for (const [key, value] of Object.entries(payload)) {
      game.data[key] = value;
      if (key === 'user_id' || key === 'wallet' || key === 'bank' || key === 'name') identityChanged = true;
    }

    if (identityChanged && !session) tryGameLogin();

    // Escape hands control back to the game without unloading the page.
    if (payload.trigger_cross !== undefined) toGame({ type: 'pin' });
  });

  // Only changed keys are pushed, so ask for the whole cache on load.
  toGame({ type: 'getData' });
  setTimeout(() => toGame({ type: 'getData' }), 1500);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toGame({ type: 'pin' });
  });
}

/** F1 menus that can template the player's id use ?id=785364. */
async function tryUrlAutoLogin() {
  const params = new URLSearchParams(location.search);
  const vrpId = params.get('id') ?? params.get('vrp');
  if (!vrpId || session) return;
  if (!cache.status?.identity?.trustUrlId) return;
  try {
    const result = await api('/link/auto', { method: 'POST', body: { vrpId: Number(vrpId) } });
    saveSession({ key: result.player.key, name: result.player.name, id: result.player.id });
    toast(`Signed in as ${result.player.name}.`, 'ok');
    await refresh(true);
  } catch (err) {
    toast(err.message, 'err');
  }
}

window.addEventListener('hashchange', render);
window.addEventListener('resize', () => {
  const { name } = currentRoute();
  if (name === 'charts' || name === 'trade') render();
});

if (!location.hash) location.hash = '#/dashboard';
startGameBridge();
await refresh(true);
await tryUrlAutoLogin();
setInterval(() => refresh(false), REFRESH_MS);
