import type { CatalogRecord } from "@supascraper/shared";

import type { RepairEvent } from "../../domain/repair/repair-event.js";
import type { OrchestrationState } from "../../domain/state-machine/state-machine.js";

export interface TargetStatus {
  readonly id: string;
  readonly label: string;
  readonly collectorId: string;
  readonly targetUrl: string;
  readonly controllable: boolean;
  readonly state: OrchestrationState;
  readonly records: readonly CatalogRecord[];
  readonly collectedAt: string | null;
  readonly events: readonly RepairEvent[];
  readonly busy: boolean;
  readonly lastError: string | null;
}

export interface DashboardStatus {
  readonly configured: boolean;
  readonly autoHealEnabled: boolean;
  readonly geminiEnabled: boolean;
  readonly scheduleMinutes: number | null;
  readonly targets: readonly TargetStatus[];
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
    return `<tr><td colspan="4" class="muted">No verified data collected yet.</td></tr>`;
  }

  return records
    .map(
      (record) => `<tr>
                <td>${escapeHtml(record.name)}</td>
                <td><code>${escapeHtml(record.sku)}</code></td>
                <td class="num">${record.price.toFixed(2)}</td>
                <td>${escapeHtml(record.availability.replaceAll("_", " "))}</td>
              </tr>`,
    )
    .join("\n");
}

function renderTimeline(events: readonly RepairEvent[]): string {
  if (events.length === 0) {
    return `<li class="muted">No runs recorded yet.</li>`;
  }

  return events
    .map((event) => {
      const label = CLASSIFICATION_LABELS[event.classification] ?? event.classification;
      const verified =
        event.verification === "not_started"
          ? ""
          : `<span class="badge ${event.verification === "passed" ? "good" : "bad"}">${
              event.verification === "passed" ? "Verified recovered" : "Verification failed"
            }</span>`;
      const metrics =
        event.afterMetrics === null
          ? `${String(event.beforeMetrics.validRowCount)}/${String(event.beforeMetrics.rowCount)} valid`
          : `${String(event.beforeMetrics.validRowCount)}/${String(event.beforeMetrics.rowCount)} &rarr; ${String(event.afterMetrics.validRowCount)}/${String(event.afterMetrics.rowCount)} valid after repair`;
      const evidence = event.evidence
        .slice(0, 2)
        .map((line) => `<li>${escapeHtml(line)}</li>`)
        .join("");
      const prompt =
        event.healPrompt === null
          ? ""
          : `<details><summary>Repair prompt sent to Scraper Studio</summary><p class="prompt">${escapeHtml(event.healPrompt)}</p></details>`;

      return `<li class="event ${event.classification}">
                <div class="event-head">
                  <span class="pill">${escapeHtml(label)}</span>
                  ${verified}
                  <span class="muted small spacer">${escapeHtml(relativeAge(event.createdAt))}</span>
                </div>
                <ul class="evidence">${evidence}</ul>
                <span class="muted small">${metrics}</span>
                ${prompt}
              </li>`;
    })
    .join("\n");
}

