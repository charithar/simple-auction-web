# CLAUDE.md: Vue + Firebase auction

A rewrite of `../auction-web` (React). Silent auction for about 44 items and 100 bidders, with Google sign-in. **Firebase must stay on the free Spark plan.** That means no Cloud Functions, no Cloud Storage, and no billing account. All enforcement happens in `firestore.rules`.

## Stack

- Vue 3 (`<script setup>`), Vite 8, Vue Router (hash history), Pinia, Tailwind CSS v4 (`@tailwindcss/vite`), Firebase JS SDK v12.
- `js-yaml` v5 has **named exports only**: `import { load } from 'js-yaml'`.
- Hosting is GitHub Pages (`.github/workflows/ci.yml`), not Firebase Hosting, because Spark's 360 MB/day transfer is too tight. `base: './'` together with hash routing means there's no 404 fallback to manage.
- Item images must live in `public/` as compressed WebP or on an external URL. Firebase Storage is not available on Spark. External images load with `referrerpolicy="no-referrer"`, and a broken image falls back to a placeholder (`ItemImage.vue`).

## Commands

- `npm run dev` / `build` / `preview` / `lint`
- `npm test`: unit tests for the pure logic (`tests/unit`)
- `npm run test:rules`: Firestore rules tests on the emulator (`tests/rules`). **Requires Java 21+.** CI runs them.
- `npm run test:docker`: lint, unit and rules tests inside Docker (`Dockerfile`: Node 22, Temurin 21, emulator JAR included). Use this when Java isn't installed locally.
- `npm run emulators`: local Auth and Firestore (needs Java). `npm run emulators:docker` starts the same services in Docker; the emulator UI is at http://127.0.0.1:4000. Set `VITE_USE_EMULATORS=true` in `.env.local`, then run `npm run dev`.
- `npm run seed [-- --first-close 5m --admin you@example.com --closed --file x.yml]`: loads `data/auction.yml` into the running emulator. It moves the end times so the first item closes after `--first-close` (default 30m), wipes items and bids, and keeps users. `--admin` needs that emulator user to have signed in once.
- `npm run smoke [-- --users 20]`: end-to-end check against the running emulators. Fake Google users sign in, profiles sync, the live queries run, and concurrent and sequential bids go through the app's own modules and the real rules.
- Firebase web config comes from `.env.local` (see `.env.example`). In CI it comes from repo variables. Never commit it.

## Auction file (`data/auction.yml`)

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
users/{uid}             { name, email, createdAt, lastSeen }       owner and admin
admins/{uid}            {}   created by hand in the Firebase console; no client writes
```

- **Bid:** `src/lib/bids.js` `placeBid()` runs a transaction that updates the item and creates `bids/{n}`. The rules cross-check both documents, so neither can be written without the other.
  - If someone else's bid commits first, the rules deny ours with `permission-denied`, and the SDK does **not** retry that.
  - `placeBid` then re-reads the item once and throws `BidError('outbid')` with the new minimum. `bidErrorMessage()` maps everything else.
- **Anti-sniping:** effective end = `max(endTime, lastBidAt + antiSnipeSeconds)`. `lastBidAt` must be `request.time`, so the client can't fake the clock.
- **Increments:** first bid ≥ `currentAmount` (the starting price). Every later bid ≥ `currentAmount + minIncrement` and ≤ `currentAmount + maxIncrement`. Values set on the item override `settings/auction`.
- **Amounts are integers.** Rules check `is int`. Money is never stored as a float.
- Bidders see only the current amount and bid count. There is no public bid history and no bidder names in public documents.
- `src/lib/auction.js` mirrors the rule logic for the UI, and `src/lib/itemView.js` derives each viewer's state (status, standing: winning/outbid/won/lost, min/max bid). **Any rule change must be made in both places**, with tests in both suites.

## Client structure

- `stores/auction.js`: listeners on settings, items (ordered by `order`) and the user's own bids (`collectionGroup` query on `uid`). They start and stop with sign-in, and **detach after the tab has been hidden for 3 minutes**, reattaching when it's visible again.
- `firebase.js` uses `persistentLocalCache`. A listener that reattaches within 30 minutes is billed only for the items that changed.
- `HomeView.vue` renders the grid with filters (All/Open/My bids/Outbid), search, sort, and a single `useNow()` ticker. The open item is kept in the URL (`#/?item=item-007`).
- `BidDialog.vue` is a native `<dialog>`. It raises the suggested amount when someone outbids you while it's open. On phones the bid box comes before the specs.

## Free-tier budget (the main risk is reads, not cost)

- Spark allows 50k reads/day.
  - A fresh load costs about 46 reads (44 items + settings + own bids). A reload within 30 minutes costs only the changed docs.
  - Every bid costs 1 read per attached listener.
- Rough capacity: 100 users × 3 fresh loads ≈ 14k, which leaves about 35k for bid fan-out, e.g. 700 bids × 50 watchers on average.
- Mitigations: detach listeners on hidden tabs; items are readable only when signed in; the only `bids` listener is the user's own; App Check is optional.
- The quota resets at midnight US Pacific time. Schedule the auction after the reset.

## Milestones

1. ✅ Scaffold, lint, unit tests, CI/Pages workflow
2. ✅ `firestore.rules` and emulator tests
3. ✅ Auth: `stores/auth.js`, `lib/profile.js` (user doc sync and clock offset, admin check), `stores/clock.js` (`useNow()`), `/admin` guard
4. ✅ Bidder UI: grid, bid dialog, filters/search/sort, winning/outbid badges, hidden-tab detach, persistent cache, auction file format + converter, `seed` and `smoke` scripts. Checked in headless Chrome on desktop and mobile.
5. ⬜ Admin: import `auction.yml` (reuse `parseAuctionFile`; warn before changing items that have bids), live table with names, bidding on/off switch and message, extend end time, reset bids, CSV export of winners
6. ⬜ Hardening: App Check, load test (extend `scripts/smoke-emulator.mjs`), README and pre-auction checklist
