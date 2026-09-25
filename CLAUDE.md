# CLAUDE.md: Vue + Firebase auction

A rewrite of `../auction-web` (React). Silent auction for about 44 items and 100 bidders, with Google sign-in. **Firebase must stay on the free Spark plan.** That means no Cloud Functions, no Cloud Storage, and no billing account. All enforcement happens in `firestore.rules`.

## Stack

- Vue 3 (`<script setup>`), Vite 8, Vue Router (hash history), Pinia, Tailwind CSS v4 (`@tailwindcss/vite`), Firebase JS SDK v12.
- `js-yaml` v5 has **named exports only**: `import { load } from 'js-yaml'`.
- Hosting is Cloudflare Pages by direct upload from the user's machine (`npm run deploy:site -- --project-name <name>`: `vite build` from `.env.local`, then `wrangler pages deploy`). Not Firebase Hosting (Spark's 360 MB/day transfer is too tight) and not GitHub Pages (the deployment is private-purpose). CI (`.github/workflows/ci.yml`) only runs tests and needs no secrets; it has a read-only token and Actions pinned to commit SHAs. `public/_headers` sets noindex, no framing (`X-Frame-Options: DENY`, `frame-ancestors 'none'` against clickjacking), an enforced CSP (a new external script/API/frame host must be added there), COOP `same-origin-allow-popups` (plain `same-origin` breaks the sign-in popup), HSTS, Permissions-Policy and immutable caching for `/assets/*`. Wrangler is a pinned dev dependency (no `npx` download at deploy time). `base: './'` together with hash routing means there's no 404 fallback to manage.
- Item images must live in `public/` as compressed WebP or on an external URL. Firebase Storage is not available on Spark. Image URLs must be `https://` or site-relative (`lib/images.js`, checked on import and on render). External images load with `referrerpolicy="no-referrer"`, and a broken image falls back to a placeholder (`ItemImage.vue`).

## Commands

- `npm run dev` / `build` / `preview` / `lint`
- `npm test`: unit tests for the pure logic (`tests/unit`)
- `npm run deploy:rules -- --project <id>`: renders the rules with `VITE_ALLOWED_DOMAINS` and deploys them (the user runs this; it contacts Firebase).
- `npm run test:rules`: Firestore rules tests on the emulator (`tests/rules`). **Requires Java 21+.** CI runs them.
- `npm run test:docker`: lint, unit and rules tests inside Docker (`Dockerfile`: Node 22, Temurin 21, emulator JAR included). Use this when Java isn't installed locally.
- `npm run emulators`: local Auth and Firestore (needs Java). `npm run emulators:docker` starts the same services in Docker; the emulator UI is at http://127.0.0.1:4000. Emulators listen on localhost only: `firebase.json` binds 127.0.0.1, and Docker uses `firebase.docker.json` (0.0.0.0 inside the container) with ports published on 127.0.0.1. Set `VITE_USE_EMULATORS=true` in `.env.local`, then run `npm run dev`.
- `npm run seed [-- --first-close 5m --admin you@example.com --closed --file x.yml]`: loads `data/auction.yml` into the running emulator (falls back to `data/auction.sample.yml` when the real file is absent). It moves the end times so the first item closes after `--first-close` (default 30m), wipes items and bids, and keeps users. `--admin` needs that emulator user to have signed in once. `--admin-only <email>` grants admin without touching items.
- `npm run load [-- --users 100 --duration 60 --gap 10 --screen 6 --mode visible|all]`: load test against the running emulators. Simulated bidders bid through `placeBid`, and the script counts billed reads and projects the daily budget.
  - `visible` (the default) mimics the app: catalog, plus live listeners for the cards on screen, favourites and own bids, with scrolling.
  - `all` is the old listen-to-everything strategy, kept for comparison.
  - **Emulator latency grows with the number of listeners and doesn't reflect production.**
