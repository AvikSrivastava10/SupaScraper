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
| Break, heal, approve, recover against a live collector | Verified end to end; recovered data byte-identical to baseline |
| Collector integration inside the app | Adapter deliberately fails closed; not wired into the running server yet |
| Contract validation and run classification | Implemented and unit-tested |
| Unattended heal → review → approve → verify | Verified live; a real break repaired itself and rows went 0/0 to 3/3 |
| Automated test suite | 148 tests, no test framework dependency |
| Dashboard | Catalog, status, freshness, and repair timeline |

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

## Live demo target

The controlled catalog is deployed at **https://supascraper-target.onrender.com/catalog**.

It runs on a free instance that idles out after inactivity, so the first request after a quiet period is slow. Warm it before a demo.

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

Save the returned `c_*` Collector ID into `.env` as `SUPASCRAPER_COLLECTOR_ID`. **Reuse it** — the whole premise is that a repair keeps the same collector, so the application never creates one on startup.

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

## Configuration

See [.env.example](./.env.example) for the full list. Nothing secret belongs in the repository.

| Variable | Purpose |
|---|---|
| `SUPASCRAPER_COLLECTOR_ID` | Existing `c_*` collector to reuse |
| `SUPASCRAPER_TARGET_URL` | Public URL to scrape |
| `BRIGHTDATA_API_KEY` | Optional; only for non-interactive runs |
| `GEMINI_API_KEY` | Optional; reasoning layer |
| `TARGET_CONTROL_TOKEN` | Protects the scenario control route |
| `TARGET_STATE_PATH` | Where scenario state is persisted |

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

## Data and safety

The demo target serves synthetic industrial-component data. It contains no personal information, sits behind no login or paywall, and is not covered by Bright Data's pre-built scraper library.

Credentials stay in `.env` or the CLI's own config directory, both untracked. Command output is sanitized before it is stored or displayed, and CLI arguments are passed as an argument array rather than interpolated into a shell string.

## License

MIT
