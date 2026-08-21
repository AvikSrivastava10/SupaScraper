import type { CatalogRecord } from "@supascraper/shared";

import type { RepairEvent } from "../../domain/repair/repair-event.js";
import type { OrchestrationState } from "../../domain/state-machine/state-machine.js";

export interface DashboardStatus {
  readonly configured: boolean;
  readonly collectorId: string | null;
  readonly targetUrl: string | null;
  readonly state: OrchestrationState;
  readonly records: readonly CatalogRecord[];
  readonly collectedAt: string | null;
  readonly events: readonly RepairEvent[];
  readonly busy: boolean;
  readonly lastError: string | null;
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replaceAll(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character);
}

function relativeAge(timestamp: string | null): string {
  if (timestamp === null) {
    return "never";
  }
  const then = Date.parse(timestamp);
  if (Number.isNaN(then)) {
    return "unknown";
  }
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${String(seconds)}s ago`;
  if (seconds < 3600) return `${String(Math.round(seconds / 60))}m ago`;
  if (seconds < 86_400) return `${String(Math.round(seconds / 3600))}h ago`;
  return `${String(Math.round(seconds / 86_400))}d ago`;
}

/** States in which the displayed data is current rather than withheld. */
const CURRENT_DATA_STATES = new Set<OrchestrationState>([
  "healthy",
  "recovered",
  "idle",
  "running",
]);

/**
 * True when rows are on screen but the most recent run was not published.
 *
 * Showing last known good data is the correct behaviour; presenting it as
 * current is not. Every non-publishing state must say so.
 */
export function isShowingStaleData(
  state: OrchestrationState,
  hasRecords: boolean,
): boolean {
  return hasRecords && !CURRENT_DATA_STATES.has(state);
}

/** Text label plus tone, so status is never conveyed by colour alone. */
function describeState(state: OrchestrationState): { label: string; tone: string } {
  switch (state) {
    case "healthy":
    case "recovered":
      return { label: "Healthy", tone: "good" };
    case "running":
    case "verifying":
      return { label: "Working", tone: "busy" };
    case "healing":
    case "awaiting_approval":
      return { label: "Repairing", tone: "warn" };
    case "suspected":
      return { label: "Break detected", tone: "warn" };
    case "manual_review":
      return { label: "Needs review", tone: "bad" };
    case "retry_or_wait":
      return { label: "Waiting to retry", tone: "warn" };
    default:
      return { label: "Idle", tone: "idle" };
  }
}

const CLASSIFICATION_LABELS: Readonly<Record<string, string>> = {
  healthy: "Healthy",
  legitimate_change: "Data changed",
  structural_break: "Extraction broke",
  transient_error: "Transient failure",
  ambiguous: "Needs review",
};

function renderRows(records: readonly CatalogRecord[]): string {
  if (records.length === 0) {
    return `<tr><td colspan="4" class="muted">No verified catalog data has been collected yet.</td></tr>`;
  }

  return records
    .map(
      (record) => `<tr>
              <td>${escapeHtml(record.name)}</td>
              <td><code>${escapeHtml(record.sku)}</code></td>
              <td class="num">$${record.price.toFixed(2)}</td>
              <td>${escapeHtml(record.availability.replaceAll("_", " "))}</td>
            </tr>`,
    )
    .join("\n");
}

function renderVerification(event: RepairEvent): string {
  if (event.verification === "not_started") {
    return "";
  }
  const passed = event.verification === "passed";
  return `<span class="badge ${passed ? "good" : "bad"}">${
    passed ? "Verified recovered" : "Verification failed"
  }</span>`;
}

function renderMetrics(event: RepairEvent): string {
  if (event.afterMetrics === null) {
    return `<span class="muted small">${String(event.beforeMetrics.validRowCount)} of ${String(event.beforeMetrics.rowCount)} row(s) valid</span>`;
  }
  return `<span class="muted small">rows ${String(event.beforeMetrics.validRowCount)}/${String(event.beforeMetrics.rowCount)} &rarr; ${String(event.afterMetrics.validRowCount)}/${String(event.afterMetrics.rowCount)} valid after repair</span>`;
}

function renderTimeline(events: readonly RepairEvent[]): string {
  if (events.length === 0) {
    return `<li class="muted">No runs recorded yet. Trigger one to populate this timeline.</li>`;
  }

  return events
    .map((event) => {
      const label = CLASSIFICATION_LABELS[event.classification] ?? event.classification;
      const evidence = event.evidence
        .slice(0, 3)
        .map((line) => `<li>${escapeHtml(line)}</li>`)
        .join("");
      const prompt =
        event.healPrompt === null
          ? ""
          : `<details><summary>Repair prompt sent to Scraper Studio</summary><p class="prompt">${escapeHtml(event.healPrompt)}</p></details>`;

      return `<li class="event ${event.classification}">
              <div class="event-head">
                <span class="pill">${escapeHtml(label)}</span>
                ${renderVerification(event)}
                <span class="muted small spacer">${escapeHtml(relativeAge(event.createdAt))}</span>
              </div>
              <ul class="evidence">${evidence}</ul>
              ${renderMetrics(event)}
              ${prompt}
            </li>`;
    })
    .join("\n");
}

export function renderDashboardPage(status: DashboardStatus): string {
  const state = describeState(status.state);
  const stale = isShowingStaleData(status.state, status.records.length > 0);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${status.busy ? `<meta http-equiv="refresh" content="10">` : ""}
    <title>SupaScraper${status.busy ? " — working" : ""}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg:#0a0f1f; --panel:#141d36; --line:#27324f; --text:#e8edff; --dim:#9fb0d9;
        --good:#4ade80; --warn:#fbbf24; --bad:#f87171; --busy:#60a5fa; --idle:#94a3b8;
      }
      * { box-sizing:border-box; }
      body { margin:0; background:var(--bg); color:var(--text);
        font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; line-height:1.5; }
      main { width:min(100% - 2rem, 72rem); margin:0 auto; padding:2.5rem 0 4rem; }
      header, section { background:var(--panel); border:1px solid var(--line);
        border-radius:.9rem; padding:1.25rem 1.4rem; margin-bottom:1rem; }
      h1 { margin:.2rem 0 .4rem; font-size:1.85rem; letter-spacing:-.02em; }
      h2 { font-size:1rem; margin:0 0 1rem; letter-spacing:.01em; }
      p { margin:.35rem 0; }
      .label { color:var(--dim); font-size:.7rem; letter-spacing:.08em; text-transform:uppercase; }
      .value { font-weight:650; margin-top:.25rem; overflow-wrap:anywhere; }
      .grid { display:grid; gap:1.1rem; grid-template-columns:repeat(auto-fit,minmax(10.5rem,1fr)); }
      .muted { color:var(--dim); }
      .small { font-size:.8rem; }
      .num { font-variant-numeric:tabular-nums; }
      code { background:#1e2942; padding:.12rem .38rem; border-radius:.3rem; font-size:.88em; }
      table { border-collapse:collapse; width:100%; }
      caption { text-align:left; color:var(--dim); font-size:.8rem; padding-bottom:.5rem; }
      th, td { text-align:left; padding:.62rem .5rem; border-bottom:1px solid var(--line); }
      th { color:var(--dim); font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; }
      tbody tr:last-child td { border-bottom:none; }
      .state { display:inline-flex; align-items:center; gap:.5rem; font-weight:700; }
      .dot { width:.62rem; height:.62rem; border-radius:50%; background:var(--idle); flex:none; }
      .good .dot{background:var(--good)} .warn .dot{background:var(--warn)}
      .bad .dot{background:var(--bad)} .busy .dot{background:var(--busy)}
      .busy .dot{animation:pulse 1.4s ease-in-out infinite}
      @keyframes pulse { 50% { opacity:.35 } }
      @media (prefers-reduced-motion:reduce) { .busy .dot{animation:none} }
      ul.timeline { list-style:none; margin:0; padding:0; display:grid; gap:1rem; }
      .event { border-left:3px solid var(--line); padding:.1rem 0 .1rem .85rem; }
      .event.structural_break { border-left-color:var(--warn); }
      .event.healthy, .event.legitimate_change { border-left-color:var(--good); }
      .event.ambiguous, .event.transient_error { border-left-color:var(--bad); }
      .event-head { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }
      .spacer { margin-left:auto; }
      .pill { background:#1e2942; border-radius:999px; padding:.12rem .6rem; font-size:.76rem; font-weight:650; }
      .badge { border-radius:.35rem; padding:.1rem .45rem; font-size:.72rem; font-weight:650; }
      .badge.good { background:rgba(74,222,128,.16); color:var(--good); }
      .badge.bad { background:rgba(248,113,113,.16); color:var(--bad); }
      ul.evidence { margin:.45rem 0 .3rem; padding-left:1.1rem; color:var(--dim); font-size:.87rem; }
      .prompt { background:#101833; border:1px solid var(--line); border-radius:.5rem;
        padding:.7rem .8rem; font-size:.83rem; color:var(--dim); }
      details summary { cursor:pointer; color:var(--dim); font-size:.8rem; margin-top:.4rem; }
      .notice { border-left:3px solid var(--warn); background:rgba(251,191,36,.07);
        padding:.6rem .8rem; border-radius:.4rem; margin-top:1rem; color:#fde68a; font-size:.88rem; }
      .notice.error { border-left-color:var(--bad); background:rgba(248,113,113,.07); color:#fecaca; }
      button { font:inherit; font-weight:650; color:#08122b; background:var(--good);
        border:none; border-radius:.5rem; padding:.55rem 1rem; cursor:pointer; }
      button:disabled { background:#3d4a6b; color:var(--dim); cursor:not-allowed; }
      :focus-visible { outline:2px solid var(--busy); outline-offset:2px; }
      .actions { display:flex; align-items:center; gap:.8rem; flex-wrap:wrap; margin-top:1rem; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <p class="label">Self-healing data contract guardian</p>
        <h1>SupaScraper</h1>
        <p class="muted">Watches a Bright Data collector's output contract. Unverified data never reaches this page.</p>
      </header>

      <section aria-labelledby="status-heading">
        <h2 id="status-heading">Collector status</h2>
        <div class="grid">
          <div>
            <div class="label">Status</div>
            <div class="value state ${state.tone}" role="status" aria-live="polite"><span class="dot"></span>${escapeHtml(state.label)}</div>
          </div>
          <div>
            <div class="label">Collector</div>
            <div class="value"><code>${escapeHtml(status.collectorId ?? "not configured")}</code></div>
          </div>
          <div>
            <div class="label">Last verified data</div>
            <div class="value">${escapeHtml(relativeAge(status.collectedAt))}</div>
          </div>
          <div>
            <div class="label">Products</div>
            <div class="value num">${String(status.records.length)}</div>
          </div>
        </div>

        ${status.busy ? `<p class="notice">A run is in progress. A repair can take several minutes; this page refreshes on its own.</p>` : ""}
        ${stale ? `<p class="notice">Showing the last verified data. The most recent run did not satisfy the expected contract, so its output was withheld.</p>` : ""}
        ${status.lastError === null ? "" : `<p class="notice error">Last run failed: ${escapeHtml(status.lastError)}</p>`}
        ${status.configured ? "" : `<p class="notice">No collector configured. Set <code>SUPASCRAPER_COLLECTOR_ID</code> and <code>SUPASCRAPER_TARGET_URL</code>.</p>`}

        ${
          status.configured
            ? `<div class="actions">
          <button id="run" ${status.busy ? "disabled" : ""}>${status.busy ? "Collecting..." : "Collect now"}</button>
          <span class="muted small" id="run-note">Runs the pinned collector and re-validates the contract.</span>
        </div>`
            : ""
        }
      </section>

      <section aria-labelledby="catalog-heading">
        <h2 id="catalog-heading">Verified supplier catalog</h2>
        <table>
          <caption>Only output that satisfied the expected contract is shown here.</caption>
          <thead>
            <tr><th scope="col">Name</th><th scope="col">SKU</th><th scope="col">Price</th><th scope="col">Availability</th></tr>
          </thead>
          <tbody>
${renderRows(status.records)}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">Runs and repairs</h2>
        <ul class="timeline">
${renderTimeline(status.events)}
        </ul>
      </section>
    </main>
    <script>
      const button = document.getElementById("run");
      if (button) {
        button.addEventListener("click", async () => {
          button.disabled = true;
          button.textContent = "Collecting...";
          const note = document.getElementById("run-note");
          try {
            const response = await fetch("/api/run", { method: "POST" });
            if (!response.ok) {
              const body = await response.json().catch(() => ({}));
              throw new Error(body.error || ("HTTP " + response.status));
            }
            if (note) note.textContent = "Run started. This page will refresh with the outcome.";
            setTimeout(() => { window.location.reload(); }, 2000);
          } catch (error) {
            if (note) note.textContent = "Could not start a run: " + error.message;
            button.disabled = false;
            button.textContent = "Collect now";
          }
        });
      }
    </script>
  </body>
</html>`;
}
