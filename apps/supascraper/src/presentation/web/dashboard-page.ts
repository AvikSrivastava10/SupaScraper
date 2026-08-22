import type { ScrapedRecord } from "@supascraper/shared";

import { MAX_DESCRIPTION_LENGTH } from "../../application/add-target/validate-site.js";
import {
  isProfiled,
  tableColumns,
  type DataContract,
} from "../../domain/contracts/data-contract.js";
import type { RepairEvent } from "../../domain/repair/repair-event.js";
import type { OrchestrationState } from "../../domain/state-machine/state-machine.js";
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

/**
 * Text label, a tone, and a glyph.
 *
 * The palette is monochrome, so tone alone carries almost no signal. Each state
 * therefore ships a word and a shape as well, which is also what keeps it
 * readable for anyone who cannot distinguish the shades.
 */
function describeState(
  state: OrchestrationState,
): { label: string; tone: string; glyph: string } {
  switch (state) {
    case "healthy":
    case "recovered":
      return { label: "Healthy", tone: "good", glyph: "●" };
    case "running":
    case "verifying":
      return { label: "Working", tone: "busy", glyph: "◐" };
    case "healing":
    case "awaiting_approval":
      return { label: "Repairing", tone: "warn", glyph: "◑" };
    case "suspected":
      return { label: "Break detected", tone: "warn", glyph: "▲" };
    case "manual_review":
      return { label: "Needs review", tone: "bad", glyph: "▲" };
    case "retry_or_wait":
      return { label: "Waiting to retry", tone: "warn", glyph: "◌" };
    default:
      return { label: "Idle", tone: "idle", glyph: "○" };
  }
}

const CLASSIFICATION_LABELS: Readonly<Record<string, string>> = {
  healthy: "Contract satisfied",
  legitimate_change: "Data changed",
  structural_break: "Extraction broke",
  transient_error: "Could not connect",
  ambiguous: "Needs review",
};

interface Situation {
  /** One line saying what the system currently believes. */
  readonly summary: string;
  /** What the reader should do, when there is anything to do. */
  readonly nextStep: string | null;
}

/**
 * What is happening to this target, in plain language.
 *
 * The diagnosis itself is not recomputed here: the classifier already wrote a
 * human sentence into the run's evidence, and repeating that reasoning in the
 * view would let the two drift apart. This only decides what the reader should
 * do about it.
 */
function describeSituation(
  target: TargetStatus,
  autoHealEnabled: boolean,
): Situation {
  if (target.provisioning !== null) {
    return {
      summary: target.provisioning,
      nextStep: "Nothing to do. This page refreshes itself and collects as soon as the scraper exists.",
    };
  }

  if (target.busy) {
    return {
      summary: "Running the collector, then checking the result against this site's contract.",
      nextStep: "A repair can take several minutes. This page refreshes on its own.",
    };
  }

  if (target.lastError !== null) {
    return {
      summary: `The run could not be started: ${target.lastError}`,
      nextStep: "Check that the Bright Data CLI is authenticated and the collector id still exists.",
    };
  }

  const latest = target.events[0];

  if (latest === undefined) {
    return {
      summary:
        target.records.length > 0
          ? "Holding previously verified data. No run has been recorded since."
          : "Never collected. Nothing has been verified for this site yet.",
      nextStep: "Choose Collect now to run it.",
    };
  }

  // The first evidence line is the classifier's own explanation of the run.
  const reason = latest.evidence[0] ?? "No explanation was recorded.";

  switch (latest.classification) {
    case "healthy":
      return {
        summary: `${reason} ${String(target.records.length)} row(s) published.`,
        nextStep: null,
      };
    case "legitimate_change":
      return {
        summary: `The page's values changed but its structure held, so the new data was published. ${reason}`,
        nextStep: null,
      };
    case "structural_break":
      return {
        summary: `The page still loads, but extraction no longer matches it. ${reason}`,
        nextStep: autoHealEnabled
          ? "A repair should start automatically. If this persists, the fix was rejected as implausible."
          : "Automatic repair is off. Set SUPASCRAPER_AUTO_HEAL=true to let it repair itself, or heal the collector by hand.",
      };
    case "transient_error":
      return {
        summary: reason,
        nextStep: "Nothing was repaired, because nothing reached the site. Retry once the connection problem is resolved.",
      };
    default:
      return {
        summary: reason,
        nextStep: "The evidence does not support a confident conclusion, so no repair was attempted. The run history below has the detail.",
      };
  }
}

