# Auction

A silent-auction web app: Vue 3, Tailwind CSS and Firebase (Google sign-in + Firestore), hosted free on Cloudflare Pages. It's built to run on Firebase's **free Spark plan**: no billing account, no Cloud Functions, no Cloud Storage. Every rule that matters (bid amounts, closing times, who may do what) is enforced by Firestore security rules.

- Bidders sign in with Google, see live prices and countdowns, and get "winning" / "outbid" badges.
- Anti-sniping: a bid in the last *N* seconds keeps that item open until *N* seconds after the bid.
- Increments: a global minimum and maximum, which individual items can override.
- Admin page: import the auction file with a preview, open or pause bidding, extend or set closing times, see bid history and leading bidders, reset an item, and export winners and bids to CSV.

---

## 1. One-time setup

### Firebase project

1. In the [Firebase console](https://console.firebase.google.com/), **create a project**. Google Analytics isn't needed. Stay on the **Spark (free)** plan and never add a billing account.
2. **Authentication → Sign-in method → Google → Enable.**
3. **Authentication → Settings → Authorized domains → Add** `<your-pages-project>.pages.dev` (plus any custom domain).
4. **Firestore Database → Create database** in production mode. Pick the location closest to your bidders, e.g. `asia-south1` (Mumbai) for Sri Lanka. **The location can't be changed later.**
5. **Project settings → Your apps → Web app (`</>`)**. Register an app and note `apiKey`, `authDomain`, `projectId` and `appId`.
6. **Restrict the API key.** It ships in the page by design, but restricted it only works from your site. [Google Cloud console](https://console.cloud.google.com/apis/credentials) → **APIs & Services → Credentials** → the *Browser key (auto created by Firebase)*:
   - **Application restrictions → Websites:** `https://<your-pages-project>.pages.dev/*` and `https://<project-id>.firebaseapp.com/*` (the `authDomain`; the sign-in popup runs there). Add a custom domain here too if you use one.
   - **API restrictions → Restrict key:** Identity Toolkit API, Token Service API, Cloud Firestore API, Firebase App Check API.
   - Pages preview URLs (`https://<hash>.<name>.pages.dev`) are then blocked, so always test on the main URL. A script can fake the `Referer` header, so this only stops casual reuse of the key; App Check is the real protection.

### Allowed sign-in domain

Only Google accounts on the domains in **`VITE_ALLOWED_DOMAINS`** (comma-separated, e.g. `example.org`) can use the app. The domain is never written in the repo:

- **App:** set it in `.env.local`; the site is built from there (see Cloudflare Pages below).
- **Rules:** [`firestore.rules`](firestore.rules) is a template. `npm run deploy:rules -- --project <id>` renders the domains from `.env.local` into `.rules/firestore.rules` (gitignored) and deploys that. It refuses to run with no domains. The unrendered template lets no real account in.

- The rules are the real check: any other account (or an unverified email) gets no reads or writes at all.
- The app asks Google to offer only that Workspace's accounts (`hd`), and signs out any other account with a message.
- Firebase Authentication still records an outsider who picks another account, because Spark has no blocking functions. Those users can't do anything; delete them in **Authentication → Users** if you like.
- Stronger, optional: if the Firebase project belongs to your Google Workspace organisation, set **Google Cloud console → APIs & Services → OAuth consent screen → User type: Internal**. Google then refuses other accounts before they reach Firebase.

### Deploy the security rules and indexes

Run this from this folder on your own machine. It signs in to your Google account and deploys only to the project you name.

```sh
npx firebase login
npm run deploy:rules -- --project <your-project-id>   # needs VITE_ALLOWED_DOMAINS in .env.local
```

Re-run it whenever `firestore.rules`, `firestore.indexes.json` or `VITE_ALLOWED_DOMAINS` change. **Without the rules, the database is locked or, worse, open.**

### Cloudflare Pages

The site is built on your machine from `.env.local` and uploaded directly (no git connection, so the config never goes to GitHub or Cloudflare's build servers). Free plan: unlimited bandwidth.

1. Once: `npx wrangler login`, then `npx wrangler pages project create <name> --production-branch main`.
2. Deploy (and re-deploy after any change): `npm run deploy:site -- --project-name <name>`. The build fails if a required value is missing from `.env.local`.
3. The site is at `https://<name>.pages.dev`. For a custom domain: Cloudflare dashboard → **Workers & Pages → your project → Custom domains**. Add both hosts to Firebase's authorized domains **and** to the API key's website restrictions (step 6 above); a host missing from the key fails sign-in with `API_KEY_HTTP_REFERRER_BLOCKED`.
4. `public/_headers` marks the site `noindex` and caches the hashed assets forever; `robots.txt` disallows crawling.
5. **After the auction:** delete the project in the Cloudflare dashboard (or `npx wrangler pages project delete <name>`).

GitHub Actions only runs lint, unit and rules tests; it needs no secrets.

### Make yourself an admin

1. Open the site and **sign in** once.
2. Firebase console → **Authentication → Users**: copy your **User UID**.
3. **Firestore → Start collection** `admins` → document ID = *your UID* → no fields needed → Save.
4. **Sign out and back in.** An **Admin** button appears. The app remembers each user's admin status for 30 minutes, and signing out refreshes it.

Only accounts listed in `admins` can import items, change settings or see bidder names. Nobody can add themselves from the app.

### Optional: App Check

App Check makes Firestore reject requests that don't come from your site, such as scripts that could burn through the free read quota.

1. Google Cloud console → **reCAPTCHA** (now called **Fraud Defense**) → create a **website, score-based** key for your site's domain (`<name>.pages.dev`).
   Then Firebase console → **App Check → Apps → your web app → reCAPTCHA Enterprise** and register that site key. Plain reCAPTCHA v3 is deprecated in App Check and the app uses the Enterprise provider.
2. Add the site key as `VITE_APPCHECK_SITE_KEY` in `.env.local`, then redeploy (`npm run deploy:site`).
3. Watch **App Check → Firestore** metrics for a day. Once almost all requests show as *verified*, click **Enforce**.

The free tier (10,000 assessments a month) comfortably covers ~100 bidders: App Check asks reCAPTCHA about once an hour per open browser. No billing account is needed below that. Enforcement can block a few users with aggressive privacy extensions, so only enforce once the metrics look clean.

---

## 2. The auction file

Everything about the auction lives in `data/auction.yml`. That file is **gitignored** so the real item list never lands in the repo: start from [`data/auction.sample.yml`](data/auction.sample.yml) (`cp data/auction.sample.yml data/auction.yml`) and keep your own backup. The format is described at the top of [`src/lib/importItems.js`](src/lib/importItems.js). The site doesn't need the file to build or deploy; items reach Firestore only through the admin import.

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

- [ ] Rules and indexes deployed (`npm run deploy:rules -- --project <id>`), with the same `VITE_ALLOWED_DOMAINS` as the site.
- [ ] Your admin account works; ideally add a second admin as a backup.
- [ ] API key restricted to your site and the `authDomain`, and to the four APIs (setup step 6).
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
5. **Abuse** (someone scripting reads or bids, reads climbing unusually fast): Firebase console → **Authentication → Users** → find the account → **Disable account**. It can't sign in again, but its current session keeps working for **up to an hour**, because a signed-in session stays valid until it expires and the rules don't check whether the account has been disabled. If they're bidding abusively, *Pause bidding* with a message until then.
6. **Delays:** extend individual items with +5m/+15m, or set a new closing time in the expanded row.
7. When everything has closed: **Winners CSV** (lot, final price, winner name and email) and **All bids CSV** for the record. Then **Pause bidding**.

## 5. Free-tier budget

Spark allows **50,000 reads and 20,000 writes per day**. Writes are no concern: a bid is 2 writes. Reads are the constraint. When the quota runs out, the site stops updating until the daily reset. There's no bill, but the auction stalls.

To keep reads low, the app loads all item details from **one** catalog document. It only keeps live prices for the items on your screen, the items you've bid on and the item you have open. A bid therefore only costs reads for the people actually looking at that item.

The load test (`npm run load`: 100 simulated bidders, real rules, emulator) measured:

| What | Reads |
|---|---|
| Opening the site fresh | ~9 (catalog + the cards on screen + settings) |
| Re-opening within 30 min | only what changed (local cache) |
| **Each bid** | **≈ 1 per person looking at that item** (~21–25 with 100 people online) + ~4 |

| Day (44 items) | Reads |
|---|---|
| 400 page loads, 1,000 bids, 60 people online on average | ~21k ✅ |
| 600 page loads, 1,500 bids, 100 people online all day | ~44k ✅ (close to the limit) |

**Multiple tabs and refreshing:**
- The tabs of one browser share a single connection, so extra tabs cost nothing.
- Refreshing is throttled. From the 3rd page load within a minute, the page shows the last known prices from the browser's cache and reconnects after 15, 30, then 60 seconds, with a "No need to refresh" banner. Someone hitting refresh repeatedly costs at most about one full load per minute.
- The header shows a green **Live** dot, so people can see prices update by themselves.

The app also disconnects when a tab has been hidden for 3 minutes (phones locked, other apps). If the Usage graph approaches the limit, pausing bidding does **not** help; the reads come from viewers, not bidders.

---

## 6. Development

Requires Node 22. The Firestore emulator needs Java 21+, or use Docker instead.

```sh
npm install
cp .env.example .env.local        # set VITE_USE_EMULATORS=true for local work

npm run emulators:docker          # Auth + Firestore emulators in Docker (UI: http://127.0.0.1:4000)
npm run seed -- --first-close 20m # load data/auction.yml (or the sample) into the emulator
npm run dev                       # http://localhost:5173 — "Sign in" shows emulator test accounts
npm run seed -- --admin-only you@example.com   # after signing in once: make that account admin

npm test                          # unit tests
npm run test:docker               # lint + unit + security-rules tests in Docker
npm run smoke -- --users 20       # end-to-end checks against the running emulators
npm run load -- --users 100       # load test + read-budget projection (--mode all to compare)
npm run check                     # emulator data integrity (bids vs. item state)

# Browser checks (headless Chrome via puppeteer-core; needs Chrome installed, or set CHROME_PATH).
# With emulators running, then: npm run seed, npm run smoke (creates test accounts), npm run dev
npm run e2e:bidder                # grid, live prices, bidding, dialog, filters, phone layout, offline
npm run e2e:tabs                  # extra tabs share one Firestore connection
npm run e2e:reload                # rapid reloads: cached prices + cooldown (~1.5 min)
npm run seed -- --admin-only smoke0@example.com && npm run e2e:admin   # admin page; changes data, re-seed after
# HEADFUL=1 to watch; screenshots go to test-results/browser/
```

`CLAUDE.md` describes the architecture, data model and conventions in detail.