- `npm run e2e:bidder | e2e:tabs | e2e:reload | e2e:admin`: headless-Chrome checks in `scripts/browser/` (puppeteer-core with the local Chrome; `CHROME_PATH`, `APP_URL` and `HEADFUL=1` are optional).
  - Setup: emulators running, then `npm run seed`, `npm run smoke` (creates `smoke0..N@example.com`) and `npm run dev`. `e2e:admin` also needs `seed -- --admin-only smoke0@example.com`, and it changes the data.
  - Sign-in goes through the Auth emulator's account picker. Its list renders before its click handlers are bound, so `signIn()` retries.
  - Wait with `polling: 250`, never animation-frame polling, because background tabs get no animation frames.
  - `tabs`/`reload` count Firestore listen targets per page (`trackListens`) to check the multi-tab sharing and the reload cooldown.
- `npm run check`: integrity check of the emulator data. For every item, the bid docs must be exactly 1..bidCount, and the top bid must match `currentAmount` and `highBidderUid`.
- `npm run smoke [-- --users 20]`: end-to-end check against the running emulators. Fake Google users sign in, profiles sync, the live queries run, and concurrent and sequential bids go through the app's own modules and the real rules.
- Firebase web config comes from `.env.local` (see `.env.example`). Builds happen only locally (CI doesn't build). `vite.config.js` fails a production build when a required value is missing, or when `VITE_APPCHECK_DEBUG_TOKEN` is set. Never commit it. Always read `import.meta.env.VITE_X` directly: a bare `import.meta.env` makes Vite inline every `VITE_*` value into the bundle.

## Auction file (`data/auction.yml`)

- **The real file is gitignored and must never be committed** (its history was purged). `data/auction.sample.yml` is the committed example; the unit test parses the sample, and `seed`/`e2e:admin` use the real file when present.

The format is documented at the top of `src/lib/importItems.js` (`parseAuctionFile`):
- The `auction:` section sets title, currency, `minIncrement`, `maxIncrement`, `antiSnipeSeconds`, `endTime` (when the first item closes) and `stagger` (each later item in list order closes this much later).
- Each entry under `items:` has `id` (stable integer; the doc ID is `item-007`), title, subtitle, category, condition, specs (a name→value map), detail, images[] and `startingPrice`. Items can override `endTime`, the increments and currency.
- `parseAuctionFile` reports every problem with the item it belongs to. The admin import (milestone 5) will reuse it.

## Data model

```
settings/auction        { title, biddingOpen, message, minIncrement, maxIncrement|null, antiSnipeSeconds }  read: signed-in, write: admin
items/{item-NNN}        { order, title, subtitle, category, condition, specs[{name,value}], detail, images[],
                          currency, startingPrice, endTime, minIncrement?, maxIncrement?,
                          currentAmount, highBidderUid, bidCount, lastBidAt }
items/{id}/bids/{n}     { amount, uid, createdAt }   n = bidCount as an unpadded string; readable by owner or admin only
catalog/items           { items: { 'item-NNN': { order, title, ..., images, startingPrice, endTime, increments? } } }
                        display data for all items in ONE doc (lib/catalog.js); read: signed-in, write: admin.
                        Rebuilt by every import; endTime is kept in sync by extend/set-end (not by anti-snipe extensions).
users/{uid}             { name, email, createdAt, lastSeen }       owner and admin; the owner may only touch lastSeen,
                        at most once a minute (guards the 20k/day write quota; name is fixed at creation)
admins/{uid}            {}   created by hand in the Firebase console; no client writes
```

- **Bid:** `src/lib/bids.js` `placeBid()` runs a transaction that updates the item and creates `bids/{n}`. The rules cross-check both documents, so neither can be written without the other.
  - If someone else's bid commits first, the rules deny ours with `permission-denied`, and the SDK does **not** retry that.
  - `placeBid` then re-reads the item from the **server** (`getDocFromServer`; a live listener's cache may lag) and throws `BidError('outbid')` with the new minimum.
  - If the item is unchanged, the denial was transient, and it retries once. The emulator's locking produces these when two bids on the same item overlap.
  - `bidErrorMessage()` maps everything else.
- **Anti-sniping:** effective end = `max(endTime, lastBidAt + antiSnipeSeconds)`. `lastBidAt` must be `request.time`, so the client can't fake the clock.
- **Increments:** first bid ≥ `currentAmount` (the starting price). Every later bid ≥ `currentAmount + minIncrement` and ≤ `currentAmount + maxIncrement`. Values set on the item override `settings/auction`.
- **Amounts are integers.** Rules check `is int`. Money is never stored as a float.
- Bidders see only the current amount and bid count. There is no public bid history and no bidder names in public documents.
- **Allowed domains** come only from the `VITE_ALLOWED_DOMAINS` env var. **Never write the real domain anywhere in the repo** (tests use `allowed.test`).
  - Every rule goes through `signedIn()` → `allowedEmail()`: a verified email on an allowed domain. `@example.com` is also accepted, but only when the token's `aud` is a `demo-*` project (emulator only).
  - `firestore.rules` is a template with `__ALLOWED_DOMAINS__`. `scripts/build-rules.mjs` (`npm run rules`, run by `emulators`/`test:rules`; `deploy:rules` adds `--require`) renders it into gitignored `.rules/firestore.rules`, which `firebase.json` points to. Unrendered it fails closed.
  - Client: `src/lib/access.js` (`parseDomains`, `ALLOWED_DOMAINS`), `hd` hint in `firebase.js`, sign-out of other domains in `stores/auth.js`. `vite.config.js` fails the build on a malformed value and warns when it's empty.
- `src/lib/auction.js` mirrors the rule logic for the UI, and `src/lib/itemView.js` derives each viewer's state (status, standing: winning/outbid/won/lost, min/max bid). **Any rule change must be made in both places**, with tests in both suites.

## Client structure

- `stores/auction.js` controls the read budget:
  - It listens to `settings/auction`, the **catalog doc** (1 read per page load) and the user's own bids (`collectionGroup` on `uid`).
  - Live `items/{id}` docs are watched per item via `watchItem(id, reason)`, reference-counted per reason: `visible` (the IntersectionObserver in `HomeView`, 400px margin), `mine` (items bid on) and `open` (`BidDialog`).
  - A released item lingers for 20 s before detaching.
  - `itemsById` merges the catalog with the live docs; `item.live === false` means there's no price yet (`pendingView`, skeleton card).
  - Everything detaches after the tab has been hidden for 3 minutes.
- **Tabs and reloads** (measured in headless Chrome):
  - With `persistentMultipleTabManager`, the tabs of one browser share **one** Firestore connection. Extra tabs and reloads while another tab is open cost 0 new listens. When the tab that owns the connection closes or reloads, another tab takes over and re-listens once.
  - The emulator never issues resume tokens, so we can't verify that production bills reloads only for changes. The design assumes it doesn't.
  - `lib/loadGuard.js` counts page loads in localStorage, shared across tabs. From the 3rd load within a minute, the store shows **cached data only** (`cached*` helpers, no reads) for 15, 30, then 60 s before listening. The header indicator (`auction.connection`) and a banner tell people refreshing isn't needed.
  - `stores/auth.js` caches the profile sync and admin check per user for 30 minutes (localStorage), saving 2 reads and 1 write per reload. Sign-out clears the cache; the rules still enforce registration and admin rights.
- The admin page does **not** use the per-item watches. `AdminView` keeps its own `subscribeItems` listener on the whole collection, because there are only a few admins.
- `firebase.js` uses `persistentLocalCache`. A listener that reattaches within 30 minutes is billed only for the items that changed.
- `HomeView.vue` renders the grid with filters (All/Open/My bids/Outbid), search, sort, and a single `useNow()` ticker. The open item is kept in the URL (`#/?item=item-007`).
- `AdminView.vue` (`#/admin`, route-guarded) is built from `components/admin/*` on top of `lib/admin.js`. The library functions take `db` so the emulator tests use them directly.
  - **Import:** `planImport` (pure diff: creates/updates/unchanged/missing, with warnings when an item that has bids gets a new price, end or increments) and then `applyImport`. Settings are merged, so `biddingOpen` and `message` survive. A first import leaves bidding **closed**. Items with bids are never removed.
  - **Per item:** +5m/+15m (`extendItem` works from max(effective end, now)), set the closing time, bid history, and `resetItemBids`, which **refuses while bidding is open** because a bid landing mid-reset would orphan a bid number.
  - **Exports:** winners CSV and all-bids CSV (one read per bid). The CSV has a UTF-8 BOM so Excel opens it correctly. Text cells starting with `= + - @` (tab/CR) get a leading `'`: bidders pick their own names, so this blocks formula injection. Numbers stay numeric.
  - User names and emails come through `createUserCache`: one read per bidder per admin session.
  - Destructive actions use the two-step `ConfirmButton` instead of `confirm()`.
- `BidDialog.vue` is a native `<dialog>`. It raises the suggested amount when someone outbids you while it's open. On phones the bid box comes before the specs.

## Free-tier budget (the main risk is reads, not cost)

- Spark allows 50k reads/day. A bid costs 1 read for each listener on *that item*, plus ~4 (transaction and rules lookups).
- **Measured** (`npm run load`, 100 bidders online, 44 items):

  | | per page load | fan-out per bid | 400 loads + 1,000 bids, 60 online |
  |---|---|---|---|
  | `--mode all` (old: everyone watches everything) | 44 | 83 | ~71k ❌ |
  | `--mode visible` (the app now) | ~9 | ~21–25 | ~21k ✅ |

- Other mitigations: detach on hidden tabs; the persistent cache (re-attaching within 30 minutes bills only changes); items are readable only when signed in; the only `bids` listener is the user's own; App Check is optional.
- The quota resets at midnight US Pacific time. Schedule the auction after the reset.

## Milestones

1. ✅ Scaffold, lint, unit tests, CI workflow
2. ✅ `firestore.rules` and emulator tests
3. ✅ Auth: `stores/auth.js`, `lib/profile.js` (user doc sync and clock offset, admin check), `stores/clock.js` (`useNow()`), `/admin` guard
4. ✅ Bidder UI: grid, bid dialog, filters/search/sort, winning/outbid badges, hidden-tab detach, persistent cache, auction file format + converter, `seed` and `smoke` scripts. Checked in headless Chrome on desktop and mobile.
5. ✅ Admin: import with a diff preview, bidding on/off and message, live table with leading bidder, bid history, extend/set closing time, reset bids (only while paused), stats, winners and all-bids CSV. Emulator tests are in `tests/rules/admin.test.js`; checked in headless Chrome.
6. ✅ Hardening:
   - Optional App Check (reCAPTCHA Enterprise, aka Fraud Defense, via `ReCaptchaEnterpriseProvider`; plain v3 is deprecated in App Check). It's dynamically imported behind a top-level await in `firebase.js`, only when `VITE_APPCHECK_SITE_KEY` is set at build time.
   - Offline banner, and bidding disabled while offline (`composables/useOnline.js`).
   - Load test.
   - README: setup, checklist, day-of runbook, budget.
8. ✅ Tabs/reload protection: shared connection across tabs (verified), reload cooldown served from cache, profile/admin check cached for 30 minutes, "Live" indicator.
7. ✅ Read budget (option B): catalog doc plus per-item live listeners for visible, bid-on and open items. About 3× less bid fan-out and about 5× cheaper page loads, measured with `npm run load`. Retry on transient denials; `npm run check` for integrity.
