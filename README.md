# Auction

A silent-auction web app: Vue 3, Tailwind CSS and Firebase (Google sign-in + Firestore), hosted free on Cloudflare Pages. It runs on Firebase's **Blaze (pay-as-you-go) plan**, where an auction of ~20 items and ~100 bidders costs about a cent in reads, and uses no Cloud Functions and no Cloud Storage. (A version built for the free Spark plan, with a more complex read-saving design, is kept on the `spark` branch.) Every rule that matters (bid amounts, closing times, who may do what) is enforced by Firestore security rules.

- Bidders sign in with Google, see live prices and countdowns, and get "winning" / "outbid" badges.
- An outbid alert (toast, plus a browser notification when the bidder is in another tab or app), a "My bids" summary with totals, and highlighted final minutes.
- Anti-sniping: a bid in the last *N* seconds keeps that item open until *N* seconds after the bid.
- Increments: a global minimum and maximum, which individual items can override.
- Admin page: import the auction file with a preview, open or pause bidding, extend or set closing times, see bid history and leading bidders, reset an item, and export winners and bids to CSV.

---

## 1. One-time setup

### Firebase project

1. In the [Firebase console](https://console.firebase.google.com/), **create a project**. Google Analytics isn't needed. Upgrade it to the **Blaze** plan (Firebase console → **Upgrade**), then set up a budget alert (step 7).
2. **Authentication → Sign-in method → Google → Enable.**
3. **Authentication → Settings → Authorized domains → Add** `<your-pages-project>.pages.dev` (plus any custom domain).
4. **Firestore Database → Create database** in production mode. Pick the location closest to your bidders, e.g. `asia-south1` (Mumbai) for Sri Lanka. **The location can't be changed later.**
5. **Project settings → Your apps → Web app (`</>`)**. Register an app and note `apiKey`, `authDomain`, `projectId` and `appId`.
6. **Restrict the API key.** It ships in the page by design, but restricted it only works from your site. [Google Cloud console](https://console.cloud.google.com/apis/credentials) → **APIs & Services → Credentials** → the *Browser key (auto created by Firebase)*:
   - **Application restrictions → Websites:** `https://<your-pages-project>.pages.dev/*` and `https://<project-id>.firebaseapp.com/*` (the `authDomain`; the sign-in popup runs there). Add a custom domain here too if you use one.
   - **API restrictions → Restrict key:** Identity Toolkit API, Token Service API, Cloud Firestore API, Firebase App Check API.
   - Pages preview URLs (`https://<hash>.<name>.pages.dev`) are then blocked, so always test on the main URL. A script can fake the `Referer` header, so this only stops casual reuse of the key; App Check is the real protection.
7. **Budget alert.** Blaze has no hard spending cap, so a script abusing the site would cost money instead of hitting a limit. Google Cloud console → **Billing → Budgets & alerts → Create budget**: scope it to this project, set an amount such as $5, and keep the email alerts at 50%, 90% and 100%. A normal auction costs cents, so an alert means something is wrong (see the abuse step in the runbook).
8. **Reads alert (faster than billing).** Budget alerts can lag by hours. Google Cloud console → **Monitoring → Alerting → Create policy** → metric **Firestore Instance → Document Reads** (`firestore.googleapis.com/document/read_count`), rolling 1 minute, threshold e.g. **20,000 per minute** (the auction's busiest minute is ~1,000), notification by email. It fires within minutes of a scripted abuser starting.

### Allowed sign-in domain

Only Google accounts on the domains in **`VITE_ALLOWED_DOMAINS`** (comma-separated, e.g. `example.org`) can use the app. The domain is never written in the repo:

- **App:** set it in `.env.local`; the site is built from there (see Cloudflare Pages below).
- **Rules:** [`firestore.rules`](firestore.rules) is a template. `npm run deploy:rules -- --project <id>` renders the domains from `.env.local` into `.rules/firestore.rules` (gitignored) and deploys that. It refuses to run with no domains. The unrendered template lets no real account in.

- The rules are the real check: any other account (or an unverified email) gets no reads or writes at all.
- The app asks Google to offer only that Workspace's accounts (`hd`), and signs out any other account with a message.
- Firebase Authentication still records an outsider who picks another account, because the app uses no blocking functions. Those users can't do anything; delete them in **Authentication → Users** if you like.
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
4. **Reload the page.** An **Admin** button appears (admin status is checked on every page load).

Only accounts listed in `admins` can import items, change settings or see bidder names. Nobody can add themselves from the app.

### Optional: App Check

App Check makes Firestore reject requests that don't come from your site, such as scripts that could run up your read bill.

1. Google Cloud console → **reCAPTCHA** (now called **Fraud Defense**) → create a **website, score-based** key for your site's domain (`<name>.pages.dev`).
   Then Firebase console → **App Check → Apps → your web app → reCAPTCHA Enterprise** and register that site key. Plain reCAPTCHA v3 is deprecated in App Check and the app uses the Enterprise provider.
2. Add the site key as `VITE_APPCHECK_SITE_KEY` in `.env.local`, then redeploy (`npm run deploy:site`).
3. Watch **App Check → Firestore** metrics for a day. Once almost all requests show as *verified*, click **Enforce**.

The free tier (10,000 assessments a month) comfortably covers ~100 bidders: App Check asks reCAPTCHA about once an hour per open browser. Enforcement can block a few users with aggressive privacy extensions, so only enforce once the metrics look clean.

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
- [ ] Budget alert set up (setup step 7), and App Check enforced.
- [ ] Test on a phone. Sign-in doesn't work inside Facebook/Instagram in-app browsers, so tell bidders to open the link in Chrome or Safari.
- [ ] Do a dry run with a couple of colleagues: open bidding, place bids, try being outbid, try anti-sniping (Admin → an item's **End in 2m**, then bid in its last minute and watch the closing time move), pause, then Admin → **Reset all bids** (bidding must be paused) to put every item back to its starting price with no bids, and re-check prices. The items, closing times and bidder accounts are kept; re-import the auction file afterwards if you also want the original closing times back.
- [ ] Decide what to post in the bidding-paused message and how you'll contact winners.
- [ ] Tell bidders about outbid notifications: after their first bid the dialog offers "Notify me if I'm outbid…"; allowing it sends a sample notification at once. The auction tab must stay open (it can be in the background). No sample? Allow notifications for the browser in the computer's settings (Windows: Settings → System → Notifications; Mac: System Settings → Notifications) and turn off Do not disturb / Focus. iPhone Safari doesn't support them.

## 4. On the day

1. Admin → **Open bidding**.
2. Keep the admin page open. It shows live prices, leading bidders, bid counts and items closing soon.
3. Glance at Firebase console → **Firestore → Usage** now and then. See the cost section below for what's normal.
4. **Problems** (wrong price, item withdrawn): *Pause bidding* with a message, fix the item (set its closing time, or reset its bids while paused), then *Open bidding*. To withdraw an item, pause first: setting its closing time in the past doesn't close it if its last bid was within the anti-snipe window (2 minutes by default).
5. **Abuse** (someone scripting reads or bids, reads climbing unusually fast, or a budget/reads alert):
   - **Stop it now:** Admin → **Emergency stop → Block all bidder access** (confirm). The rules then refuse every request from anyone but admins: no reads, no bids, no sign-ins. Open pages lose their live prices and show "The auction is temporarily unavailable. This page reconnects by itself." It works even without the admin page: create a document `settings/killswitch` (any content) in the Firestore console; delete it to resume.
   - **Find and block the account:** Firebase console → **Firestore → Usage** and **Authentication → Users** (recent sign-ins) → **Disable account**. It can't sign in again, but its current session keeps working for **up to an hour** (the rules don't check whether an account is disabled), so keep the emergency stop on for that hour, or *Pause bidding* if only bids are affected.
   - **Resume:** **Resume access**. Open pages reconnect by themselves (they retry after 5 s, 15 s, then every minute), so bidders don't need to reload or sign in again.
6. **Delays:** extend individual items with +5m/+15m, or set a new closing time in the expanded row.
7. When everything has closed: **Winners CSV** (lot, final price, winner name and email) and **All bids CSV** for the record. Then **Pause bidding**.

## 5. Cost

Reads are what you pay for; writes are negligible (a bid is 2 writes). The first **50,000 reads a day are free**, and beyond that reads cost a few US cents per 100,000 (see Firestore pricing for your database's location).

Every open tab listens to all items, so every card always shows the current price. The load test (`npm run load`: simulated bidders, real rules, emulator) measured:

| What | Reads |
|---|---|
| Opening the site | ~22 (20 items, settings, your own bids) |
| **Each bid** | **1 per open tab** + ~4 (transaction and rule checks) |

| Day (20 items, measured 2026-09-26) | Reads | Cost beyond the free tier |
|---|---|---|
| 400 page loads, 600 bids, 100 people online (the 30-minute window) | ~70k | ~1 cent |
| 400 page loads, 1,000 bids, 100 online | ~112k | ~4 cents |
| 600 page loads, 1,500 bids, 100 online | ~168k | ~7 cents |

Refreshing and extra tabs cost a page load each (~22 reads), which is nothing at this scale. The real risk is abuse: someone scripting reads from a signed-in account. That's why the site requires sign-in on your domain, App Check is enforced, and the budget alert (setup step 7) tells you if something is off.

---

## 6. Two versions

The app exists in two versions. Only one is live at a time.

| | Blaze version | Spark version |
|---|---|---|
| Where | `main` branch | `spark` branch, tag `v1.0-spark` (the release as it was when frozen) |
| Firebase plan | Blaze (paid) | Spark (free); also runs on Blaze, just with fewer reads |
| How prices stay live | every tab listens to all items | a catalog document plus live listeners only for the cards on screen, your bids and the open item; reload cooldown; tabs share one connection |
| Reads for a 30-minute auction (~100 bidders, ~600 bids) | ~70k, about 1 cent | ~43k–68k, which can hit the free 50k/day limit |
| Extras | outbid toast and notification, "My bids" totals, final-minutes highlight | — |
| Rules | as below | the same, plus read access to `catalog/items` |

The live site runs `main`. CI runs the tests for pushes to both branches.

### Working on either version

```sh
git switch main      # Blaze version: normal day-to-day work
git switch spark     # Spark version: fixes only, if you'll ever go back to it
```

- **Deploy from the branch you have checked out.** `npm run deploy:site` builds whatever is in the working tree, so check `git status` first: deploying from the other branch switches the live site.
- **Fixes that apply to both** (rules, bid logic in `src/lib/bids.js` / `auction.js`, the admin import): commit on `main`, then copy to `spark` with `git switch spark && git cherry-pick <commit>`, run `npm run test:docker`, and push. The store, the home page and the bid dialog differ a lot between the versions, so expect to redo UI fixes by hand rather than cherry-pick them.
- Each branch's `CLAUDE.md` describes that branch's design.

### Switching the live site to the other version

Deploy in an order that never leaves the live site without the permissions it needs:

- **To the Spark version:**
  1. `git switch spark`.
  2. Deploy the rules first: `npm run deploy:rules -- --project <id>`. They are a superset, so the Blaze site keeps working meanwhile.
  3. `npm run deploy:site -- --project-name <name>`.
  4. On the admin page, **import the auction file once**. That rebuilds the catalog document, which the Blaze version doesn't maintain.
- **Back to the Blaze version:**
  1. `git switch main`.
  2. Deploy the site first: `npm run deploy:site -- --project-name <name>`.
  3. Then the rules: `npm run deploy:rules -- --project <id>`. They drop the catalog, which the Spark site still reads.

Tabs still open on the old version show "Lost connection… Reload" until they're reloaded. Switch before bidders arrive, not during the auction. The Firebase plan doesn't need to change: the Spark version runs fine on Blaze.

## 7. Development

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
npm run test:coverage             # unit + rules tests with coverage (needs Java; report in coverage/)
npm run smoke -- --users 20       # end-to-end checks against the running emulators
npm run load -- --users 100       # load test + reads and cost projection
npm run check                     # emulator data integrity (bids vs. item state)

# Browser checks (headless Chrome via puppeteer-core; needs Chrome installed, or set CHROME_PATH).
# With emulators running, then: npm run seed, npm run smoke (creates test accounts), npm run dev
npm run e2e:bidder                # grid, live prices, bidding, dialog, filters, phone layout, offline
npm run e2e:outbid                # two bidders: outbid toast, "Bid again", My-bids summary
npm run seed -- --admin-only smoke0@example.com && npm run e2e:killswitch   # emergency stop, as admin and bidder
npm run seed -- --admin-only smoke0@example.com && npm run e2e:admin   # admin page; changes data, re-seed after
# HEADFUL=1 to watch; screenshots go to test-results/browser/
```

`CLAUDE.md` describes the architecture, data model and conventions in detail.
