# src/: architecture, data model, bid logic, client

Loaded when working under `src/`. Root rules in `/CLAUDE.md`; decisions and history in `docs/decisions.md`.

## Stack and hosting

- Vue 3 (`<script setup>`), Vite 8, Vue Router (hash history), Pinia, Tailwind CSS v4 (`@tailwindcss/vite`), Firebase JS SDK v12. `js-yaml` v5 has **named exports only** (`import { load } from 'js-yaml'`).
- Cloudflare Pages, direct upload from the owner's machine (not Firebase Hosting: its free transfer is tight; not GitHub Pages). `base: './'` + hash routing: no 404 fallback needed.
- `public/_headers`: noindex; no framing (`X-Frame-Options: DENY`, `frame-ancestors 'none'`); an **enforced CSP** (a new external script/API/frame host must be added there or the browser blocks it); COOP `same-origin-allow-popups` (plain `same-origin` breaks the Google sign-in popup); HSTS; Permissions-Policy; immutable caching for `/assets/*`. Expected, harmless console noise is listed in its comment (COOP `window.closed` warning during sign-in; reCAPTCHA's report-only `frame-ancestors`).
- Firebase web config comes from `.env.local` (see `.env.example`); `vite.config.js` fails a production build when a required value is missing, when `VITE_ALLOWED_DOMAINS` is malformed, or when `VITE_APPCHECK_DEBUG_TOKEN` is set.
- App Check (reCAPTCHA Enterprise via `ReCaptchaEnterpriseProvider`) is dynamically imported behind a top-level await in `firebase.js`, only when `VITE_APPCHECK_SITE_KEY` is set at build time. It is enforced for Firestore on the live project.
- `firebase.js` uses Firestore's default in-memory cache: each tab has its own connection (the Spark version shared one across tabs).
- Item images: `https://` URLs or site-relative paths into `public/` (WebP), checked on import and on render (`lib/images.js`); external images load with `referrerpolicy="no-referrer"`; a broken image falls back to a placeholder (`ItemImage.vue`). No Firebase Storage.

## Auction file (`data/auction.yml`, gitignored; `data/auction.sample.yml` is the committed 8-item example)

Format documented at the top of `lib/importItems.js` (`parseAuctionFile`): `auction:` sets title, currency, `minIncrement`, `maxIncrement`, `antiSnipeSeconds`, `endTime` (first item's close) and `stagger` (each later item closes this much later). Each `items:` entry has `id` (stable integer → doc ID `item-007`), title, subtitle, category, condition, specs (name→value map), detail, images[], `startingPrice`; items may override `endTime`, increments and currency. Every problem is reported with its item.

## Data model

```
settings/auction        { title, biddingOpen, message, minIncrement, maxIncrement|null, antiSnipeSeconds }  read: signed-in, write: admin
settings/killswitch     { since }   emergency stop: while it exists the rules refuse every non-admin request (live())
items/{item-NNN}        { order, title, subtitle, category, condition, specs[{name,value}], detail, images[],
                          currency, startingPrice, endTime, minIncrement?, maxIncrement?,
                          currentAmount, highBidderUid, bidCount, lastBidAt }
items/{id}/bids/{n}     { amount, uid, createdAt }   n = bidCount as an unpadded string; readable by owner or admin only
users/{uid}             { name, email, createdAt, lastSeen }   owner and admin; the owner may only touch lastSeen,
                        at most once a minute (write spam; the name is fixed at creation)
admins/{uid}            {}   created by hand in the Firebase console; no client writes
```

## Rules (`/firestore.rules`) and the bidding logic

- **Access:** every rule goes through `signedIn()` → `allowedEmail()`: a verified email on an allowed domain. `@example.com` is accepted only when the token's `aud` is a `demo-*` project (the emulator). `firestore.rules` is a template with `__ALLOWED_DOMAINS__`; `scripts/build-rules.mjs` renders it into gitignored `.rules/firestore.rules` (what `firebase.json` points to); unrendered it fails closed. Client side: `lib/access.js` (`parseDomains`), the `hd` hint in `firebase.js`, sign-out of other domains in `stores/auth.js`.
- **Emergency stop:** every non-admin rule also requires `live()` = `!exists(settings/killswitch)` (1 read per request); admins keep access (`live() || isAdmin()`, and can read their own `admins` doc). New requests are refused at once, and on the live site open listeners are cut too (the emulator doesn't do that).
- **A bid** (`lib/bids.js` `placeBid`) is one transaction: update the item (`currentAmount`, `highBidderUid`, `bidCount+1`, `lastBidAt = request.time`) and create `bids/{n}`. The rules cross-check both with `get`/`getAfter`, so neither can be written alone. Only those four item fields may change.
- **Increments:** the first bid ≥ `currentAmount` (the starting price); later bids ≥ `currentAmount + minIncrement` and ≤ `currentAmount + maxIncrement`; item values override settings.
- **Anti-sniping:** effective end = `max(endTime, lastBidAt + antiSnipeSeconds)`; `lastBidAt` must equal `request.time`.
- **Bid deletes** (resets) only by admins and only while `biddingOpen == false`.
- **Client mirror:** `lib/auction.js` (`validateBid`, `effectiveEnd`, `minNextBid`…) and `lib/itemView.js` (`viewFor`: status, standing winning/outbid/won/lost, min/max bid, `final` = under `FINAL_MS` 2 min). Keep them identical to the rules.
- **placeBid outcomes:**
  - If a rival commits first: the SDK retries our transaction (our check then sees the higher price) or the rules deny ours (`permission-denied`, not retried). Both become `BidError('outbid')` with the new price and minimum: via `seenBidCount` (the count the bidder saw) or by re-reading the item from the **server** (`getDocFromServer`; a listener's cache may lag). Only a *rise* in `bidCount` counts (a reset lowers it). If the new leader is the same user (quick second click, another tab/device): "You're already the highest bidder".
  - Refused on an unchanged item: retried; from the second refusal it re-reads the settings (one read): bidding off → `closed` ("Bidding is currently closed.", the same wording as the banner); within 2 s of the end → `ended` ("just closed"); otherwise retried up to 3 attempts. Even reads refused (emergency stop) → `unavailable` ("temporarily unavailable").
  - `now` is a fresh server-time estimate (`Date.now() + clockOffsetMs`), not the 1 s ticker, and it advances between attempts.
  - The leading bidder may raise their own bid (deliberate).
- **Admin writes skip the bid rules**, so admin actions that race with bidding re-check in a transaction (`applyImport`) or are refused by the rules (bid deletes while open).
- Bidders see prices, counts and the leader's uid, never names or emails (a pseudonymous history; accepted).

## Client structure

- `stores/auction.js`: while signed in, three live listeners: `settings/auction`, **all items** (`lib/items.js` `subscribeItems`, lot order) and the user's own bids (`collectionGroup` on `uid`). Every card always shows the current price.
  - A failed listener (a refusal: emergency stop, App Check, quota; the SDK handles network trouble itself) drops all three and reattaches after 5 s, 15 s, then every 60 s (`lib/retry.js`), with a banner and "Reconnecting…" in the header. Recovery counts only on a server snapshot (`fromCache` false); the items listener uses `includeMetadataChanges: true`, because a server merely confirming unchanged cached data is otherwise never reported (seen live). `attach()` cancels a pending reconnect (an account switch can't bring back the previous user's listeners).
  - After a successful bid, `noteOwnBid(id, { bidCount, amount })` shows the item as the bidder's (`ownPending`) until the item listener reaches that bid count; otherwise the "my bids" update can arrive first and the card flashes "Outbid". A rival bid that lands first overrides it.
- `stores/auth.js`: on every page load, profile sync (`lib/profile.js`: touches `lastSeen`, which doubles as a server clock sample for `clockOffsetMs`) + admin check: 2 reads, at most 1 write. If no offset could be measured (profile touched under a minute ago, or created by another device at the same moment): the last measured one (`localStorage` `auction.clockOffset`, up to 12 h), else the site's HTTP `Date` header (`httpDateOffset`, ~1 s accuracy), else 0. A refused sync (emergency stop) keeps the Google session and retries on the same schedule (`retrying`: "Reconnecting…" instead of "Sign in").
- `stores/clock.js`: one shared 1 s ticker (`useNow()`), corrected by `clockOffsetMs`.
- `views/HomeView.vue`: grid with filters (All/Open/My bids/Outbid, `matchesFilter`), search, sort. The open item lives in the URL (`#/?item=item-007`; only `item-NNN` ids accepted).
  - My-bids summary (`lib/myBids.js`): "Winning N items · total if they close now", "Outbid on N: bid again?", "You won N items: total".
  - Outbid alerts (`composables/useOutbidAlerts.js`, `components/OutbidToasts.vue`): on winning → outbid (`newlyOutbid`; only when someone else leads; never on first load; forgotten on sign-out), a toast with "Bid again", plus a browser notification when the bidder isn't looking (tab hidden or `!document.hasFocus()`) and allowed notifications. Client only: the tab must stay open.
  - Final minutes (`view.final`): amber ring, pulsing countdown, "extended" pill.
- `components/BidDialog.vue`: a native `<dialog>`. Pre-fills the minimum; raises it when outbid while open; replaces a stale green "Bid placed" with "You've been outbid. The price is now X; the minimum bid is Y." (`outbidNotice`, live); offers notifications after a successful bid and sends a sample when allowed (`showTestNotification`); ignores a late native `close` event when it is open again. On phones the bid box comes before the specs.
- `views/AdminView.vue` (`#/admin`, route-guarded; uses the same store) from `components/admin/*` on top of `lib/admin.js` (functions take `db`, so emulator tests call them directly):
  - Import: `planImport` (pure diff, warnings when an item with bids would get a new price/end/increments) then `applyImport` (settings merged so `biddingOpen`/`message` survive; a first import leaves bidding closed; one transaction per item: an item that got bids after the preview keeps its terms and is reported in `skipped`; price follows a new starting price only if the item has no bids at apply time; items deleted since the preview aren't recreated; items with bids are never removed).
  - Per item: +5m/+15m (`extendItem`, from max(effective end, now)), "End in 2m" (`endItemIn`, for trying anti-sniping), set the closing time, bid history, reset (`resetItemBids`: only while paused; deletes bids in chunks of `BATCH_SIZE` 450 and resets the item last, so an interrupted reset can be rerun).
  - Reset all bids (`resetAllBids`, `AdminResetAll.vue`), emergency stop (`AdminControls.vue`, `setKillSwitch`, `subscribeKillSwitch`), pause/open + message.
  - Exports: winners CSV and all-bids CSV (UTF-8 BOM; text cells starting with `= + - @` tab/CR get a leading `'` against formula injection). User names via `createUserCache` (one read per bidder per session). Destructive actions use the two-step `ConfirmButton`.
- `main.js`: one automatic reload when a lazy chunk fails to load after a redeploy (guarded against loops).

## Cost and abuse (Blaze)

- Reads dominate: ~22 per page load (20 items + settings + own bids); each bid costs 1 read per open tab plus ~4. The first 50k reads/day are free. The 30-minute window (400 loads, 600 bids, ~100 online) ≈ 70k reads ≈ 1 US cent.
- Rules can't rate-limit reads, and Firebase has no spending cap: a scripted signed-in client could cost roughly $0.40–$20/hour. Mitigations: domain-restricted sign-in, App Check, the `lastSeen` write limit, budget + reads-per-minute alerts (README setup), the emergency stop, disabling the account. Writes are effectively capped (bids must raise the price; profile writes 1/min; everything else admin-only).
