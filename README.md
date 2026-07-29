# 🚛 Tycoon Crypto Exchange

A crypto exchange for Transport Tycoon. Coins are backed by real activity on the game
server — deliveries, flights, fuel sales, company revenue — and their prices move as
that activity moves. Players trade them with in-game money.

One Node process does everything: it polls the game API, runs the pricing engine,
stores price history, serves the JSON API, and serves the website. **No dependencies,
no build step, no database.**

```
Transport Tycoon API  ──▶  poller  ──▶  crypto engine  ──▶  JSON API  ──▶  website
                                            │
                                     data/store.json
```

## Run it

```bash
npm start          # http://localhost:3000
npm run dev        # same, restarts on file changes
npm run reset      # wipe the exchange and re-seed
```

It boots straight into a **synthetic Transport Tycoon economy**, so there is nothing
to configure to see it working. Point it at the real API when you have a key —
see [Connecting the live API](#connecting-the-live-api).

Copy `.env.example` to `.env` to change the port, tick rate or data source.

## How prices move

Every coin lists at exactly **$1,000,000**. After that, each tick (default 30s) the
engine polls the game and re-prices every coin:

```
drift = 0.55 × fundamentals      each driver metric vs its rolling baseline, weighted
      + 0.35 × order flow        net player buying/selling since the last tick
      + 0.06 × anchor pull       gravity toward the coin's own average and its listing price
      + event drift              an active market event, spread over its lifetime
      + noise                    so charts are never flat

new price = price × (1 + drift)     clamped to ±25% per tick
```

Each term earns its place:

- **Fundamentals** are the point of the whole thing. A coin's `drivers` map names the
  metrics it tracks and how heavily. Each metric is compared to an exponential
  baseline, so a coin reacts to *change* in activity, not the absolute number —
  a server with 12,000 deliveries a tick isn't permanently bullish, but 12,000
  after a week of 9,000 is.
- **Order flow** lets players actually move the market. It is normalised against
  circulating supply, with a floor at 5% of total supply — otherwise a freshly listed
  coin with 3 coins in circulation would swing 30% on a single trade.
- **Anchor pull** stops the price being a pure random walk. Without it, thousands of
  ticks of compounding noise send coins to $50 or $40M regardless of the economy.
  The anchor is 75% the coin's own slow-moving average and 25% its listing price, so
  trends are allowed but never permanent.

Market confidence (`HIGH` / `NEUTRAL` / `LOW`) is the sign and size of the
fundamentals score. The **Why it's moving** panel on the trade page shows the actual
driver deltas behind the latest move.

### Backing types

There are no house coins. When a player issues one they choose what backs it, and
each backing is led by its own leaderboard stat so the sectors don't move in lockstep:

| Backing | Driven by |
|---|---|
| `freight` | quarry deliveries, freight train routes, players online, money supply |
| `aero` | airline trips flown, players online, signup rate |
| `business` | houses built, millionaires, money supply, signup rate |
| `fuel` | road tolls paid, vehicles built, millionaires |
| `economy` | money, players online, millionaires, signups, **debt (inverted)** |

Driver weights may be negative — rising server debt drags the index coin down. The
"why it's moving" panel distinguishes what a metric *did* from which way it pushed
the price, so an inverted driver reads correctly instead of backwards.

A coin created with a `companyId` tracks that company's numbers. The live API has no
per-company feed, so such a coin also carries its sector's drivers at 30% weight —
otherwise it would have no signal at all and drift on noise.

> **Caveat:** Tycoon's public API exposes no fuel telemetry, so `fuel` tracks road
> tolls and vehicles built — a good proxy, not the real thing. Aviation *is* real:
> `/top10/airline_trips` is a genuine leaderboard.

## Real players, real balances

Players sign in as their actual Tycoon character. Their **real in-game net worth is
their buying power**, and the leaderboard is a real ranking of real people.

### The one hard limit

**The game API is read-only.** Every endpoint is a GET; nothing can give, take or
transfer a player's money. So the exchange *cannot* debit real dollars when someone
buys a coin, and cannot pay real dollars when they sell.

This is trading on real money, not with it:

```
real net worth (wallet + bank - loan)   ← read from the game, never written
        │
        ├── buying power on the exchange
        └── positions settle in the exchange's own ledger

        available = netWorth + realisedPnl - committed - reservedCash
```

`committed` is the cost basis of open positions; `realisedPnl` is booked on every
sale. The identity above is asserted by the test suite after every operation. When a
player earns money in game their buying power here rises automatically — and nothing
they do on the exchange can cost them a dollar in game.

### How a player signs in

**In game, sign-in is automatic.** Paste the exchange URL into the F1 *User
Applications* prompt and the game client streams the player's live state to the page
— `user_id`, `name`, `wallet`, `bank` — so it knows who is playing without anyone
picking a name or typing a balance.

The wallet figure is still checked against the game API before an account is linked.
It has to be: the same page opened in an ordinary browser could post any `user_id` it
liked, and only the real client knows a player's live balance. So the automatic path
carries exactly the same guarantee as the manual one, minus the typing.

**In a normal browser** the page has no game to talk to, so it falls back: pick your
character from the live online list and type your current wallet balance. Wrong
answers are capped at 5 per account per 10 minutes, because each check costs an API
charge and would otherwise be a way to drain the key.

Either way, linking requires the player to be **online** — `/wealth` returns 412 for
offline users, which is also what stops a stale balance being replayed later.

### Running inside the game

The page detects that it is framed by the game client and, per the
[User Applications protocol](https://cdn.tycoon.community/dev/userapp/sample.html):

- asks for the full data cache on load (`getData`), since the client otherwise sends
  only what changed;
- signs the player in as soon as `user_id` and `wallet` arrive, retrying on the next
  wallet update if the balance drifted mid-check;
- mirrors confirmations onto the game HUD, so they are readable with the app pinned;
- treats **Escape** as `pin` — control returns to the game without unloading the page,
  so a player is never trapped in the app.

None of this runs in a normal browser: the bridge only activates when the page is
actually framed.

There is also a URL-parameter path (`?id=785364`) for menus that template the id
server-side, off unless `IDENTITY_TRUST_URL_ID=true`. The in-game bridge is the
better route — prefer it.

## Player-issued coins, issuer-approved buyers

**Every coin is issued by a player, and nobody buys in without that player's
approval.** The exchange ships with no coins and no NPC traders — it is genuinely
empty until somebody creates the first one.

Issuing a coin at $1,000,000 hands the creator the entire supply as their
**treasury**. Buyers don't fill against a house order book; they ask the issuer:

```
buyer requests N coins  →  funds reserved, price locked
                        →  issuer approves  →  coins from treasury, money to issuer
                        →  issuer declines  →  funds released
                        →  nobody answers   →  expires, funds released
```

Details that matter:

- **The price is locked at request time.** The engine re-prices every coin each tick,
  so without a lock a buyer would agree to one number and pay whatever it had drifted
  to by the time the issuer looked.
- **Funds are held in escrow** the moment a request is sent, so the same money can't
  be promised to two issuers at once. Treasury coins are held the same way and can't
  be sold twice.
- **Requests expire** (default 15 minutes, `REQUEST_TTL_MS`) so an issuer who never
  answers cannot leave a buyer's money locked up indefinitely.
- **A crossing limit buy becomes a request** rather than filling — otherwise it would
  be a way around approval entirely. The over-reservation comes back on approval.
- **Selling never needs approval.** Holders can always exit; an issuer who stopped
  answering could otherwise trap everyone who bought in. Sold coins return to the
  issuer's treasury.
- **Issuers can't trade their own coin** — they already hold all of it.

Approval is per-coin: untick *"Approve every buyer myself"* when issuing to let
anyone buy freely.

## Features

**Trading** — buying is a request to the issuer; selling is immediate at the book
price plus spread and size-based slippage. Limit orders reserve your cash (or coins);
a sell fills on the tick the price crosses, a buy turns into a purchase request.

**Staking** — lock coins for 7/14/30/90 days at 5% per 30 days. Rewards are newly
minted and increase the coin's supply, so market cap stays honest. Unstake early to
get your principal back without the reward.

**Market events** — fuel shortages, shipping booms, driver strikes, crashes. Each
carries a total percentage effect spread across a few ticks rather than teleporting
the chart.

**News, whales, rankings** — headlines are generated from real state changes: moves
over 8%, trades over $50M, new coins, approved sales, new all-time highs (throttled
so a coin grinding upward doesn't post the same headline every tick). Every name on
the whale tracker and leaderboard is a real player.

## Hosting on Cloudflare

```bash
npm run cf:secrets   # prompts for TYCOON_API_KEY and ADMIN_KEY
npm run cf:deploy
npm run cf:dev       # run it locally on the real Workers runtime first
```

`wrangler.toml` covers the rest. Everything fits the **free** plan.

A Worker is request-scoped — no filesystem, no memory between requests, no
background timers — and the exchange needs all three. So the whole thing runs inside
a single **Durable Object**:

- **One instance globally**, which also makes it the serialisation point for the
  ledger. Durable Objects are single-threaded, so two players cannot approve the same
  purchase request concurrently and the in-memory state stays correct without locks.
- **An alarm drives the pricing engine**, re-arming itself each tick. Alarms can run
  faster than cron's one-minute floor; the cron trigger only pokes the object awake
  after an idle spell.
- **Storage is split in two.** Price history dominates the size but only changes on a
  tick, whereas wallets and orders change on requests. Writing everything on every
  request would burn CPU serialising megabytes that did not change, so `core` is
  written when a request dirties it and `history` only when a tick moves prices. Both
  are chunked across numbered keys, because a single stored value has a size cap far
  below what this state reaches.

The same engine code runs on both platforms. Only three things differ, and each is
behind a small seam: configuration (`configure(env)` instead of `process.env`),
persistence (`setPersistence(adapter)`), and the tick (`setInterval` vs alarm).

The admin gate behaves differently here by necessity: Cloudflare terminates TLS at
the edge, so no request ever looks like localhost. **`ADMIN_KEY` is the only way into
the diagnostics on Cloudflare** — set it or they stay locked.

## Hosting on Render

`render.yaml` covers the deployment. There is no build step — Render just runs
`node server/index.js`.

**The one thing that will bite you: Render's filesystem is wiped on every deploy and
restart.** Every coin, wallet, price history and primed stat baseline lives in
`data/store.json`, so without a persistent disk your entire market vanishes the first
time you push a change. `render.yaml` attaches a 1 GB disk at `/var/data` and points
`DATA_FILE` at it. Keep both.

Set these as secrets in the Render dashboard rather than in the committed file:

| | |
|---|---|
| `TYCOON_API_KEY` | your game API key |
| `ADMIN_KEY` | unlocks engine diagnostics (see below) |

`render.yaml` targets a **Starter instance with a 1 GB disk**, which is what makes the
market survive. `DATA_FILE` points inside the disk's mount path, and the two belong
together: a `DATA_FILE` with no disk behind it leaves the store unwritable, and a disk
with no `DATA_FILE` is never used.

Being paid also means the instance never sleeps, so prices keep moving overnight and
the API charge rotation runs around the clock. That rotation is the only thing that
spends charges — one per `TYCOON_STAT_POLL_MS`:

| Interval | Charges/day |
|---|---|
| 15 min | 96 |
| 30 min (configured) | 48 |
| 60 min | 24 |

Raise it to stretch a key further; refill in game with `/api private refill`.

**On the free plan instead:** delete the `disk:` block *and* the `DATA_FILE` variable
together, set `plan: free`, and set `TYCOON_PRIME_STATS=false`. Nothing will persist —
free services sleep when idle and restart on the next request, wiping every coin and
wallet — but the site runs, and a cold boot costs no charges.

### If the deployed site is unreachable

`ERR_CONNECTION_RESET` or a blank page means the process is not listening. Check the
Render logs for the startup banner:

```
🚛 Tycoon Crypto Exchange
   listening 0.0.0.0:10000
```

If that line is absent the process died before opening its port, and the lines above
it say why. A `[store] CANNOT WRITE …` warning is not fatal — the site still serves,
it just has no persistence.

### What players can and cannot see

The Settings page shows players only harmless facts — status, tick interval, coin
count, spread, staking rate. **Engine internals are hidden**: the data source, your
remaining API charge balance, source errors, discovered metric keys, and the manual
"run a tick" control. `POST /api/tick` and `GET /api/source/keys` return 403.

Access is deliberately closed by default:

- **`ADMIN_KEY` set** — only that key opens the diagnostics, via *Operator access* at
  the bottom of Settings. The key is kept in your browser and sent as `x-admin-key`.
- **`ADMIN_KEY` unset** — only requests from localhost see them. So local development
  shows everything, and a deployment behind Render's proxy shows nothing even if you
  forget to set the variable.

## Connecting the live API

```bash
DATA_SOURCE=tycoon
TYCOON_API_URL=https://api.tycoon.community
TYCOON_API_KEY=your-key          # in game: /api private new
```

Verified against the live API. Endpoints sit at the **root** of that host — `/alive`,
`/charges.json`, `/economy.csv`, `/players.json`, `/top10/<stat>` — and auth is the
`X-Tycoon-Key` header. Three measured facts shape the adapter:

**1. Charges are the scarce resource.** A key has a finite number of calls. Measured
costs:

| Endpoint | Cost | Used for |
|---|---|---|
| `/players.json` | **free** | players online, every tick |
| `/economy.csv` | **free** | money, debt, millionaires, signups |
| `/charges.json`, `/alive` | **free** | health and budget display |
| `/top10/<stat>` | **1 charge** | sector activity |

So the hot path is entirely free. Only sector stats cost anything, and they are
polled **one at a time, round-robin**, on their own slow timer. At the default
15-minute interval that is ~96 charges/day. Below `TYCOON_CHARGE_FLOOR` (default 100)
they stop entirely and the exchange keeps running on the free endpoints. Refill in
game with `/api private refill`.

A shorter `TYCOON_STATS` list is **not cheaper** — it refreshes each stat sooner at
the same burn rate. Four stats is a full rotation every hour.

**2. `economy.csv` is a 3 MB full-history download** — no gzip, no `Content-Length`,
and `Range` requests are silently ignored (I checked). It gains one row every 15
minutes, so it has its own poll timer and is cached in between. Polling it faster
only re-downloads 3 MB of identical data.

**3. Cumulative counters must become rates.** `/top10` returns lifetime totals, and a
number that only ever grows would read as permanently bullish. Each is converted to a
per-hour rate before the engine sees it, so what moves the price is the *change* in
activity. That needs two observations, so a cold start primes every stat once, and
those baselines are **persisted** — restarting the server costs zero charges.

`GET /api/source/keys` lists every metric currently being fed. Settings shows charges
remaining, which stat is next, and how stale `economy.csv` is. If the live API fails
entirely, the engine falls back to mock data for that tick rather than freezing.

## API

Everything the website shows is available as JSON.

| | |
|---|---|
| `GET /api/status` | engine health, tick rate, economy constants |
| `GET /api/market` | every coin plus the Tycoon Index |
| `GET /api/dashboard` | index, movers, news and trades in one call |
| `GET /api/coins/:symbol` | detail, recent trades, resting orders |
| `GET /api/coins/:symbol/history?range=1h\|6h\|24h\|7d\|all` | downsampled price points |
| `GET /api/news` · `/api/events` · `/api/trades` | feeds |
| `GET /api/whales` · `/api/leaderboard` | rankings |
| `GET /api/backings` | coin types and their driver weights |
| `GET /api/source/keys` | **operator only** — metric keys discovered from the game API |
| `GET /api/players/online` | who is in game right now (free) |
| `POST /api/link/start` | check a character is online, get the challenge |
| `POST /api/link/confirm` | prove ownership by balance, mint the session |
| `POST /api/link/auto` | claim from a URL id (needs `IDENTITY_TRUST_URL_ID`) |
| `POST /api/session` | create a demo wallet, returns a player key |
| `POST /api/quote` | price a market order without placing it |
| `POST /api/tick` | **operator only** — force a tick (handy when developing) |

Authenticated routes take an `x-player-key` header:

| | |
|---|---|
| `GET /api/wallet` | portfolio, orders, stakes, trade history |
| `POST /api/wallet/refresh` | re-read real in-game balance (1 charge) |
| `POST /api/trade` | market buy/sell |
| `POST /api/orders` · `DELETE /api/orders/:id` | limit orders |
| `POST /api/stakes` · `/:id/claim` · `/:id/unstake` | staking |
| `POST /api/coins` | issue a coin |
| `GET /api/requests` | requests waiting on you, and the ones you sent |
| `POST /api/requests` | ask an issuer to sell you coins |
| `POST /api/requests/:id/approve` · `/decline` | issuer decides |
| `POST /api/requests/:id/cancel` | buyer withdraws |

## Layout

```
server/
  index.js          HTTP server: static files + API + SPA fallback
  api.js            every REST route
  config.js         all tunables, env-driven
  store.js          JSON persistence with atomic writes
  seed.js           starting coins, traders and backfilled history
  engine/
    identity.js     real player lookup, ownership proof, live balances
    tick.js         orchestrates a tick: poll → reprice → match → news
    pricing.js      the price model
    trading.js      market orders, limit orders, matching
    coins.js        coin creation, backing templates, issuer treasury
    requests.js     purchase requests: escrow, approve, decline, expiry
    players.js      wallets, portfolios, whales, leaderboard
    staking.js      lock, claim, unstake
    events.js       market event catalog
    news.js         headline generation
  sources/
    client.js       shared API client — all charge accounting in one place
    mock.js         synthetic economy, same metric keys as live
    tycoon.js       live api.tycoon.community adapter (charge-budgeted)
public/             the website (vanilla JS, no build step)
data/store.json     persisted state, written atomically every 5s
```

## Notes on the money

Prices and cash are stored to the cent and every path reconciles. A purchase debits
the buyer exactly what the locked quote said and credits the issuer the same amount —
approved sales are a transfer between two players, not money appearing from nowhere.
Escrow is released in full on decline, withdrawal or expiry; limit buys reserve
`qty × limit` and return the difference when the fill costs less. Coins come out of a
finite issuer treasury rather than being conjured.

Staking rewards are the one exception: they are minted, and the coin's supply is
increased to match so market cap stays honest.

The invariant `available = netWorth + realisedPnl - committed - reservedCash` is
asserted by the test suite after every operation — purchase, approval, decline,
withdrawal, partial sale, order cancel and stake.