function renderTarget(target: TargetStatus): string {
  const state = describeState(target.state);
  const stale = isShowingStaleData(target.state, target.records.length > 0);
  const host = (() => {
    try {
      return new URL(target.targetUrl).host;
    } catch {
      return target.targetUrl;
    }
  })();

  return `      <section class="target" aria-labelledby="t-${escapeHtml(target.id)}">
        <div class="target-head">
          <div>
            <h2 id="t-${escapeHtml(target.id)}">${escapeHtml(target.label)}</h2>
            <p class="muted small">
              <a href="${escapeHtml(target.targetUrl)}" rel="noreferrer noopener" target="_blank">${escapeHtml(host)}</a>
              &middot; <code>${escapeHtml(target.collectorId)}</code>
              &middot; ${target.controllable ? "layout switchable" : "site we do not control"}
            </p>
          </div>
          <div class="value state ${state.tone}" role="status" aria-live="polite"><span class="dot"></span>${escapeHtml(state.label)}</div>
        </div>

        <div class="grid">
          <div><div class="label">Last verified</div><div class="value">${escapeHtml(relativeAge(target.collectedAt))}</div></div>
          <div><div class="label">Records</div><div class="value num">${String(target.records.length)}</div></div>
          <div><div class="label">Runs recorded</div><div class="value num">${String(target.events.length)}</div></div>
        </div>

        ${target.busy ? `<p class="notice">Collecting. A repair can take several minutes; this page refreshes on its own.</p>` : ""}
        ${stale ? `<p class="notice">Showing the last verified data. The most recent run did not satisfy the contract, so its output was withheld.</p>` : ""}
        ${target.lastError === null ? "" : `<p class="notice error">Last run failed: ${escapeHtml(target.lastError)}</p>`}

        <div class="actions">
          <button data-target="${escapeHtml(target.id)}" ${target.busy ? "disabled" : ""}>${target.busy ? "Collecting..." : "Collect now"}</button>
        </div>

        <table>
          <caption>Only output that satisfied the expected contract appears here.</caption>
          <thead><tr><th scope="col">Name</th><th scope="col">SKU</th><th scope="col">Price</th><th scope="col">Availability</th></tr></thead>
          <tbody>
${renderRows(target.records)}
          </tbody>
        </table>

        <h3>Runs and repairs</h3>
        <ul class="timeline">
${renderTimeline(target.events)}
        </ul>
      </section>`;
}

