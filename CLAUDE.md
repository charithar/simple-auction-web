# CLAUDE.md: Vue + Firebase auction

A rewrite of `../auction-web` (React). Silent auction for about 20 items (the real `data/auction.yml`; earlier plans had 44) and 100 bidders, with Google sign-in. **Firebase is on the paid Blaze plan** (since 2026-09-26; the free-plan version with its read-budget design is kept on the `spark` branch, tag `v1.0-spark`). Keep spending low and the design simple: an auction costs a few cents in reads (see "Cost"). There are still no Cloud Functions and no Cloud Storage; all enforcement happens in `firestore.rules`.

## Stack

- Vue 3 (`<script setup>`), Vite 8, Vue Router (hash history), Pinia, Tailwind CSS v4 (`@tailwindcss/vite`), Firebase JS SDK v12.
- `js-yaml` v5 has **named exports only**: `import { load } from 'js-yaml'`.
- Hosting is Cloudflare Pages by direct upload from the user's machine (`npm run deploy:site -- --project-name <name>`: `vite build` from `.env.local`, then `wrangler pages deploy`). Not Firebase Hosting (its free 360 MB/day transfer is tight; Cloudflare's is unlimited) and not GitHub Pages (the deployment is private-purpose). CI (`.github/workflows/ci.yml`) only runs tests and needs no secrets; it has a read-only token and Actions pinned to commit SHAs. `public/_headers` sets noindex, no framing (`X-Frame-Options: DENY`, `frame-ancestors 'none'` against clickjacking), an enforced CSP (a new external script/API/frame host must be added there), COOP `same-origin-allow-popups` (plain `same-origin` breaks the sign-in popup), HSTS, Permissions-Policy and immutable caching for `/assets/*`. Wrangler is a pinned dev dependency (no `npx` download at deploy time). `base: './'` together with hash routing means there's no 404 fallback to manage.
- Item images must live in `public/` as compressed WebP or on an external URL. Firebase Storage isn't used, to keep the setup simple. Image URLs must be `https://` or site-relative (`lib/images.js`, checked on import and on render). External images load with `referrerpolicy="no-referrer"`, and a broken image falls back to a placeholder (`ItemImage.vue`).

## Commands

- `npm run dev` / `build` / `preview` / `lint`
- `npm test`: unit tests for the pure logic (`tests/unit`)
- `npm run deploy:rules -- --project <id>`: renders the rules with `VITE_ALLOWED_DOMAINS` and deploys them (the user runs this; it contacts Firebase).
- `npm run test:rules`: Firestore rules tests on the emulator (`tests/rules`). **Requires Java 21+.** CI runs them.
- `npm run test:coverage`: unit + rules suites together with v8 coverage of `src/**/*.js` (report in gitignored `coverage/`; needs Java, or run it in the Docker image and copy `coverage/` out, since Vitest can't delete a mounted folder). Kept at 100% statements/branches/functions/lines; `.vue` components are covered by the e2e scripts.
- `npm run test:docker`: lint, unit and rules tests inside Docker (`Dockerfile`: Node 22, Temurin 21, emulator JAR included). Use this when Java isn't installed locally.
- `npm run emulators`: local Auth and Firestore (needs Java). `npm run emulators:docker` starts the same services in Docker; the emulator UI is at http://127.0.0.1:4000. Emulators listen on localhost only: `firebase.json` binds 127.0.0.1, and Docker uses `firebase.docker.json` (0.0.0.0 inside the container) with ports published on 127.0.0.1. Set `VITE_USE_EMULATORS=true` in `.env.local`, then run `npm run dev`.
- `npm run seed [-- --first-close 5m --admin you@example.com --closed --file x.yml]`: loads `data/auction.yml` into the running emulator (falls back to `data/auction.sample.yml` when the real file is absent). It moves the end times so the first item closes after `--first-close` (default 30m), wipes items and bids, and keeps users. `--admin` needs that emulator user to have signed in once. `--admin-only <email>` grants admin without touching items.
- `npm run load [-- --users 100 --duration 60 --gap 10 --price 0.06]`: load test against the running emulators. Simulated bidders listen like the app (settings, all items, own bids) and bid through `placeBid` with `seenBidCount`; the script counts billed reads and projects a day's reads and cost beyond the free 50k (`--price` = USD per 100k reads for your database's location).
  - **Emulator latency grows with the number of listeners and doesn't reflect production.**
