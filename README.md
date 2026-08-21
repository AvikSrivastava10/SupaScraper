# SupaScraper

A data-contract guardian for [Bright Data Scraper Studio](https://brightdata.com) collectors.

Scrapers rarely fail loudly. A site ships a redesign, extraction quietly returns nulls, and the pipeline downstream keeps running on stale or empty data. Retries do not help, because the page is reachable — the extraction logic no longer matches it.

SupaScraper watches a collector's **output contract** rather than its exit code. When a run stops satisfying that contract, it decides whether the cause is a structural break, a legitimate data change, or a transient error; asks Scraper Studio to repair the scraper; reviews the proposed fix before committing it; and re-verifies the result with the **same Collector ID** before any data reaches the downstream product.

> Same Collector ID. Same data contract. No downstream code change.

## Project status

Built for the WeMakeDevs "Into the Scrape-Verse" hackathon (17–23 August 2026). This is work in progress, and the table below reflects what is actually verified rather than what is planned.

| Area | Status |
|---|---|
| Bright Data CLI capability audit | Verified against CLI `0.3.5` |
| Controlled target site with switchable failure scenarios | Implemented, durable across restarts |
| Public deployment of the target | Configuration ready, not yet deployed |
| Scrapes a real site we do not control | Verified; 11 books from books.toscrape.com |
| Monitors several sites at once | Verified; per-target history, guards, and dashboard |
| Break, heal, approve, recover against a live collector | Verified end to end; recovered data byte-identical to baseline |
| Collector integration inside the app | Adapter deliberately fails closed; not wired into the running server yet |
| Contract validation and run classification | Implemented and unit-tested |
| Unattended heal → review → approve → verify | Verified live; a real break repaired itself and rows went 0/0 to 3/3 |
| Tells a data change from a broken extraction | Verified live; changed prices published without any repair |
| Gemini second opinion | Implemented and unit-tested; needs `GEMINI_API_KEY` to run live |
| Scheduled unattended runs | Implemented, opt-in, five-minute floor |
| Dashboard | Catalog, status, freshness, repair timeline, generated prompt |
| Automated test suite | 197 tests, no test framework dependency |

Automatic repair is off unless `SUPASCRAPER_AUTO_HEAL=true`, and the repair dependencies are only assembled when it is enabled, so no accidental code path can mutate a hosted collector.

The Bright Data adapter intentionally throws rather than pretending to work, so nothing can silently report a fake repair.

## How it fits together

```text
Public controlled target  ──scraped by──▶  Bright Data collector (c_*)
                                                    │ structured JSON
                                                    ▼
                                          SupaScraper orchestrator
                                          ├─ contract profiler
                                          ├─ deterministic detector
                                          ├─ optional Gemini reasoning
                                          └─ heal / approve / verify
                                                    │ verified data only
                                                    ▼
                                          Downstream catalog view
```

Bright Data owns scraper generation, execution, proxying, unblocking, and healing. SupaScraper adds only the judgment and verification layer around it.

### Workspace layout

```text
apps/target-site    Public demo catalog with server-side failure scenarios
apps/supascraper    Domain logic, adapters, orchestration, dashboard
packages/shared     Contracts shared by both apps
fixtures/           Sanitized contract and sample data
```

## What it monitors

Two sites, for two different reasons. Both are defined in [targets.json](./targets.json).

| Site | Collector | Why |
|---|---|---|
| [books.toscrape.com](https://books.toscrape.com/catalogue/category/books/travel_2/index.html) | `c_mt3hxh7g1dg3mosktp` | A real public site we do not control. Proves the pipeline works on the open web. |
| [supascraper-target.onrender.com](https://supascraper-target.onrender.com/catalog) | `c_mt351xy524myzqlu8x` | A catalog we deployed, whose markup can be changed on command. Proves the repair works on cue. |

The controlled site exists because a demo needs a break you can cause, reverse, and repeat. No third-party site will redesign its markup while you watch. But the detection and repair logic has no idea which is which: it only ever sees collector output.

Both were healed by the system itself. The real site's collector initially omitted `price` and returned unnormalised availability; SupaScraper classified that as a structural break, repaired it, verified the repair, and published eleven books.

The controlled site runs on a free instance that idles out, so warm it before a demo.

## Prerequisites

- Node.js 22.16 or newer
- npm 10
- A Bright Data account (the free tier needs no card)

## Setup

```bash
npm install
cp .env.example .env      # then fill in the values you need
npm run build
```

Authenticate the Bright Data CLI once. It stores a key in your OS config directory, outside this repository:

```bash
node node_modules/@brightdata/cli/dist/index.js login
```

Confirm it worked, and check your credit:

```bash
node node_modules/@brightdata/cli/dist/index.js budget balance
```

## Running locally

Two separate services, in two terminals:

```bash
npm run start:target   # demo catalog, default http://localhost:3001
npm run start:app      # SupaScraper dashboard, default http://localhost:3000
```

The target exposes:

| Route | Purpose |
|---|---|
| `GET /catalog` | The public page a collector scrapes |
| `GET /health` | Liveness plus the active scenario |
| `POST /__control/scenario` | Switch scenario; requires a bearer token |

### Driving the failure scenarios

Set `TARGET_CONTROL_TOKEN` before starting the target, then:

```bash
curl -X POST http://localhost:3001/__control/scenario \
  -H "Authorization: Bearer $TARGET_CONTROL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"structural_break"}'
```

Valid modes are `baseline`, `legitimate_change`, `structural_break`, `transient_error`, and `reset`.

`structural_break` rewrites the server-rendered markup while keeping the same information visible to a human, which is what makes the extraction fail for the right reason. The change is applied **server side** on purpose: Bright Data scrapes from its own browser session, so a client-side DOM edit would be invisible to it.

Scenario state persists to disk so it survives across requests, and resets to `baseline` on a fresh deployment.

## Deploying the target

Bright Data scrapes from its cloud, so the target needs a public HTTPS URL.

Connect the repository to [Render](https://render.com) as a Blueprint. `render.yaml` provisions a free web service on the native Node runtime and generates `TARGET_CONTROL_TOKEN` for you; read it from the Render dashboard to drive scenarios. It is never committed.

The build and start commands are plain npm:

```bash
npm ci && npm run build --workspace @supascraper/target-site
node apps/target-site/dist/server.js
```

The service reads `PORT` when a platform injects one and falls back to `TARGET_SITE_PORT` locally, so it runs unchanged on any host that can run Node.

Scenario state lives on an ephemeral filesystem by design, so a redeploy returns the target to `baseline`.

## Working with a collector

Create a scraper once, from a plain-language description with no hardcoded selectors. Generation typically takes 5–10 minutes:

```bash
node node_modules/@brightdata/cli/dist/index.js scraper create <public-url> \
  "Extract each product's name, SKU, numeric price, and availability." --pretty
```

Add the returned `c_*` Collector ID to [targets.json](./targets.json), or set `SUPASCRAPER_COLLECTOR_ID` for a single-target setup. **Reuse it** — the whole premise is that a repair keeps the same collector, so the application never creates one on startup.

Each target needs an `id`, a `label`, the `collectorId`, the `targetUrl`, the plain-language `fieldDescription`, and `controllable` set to true only for a site whose markup you can change yourself.

```bash
node node_modules/@brightdata/cli/dist/index.js scraper run <collector_id> <url> --pretty
node node_modules/@brightdata/cli/dist/index.js scraper heal <collector_id> "<what broke>" --pretty
node node_modules/@brightdata/cli/dist/index.js scraper approve <collector_id>
```

`scraper heal` stops at an approval gate and returns a preview plus a diff summary. That gate is the point where SupaScraper checks the proposed fix for plausibility before committing it, and a successful heal command is never treated as proof of recovery on its own.

Note that `approve` must be given `--auto-save`. Without it the flow ends at `user_approval`, the healed template is never persisted, and the collector keeps failing while every command reports success.

## Triggering a run

```bash
curl -X POST http://localhost:3000/api/run     # returns 202
curl http://localhost:3000/api/status          # poll for the outcome
```

The trigger returns immediately because a repair takes minutes. Progress appears in `/api/status` and on the dashboard, which refreshes while a run is in flight.

## Reproducing the self-healing demo

The point of the demo is that a layout change breaks extraction, the system notices, repairs itself, and the downstream catalog keeps working under the **same Collector ID**.

Enable automatic repair in `.env`:

```bash
SUPASCRAPER_AUTO_HEAL=true
```

Then, with the app running:

```bash
# 1. Align the target with the layout the collector currently handles.
npm run layout baseline

# 2. Collect. Expect classification "healthy" and products on the dashboard.
curl -X POST http://localhost:3000/api/run

# 3. Change prices and stock, keeping the structure valid.
npm run layout legitimate_change
curl -X POST http://localhost:3000/api/run
#    Expect "legitimate_change": new values published, no repair attempted.

# 4. Now change the markup itself.
npm run layout structural_break
curl -X POST http://localhost:3000/api/run
#    Expect "structural_break": extraction fails, the repair runs, and the
#    rerun of the same collector restores the original data contract.
```

Poll `/api/status` between steps, or just watch the dashboard, which refreshes while a run is in flight. A repair takes several minutes.

Two things worth understanding before running it:

**A repair binds the collector to the new markup.** After step 4 the collector expects the restructured layout, so returning to `baseline` will break it again and trigger another repair. That is correct behaviour, since real sites do not revert.

**Deploying resets the target's layout.** Scenario state is intentionally ephemeral, so any redeploy returns it to `baseline`. Always run `npm run layout <mode>` after a deploy, and never rely on a previous session's state.

## Configuration

See [.env.example](./.env.example) for the full list. Nothing secret belongs in the repository.

| Variable | Purpose |
|---|---|
| `SUPASCRAPER_COLLECTOR_ID` | Existing `c_*` collector to reuse |
| `SUPASCRAPER_TARGET_URL` | Public URL to scrape |
| `SUPASCRAPER_AUTO_HEAL` | Enables unattended repair; off by default |
| `SUPASCRAPER_SCHEDULE_MINUTES` | Unattended run interval; empty for none, minimum 5 |
| `SUPASCRAPER_GEMINI_ENABLED` | Enables the second-opinion layer |
| `SUPASCRAPER_HOST` / `SUPASCRAPER_API_TOKEN` | Loopback by default; a non-loopback bind requires a token |
| `SUPASCRAPER_DATA_PATH` | Where verified data and repair history persist |
| `BRIGHTDATA_API_KEY` | Optional; only for non-interactive runs |
| `GEMINI_API_KEY` | Optional; reasoning layer |
| `TARGET_CONTROL_TOKEN` | Protects the scenario control route |
| `TARGET_STATE_PATH` | Where scenario state is persisted |

## How a decision is made

Every run is classified deterministically before anything else happens, in a deliberate order:

| Observation | Classification | What happens |
|---|---|---|
| Run failed or timed out, retryable | `transient_error` | Retry later, publish nothing |
| Page unreachable, e.g. a 404 | `ambiguous` | Manual review; healing a dead page would destroy working logic |
| Page loaded, a selector no longer matches | `structural_break` | Repair, review the preview, approve, verify |
| Rows violate the contract, including duplicate SKUs | `structural_break` | As above |
| Valid rows, values differ from history | `legitimate_change` | Publish; the site changed, the scraper is fine |
| Valid rows, more than half the catalog gone | `ambiguous` | Manual review; likely partial extraction |
| Valid rows, unchanged | `healthy` | Publish |

Gemini, when enabled, is consulted only for `ambiguous` and `structural_break` verdicts. It can add evidence and it can downgrade a repair to manual review, but it can never escalate anything into a repair. The deterministic result always sets the ceiling.

## Scripts

| Command | Description |
|---|---|
| `npm run build` | Build all workspaces |
| `npm test` | Build, then run the test suite |
| `npm run verify` | Build and test in one step |
| `npm run typecheck` | Type check without emitting |
| `npm run clean` | Remove build output |

Tests use Node's built-in runner with no test framework dependency. They run against compiled output, so `npm test` builds first.
| `npm run start:target` | Run the demo target |
| `npm run start:app` | Run the SupaScraper app |

## Scheduled runs

Unattended collection is opt-in:

```bash
SUPASCRAPER_SCHEDULE_MINUTES=30
```

The interval has a five-minute floor, because each run consumes credit and a schedule keeps going after everyone has stopped watching. Ticks never overlap: if a repair is still in progress when the timer fires, that tick is skipped rather than queued. The schedule calls the same guarded trigger as the HTTP endpoint, so it obeys the same in-flight guard, validation, and publication rules.

To stop it, clear the variable and restart. The startup log states the interval and the implied runs per day so the budget impact is visible rather than assumed.

## Data and safety

The demo target serves synthetic industrial-component data. It contains no personal information, sits behind no login or paywall, and is not covered by Bright Data's pre-built scraper library.

Credentials stay in `.env` or the CLI's own config directory, both untracked. Command output is sanitized before it is stored or displayed, and CLI arguments are passed as an argument array rather than interpolated into a shell string.

## License

MIT
