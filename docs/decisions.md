# Decisions, measurements and history

Why the app is the way it is. Read this before changing behaviour that looks odd: most of it is deliberate. Dates are 2026.

## Product decisions

- **The first bid may equal the starting price.** The starting price is the minimum first bid; later bids add at least the minimum increment. Standard for auctions; rules, client and tests agree.
- **The leading bidder may raise their own bid** (no "you're already winning" block). Considered and kept.
- **Pseudonymous history is accepted.** Anyone watching an item can follow its bids as amount + leader uid pairs; names and emails are never exposed to bidders.
- **Anti-sniping**: a bid in the last `antiSnipeSeconds` (120 s in the sample) keeps the item open until that long after the bid. "End in 2m" on the admin page exists to try it.
- **Bidding window**: about 30 minutes, ~600 bids, ~100 bidders online at once, all items open for bidding at the same time.
- **No backend.** No Cloud Functions or Storage: all enforcement is in the rules; alerts and notifications are client-side (the tab must stay open for notifications).

## Hosting and platform

- **Cloudflare Pages**, direct upload from the owner's machine (unlimited transfer, no build secrets in CI). Firebase Hosting's free transfer was too small; GitHub Pages was ruled out.
- **Firebase plan**: started on Spark (free, 50k reads/day hard cap). A 30-minute window with ~100 people online was projected at 43k–68k reads, so the owner moved to **Blaze** (paid) on 09-26 and asked for less complexity. The Spark design (a catalog document, per-card "on screen" watches, a reload cooldown, a shared cross-tab connection, self-repair) is preserved on the `spark` branch / tag `v1.0-spark`; `main` listens to all items instead. Blaze has no spending cap, so abuse costs money instead of causing an outage, hence the alerts and the emergency stop.
- **API key** restricted in Google Cloud to the site and the auth domain as referrers, and to Identity Toolkit, Token Service, Cloud Firestore and Firebase App Check. Preview deployment URLs are therefore blocked: always test on the main URL.
- **Only Google sign-in** is enabled; `localhost` is not an authorized domain on the live project (development uses the emulators).
- **App Check** (reCAPTCHA Enterprise) is enforced for Firestore.

## Measurements

- **Blaze version, `npm run load`, 20 items**: 20 reads per page load; each bid costs 1 read per online client + ~4. The 30-minute window (400 loads, 600 bids, 100 online) ≈ 70k reads ≈ $0.01; 1,500 bids with 100 online ≈ 170k reads, under $0.10. A realistic 10-minute run (100 bidders, 600 bids): 600 accepted = 600 stored, 0 hard failures, integrity OK.
- **Abuse**: one signed-in script can generate unlimited reads (rules can't rate-limit reads). Estimated cost ≈ $0.40/h (one loop) to ≈ $20/h (50 parallel loops) at $0.06/100k, so a $5 budget alert may take 15 min–12 h to fire and billing data can lag; a Cloud Monitoring alert on reads/minute reacts within minutes.
- **Spark version** (for reference): ~9 reads per page load; 42–99 reads per bid depending on how many cards were on screen.

## Observed on the live site (the emulator behaves differently)

- **The emergency stop cuts open listeners** on production; the emulator never does, not even on a rules change. Pages now reconnect by themselves after "Resume access".
- **A reconnect waited forever for "fresh" data**: re-attached listeners got cached data, and the server's confirmation of unchanged data is metadata-only, which `onSnapshot` doesn't report by default. Fixed with `includeMetadataChanges: true` on the items listener (metadata-only snapshots aren't billed).
- **Browser notifications silently missing**: the page created them (no console error) but Windows suppressed them (app notifications off / Do not disturb). Hence the sample notification on opt-in, and the README checklist. iPhone Safari doesn't support web notifications for sites that aren't installed as apps.
- **A stale tab after a redeploy** requested a lazy chunk that no longer existed (Pages serves `index.html` for missing files): hence the one-time automatic reload in `main.js`.

## Review history

Three rounds of three parallel reviewers (rules/logic, load/concurrency, real-browser journeys), each followed by fixes with tests:

1. **Round 1 (Spark)**: the "Open" filter hid anti-snipe-extended items; re-import could reset a live bid's price; race losers saw "Minimum bid" instead of "outbid"; the reload cooldown blocked the bid form; clock offset stuck at 0; first sign-in on two devices failed on one; the pause-before-reset guard was client-only; background tabs never paused; generic message for a bid just after the close.
2. **Round 2 (Spark)**: ended items looped on the "Open" tab; bids reset between preview and apply; items deleted between preview and apply stayed in the catalog; neutral wording for the same bidder's other device; sub-second pauses; "closed" vs "paused" wording.
3. **Round 3 (Blaze)**: coverage raised from 70% to 100% (15 new test files); clock offset lost on a quick reload; false outbid alerts after a reset and after switching accounts; header stuck on "Loading…"; the emergency stop added.

Other fixes found while testing: the first-bid "Outbid" flash (own bid shown until the listener confirms); a stale green "Bid placed" after being outbid; a late dialog `close` event closing a newly opened item; resets failing above 500 bids (batch limit); a new device with no clock offset trusting its wrong clock (HTTP Date header fallback).

Security audit (OWASP-oriented) at the start: env inlining that could leak a debug token, write-quota abuse via profile updates, image URL schemes, the `?item=` parameter, Docker context leaks, CSP/COOP/HSTS; all fixed or configured.

## Known limits

- Reads can't be rate-limited per user without moving reads behind Cloud Functions (not worth it here). Detection: alerts; response: emergency stop + disable the account (a disabled account's session stays valid up to an hour).
- Automated browser checks cover Chrome and Safari's engine (WebKit) on emulated devices, not real phones, not the real Google sign-in and not App Check: the README has a 10-minute real-device check for the dry run.
- Outbid notifications need the tab open; not on iPhone Safari.
- Emulator-only artifacts: timestamps under lock contention can predate the rules check by ~2 s; latency grows with listeners.