/** Reads a metrics pair as a sentence instead of "0/0 valid". */
function describeMetrics(event: RepairEvent): string {
  const phrase = (valid: number, total: number): string => {
    if (total === 0) return "no rows returned";
    if (valid === total) return `all ${String(total)} row(s) valid`;
    return `${String(valid)} of ${String(total)} row(s) valid`;
  };

  const before = phrase(
    event.beforeMetrics.validRowCount,
    event.beforeMetrics.rowCount,
  );

  if (event.afterMetrics === null) {
    return before;
  }
  return `${before}, then ${phrase(
    event.afterMetrics.validRowCount,
    event.afterMetrics.rowCount,
  )} after the repair`;
}

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

  return `<div class="block">
            <h3>Download ${String(target.records.length)} verified record(s)</h3>
            <div class="chips">
            ${links}
            </div>
          </div>`;
}

/**
 * Collapses a repeated identical outcome into one entry with a count.
 *
 * Three consecutive runs failing the same way is one fact, not three. Listing it
 * three times pushed everything useful off the screen.
 */
interface TimelineEntry {
  readonly event: RepairEvent;
  readonly repeats: number;
  readonly oldestAt: string;
}

export function groupEvents(events: readonly RepairEvent[]): TimelineEntry[] {
  const grouped: TimelineEntry[] = [];

  for (const event of events) {
    const last = grouped.at(-1);
    const sameOutcome =
      last !== undefined &&
      last.event.classification === event.classification &&
      last.event.state === event.state &&
      last.event.evidence.join("|") === event.evidence.join("|");

    if (sameOutcome && last !== undefined) {
      grouped[grouped.length - 1] = {
        event: last.event,
        repeats: last.repeats + 1,
        oldestAt: event.createdAt,
      };
      continue;
    }
    grouped.push({ event, repeats: 1, oldestAt: event.createdAt });
  }

  return grouped;
}

function renderTimeline(events: readonly RepairEvent[]): string {
  if (events.length === 0) {
    return `<li class="muted">No runs recorded yet.</li>`;
  }

  return groupEvents(events)
    .map((entry) => {
      const { event, repeats } = entry;
      const label = CLASSIFICATION_LABELS[event.classification] ?? event.classification;
      const verified =
        event.verification === "not_started"
          ? ""
          : `<span class="badge">${
              event.verification === "passed" ? "Verified recovered" : "Verification failed"
            }</span>`;
      const count =
        repeats > 1
          ? `<span class="badge">${String(repeats)} runs, same outcome</span>`
          : "";
      const when =
        repeats > 1
          ? `${escapeHtml(relativeAge(entry.oldestAt))} &ndash; ${escapeHtml(relativeAge(event.createdAt))}`
          : escapeHtml(relativeAge(event.createdAt));

      // The first line is already the headline, so only the remaining evidence
      // is listed here.
      const evidence = event.evidence
        .slice(1, 3)
        .map((line) => `<li>${escapeHtml(line)}</li>`)
        .join("");

      const prompt =
        event.healPrompt === null
          ? ""
          : `<details><summary>Repair instruction sent to Scraper Studio</summary><p class="prompt">${escapeHtml(event.healPrompt)}</p></details>`;

      return `<li class="event ${event.classification}">
                <div class="event-head">
                  <span class="pill">${escapeHtml(label)}</span>
                  ${verified}
                  ${count}
                  <span class="muted small spacer">${when}</span>
                </div>
                <p class="small">${escapeHtml(event.evidence[0] ?? "No explanation was recorded.")}</p>
                ${evidence === "" ? "" : `<ul class="evidence">${evidence}</ul>`}
                <p class="muted small">${escapeHtml(describeMetrics(event))}</p>
                ${prompt}
              </li>`;
    })
    .join("\n");
}

