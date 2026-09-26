# scripts/: emulator tools and browser checks

Loaded when working under `scripts/`. Everything here talks to the **local emulators** only (`demo-auction`, 127.0.0.1), never a real project; the only exception is `build-rules.mjs`, which renders rules for `npm run deploy:rules`.

## Emulator tools (need the emulators running)

- `npm run seed [-- --first-close 5m --admin you@example.com --closed --file x.yml]`: loads `data/auction.yml` (or the sample when absent) and shifts end times so the first item closes after `--first-close` (default 30m); wipes items and bids, keeps users and admins. `--admin` needs that user to have signed in once; `--admin-only <email>` only grants admin.
- `npm run smoke [-- --users 20]`: fake Google users `smoke0..(N-1)@example.com` sign in, sync profiles, run the live queries, place concurrent and sequential bids through the app's modules. Also creates the accounts the browser checks use.
- `npm run load [-- --users 100 --duration 60 --gap 10 --price 0.06]`: simulated bidders listen like the app and bid through `placeBid`; counts billed reads and projects a day's reads and cost beyond the free 50k. Emulator latency grows with listeners and doesn't reflect production.
- `npm run check`: integrity: every item's bid docs are exactly 1..bidCount and the top bid matches `currentAmount`/`highBidderUid`.
- `build-rules.mjs` (`npm run rules`): renders `firestore.rules` with `VITE_ALLOWED_DOMAINS` into `.rules/firestore.rules`; `--require` (deploy) refuses without domains.

## Browser checks (`scripts/browser/`)

Headless Chrome via puppeteer-core (the local Chrome; `CHROME_PATH` to override) and WebKit via playwright-core (`npx playwright-core install webkit` once). They drive the real app (`npm run dev` in emulator mode) and sign in through the Auth emulator's account picker.

- **All at once:** `npm run e2e:all` (starts the emulators via `firebase emulators:exec`, needs Java; what CI runs) or `npm run e2e:run` (emulators already running, e.g. `emulators:docker`). `run-all.mjs` seeds `data/auction.sample.yml` (8 lots; the same everywhere; `AUCTION_FILE` tells `e2e:admin`), runs `smoke -- --users 6`, grants `smoke0` admin, starts the dev server on 127.0.0.1:5173, reseeds before each script, runs them in order and stops the server. `E2E_SKIP=webkit,timing` skips scripts.
- **Scripts** (one at a time: emulators running, then `npm run seed`, `npm run smoke`, `npm run dev`):
  - `e2e:bidder`: grid, every card priced, bidding, dialog/URL, filters, phone width, offline banner.
  - `e2e:outbid`: two contexts. A bids (notification opt-in and sample), B outbids A: toast, notification with "another app in front", summary, "Bid again"; two rounds with A's dialog open ("You've been outbid").
  - `e2e:phone`: the whole journey at 390x844 with taps.
  - `e2e:webkit`: Safari's engine on an emulated iPhone 13: sign-in popup, bid, outbid in the open dialog, toast.
  - `e2e:killswitch` (needs the admin): the emergency stop on/off; refused bids; a reload during the stop stays signed in; recovery without reload; an open page with refused listeners goes Live again and shows a rival's bid.
  - `e2e:timing` (~2 min): moves two items' closing times and sets a 30 s anti-snipe window itself (restored after). Final-minutes highlight, a 3-minutes-fast device clock showing the same countdown, anti-sniping seen by both bidders, a dialog open through the close, the "Open" filter, "You won"/"Not won".
  - `e2e:admin` (needs the admin; **changes data**, run last): stats, bid history, All-bids CSV, +5m, End in 2m, pause, reset, import preview/apply, winners CSV, reset all.
- **Helpers** (`helpers.mjs`): `launch`, `signIn` (retries: the picker's list renders before its handlers bind), `waitForText`, `clickText`, `collectConsole`, `checker`, and emulator helpers that use the REST API as owner: `setItemEndIn`, `setAntiSnipeSeconds`, `clearKillSwitch`; `rival()` bids from Node through the app's `placeBid` (scripts that use it end with `process.exit(0)`); `cardInfo(page, lot)` (text, price, ring, pulse).

## Gotchas (all learned the hard way)

- Wait with `{ polling: 250 }`, never animation-frame polling: background pages get no frames.
- `smoke -- --users N` creates `smoke0..smoke(N-1)`; the picker lists only accounts that exist.
- Downloads (CSV exports) need **trusted clicks** (`elementHandle.click()`): Chrome blocks a second download started by a script's `element.click()`. Buttons disabled for a reason (e.g. no bids) simply do nothing.
- The emulator **never cuts open listeners**, not even on a rules change, unlike production under the emergency stop. `e2e:killswitch` gets refused listeners by flipping `auth.user` through the dev build's Pinia (`document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('auth')`) while the stop is on.
- Headless pages always report `document.hasFocus()` true and visible: simulate "another app in front" by overriding `document.hasFocus` on the page.
- Record notifications by wrapping `window.Notification` in `evaluateOnNewDocument`; grant with `browserContext().overridePermissions(origin, ['notifications'])`.
- After `Escape` on a dialog, pause ~300 ms before opening another item: the native `close` event arrives late (the app ignores a late one, but scripts that race it get confusing results).
- A dialog that's open blocks real clicks on cards behind it; close it before opening another item.
- On a phone viewport the header shows the Live dot without the word "Live".
- Emulator timestamps: under lock contention a commit's `request.time` can predate its rules evaluation by up to ~2 s (seen in load tests); correctness isn't affected.
- Scratch scripts belong outside the repo (or delete them); don't commit debugging output.
