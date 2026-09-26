# CLAUDE.md: Vue + Firebase silent auction

A silent auction web app: about 20 items, about 100 bidders, a 30-minute bidding window, Google sign-in restricted to one organisation's domain. Vue 3 + Vite + Pinia + Tailwind v4 on the client; Firebase Auth + Firestore behind it; hosted on Cloudflare Pages. **There is no backend**: `firestore.rules` is the only server-side enforcement. A rewrite of an earlier React app (`../auction-web`).

- `main` is the **Blaze (paid plan)** version and runs the live site. The free-plan (Spark) version, with its more complex read-saving design, is kept on the `spark` branch (tag `v1.0-spark`); README §6 explains maintaining and switching between them.
- Details load when you work in a folder: `src/CLAUDE.md` (architecture, data model, bid logic, client), `tests/CLAUDE.md` (unit and rules tests, coverage), `scripts/CLAUDE.md` (seed/smoke/load, browser e2e). Design decisions, measurements, production observations and review history: `docs/decisions.md` (read it before changing behaviour that looks odd; it's probably deliberate).
- `README.md` is the owner's manual: setup, the auction file, pre-auction checklist, day-of runbook, cost, the two versions, development commands.

## Never

- **Never put private data in the repo, in commits, or in output you show**: the real sign-in domain, the Firebase project ID, the Cloudflare Pages project name, the real auction title/items/images, API keys. They live only in `.env.local`, `data/auction.yml` and `public/images/` (all gitignored; the auction file's history was purged once). Use placeholders (`<project-id>`, `<pages-project>`, `allowed.test`, `@example.com`) in code, docs and examples. When a command's output may contain them (the built bundle, deploy output, emulator data from the real file), filter or mask it before printing. Check staged diffs before committing, e.g. `git diff --cached | grep -iE '<domain>|AIza'`.
- Never commit `.env*` (except `.env.example`), `coverage/`, `dist/`, `test-results/`.
- Never build with `VITE_APPCHECK_DEBUG_TOKEN` set (the build refuses). Read env vars as `import.meta.env.VITE_X`, never a bare `import.meta.env` (Vite would inline every `VITE_*` value).
- Money is always an integer (rules check `is int`).
- A change to the bidding rules goes in **both** `firestore.rules` and the client mirror (`src/lib/auction.js`, `src/lib/itemView.js`), with tests in both suites.

## Working agreements with the owner

- The owner is an experienced developer (PHP mainly; Python/Node as needed). Be concise; no beginner explanations.
- **Ask before anything that changes remote state**: `git push`, `npm run deploy:site`, `npm run deploy:rules`, anything in GitHub/Firebase/Google Cloud/Cloudflare. Read-only remote checks are fine without asking (curl the live site's HTML/headers/bundle, the GitHub API for CI status). Never connect to AWS.
- History rewrites and force pushes: prepare the exact commands for the owner to run.
- Reproduce before fixing (instrumented logging, a small browser script), fix, then prove the new test catches the bug by temporarily undoing the fix (a mutation check).
- After deploying: confirm the live `index-*.js` name matches `dist/assets`, grep the live bundle for a marker of the change, and wait for CI on the commit (GitHub API).
- Commits: imperative subject, a body that explains why; end with the co-author trailer your harness specifies.

## Definition of done (before asking to commit/deploy)

1. `npx eslint .`
2. Unit + rules tests: `npm run test:docker` (no Java needed) or `npm test` + `npm run test:rules`.
3. Coverage stays **100%** statements/branches/functions/lines of `src/**/*.js` (`npm run test:coverage`; see `tests/CLAUDE.md` for running it in Docker).
4. The affected browser checks, or all of them: `npm run e2e:all` (needs Java) / `npm run e2e:run` (emulators already running). See `scripts/CLAUDE.md`.
5. Docs: these CLAUDE.md files, `docs/decisions.md` for decisions/observations, `README.md` for anything the owner or bidders see.

## Commands

| | |
|---|---|
| `npm run dev` / `build` / `preview` / `lint` | Vite dev server (set `VITE_USE_EMULATORS=true` in `.env.local` for local work), production build, ESLint |
| `npm test` · `npm run test:rules` · `npm run test:coverage` · `npm run test:docker` | unit tests · rules tests on the emulator (Java 21+) · both with coverage · lint+unit+rules in Docker |
| `npm run emulators` · `npm run emulators:docker` | local Auth + Firestore (Java) · the same in Docker (UI http://127.0.0.1:4000); localhost only |
| `npm run seed` · `smoke` · `load` · `check` | emulator data and checks (`scripts/CLAUDE.md`) |
| `npm run e2e:all` · `e2e:run` · `e2e:<name>` | browser checks (`scripts/CLAUDE.md`) |
| `npm run deploy:site -- --project-name <pages-project>` | builds from `.env.local`, uploads to Cloudflare Pages (Wrangler, pinned) |
| `npm run deploy:rules -- --project <project-id>` | renders `firestore.rules` with `VITE_ALLOWED_DOMAINS` (refuses without) and deploys rules + indexes |

## Deploying

- The site and the rules deploy separately. Pick the order that keeps the live site working at every moment: if new rules drop something the live site still uses, deploy the site first; if the new site needs something the new rules add, deploy the rules first. Most changes are site-only.
- Tabs opened before a deploy keep the old bundle until reloaded; a missing lazy chunk triggers one automatic reload (`src/main.js`).
- CI (`.github/workflows/ci.yml`, read-only token, Actions pinned to commit SHAs) runs lint + unit + rules tests and, in a second job, all browser checks (`npm run e2e:all`) on pushes to `main` and on pull requests (the `spark` branch has its own copy of the workflow). It needs no secrets and never builds or deploys.

## Local environment tips

- No Java? Use Docker: `npm run test:docker`, and for emulators `npm run emulators:docker`, or detached: `docker run -d --rm --name auction-emu -p 127.0.0.1:4000:4000 -p 127.0.0.1:4400:4400 -p 127.0.0.1:8080:8080 -p 127.0.0.1:9099:9099 auction-vue-test sh -c "npm run rules && npx firebase emulators:start --only firestore,auth --project demo-auction --config firebase.docker.json"` (the image comes from `docker build -t auction-vue-test .`, which `test:docker` runs; rebuild it after changing code the container should see). Stop it with `docker stop auction-emu`.
- Browser checks need Chrome (`CHROME_PATH` if not found) and, for `e2e:webkit`, `npx playwright-core install webkit` once.
- On Windows (Git Bash), multi-line edits through shell heredocs mangle backslashes in regexes; prefer the editor tool for code containing `\d`, `\s`, etc. Stop background dev servers by the PID listening on 127.0.0.1:5173.