function renderTarget(target: TargetStatus, autoHealEnabled: boolean): string {
  const state = describeState(target.state);
  const stale = isShowingStaleData(target.state, target.records.length > 0);
  const columns = tableColumns(target.contract, target.records);
  const provisioning = target.provisioning !== null;
  const situation = describeSituation(target, autoHealEnabled);
  const shown = provisioning
    ? { label: "Building scraper", tone: "busy", glyph: "◐" }
    : state;

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
          <div class="value state ${shown.tone}" role="status" aria-live="polite"><span class="glyph" aria-hidden="true">${shown.glyph}</span>${escapeHtml(shown.label)}</div>
        </div>

        <div class="situation">
          <p>${escapeHtml(situation.summary)}</p>
          ${situation.nextStep === null ? "" : `<p class="muted small">${escapeHtml(situation.nextStep)}</p>`}
        </div>

        <div class="grid">
          <div><div class="label">Last verified</div><div class="value">${escapeHtml(relativeAge(target.collectedAt))}</div></div>
          <div><div class="label">Verified records</div><div class="value num">${String(target.records.length)}</div></div>
          <div><div class="label">Runs recorded</div><div class="value num">${String(target.events.length)}</div></div>
        </div>

        ${stale ? `<p class="notice">Showing the last verified data. The most recent run did not satisfy the contract, so its output was withheld.</p>` : ""}

        <div class="actions">
          <button data-target="${escapeHtml(target.id)}" ${target.busy || provisioning ? "disabled" : ""}>${target.busy ? "Collecting..." : "Collect now"}</button>
          <span class="muted small">${
            provisioning
              ? "Available once the scraper is built."
              : "Runs the collector once and validates the result."
          }</span>
        </div>

        <div class="block">
          <h3>Verified data</h3>
          <table>
            <caption>Only output that satisfied the contract appears here.</caption>
            <thead><tr>${head.length > 0 ? head : `<th scope="col">Data</th>`}</tr></thead>
            <tbody>
${renderRows(target.records, columns)}
            </tbody>
          </table>
        </div>

        ${renderExports(target)}

        <div class="block">
          <h3>Contract</h3>
          ${renderContract(target.contract)}
        </div>

        <div class="block">
          <h3>Run history</h3>
          <ul class="timeline">
${renderTimeline(target.events)}
          </ul>
        </div>
      </section>`;
}

function renderAddForm(status: DashboardStatus): string {
  if (!status.canAddTargets) {
    return `      <section><p class="notice">Adding sites needs the Bright Data CLI to be reachable from this process.</p></section>`;
  }

  return `      <section aria-labelledby="add-heading">
        <h2 id="add-heading">Add a website</h2>
        <p class="muted small">Bright Data's AI builds a scraper from your description. This takes roughly 5 to 10 minutes, and everything else keeps running while it works.</p>
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
      :root { color-scheme: light;
        --paper:#ffffff; --ink:#000000; --ink-2:#2b2b2b; --ink-3:#5c5c5c;
        --line:#d9d9d9; --line-strong:#000000; --wash:#fafafa; --wash-2:#f2f2f2; }
      * { box-sizing:border-box; }
      body { margin:0; background:var(--paper); color:var(--ink);
        font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; line-height:1.55;
        -webkit-font-smoothing:antialiased; }
      main { width:min(100% - 2rem, 70rem); margin:0 auto; padding:2.5rem 0 4rem; }
      header { background:var(--ink); color:var(--paper); border-radius:.5rem;
        padding:1.5rem 1.6rem; margin-bottom:1.25rem; }
      header a { color:var(--paper); }
      header .label, header .muted { color:#c9c9c9; }
      section { background:var(--paper); border:1px solid var(--line);
        border-radius:.5rem; padding:1.35rem 1.5rem; margin-bottom:1.25rem; }
      h1 { margin:.25rem 0 .5rem; font-size:1.9rem; letter-spacing:-.025em; font-weight:750; }
      h2 { font-size:1.15rem; margin:0; letter-spacing:-.01em; }
      h3 { font-size:.72rem; text-transform:uppercase; letter-spacing:.09em;
        color:var(--ink-3); margin:0 0 .55rem; font-weight:700; }
      p { margin:.35rem 0; }
      a { color:var(--ink); text-underline-offset:2px; }
      .label { color:var(--ink-3); font-size:.68rem; letter-spacing:.09em;
        text-transform:uppercase; font-weight:700; }
      .value { font-weight:650; margin-top:.15rem; overflow-wrap:anywhere; }
      .muted { color:var(--ink-3); } .small { font-size:.83rem; }
      .num { font-variant-numeric:tabular-nums; }
      code { background:var(--wash-2); border:1px solid var(--line);
        padding:.05rem .34rem; border-radius:.25rem; font-size:.85em; }

      .target-head { display:flex; gap:1rem; align-items:flex-start;
        justify-content:space-between; flex-wrap:wrap;
        border-bottom:1px solid var(--line); padding-bottom:.9rem; }

      /* Status is carried by a word and a shape. The shades only reinforce it,
         so nothing is lost when they cannot be told apart. */
      .state { display:inline-flex; align-items:center; gap:.45rem; font-weight:700;
        white-space:nowrap; font-size:.92rem; padding:.25rem .6rem; border-radius:999px;
        border:1px solid var(--line-strong); }
      .state .glyph { font-size:.8rem; line-height:1; }
      .state.bad, .state.warn { background:var(--ink); color:var(--paper); }
      .state.good { background:var(--paper); color:var(--ink); }
      .state.busy { background:var(--wash-2); color:var(--ink); }
      .state.idle { background:var(--paper); color:var(--ink-3); border-color:var(--line); }
      .state.busy .glyph { animation:spin 1.6s linear infinite; }
      @keyframes spin { to { transform:rotate(360deg) } }
      @media (prefers-reduced-motion:reduce) { .state.busy .glyph{animation:none} }

      .situation { border-left:3px solid var(--ink); padding:.15rem 0 .15rem .85rem;
        margin:1rem 0 .25rem; }
      .situation p:first-child { font-weight:600; }

      .grid { display:grid; gap:1rem; grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));
        margin-top:1.15rem; padding-top:1rem; border-top:1px solid var(--line); }

      .block { margin-top:1.6rem; }
      table { border-collapse:collapse; width:100%; display:block; overflow-x:auto; }
      caption { text-align:left; color:var(--ink-3); font-size:.79rem; padding-bottom:.45rem; }
      th, td { text-align:left; padding:.5rem .55rem; border-bottom:1px solid var(--line);
        max-width:22rem; overflow-wrap:anywhere; }
      th { color:var(--ink-3); font-size:.68rem; text-transform:uppercase;
        letter-spacing:.07em; white-space:nowrap; border-bottom:1px solid var(--ink); font-weight:700; }
      tbody tr:last-child td { border-bottom:none; }

      ul.timeline { list-style:none; margin:0; padding:0; display:grid; gap:1rem; }
      .event { border-left:2px solid var(--line); padding:.1rem 0 .1rem .85rem; }
      .event.structural_break, .event.ambiguous, .event.transient_error {
        border-left-color:var(--ink); border-left-width:3px; }
      .event-head { display:flex; gap:.45rem; align-items:center; flex-wrap:wrap; }
      .spacer { margin-left:auto; }
      .pill { background:var(--ink); color:var(--paper); border-radius:999px;
        padding:.1rem .6rem; font-size:.73rem; font-weight:700; }
      .badge { border:1px solid var(--line-strong); border-radius:.25rem;
        padding:.05rem .4rem; font-size:.7rem; font-weight:650; }
      ul.evidence { margin:.35rem 0 .3rem; padding-left:1.05rem; color:var(--ink-3);
        font-size:.83rem; }
      .prompt { background:var(--wash); border:1px solid var(--line); border-radius:.35rem;
        padding:.6rem .7rem; font-size:.82rem; color:var(--ink-2); }
      details summary { cursor:pointer; color:var(--ink-3); font-size:.8rem;
        margin-top:.3rem; font-weight:600; }
      .contract .fields { display:flex; flex-wrap:wrap; gap:.35rem; }

      .notice { border:1px solid var(--ink); border-left-width:3px; background:var(--wash);
        padding:.6rem .8rem; border-radius:.35rem; margin-top:1rem; font-size:.86rem; }

      button { font:inherit; font-weight:650; color:var(--paper); background:var(--ink);
        border:1px solid var(--ink); border-radius:.35rem; padding:.5rem 1rem; cursor:pointer; }
      button:hover:not(:disabled) { background:var(--ink-2); }
      button:disabled { background:var(--paper); color:var(--ink-3);
        border-color:var(--line); cursor:not-allowed; }
      :focus-visible { outline:2px solid var(--ink); outline-offset:2px; }
      .actions { margin-top:1.1rem; display:flex; gap:.75rem; align-items:center; flex-wrap:wrap; }

      .chips { display:flex; flex-wrap:wrap; gap:.4rem; }
      .chip { display:inline-block; background:var(--paper); border:1px solid var(--ink);
        border-radius:.3rem; padding:.28rem .65rem; font-size:.8rem; font-weight:650;
        text-decoration:none; color:var(--ink); }
      .chip:hover { background:var(--ink); color:var(--paper); }

      .field { margin-top:.9rem; max-width:44rem; }
      label { display:block; font-size:.8rem; font-weight:700; margin-bottom:.28rem; }
      input, textarea { font:inherit; width:100%; background:var(--paper); color:var(--ink);
        border:1px solid var(--line-strong); border-radius:.35rem; padding:.5rem .6rem; }
      textarea { resize:vertical; }
      ::placeholder { color:#9a9a9a; }
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
    ? status.targets
        .map((target) => renderTarget(target, status.autoHealEnabled))
        .join("\n")
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