export function renderDashboardPage(status: DashboardStatus): string {
  const busy = status.targets.some((target) => target.busy);
  const modes = [
    status.autoHealEnabled ? "auto-repair on" : "auto-repair off",
    status.geminiEnabled ? "Gemini on" : "Gemini off",
    status.scheduleMinutes === null
      ? "no schedule"
      : `every ${String(status.scheduleMinutes)} min`,
  ].join(" &middot; ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${busy ? `<meta http-equiv="refresh" content="10">` : ""}
    <title>SupaScraper${busy ? " — working" : ""}</title>
    <style>
      :root { color-scheme: dark;
        --bg:#0a0f1f; --panel:#141d36; --line:#27324f; --text:#e8edff; --dim:#9fb0d9;
        --good:#4ade80; --warn:#fbbf24; --bad:#f87171; --busy:#60a5fa; --idle:#94a3b8; }
      * { box-sizing:border-box; }
      body { margin:0; background:var(--bg); color:var(--text);
        font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; line-height:1.5; }
      main { width:min(100% - 2rem, 74rem); margin:0 auto; padding:2.5rem 0 4rem; }
      header, section { background:var(--panel); border:1px solid var(--line);
        border-radius:.9rem; padding:1.25rem 1.4rem; margin-bottom:1rem; }
      h1 { margin:.2rem 0 .4rem; font-size:1.85rem; letter-spacing:-.02em; }
      h2 { font-size:1.1rem; margin:0; }
      h3 { font-size:.85rem; text-transform:uppercase; letter-spacing:.06em;
        color:var(--dim); margin:1.4rem 0 .7rem; }
      p { margin:.3rem 0; }
      a { color:#93b4ff; }
      .label { color:var(--dim); font-size:.7rem; letter-spacing:.08em; text-transform:uppercase; }
      .value { font-weight:650; margin-top:.2rem; overflow-wrap:anywhere; }
      .grid { display:grid; gap:1rem; grid-template-columns:repeat(auto-fit,minmax(9rem,1fr)); margin-top:1rem; }
      .muted { color:var(--dim); } .small { font-size:.8rem; }
      .num { font-variant-numeric:tabular-nums; }
      code { background:#1e2942; padding:.1rem .36rem; border-radius:.3rem; font-size:.86em; }
      .target-head { display:flex; gap:1rem; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; }
      table { border-collapse:collapse; width:100%; margin-top:1.2rem; }
      caption { text-align:left; color:var(--dim); font-size:.78rem; padding-bottom:.5rem; }
      th, td { text-align:left; padding:.55rem .5rem; border-bottom:1px solid var(--line); }
      th { color:var(--dim); font-size:.7rem; text-transform:uppercase; letter-spacing:.06em; }
      tbody tr:last-child td { border-bottom:none; }
      .state { display:inline-flex; align-items:center; gap:.5rem; font-weight:700; white-space:nowrap; }
      .dot { width:.6rem; height:.6rem; border-radius:50%; background:var(--idle); flex:none; }
      .good .dot{background:var(--good)} .warn .dot{background:var(--warn)}
      .bad .dot{background:var(--bad)} .busy .dot{background:var(--busy);animation:pulse 1.4s ease-in-out infinite}
      @keyframes pulse { 50% { opacity:.35 } }
      @media (prefers-reduced-motion:reduce) { .busy .dot{animation:none} }
      ul.timeline { list-style:none; margin:0; padding:0; display:grid; gap:.9rem; }
      .event { border-left:3px solid var(--line); padding:.1rem 0 .1rem .8rem; }
      .event.structural_break { border-left-color:var(--warn); }
      .event.healthy,.event.legitimate_change { border-left-color:var(--good); }
      .event.ambiguous,.event.transient_error { border-left-color:var(--bad); }
      .event-head { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }
      .spacer { margin-left:auto; }
      .pill { background:#1e2942; border-radius:999px; padding:.1rem .58rem; font-size:.75rem; font-weight:650; }
      .badge { border-radius:.35rem; padding:.08rem .42rem; font-size:.71rem; font-weight:650; }
      .badge.good { background:rgba(74,222,128,.16); color:var(--good); }
      .badge.bad { background:rgba(248,113,113,.16); color:var(--bad); }
      ul.evidence { margin:.4rem 0 .25rem; padding-left:1.05rem; color:var(--dim); font-size:.85rem; }
      .prompt { background:#101833; border:1px solid var(--line); border-radius:.5rem;
        padding:.65rem .75rem; font-size:.82rem; color:var(--dim); }
      details summary { cursor:pointer; color:var(--dim); font-size:.79rem; margin-top:.35rem; }
      .notice { border-left:3px solid var(--warn); background:rgba(251,191,36,.07);
        padding:.55rem .75rem; border-radius:.4rem; margin-top:.9rem; color:#fde68a; font-size:.86rem; }
      .notice.error { border-left-color:var(--bad); background:rgba(248,113,113,.07); color:#fecaca; }
      button { font:inherit; font-weight:650; color:#08122b; background:var(--good);
        border:none; border-radius:.5rem; padding:.5rem .95rem; cursor:pointer; }
      button:disabled { background:#3d4a6b; color:var(--dim); cursor:not-allowed; }
      :focus-visible { outline:2px solid var(--busy); outline-offset:2px; }
      .actions { margin-top:1rem; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <p class="label">Self-healing data contract guardian</p>
        <h1>SupaScraper</h1>
        <p class="muted">Watches each collector's output contract. Unverified data never reaches this page.</p>
        <p class="muted small">${modes}</p>
      </header>

${
  status.configured
    ? status.targets.map((target) => renderTarget(target)).join("\n")
    : `      <section><p class="notice">No targets configured. Set <code>SUPASCRAPER_TARGETS_PATH</code>, or <code>SUPASCRAPER_COLLECTOR_ID</code> with <code>SUPASCRAPER_TARGET_URL</code>.</p></section>`
}
    </main>
    <script>
      for (const button of document.querySelectorAll("button[data-target]")) {
        button.addEventListener("click", async () => {
          const id = button.getAttribute("data-target");
          button.disabled = true;
          button.textContent = "Collecting...";
          try {
            const response = await fetch("/api/run?target=" + encodeURIComponent(id), { method: "POST" });
            if (!response.ok) {
              const body = await response.json().catch(() => ({}));
              throw new Error(body.error || ("HTTP " + response.status));
            }
            setTimeout(() => { window.location.reload(); }, 1500);
          } catch (error) {
            button.disabled = false;
            button.textContent = "Collect now";
            alert("Could not start a run: " + error.message);
          }
        });
      }
    </script>
  </body>
</html>`;
}
