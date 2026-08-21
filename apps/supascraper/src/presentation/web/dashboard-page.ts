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

/** Text label plus tone, so status is never conveyed by colour alone. */
function describeState(state: OrchestrationState): { label: string; tone: string } {
  switch (state) {
    case "healthy":
    case "recovered":
      return { label: "Healthy", tone: "good" };
    case "running":
    case "verifying":
      return { label: "Working", tone: "busy" };
    case "suspected":
    case "healing":
    case "awaiting_approval":
      return { label: "Repairing", tone: "warn" };
    case "manual_review":
      return { label: "Needs review", tone: "bad" };
    case "retry_or_wait":
      return { label: "Waiting to retry", tone: "warn" };
    default:
      return { label: "Idle", tone: "idle" };
  }
}

function renderRows(records: readonly CatalogRecord[]): string {
  if (records.length === 0) {
    return `<tr><td colspan="4">No verified catalog data has been collected yet.</td></tr>`;
  }

  return records
    .map(
      (record) => `<tr>
            <td>${escapeHtml(record.name)}</td>
            <td>${escapeHtml(record.sku)}</td>
            <td>$${record.price.toFixed(2)}</td>
            <td>${escapeHtml(record.availability)}</td>
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
      const evidence = event.evidence.slice(0, 3).map(escapeHtml).join(" &middot; ");
      return `<li>
            <div class="event-head">
              <span class="pill">${escapeHtml(event.classification)}</span>
              <span class="muted">${escapeHtml(relativeAge(event.createdAt))}</span>
            </div>
            <div class="muted">${evidence || "&mdash;"}</div>
            <div class="muted small">rows ${String(event.beforeMetrics.rowCount)} &middot; valid ${String(event.beforeMetrics.validRowCount)} &middot; confidence ${event.confidence.toFixed(2)}</div>
          </li>`;
    })
    .join("\n");
}

export function renderDashboardPage(status: DashboardStatus): string {
  const state = describeState(status.state);
  const stale = status.records.length > 0 && status.state === "manual_review";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>SupaScraper</title>
    <style>
      :root { color-scheme: dark; --good:#4ade80; --warn:#fbbf24; --bad:#f87171; --busy:#60a5fa; --idle:#94a3b8; }
      * { box-sizing: border-box; }
      body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background:#0b1020; color:#e8edff; }
      main { width:min(100% - 2rem, 70rem); margin:0 auto; padding:2.5rem 0 4rem; }
      h1 { margin:.25rem 0 0; font-size:1.9rem; }
      h2 { font-size:1.05rem; margin:0 0 .9rem; }
      section, header { background:#141d36; border:1px solid #27324f; border-radius:.9rem; padding:1.25rem; margin-bottom:1rem; }
      .label { color:#9fb0d9; font-size:.72rem; letter-spacing:.06em; text-transform:uppercase; }
      .value { font-weight:650; margin-top:.2rem; overflow-wrap:anywhere; }
      .grid { display:grid; gap:1rem; grid-template-columns:repeat(auto-fit,minmax(11rem,1fr)); }
      table { border-collapse:collapse; width:100%; }
      th, td { text-align:left; padding:.6rem .5rem; border-bottom:1px solid #27324f; }
      th { color:#9fb0d9; font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; }
      td:nth-child(3) { font-variant-numeric:tabular-nums; }
      ul { list-style:none; margin:0; padding:0; display:grid; gap:.75rem; }
      li { border-left:3px solid #27324f; padding:.15rem 0 .15rem .75rem; }
      .muted { color:#9fb0d9; font-size:.85rem; }
      .small { font-size:.78rem; }
      .pill { display:inline-block; padding:.1rem .5rem; border-radius:999px; background:#1e2942; font-size:.75rem; }
      .event-head { display:flex; gap:.5rem; align-items:center; justify-content:space-between; }
      .state { display:inline-flex; align-items:center; gap:.45rem; font-weight:700; }
      .dot { width:.6rem; height:.6rem; border-radius:50%; background:var(--idle); }
      .good .dot{background:var(--good)} .warn .dot{background:var(--warn)} .bad .dot{background:var(--bad)} .busy .dot{background:var(--busy)}
      .notice { border-left:3px solid var(--warn); padding-left:.75rem; color:#fde68a; }
      code { background:#1e2942; padding:.1rem .35rem; border-radius:.3rem; font-size:.85em; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <p class="label">Self-healing data contract guardian</p>
        <h1>SupaScraper</h1>
        <p class="muted">Watches a Bright Data collector's output contract, and blocks unverified data from reaching this view.</p>
      </header>

      <section aria-label="Collector status">
        <div class="grid">
          <div>
            <div class="label">Status</div>
            <div class="value state ${state.tone}"><span class="dot"></span>${escapeHtml(state.label)}</div>
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
            <div class="value">${String(status.records.length)}</div>
          </div>
        </div>
        ${stale ? `<p class="notice" style="margin-top:1rem">Showing the last verified data. A repair is awaiting review, so newer output has not been published.</p>` : ""}
        ${status.configured ? "" : `<p class="notice" style="margin-top:1rem">No collector configured. Set SUPASCRAPER_COLLECTOR_ID and SUPASCRAPER_TARGET_URL.</p>`}
      </section>

      <section>
        <h2>Verified supplier catalog</h2>
        <table>
          <thead><tr><th scope="col">Name</th><th scope="col">SKU</th><th scope="col">Price</th><th scope="col">Availability</th></tr></thead>
          <tbody>
${renderRows(status.records)}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Recent runs and repairs</h2>
        <ul>
${renderTimeline(status.events)}
        </ul>
      </section>
    </main>
  </body>
</html>`;
}
