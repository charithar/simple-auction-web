# tests/: unit and rules tests, coverage

Loaded when working under `tests/`. Browser (e2e) checks are in `scripts/browser/` (see `scripts/CLAUDE.md`).

## Suites

- `tests/unit/` (`npm test`): Vitest, node environment. Pure logic (`lib/*`), plus stores, composables, `firebase.js`, `main.js` and the router with Firebase/DOM replaced by `vi.mock`/`vi.stubGlobal`.
- `tests/rules/` (`npm run test:rules`, needs Java 21+; or `npm run test:docker`): the real rules on the Firestore emulator, through the app's own modules (`placeBid`, `lib/admin.js`, `lib/profile.js`, `lib/items.js`). Files: `firestore.rules.test.js` (bids, reads, users, domains), `admin.test.js` (import, resets, extend, exports), `profile.test.js`, `liveData.test.js` (the three live listeners for real), `killswitch.test.js` (emergency stop).
- `vite.config.js` `test`: `fileParallelism: false`, 20 s timeout.

## Coverage policy: 100%

`npm run test:coverage` runs both suites with v8 coverage of `src/**/*.js` (not `.vue`: components are covered by the browser checks). Keep it at **100% statements, branches, functions and lines**. If a branch can't be reached, remove it rather than exclude it (e.g. a guard for a state the code already prevents), unless the guard is real defence, then test it.

Without Java, run it in the Docker image and copy the report out (Vitest can't delete a mounted folder, so mount a different one):

```sh
docker build -q -t auction-vue-test .
mkdir -p coverage && MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD/coverage:/out" auction-vue-test \
  sh -c "npm run lint && npm run test:coverage; s=\$?; cp -r coverage/. /out/; exit \$s"
node -e "const t=require('./coverage/coverage-summary.json').total;console.log(t.statements.pct,t.branches.pct,t.functions.pct,t.lines.pct)"
```

To run new test files in the image without rebuilding it, mount the tests folder: `-v "$PWD/tests:/app/tests"`.

## Patterns

- Mock Firebase at the module boundary: `vi.mock('../../src/firebase.js', () => ({ db: {}, auth: {}, googleProvider: {}, useEmulators: false }))` and mock `lib/items.js` / `firebase/firestore` / `firebase/auth` as needed; import the module under test afterwards with `await import(...)`. See `auctionStore.test.js`, `placeBid.test.js` (scripted refusals), `authStore.test.js`.
- Pinia stores: `setActivePinia(createPinia())` per test; assign store state directly (`useAuthStore().user = { uid }`) and `await nextTick()` for watchers.
- Timers: `vi.useFakeTimers()`; `vi.advanceTimersByTimeAsync` when promises are involved; restore with `vi.useRealTimers()`.
- Browser globals in node: `vi.stubGlobal('window'|'document'|'Notification'|'fetch'|'localStorage', …)`, then `vi.unstubAllGlobals()`.
- Rules tests render the template like a deploy with a placeholder domain: `renderRules(readFileSync(RULES_TEMPLATE, 'utf8'), ['allowed.test'])`. Test users are `<name>@example.com` with `email_verified` and `sign_in_provider: 'google.com'`; the project ID is `demo-auction`.
- Seed with `env.withSecurityRulesDisabled(fn)`. **It returns nothing**: assign what you read inside the callback to an outer variable.
- To test a bid the client check would stop (late, too low), pass `now` to `placeBid` (a client clock estimate) or write the batch directly (`rawBid` in `firestore.rules.test.js`), so only the rules decide.
- User docs seeded for update tests need an old `lastSeen` (e.g. an hour ago), or the once-a-minute rule refuses the touch.
- Every fix gets a test that fails without it: temporarily undo the fix and confirm (a mutation check).
- Don't print private data in test names or fixtures; use `allowed.test`, `example.com`, `Lot a`, `Rs.`.
