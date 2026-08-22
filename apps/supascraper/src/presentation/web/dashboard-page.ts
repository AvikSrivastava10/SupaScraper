import type { ScrapedRecord } from "@supascraper/shared";

import {
  isProfiled,
  tableColumns,
  type DataContract,
} from "../../domain/contracts/data-contract.js";
import type { RepairEvent } from "../../domain/repair/repair-event.js";
import type { OrchestrationState } from "../../domain/state-machine/state-machine.js";
import { MAX_DESCRIPTION_LENGTH } from "../../application/add-target/validate-site.js";
import { EXPORT_FORMATS, EXPORT_LABELS } from "../export/export-records.js";

export interface TargetStatus {
  readonly id: string;
  readonly label: string;
  readonly collectorId: string;
  readonly targetUrl: string;
  readonly controllable: boolean;
  readonly state: OrchestrationState;
  readonly records: readonly ScrapedRecord[];
  readonly collectedAt: string | null;
  readonly events: readonly RepairEvent[];
  readonly busy: boolean;
  readonly lastError: string | null;
  /** Null until a good run has taught the system this site's shape. */
  readonly contract: DataContract | null;
  /** Set while a collector is still being built for a newly added site. */
  readonly provisioning: string | null;
}

export interface DashboardStatus {
  readonly configured: boolean;
  readonly autoHealEnabled: boolean;
  readonly geminiEnabled: boolean;
  readonly scheduleMinutes: number | null;
  readonly targets: readonly TargetStatus[];
  /** False when no Bright Data CLI is available to build new scrapers. */
  readonly canAddTargets: boolean;
  /** True when write endpoints need a bearer token, so the page must ask for one. */
  readonly requiresToken: boolean;
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

const MAX_CELL_LENGTH = 90;

/** Renders any scraped value as a table cell, whatever its type. */
function renderCell(value: unknown): string {
  if (value === null || value === undefined) {
    return `<td class="muted">&mdash;</td>`;
  }
  if (typeof value === "number") {
    return `<td class="num">${escapeHtml(String(value))}</td>`;
  }
  if (typeof value === "boolean") {
    return `<td>${value ? "yes" : "no"}</td>`;
  }

  const text = typeof value === "string" ? value : JSON.stringify(value);
  const shown =
    text.length > MAX_CELL_LENGTH ? `${text.slice(0, MAX_CELL_LENGTH - 1)}…` : text;

  if (/^https?:\/\/\S+$/.test(text)) {
    return `<td><a href="${escapeHtml(text)}" rel="noreferrer noopener nofollow" target="_blank">${escapeHtml(
      shown,
    )}</a></td>`;
  }
  return `<td>${escapeHtml(shown.replaceAll("_", " "))}</td>`;
}

const MAX_VISIBLE_ROWS = 25;

function renderRows(
  records: readonly ScrapedRecord[],
  columns: readonly string[],
): string {
  const span = Math.max(1, columns.length);

  if (columns.length === 0 || records.length === 0) {
    return `<tr><td colspan="${String(span)}" class="muted">No verified data collected yet.</td></tr>`;
  }

  const rows = records
    .slice(0, MAX_VISIBLE_ROWS)
    .map(
      (record) =>
        `<tr>${columns.map((column) => renderCell(record[column])).join("")}</tr>`,
    );

  if (records.length > MAX_VISIBLE_ROWS) {
    rows.push(
      `<tr><td colspan="${String(span)}" class="muted small">and ${String(
        records.length - MAX_VISIBLE_ROWS,
      )} more row(s) &mdash; download the full set below.</td></tr>`,
    );
  }

  return rows.join("\n");
}

/** Shows the contract the site is being held to, so the guarantee is visible. */
function renderContract(contract: DataContract | null): string {
  if (contract === null || !isProfiled(contract)) {
    return `<p class="muted small">No contract learned yet. The first successful run defines one.</p>`;
  }

  const fields =
    contract.requiredFields.length === 0
      ? "<em>none</em>"
      : contract.requiredFields
          .map(
            (field) =>
              `<code>${escapeHtml(field)}</code>${
                contract.fieldTypes[field] === undefined
                  ? ""
                  : `<span class="muted small">:${escapeHtml(String(contract.fieldTypes[field]))}</span>`
              }`,
          )
          .join(" ");

  return `<details class="contract">
            <summary>Learned data contract</summary>
            <p class="small">Every run must return ${escapeHtml(
              String(contract.minimumRows),
            )}&ndash;${escapeHtml(String(contract.maximumRows))} rows with these fields present and non-empty:</p>
            <p class="small fields">${fields}</p>
            <p class="muted small">${
              contract.identityField === null
                ? "No unique identifier was found, so rows are compared whole."
                : `Rows are identified by <code>${escapeHtml(contract.identityField)}</code>.`
            } Learned ${escapeHtml(relativeAge(contract.profiledAt))}.</p>
          </details>`;
}

function renderExports(target: TargetStatus): string {
  if (target.records.length === 0) {
    return "";
  }

  const links = EXPORT_FORMATS.map(
    (format) =>
      `<a class="chip" download href="/api/targets/${encodeURIComponent(
        target.id,
      )}/export?format=${format}">${escapeHtml(EXPORT_LABELS[format])}</a>`,
  ).join("\n            ");

  return `<div class="exports">
            <div class="label">Download ${String(target.records.length)} verified record(s)</div>
            <div class="chips">
            ${links}
            </div>
          </div>`;
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
  const columns = tableColumns(target.contract, target.records);
  const provisioning = target.provisioning !== null;
  const host = (() => {
    try {
      return new URL(target.targetUrl).host;
    } catch {
      return target.targetUrl;
    }
  })();

  const head = columns
    .map((column) => `<th scope="col">${escapeHtml(column.replaceAll("_", " "))}</th>`)
    .join("");

  return `      <section class="target" aria-labelledby="t-${escapeHtml(target.id)}">
        <div class="target-head">
          <div>
            <h2 id="t-${escapeHtml(target.id)}">${escapeHtml(target.label)}</h2>
            <p class="muted small">
              <a href="${escapeHtml(target.targetUrl)}" rel="noreferrer noopener nofollow" target="_blank">${escapeHtml(host)}</a>
              &middot; <code>${escapeHtml(target.collectorId)}</code>
              &middot; ${target.controllable ? "layout switchable" : "site we do not control"}
            </p>
          </div>
          <div class="value state ${provisioning ? "busy" : state.tone}" role="status" aria-live="polite"><span class="dot"></span>${escapeHtml(
            provisioning ? "Building scraper" : state.label,
          )}</div>
        </div>

        <div class="grid">
          <div><div class="label">Last verified</div><div class="value">${escapeHtml(relativeAge(target.collectedAt))}</div></div>
          <div><div class="label">Records</div><div class="value num">${String(target.records.length)}</div></div>
          <div><div class="label">Runs recorded</div><div class="value num">${String(target.events.length)}</div></div>
        </div>

        ${provisioning ? `<p class="notice">${escapeHtml(target.provisioning ?? "")}</p>` : ""}
        ${target.busy ? `<p class="notice">Collecting. A repair can take several minutes; this page refreshes on its own.</p>` : ""}
        ${stale ? `<p class="notice">Showing the last verified data. The most recent run did not satisfy the contract, so its output was withheld.</p>` : ""}
        ${target.lastError === null ? "" : `<p class="notice error">Last run failed: ${escapeHtml(target.lastError)}</p>`}

        <div class="actions">
          <button data-target="${escapeHtml(target.id)}" ${target.busy || provisioning ? "disabled" : ""}>${target.busy ? "Collecting..." : "Collect now"}</button>
        </div>

        <table>
          <caption>Only output that satisfied the expected contract appears here.</caption>
          <thead><tr>${head.length > 0 ? head : `<th scope="col">Data</th>`}</tr></thead>
          <tbody>
${renderRows(target.records, columns)}
          </tbody>
        </table>

        ${renderExports(target)}
        ${renderContract(target.contract)}

        <h3>Runs and repairs</h3>
        <ul class="timeline">
${renderTimeline(target.events)}
        </ul>
      </section>`;
}

function renderAddForm(status: DashboardStatus): string {
  if (!status.canAddTargets) {
    return `      <section><p class="notice">Adding sites needs the Bright Data CLI to be reachable from this process.</p></section>`;
  }

  return `      <section aria-labelledby="add-heading">
        <h2 id="add-heading">Add a website</h2>
        <p class="muted small">Bright Data's AI builds a scraper from your description. This takes roughly 5 to 10 minutes, and the site keeps running while it works.</p>
        <form id="add-form">
          <div class="field">
            <label for="add-url">Page URL</label>
            <input id="add-url" name="url" type="url" required placeholder="https://example.com/products"
                   inputmode="url" autocomplete="off">
            <p class="muted small">Must be a public HTTPS page. Scrape only data you are permitted to collect.</p>
          </div>
          <div class="field">
            <label for="add-description">What should be extracted?</label>
            <textarea id="add-description" name="description" required rows="3"
                      maxlength="${String(MAX_DESCRIPTION_LENGTH)}"
                      placeholder="For each product card, extract the title, price as a number, rating, and product link."></textarea>
            <p class="muted small">Plain language. Name the fields you want; Bright Data works out the markup.</p>
          </div>
          <div class="field">
            <label for="add-label">Display name <span class="muted">(optional)</span></label>
            <input id="add-label" name="label" type="text" maxlength="60" placeholder="Example shop">
          </div>
          <div class="actions">
            <button type="submit">Build scraper</button>
            <span id="add-status" class="muted small" role="status" aria-live="polite"></span>
          </div>
        </form>
      </section>`;
}

export function renderDashboardPage(status: DashboardStatus): string {
  const busy = status.targets.some(
    (target) => target.busy || target.provisioning !== null,
  );
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
    ${busy ? `<meta http-equiv="refresh" content="15">` : ""}
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
      table { border-collapse:collapse; width:100%; margin-top:1.2rem; display:block; overflow-x:auto; }
      caption { text-align:left; color:var(--dim); font-size:.78rem; padding-bottom:.5rem; }
      th, td { text-align:left; padding:.55rem .5rem; border-bottom:1px solid var(--line); max-width:22rem; overflow-wrap:anywhere; }
      th { color:var(--dim); font-size:.7rem; text-transform:uppercase; letter-spacing:.06em; white-space:nowrap; }
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
      .contract { margin-top:.9rem; }
      .contract .fields { display:flex; flex-wrap:wrap; gap:.35rem; }
      .notice { border-left:3px solid var(--warn); background:rgba(251,191,36,.07);
        padding:.55rem .75rem; border-radius:.4rem; margin-top:.9rem; color:#fde68a; font-size:.86rem; }
      .notice.error { border-left-color:var(--bad); background:rgba(248,113,113,.07); color:#fecaca; }
      .notice.good { border-left-color:var(--good); background:rgba(74,222,128,.07); color:#bbf7d0; }
      button { font:inherit; font-weight:650; color:#08122b; background:var(--good);
        border:none; border-radius:.5rem; padding:.5rem .95rem; cursor:pointer; }
      button:disabled { background:#3d4a6b; color:var(--dim); cursor:not-allowed; }
      :focus-visible { outline:2px solid var(--busy); outline-offset:2px; }
      .actions { margin-top:1rem; display:flex; gap:.75rem; align-items:center; flex-wrap:wrap; }
      .exports { margin-top:1.1rem; }
      .chips { display:flex; flex-wrap:wrap; gap:.4rem; margin-top:.4rem; }
      .chip { display:inline-block; background:#1e2942; border:1px solid var(--line);
        border-radius:.45rem; padding:.28rem .6rem; font-size:.8rem; font-weight:600;
        text-decoration:none; color:var(--text); }
      .chip:hover { border-color:var(--busy); }
      .field { margin-top:.9rem; max-width:44rem; }
      label { display:block; font-size:.78rem; font-weight:650; margin-bottom:.3rem; }
      input, textarea { font:inherit; width:100%; background:#101833; color:var(--text);
        border:1px solid var(--line); border-radius:.5rem; padding:.5rem .6rem; }
      textarea { resize:vertical; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <p class="label">Self-healing data contract guardian</p>
        <h1>SupaScraper</h1>
        <p class="muted">Add any public page. SupaScraper learns the shape of its data, watches for the day extraction breaks, repairs itself, and never publishes data it could not verify.</p>
        <p class="muted small">${modes}</p>
      </header>

${renderAddForm(status)}

${
  status.configured
    ? status.targets.map((target) => renderTarget(target)).join("\n")
    : `      <section><p class="notice">No sites yet. Add one above, or configure <code>SUPASCRAPER_TARGETS_PATH</code>.</p></section>`
}
    </main>
    <script>
      const REQUIRES_TOKEN = ${status.requiresToken ? "true" : "false"};
      const KEY = "supascraper-token";

      function headers() {
        const token = sessionStorage.getItem(KEY);
        return token ? { authorization: "Bearer " + token } : {};
      }

      function askForToken(force) {
        if (!REQUIRES_TOKEN) return true;
        if (!force && sessionStorage.getItem(KEY)) return true;
        const token = window.prompt("This deployment is protected. Enter the API token to continue:");
        if (!token) return false;
        sessionStorage.setItem(KEY, token.trim());
        return true;
      }

      async function send(url, options) {
        if (!askForToken(false)) throw new Error("An API token is required.");
        let response = await fetch(url, {
          ...options,
          headers: { ...(options.headers || {}), ...headers() },
        });
        if (response.status === 401) {
          sessionStorage.removeItem(KEY);
          if (!askForToken(true)) throw new Error("An API token is required.");
          response = await fetch(url, {
            ...options,
            headers: { ...(options.headers || {}), ...headers() },
          });
        }
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || "HTTP " + response.status);
        }
        return response.json().catch(() => ({}));
      }

      for (const button of document.querySelectorAll("button[data-target]")) {
        button.addEventListener("click", async () => {
          const id = button.getAttribute("data-target");
          const original = button.textContent;
          button.disabled = true;
          button.textContent = "Collecting...";
          try {
            await send("/api/run?target=" + encodeURIComponent(id), { method: "POST" });
            setTimeout(() => { window.location.reload(); }, 1500);
          } catch (error) {
            button.disabled = false;
            button.textContent = original;
            window.alert("Could not start a run: " + error.message);
          }
        });
      }

      const form = document.getElementById("add-form");
      if (form) {
        const note = document.getElementById("add-status");
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const button = form.querySelector("button[type=submit]");
          const data = new FormData(form);
          button.disabled = true;
          note.textContent = "Asking Bright Data to build a scraper. This can take 5 to 10 minutes.";
          try {
            await send("/api/targets", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                url: data.get("url"),
                description: data.get("description"),
                label: data.get("label") || undefined,
              }),
            });
            note.textContent = "Building. This page will keep refreshing.";
            form.reset();
            setTimeout(() => { window.location.reload(); }, 2000);
          } catch (error) {
            button.disabled = false;
            note.textContent = "";
            window.alert("Could not add that site: " + error.message);
          }
        });
      }
    </script>
  </body>
</html>`;
}