- `npm run e2e:bidder | e2e:outbid | e2e:killswitch | e2e:admin`: headless-Chrome checks in `scripts/browser/` (puppeteer-core with the local Chrome; `CHROME_PATH`, `APP_URL` and `HEADFUL=1` are optional).
  - Setup: emulators running, then `npm run seed`, `npm run smoke` (creates `smoke0..N@example.com`) and `npm run dev`. `e2e:admin` also needs `seed -- --admin-only smoke0@example.com`, and it changes the data.
  - `e2e:outbid` uses two browser contexts: A bids, B outbids A, A gets the toast and the summary updates. `e2e:killswitch` (needs the admin) turns the emergency stop on and off; it clears `settings/killswitch` through the emulator's REST API first.
  - Downloads (admin CSV exports) need real clicks (`elementHandle.click()`): Chrome blocks a second script-started download.
  - Sign-in goes through the Auth emulator's account picker. Its list renders before its click handlers are bound, so `signIn()` retries.
  - Wait with `polling: 250`, never animation-frame polling, because background tabs get no animation frames.
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
users/{uid}             { name, email, createdAt, lastSeen }       owner and admin; the owner may only touch lastSeen,
                        at most once a minute (limits write spam; name is fixed at creation)
admins/{uid}            {}   created by hand in the Firebase console; no client writes
settings/killswitch     { since }   emergency stop: while it exists the rules refuse every non-admin request (live())
```

- **Bid:** `src/lib/bids.js` `placeBid()` runs a transaction that updates the item and creates `bids/{n}`. The rules cross-check both documents, so neither can be written without the other.
  - If someone else's bid commits first, either the SDK retries our transaction (our check then sees the higher price) or the rules deny ours with `permission-denied`, which the SDK does **not** retry.
  - Both end as `BidError('outbid')` with the new price and minimum: the first because the caller passes `seenBidCount` (the bid count the bidder was looking at), the second because `placeBid` re-reads the item from the **server** (`getDocFromServer`; a live listener's cache may lag). If the new leader is the same user (a quick second click, another tab or device), the message says "You're already the highest bidder".
  - If the item is unchanged, the denial was transient, and it retries once. The emulator's locking produces these when two bids on the same item overlap. From the second denial on, it re-reads the settings (one read): bidding off → `closed` ("Bidding is currently closed.", the same wording as the page banner and `validateBid`, correct before the start and during a pause); within 2 s of the item's end → `ended` ("just closed"); otherwise the refusal has passed (e.g. a pause under a second) and it tries again, up to 3 attempts, then the original error.
  - `now` is a fresh server-time estimate (`Date.now() + clockOffsetMs`), not the 1 s ticker, and it advances between attempts.
  - `bidErrorMessage()` maps everything else.
  - The leading bidder may raise their own bid (a deliberate choice).
- **Admin writes skip the bid rules**, so admin actions that race with bidding re-check inside a transaction (`applyImport`) or are refused by the rules (bids can only be deleted while bidding is paused).
- **Anti-sniping:** effective end = `max(endTime, lastBidAt + antiSnipeSeconds)`. `lastBidAt` must be `request.time`, so the client can't fake the clock.
- **Increments:** first bid ≥ `currentAmount` (the starting price). Every later bid ≥ `currentAmount + minIncrement` and ≤ `currentAmount + maxIncrement`. Values set on the item override `settings/auction`.
- **Amounts are integers.** Rules check `is int`. Money is never stored as a float.
- Bidders see only the current amount, bid count and the leader's uid, never names or emails. Someone listening to an item can still follow its bids as amount + uid pairs, i.e. a pseudonymous history. That was accepted (2026-09-26).
- **Allowed domains** come only from the `VITE_ALLOWED_DOMAINS` env var. **Never write the real domain anywhere in the repo** (tests use `allowed.test`).
  - Every rule goes through `signedIn()` → `allowedEmail()`: a verified email on an allowed domain. `@example.com` is also accepted, but only when the token's `aud` is a `demo-*` project (emulator only).
  - `firestore.rules` is a template with `__ALLOWED_DOMAINS__`. `scripts/build-rules.mjs` (`npm run rules`, run by `emulators`/`test:rules`; `deploy:rules` adds `--require`) renders it into gitignored `.rules/firestore.rules`, which `firebase.json` points to. Unrendered it fails closed.
  - Client: `src/lib/access.js` (`parseDomains`, `ALLOWED_DOMAINS`), `hd` hint in `firebase.js`, sign-out of other domains in `stores/auth.js`. `vite.config.js` fails the build on a malformed value and warns when it's empty.
- `src/lib/auction.js` mirrors the rule logic for the UI, and `src/lib/itemView.js` derives each viewer's state (status, standing: winning/outbid/won/lost, min/max bid). **Any rule change must be made in both places**, with tests in both suites.

## Client structure

- `stores/auction.js`: while signed in, three live listeners: `settings/auction`, **all items** (`subscribeItems`, lot order) and the user's own bids (`collectionGroup` on `uid`). Every card always shows the current price; there are no per-item watches, no skeletons and no cache-only modes. Signing out detaches and clears everything. A failed listener shows a "reload" banner.
- `firebase.js` uses Firestore's default in-memory cache: each tab has its own connection.
- `stores/auth.js` syncs the profile (and measures the clock offset) and checks admin on every page load: 2 reads, at most 1 write. `clockOffsetMs: null` (profile touched under a minute ago, or created by another device at the same moment) falls back to the last measured offset (`localStorage` `auction.clockOffset`, up to 12 h old), else 0. A refused sync (`permission-denied`: emergency stop on) says the auction is temporarily unavailable.
- `HomeView.vue` renders the grid with filters (All/Open/My bids/Outbid, `matchesFilter` in `lib/itemView.js`), search, sort, and a single `useNow()` ticker. The open item is kept in the URL (`#/?item=item-007`).
  - **My bids summary** (`lib/myBids.js`): "Winning N items · total if they close now", "Outbid on N: bid again?", and after the close "You won N items: total".
  - **Outbid alerts** (`composables/useOutbidAlerts.js`, `OutbidToasts.vue`): when an item goes from winning to outbid (`newlyOutbid`; never on first load), a toast with "Bid again", plus a browser notification if the tab is in the background and the bidder allowed it (offered in `BidDialog` after a successful bid). Client only, no backend.
  - **Final minutes** (`FINAL_MS` = 2 min, `view.final`): amber ring on the card, pulsing countdown, and an "extended" pill when anti-snipe has extended the item.
