# Auction

A silent-auction web app: Vue 3, Tailwind CSS and Firebase (Google sign-in + Firestore), hosted free on GitHub Pages. It's built to run on Firebase's **free Spark plan**: no billing account, no Cloud Functions, no Cloud Storage. Every rule that matters (bid amounts, closing times, who may do what) is enforced by Firestore security rules.

- Bidders sign in with Google, see live prices and countdowns, and get "winning" / "outbid" badges.
- Anti-sniping: a bid in the last *N* seconds keeps that item open until *N* seconds after the bid.
- Increments: a global minimum and maximum, which individual items can override.
- Admin page: import the auction file with a preview, open or pause bidding, extend or set closing times, see bid history and leading bidders, reset an item, and export winners and bids to CSV.

---

## 1. One-time setup

### Firebase project

1. In the [Firebase console](https://console.firebase.google.com/), **create a project**. Google Analytics isn't needed. Stay on the **Spark (free)** plan and never add a billing account.
2. **Authentication → Sign-in method → Google → Enable.**
3. **Authentication → Settings → Authorized domains → Add** `<your-github-user>.github.io` (plus any custom domain).
4. **Firestore Database → Create database** in production mode. Pick the location closest to your bidders, e.g. `asia-south1` (Mumbai) for Sri Lanka. **The location can't be changed later.**
5. **Project settings → Your apps → Web app (`</>`)**. Register an app and note `apiKey`, `authDomain`, `projectId` and `appId`.

### Deploy the security rules and indexes

Run this from this folder on your own machine. It signs in to your Google account and deploys only to the project you name.

```sh
npx firebase login
npx firebase deploy --only firestore:rules,firestore:indexes --project <your-project-id>
```

Re-run it whenever `firestore.rules` or `firestore.indexes.json` change. **Without the rules, the database is locked or, worse, open.**

### GitHub Pages

1. Push this folder to a GitHub repository.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Settings → Secrets and variables → Actions → Variables**: add `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID` and `VITE_FIREBASE_APP_ID` (optionally `VITE_APPCHECK_SITE_KEY`, see below). The Firebase web config isn't secret, but keeping it out of the code makes it easy to switch projects.
4. Push to `main`. The workflow runs lint, unit and rules tests, then deploys to `https://<user>.github.io/<repo>/`.

### Make yourself an admin

1. Open the site and **sign in** once.
2. Firebase console → **Authentication → Users**: copy your **User UID**.
3. **Firestore → Start collection** `admins` → document ID = *your UID* → no fields needed → Save.
4. Reload the site. An **Admin** button appears.

Only accounts listed in `admins` can import items, change settings or see bidder names. Nobody can add themselves from the app.

### Optional: App Check

App Check makes Firestore reject requests that don't come from your site, such as scripts that could burn through the free read quota.

1. Firebase console → **App Check → Apps → your web app → reCAPTCHA v3**. Create a site key for your Pages domain and register it.
2. Add the site key as the `VITE_APPCHECK_SITE_KEY` repository variable, then redeploy.
3. Watch **App Check → Firestore** metrics for a day. Once almost all requests show as *verified*, click **Enforce**.

reCAPTCHA v3's free tier comfortably covers ~100 bidders. Enforcement can block a few users with aggressive privacy extensions, so only enforce once the metrics look clean.

---

## 2. The auction file

Everything about the auction lives in [`data/auction.yml`](data/auction.yml); the format is described at the top of [`src/lib/importItems.js`](src/lib/importItems.js).

```yaml
auction:
  title: Sample Equipment Auction
  currency: Rs.
  minIncrement: 50          # each bid after the first must beat the current price by at least this
  maxIncrement: 1000        # typo guard; remove for no cap
  antiSnipeSeconds: 120
  endTime: 2026-10-31T18:00:00+05:30   # when the FIRST item closes
  stagger: 1m               # each following item closes 1 minute later
items:
  - id: 0                   # stable; don't renumber once imported
    title: HP ProDesk 400 G4
    subtitle: S/N SAMPLE0001
    category: Desktop
    condition: Used
    specs: { CPU: Core i5, RAM: 16 GB, Storage: 1 TB HDD }
    detail: Free text.
    images: [https://…]     # or images/lot-0.webp (relative, no leading slash) from public/images
    startingPrice: 6000
    # optional per item: endTime, minIncrement, maxIncrement, currency
```

- **Images:** hotlinked images can disappear. Put compressed photos (WebP, around 50–100 KB) in `public/images/` and reference them as `images/lot-0.webp`.
- **Importing:** Admin → *Import auction file* shows exactly what will be added or changed before anything is written. Bids are kept. The first import leaves bidding **paused**.
- Re-importing during the auction also re-applies the file's closing times, and the preview says so ("closing time ×44"). Change `endTime`/`stagger` in the file first, or use the per-item controls.

---

## 3. Pre-auction checklist

- [ ] Rules and indexes deployed (`npx firebase deploy --only firestore:rules,firestore:indexes`).
- [ ] Your admin account works; ideally add a second admin as a backup.
- [ ] `data/auction.yml` has the real `endTime`, prices and increments, and every image loads.
- [ ] Imported on the admin page. Check the preview, apply, then spot-check a few items on the bidder page.
- [ ] **Schedule:** Firestore's free quota resets at **midnight US Pacific time** (12:30 in Sri Lanka during US summer time, 13:30 otherwise). Run the busiest part, the closing, after the reset on the same day.
- [ ] Test on a phone. Sign-in doesn't work inside Facebook/Instagram in-app browsers, so tell bidders to open the link in Chrome or Safari.
- [ ] Do a dry run with a couple of colleagues: open bidding, place bids, try being outbid, pause, **reset those test bids** (bidding must be paused), and re-check prices.
- [ ] Decide what to post in the bidding-paused message and how you'll contact winners.

## 4. On the day

1. Admin → **Open bidding**.
2. Keep the admin page open. It shows live prices, leading bidders, bid counts and items closing soon.
3. Watch usage in Firebase console → **Firestore → Usage**. See the budget below.
4. **Problems** (wrong price, item withdrawn): *Pause bidding* with a message, fix the item (set its closing time, or reset its bids while paused), then *Open bidding*.
5. **Delays:** extend individual items with +5m/+15m, or set a new closing time in the expanded row.
6. When everything has closed: **Winners CSV** (lot, final price, winner name and email) and **All bids CSV** for the record. Then **Pause bidding**.

## 5. Free-tier budget

Spark allows **50,000 reads and 20,000 writes per day**. Writes are no concern: a bid is 2 writes. Reads are the constraint. When the quota runs out, the site stops updating until the daily reset. There's no bill, but the auction stalls.

The load test (`npm run load`: 100 simulated bidders, real rules, emulator) measured:

| What | Reads |
|---|---|
| Opening the site fresh | ~46 (one per item + settings + your bids) |
| Re-opening within 30 min | only the items that changed (local cache) |
| **Each bid** | **≈ 1 per person with the site open** + ~4 |

For example, 400 fresh page loads + 600 bids with 30 people watching on average ≈ 38k reads. The same bids with 60 people watching on average ≈ 56k, **over the quota**. The app detaches from Firestore when a tab has been hidden for 3 minutes (phones locked, other apps), so "watching" counts only people actively looking at the page. If the Usage graph approaches the limit, pausing bidding briefly does **not** help; the reads come from viewers, not bidders.

---

## 6. Development

Requires Node 22. The Firestore emulator needs Java 21+, or use Docker instead.

```sh
npm install
cp .env.example .env.local        # set VITE_USE_EMULATORS=true for local work

npm run emulators:docker          # Auth + Firestore emulators in Docker (UI: http://127.0.0.1:4000)
npm run seed -- --first-close 20m # load data/auction.yml into the emulator
npm run dev                       # http://localhost:5173 — "Sign in" shows emulator test accounts
npm run seed -- --admin-only you@example.com   # after signing in once: make that account admin

npm test                          # unit tests
npm run test:docker               # lint + unit + security-rules tests in Docker
npm run smoke -- --users 20       # end-to-end checks against the running emulators
npm run load -- --users 100       # load test + read-budget projection
```

`CLAUDE.md` describes the architecture, data model and conventions in detail.
