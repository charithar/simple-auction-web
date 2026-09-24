# CLAUDE.md: Vue + Firebase auction

A rewrite of `../auction-web` (React). Silent auction for about 20 items and 100 bidders, with Google sign-in. **Firebase must stay on the free Spark plan.** That means no Cloud Functions, no Cloud Storage, and no billing account. All enforcement happens in `firestore.rules`.

## Stack

- Vue 3 (`<script setup>`), Vite 8, Vue Router (hash history), Pinia, Tailwind CSS v4 (`@tailwindcss/vite`), Firebase JS SDK v12.
- Hosting is GitHub Pages (`.github/workflows/ci.yml`), not Firebase Hosting, because Spark's 360 MB/day transfer is too tight. `base: './'` together with hash routing means there's no 404 fallback to manage.
- Item images must live in `public/` as compressed WebP or on an external URL. Firebase Storage is not available on Spark.

## Commands

- `npm run dev` / `build` / `preview` / `lint`
- `npm test`: unit tests for the pure logic (`tests/unit`)
- `npm run test:rules`: Firestore rules tests on the emulator (`tests/rules`). **Requires Java 21+.** CI runs them.
- `npm run test:docker`: lint, unit and rules tests inside Docker (`Dockerfile`: Node 22, Temurin 21, emulator JAR included). Use this when Java isn't installed locally.
- `npm run emulators`: local Auth and Firestore (needs Java). `npm run emulators:docker` starts the same services in Docker; the emulator UI is at http://127.0.0.1:4000. Set `VITE_USE_EMULATORS=true` in `.env.local`, then run `npm run dev`. To make a local admin, sign in once, then create `admins/{uid}` in the emulator UI.
- Firebase web config comes from `.env.local` (see `.env.example`). In CI it comes from repo variables. Never commit it.

## Data model

```
settings/auction        { biddingOpen, minIncrement, maxIncrement|null, antiSnipeSeconds }  read: signed-in, write: admin
items/{itemId}          { title, subtitle, detail, images[], currency, startingPrice, endTime,
                          minIncrement?, maxIncrement?,            // optional per-item overrides
                          currentAmount, highBidderUid, bidCount, lastBidAt }
items/{id}/bids/{n}     { amount, uid, createdAt }   n = bidCount as an unpadded string; readable by owner or admin only
users/{uid}             { name, email, createdAt, lastSeen }       owner and admin
admins/{uid}            {}   created by hand in the Firebase console; no client writes
```

- **Bid:** `src/lib/bids.js` `placeBid()` runs a transaction that updates the item and creates `bids/{n}`. The rules cross-check both documents, so neither can be written without the other.
- **Anti-sniping:** effective end = `max(endTime, lastBidAt + antiSnipeSeconds)`. `lastBidAt` must be `request.time`, so the client can't fake the clock.
- **Increments:** first bid ≥ `currentAmount` (the starting price). Every later bid ≥ `currentAmount + minIncrement` and ≤ `currentAmount + maxIncrement`. Values set on the item override `settings/auction`.
- **Amounts are integers.** Rules check `is int`. Money is never stored as a float.
- Bidders see only the current amount and bid count. There is no public bid history and no bidder names in public documents.
- `src/lib/auction.js` mirrors the rule logic for the UI. **Any rule change must be made in both places**, with tests in both suites.

## Free-tier budget (the main risk is reads, not cost)

- Spark allows 50k reads/day. Every bid costs about one read per open listener, so 100 listeners × 500 bids reaches the cap.
- Required mitigations: detach Firestore listeners when the tab is hidden; items are readable only when signed in; never listen on `bids` except the user's own (`collectionGroup` query filtered on `uid == me`); App Check is optional.
- The quota resets at midnight US Pacific time. Schedule the auction after the reset.

## Milestones

1. ✅ Scaffold, lint, unit tests, CI/Pages workflow
2. ✅ `firestore.rules` and emulator tests (37 passing in Docker)
3. ✅ Auth: `stores/auth.js` (Google popup sign-in, `whenReady()` for route guards), `lib/profile.js` (user doc sync and clock offset, admin check), `stores/clock.js` (shared ticker, `useNow()`), `/admin` guard
4. ⬜ Bidder UI: item grid, bid modal, one shared ticker, listeners that stop when the tab is hidden, "my bids" via `collectionGroup`
5. ⬜ Admin: YAML/JSON import (batch; warn before changing items that have bids), live table with names, bidding on/off switch, extend end time, reset bids, CSV export of winners
6. ⬜ Hardening: App Check, load test on the emulator, README and pre-auction checklist