- The admin page uses the same store (`auction.items`), no listener of its own.
- `AdminView.vue` (`#/admin`, route-guarded) is built from `components/admin/*` on top of `lib/admin.js`. The library functions take `db` so the emulator tests use them directly.
  - **Import:** `planImport` (pure diff: creates/updates/unchanged/missing, with warnings when an item that has bids gets a new price, end or increments) and then `applyImport`. It updates each item in a transaction: an item that received bids after the preview keeps its price, end and increments and is reported in `skipped`; the price follows a new starting price whenever the item has no bids at apply time; items deleted since the preview aren't recreated. Settings are merged, so `biddingOpen` and `message` survive. A first import leaves bidding **closed**. Items with bids are never removed.
  - **Per item:** +5m/+15m (`extendItem` works from max(effective end, now)), set the closing time, bid history, and `resetItemBids`, which **refuses while bidding is open** because a bid landing mid-reset would orphan a bid number. The rules enforce this too (bid deletes need `biddingOpen == false`).
  - **Exports:** winners CSV and all-bids CSV (one read per bid). The CSV has a UTF-8 BOM so Excel opens it correctly. Text cells starting with `= + - @` (tab/CR) get a leading `'`: bidders pick their own names, so this blocks formula injection. Numbers stay numeric.
  - User names and emails come through `createUserCache`: one read per bidder per admin session.
  - Destructive actions use the two-step `ConfirmButton` instead of `confirm()`.
- `BidDialog.vue` is a native `<dialog>`. It raises the suggested amount when someone outbids you while it's open. On phones the bid box comes before the specs.

## Cost (Blaze plan)

- Reads dominate. A page load costs ~22 reads (20 items, settings, own bids). A bid costs 1 read per open tab (every tab listens to all items) plus ~4 (transaction and rules lookups). The first 50k reads a day are free.
- **Measured** (`npm run load`, 20 items, 2026-09-26): 20 reads per page load, 1 read per bid per online bidder. Projection for the 30-minute window (400 page loads, 600 bids, ~100 online): **~70k reads, about 1 US cent** beyond the free tier; 1,500 bids with 100 online is ~170k reads, still under 10 cents.
- **Abuse now costs money instead of causing an outage:** Firebase has no hard spending cap, and rules can't rate-limit reads. One signed-in scripted client can cost roughly $0.40–$20/hour (round 3 measurement). Mitigations: items readable only when signed in on an allowed domain, App Check enforced for Firestore, the once-a-minute `lastSeen` rule, a Cloud Billing budget alert and a Monitoring alert on reads per minute (README setup), and the **emergency stop**.
- **Emergency stop** (`settings/killswitch`, rules `live()`): every non-admin rule requires `live()` (`!exists(settings/killswitch)`, 1 read per request); admins keep full access (`live() || isAdmin()`, and admins can still read their own `admins` doc). Toggled on the admin page (`AdminControls.vue`, `setKillSwitch`, `subscribeKillSwitch`) or in the console. New requests are refused at once; listeners already open are not re-checked (verified on the emulator), so open pages keep their last prices but every bid is refused, and `placeBid` reports it as `unavailable` ("temporarily unavailable") when even its reads are refused. Bidders' listener errors and refused profile syncs show the same message.

## Milestones

1. ✅ Scaffold, lint, unit tests, CI workflow
2. ✅ `firestore.rules` and emulator tests
3. ✅ Auth: `stores/auth.js`, `lib/profile.js` (user doc sync and clock offset, admin check), `stores/clock.js` (`useNow()`), `/admin` guard
4. ✅ Bidder UI: grid, bid dialog, filters/search/sort, winning/outbid badges, auction file format + converter, `seed` and `smoke` scripts. Checked in headless Chrome on desktop and mobile.
5. ✅ Admin: import with a diff preview, bidding on/off and message, live table with leading bidder, bid history, extend/set closing time, reset bids (only while paused), stats, winners and all-bids CSV. Emulator tests are in `tests/rules/admin.test.js`; checked in headless Chrome.
6. ✅ Hardening:
   - Optional App Check (reCAPTCHA Enterprise, aka Fraud Defense, via `ReCaptchaEnterpriseProvider`; plain v3 is deprecated in App Check). It's dynamically imported behind a top-level await in `firebase.js`, only when `VITE_APPCHECK_SITE_KEY` is set at build time.
   - Offline banner, and bidding disabled while offline (`composables/useOnline.js`).
   - Load test.
   - README: setup, checklist, day-of runbook, budget.
7. ✅ Read budget for the free plan: catalog doc plus per-item live listeners, reload cooldown, shared tab connection. **Replaced by 9**; kept on the `spark` branch.
8. ✅ Three-angle reviews (rules/logic, load, browser), two rounds; their fixes are in the code and tests.
9. ✅ Blaze plan: removed the read-budget machinery (catalog, visibility watches and self-repair, reload cooldown, hidden-tab pause, multi-tab persistence, profile cache); all items live. Added the My-bids summary, outbid toasts/notifications and final-minutes emphasis.
