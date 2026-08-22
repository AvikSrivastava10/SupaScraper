import type { ScrapedRecord } from "@supascraper/shared";

import {
  isProfiled,
  tableColumns,
  type DataContract,
} from "../../domain/contracts/data-contract.js";
import {
  formatScore,
  type HealthScore,
} from "../../domain/health/health-score.js";
import type { PipelineStage, PipelineStep } from "../../domain/progress/pipeline-step.js";
import type { RepairEvent } from "../../domain/repair/repair-event.js";
import type { OrchestrationState } from "../../domain/state-machine/state-machine.js";
import { EXPORT_FORMATS, EXPORT_LABELS } from "../export/export-records.js";
import { escapeHtml } from "./layout.js";

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

export interface TargetStatus {
  readonly id: string;
  readonly label: string;
  readonly collectorId: string;
  readonly targetUrl: string;
  /** The plain-language request Bright Data built the extractor from. */
  readonly fieldDescription: string;
  readonly controllable: boolean;
  readonly state: OrchestrationState;
  readonly records: readonly ScrapedRecord[];
  readonly collectedAt: string | null;
  readonly events: readonly RepairEvent[];
  readonly busy: boolean;
  readonly lastError: string | null;
  /** Null until a good run has taught the system this site's shape. */
  readonly contract: DataContract | null;
  /** Set while an extractor is still being built for a newly added site. */
  readonly provisioning: string | null;
  /** What the system is doing, or did, on this attempt. */
  readonly steps: readonly PipelineStep[];
  /** Derived from real run metrics, never assumed. */
  readonly health: HealthScore;
}

export interface DashboardStatus {
  readonly configured: boolean;
  readonly autoHealEnabled: boolean;
  readonly geminiEnabled: boolean;
  readonly scheduleMinutes: number | null;
  readonly targets: readonly TargetStatus[];
  readonly canAddTargets: boolean;
  readonly requiresToken: boolean;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export function relativeAge(timestamp: string | null): string {
  if (timestamp === null) return "never";
  const then = Date.parse(timestamp);
  if (Number.isNaN(then)) return "unknown";

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${String(seconds)}s ago`;
  if (seconds < 3600) return `${String(Math.round(seconds / 60))}m ago`;
  if (seconds < 86_400) return `${String(Math.round(seconds / 3600))}h ago`;
  return `${String(Math.round(seconds / 86_400))}d ago`;
}

/** Wall-clock time, for reading a sequence of events in order. */
export function clockTime(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "--:--";
  const hours = String(parsed.getHours()).padStart(2, "0");
  const minutes = String(parsed.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

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
 * Showing last known good data is correct; presenting it as current is not.
 */
export function isShowingStaleData(
  state: OrchestrationState,
  hasRecords: boolean,
): boolean {
  return hasRecords && !CURRENT_DATA_STATES.has(state);
}

export interface StateBadge {
  readonly label: string;
  readonly tone: string;
  readonly glyph: string;
}

/**
 * A word, a tone, and a shape for every state.
 *
 * Only one hue carries meaning in this palette, so the word and the shape are
 * what actually communicate status. The colour reinforces; it never carries.
 */
export function describeState(state: OrchestrationState): StateBadge {
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
      return { label: "Schema drift", tone: "bad", glyph: "▲" };
    case "manual_review":
      return { label: "Needs review", tone: "bad", glyph: "▲" };
    case "retry_or_wait":
      return { label: "Waiting", tone: "warn", glyph: "◌" };
    default:
      return { label: "Idle", tone: "idle", glyph: "○" };
  }
}

export function badgeFor(target: TargetStatus): StateBadge {
  if (target.provisioning !== null) {
    return { label: "Building", tone: "busy", glyph: "◐" };
  }
  return describeState(target.state);
}

export function renderStatus(badge: StateBadge): string {
  return `<span class="status ${badge.tone}" role="status"><span class="glyph" aria-hidden="true">${badge.glyph}</span>${escapeHtml(badge.label)}</span>`;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

function meter(score: number | null): string {
  if (score === null) {
    return `<span class="meter"><span style="width:0%"></span></span>`;
  }
  const percent = Math.round(score * 100);
  return `<span class="meter${score < 0.6 ? " low" : ""}"><span style="width:${String(percent)}%"></span></span>`;
}

/**
 * The health panel.
 *
 * Every figure comes from the last recorded run. A component that could not be
 * measured shows a dash rather than a flattering default, because a scraper
 * claiming 100% before it has ever run is worse than one admitting it does not
 * know.
 */
export function renderHealth(target: TargetStatus): string {
  const badge = badgeFor(target);
  const rows: [string, number | null][] = [
    ["Extraction", target.health.extraction],
    ["Schema", target.health.schema],
    ["Freshness", target.health.freshness],
  ];

  const body = rows
    .map(
      ([label, score]) => `<div class="health-row">
                <span class="k">${label}</span>
                <span class="v">${formatScore(score)}</span>
                ${meter(score)}
              </div>`,
    )
    .join("\n              ");

  return `<div class="health">
            ${renderStatus(badge)}
            <div class="health-rows">
              ${body}
            </div>
            <p class="health-foot">Last checked <span class="time">${escapeHtml(relativeAge(target.health.checkedAt))}</span></p>
          </div>`;
}

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

export interface FeedItem {
  readonly at: string;
  readonly what: string;
  readonly why: string;
  readonly tone: "good" | "bad" | "plain";
  readonly running: boolean;
}

const STAGE_HEADLINES: Readonly<Record<PipelineStage, string>> = {
  validate: "Request accepted",
  build_scraper: "Building the extractor",
  collect: "Scrape started",
  read_output: "Output read",
  check_contract: "Data validated",
  classify: "Run classified",
  learn_contract: "Data contract learned",
  publish: "Data published",
  heal: "Repair agent activated",
  review_fix: "Proposed fix reviewed",
  apply_fix: "Fix applied to the same collector",
  verify: "Repair verified",
};

/** Headlines that read better once the step has finished. */
const DONE_HEADLINES: Partial<Record<PipelineStage, string>> = {
  collect: "Scrape completed",
  build_scraper: "Extractor built",
  heal: "Repair proposed",
  verify: "Scraper repaired successfully",
};

const FAILED_HEADLINES: Partial<Record<PipelineStage, string>> = {
  collect: "Scrape failed",
  build_scraper: "Extractor could not be built",
  check_contract: "Schema drift detected",
  read_output: "No usable output",
  heal: "Repair did not reach approval",
  review_fix: "Proposed fix rejected",
  verify: "Repair could not be verified",
};

/**
 * A skipped step needs its own wording.
 *
 * Reusing the done wording would be actively misleading: a skipped publish would
 * read "Data published" at the exact moment data was withheld, which is the one
 * confusion this whole product exists to prevent.
 */
const SKIPPED_HEADLINES: Partial<Record<PipelineStage, string>> = {
  publish: "Data withheld",
  learn_contract: "Contract already known",
  heal: "Repair not started",
  review_fix: "No fix to review",
  verify: "Nothing to verify",
};

export function stepsToFeed(steps: readonly PipelineStep[]): FeedItem[] {
  return steps.map((step) => {
    const fallback = STAGE_HEADLINES[step.stage];
    const headline =
      step.status === "failed"
        ? (FAILED_HEADLINES[step.stage] ?? fallback)
        : step.status === "done"
          ? (DONE_HEADLINES[step.stage] ?? fallback)
          : step.status === "skipped"
            ? (SKIPPED_HEADLINES[step.stage] ?? `${fallback} (not needed)`)
            : fallback;

    return {
      at: step.at,
      what: headline,
      why: step.detail,
      tone: step.status === "failed" ? "bad" : step.status === "done" ? "good" : "plain",
      running: step.status === "started",
    };
  });
}

const CLASSIFICATION_HEADLINES: Readonly<Record<string, string>> = {
  healthy: "Contract satisfied",
  legitimate_change: "Data changed, structure held",
  structural_break: "Schema drift detected",
  transient_error: "Could not connect",
  ambiguous: "Needs review",
};

export function eventsToFeed(events: readonly RepairEvent[]): FeedItem[] {
  return events.map((event) => ({
    at: event.createdAt,
    what: CLASSIFICATION_HEADLINES[event.classification] ?? event.classification,
    why: event.evidence[0] ?? "No explanation was recorded.",
    tone:
      event.classification === "healthy" || event.classification === "legitimate_change"
        ? "good"
        : "bad",
    running: false,
  }));
}

export function renderFeed(items: readonly FeedItem[], emptyMessage: string): string {
  if (items.length === 0) {
    return `<p class="muted small">${escapeHtml(emptyMessage)}</p>`;
  }

  const rows = items
    .map(
      (item) => `<li class="${item.running ? "started" : ""}">
              <span class="bullet ${item.tone === "plain" ? "" : item.tone}" aria-hidden="true">${
                item.tone === "good" ? "✓" : "●"
              }</span>
              <span class="at">${escapeHtml(clockTime(item.at))}</span>
              <span class="what">${escapeHtml(item.what)}<span class="why">${escapeHtml(item.why)}</span></span>
            </li>`,
    )
    .join("\n            ");

  return `<ul class="feed">
            ${rows}
          </ul>`;
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export function renderContractFields(contract: DataContract | null): string {
  if (contract === null || !isProfiled(contract)) {
    return `<p class="muted small">No contract yet. The first successful scrape defines one.</p>`;
  }
  if (contract.requiredFields.length === 0) {
    return `<p class="muted small">No field was present in every row, so none is being enforced.</p>`;
  }

  const rows = contract.requiredFields
    .map((field) => {
      const type = contract.fieldTypes[field];
      const identity = field === contract.identityField;
      return `<div class="field-row">
                <span class="ok" aria-hidden="true">✓</span>
                <span class="name">${escapeHtml(field)}</span>
                <span class="type">${escapeHtml(type ?? "any")}${identity ? " &middot; row identity" : ""}</span>
              </div>`;
    })
    .join("\n              ");

  return `<div class="fields">
              ${rows}
            </div>`;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const MAX_CELL_LENGTH = 80;

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
    return `<td><a href="${escapeHtml(text)}" rel="noreferrer noopener nofollow" target="_blank">${escapeHtml(shown)}</a></td>`;
  }
  return `<td>${escapeHtml(shown)}</td>`;
}

export function renderDataTable(
  records: readonly ScrapedRecord[],
  contract: DataContract | null,
  limit: number,
): string {
  const columns = tableColumns(contract, records, 8);

  if (columns.length === 0 || records.length === 0) {
    return `<p class="muted small">No verified data collected yet.</p>`;
  }

  const head = columns
    .map((column) => `<th scope="col">${escapeHtml(column)}</th>`)
    .join("");

  const body = records
    .slice(0, limit)
    .map(
      (record) =>
        `<tr>${columns.map((column) => renderCell(record[column])).join("")}</tr>`,
    )
    .join("\n              ");

  const more =
    records.length > limit
      ? `<tr><td colspan="${String(columns.length)}" class="muted small">and ${String(records.length - limit)} more row(s) &mdash; download the full set to see everything.</td></tr>`
      : "";

  return `<div class="scroll">
            <table>
              <thead><tr>${head}</tr></thead>
              <tbody>
              ${body}
              ${more}
              </tbody>
            </table>
          </div>`;
}

export function renderExportChips(target: TargetStatus): string {
  if (target.records.length === 0) {
    return "";
  }
  const links = EXPORT_FORMATS.map(
    (format) =>
      `<a class="chip" download href="/api/targets/${encodeURIComponent(target.id)}/export?format=${format}">${escapeHtml(EXPORT_LABELS[format])}</a>`,
  ).join("\n              ");

  return `<div class="chips">
              ${links}
            </div>`;
}

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------

export interface TimelineEntry {
  readonly event: RepairEvent;
  readonly repeats: number;
  readonly oldestAt: string;
}

/**
 * Collapses a repeated identical outcome into one entry with a count.
 *
 * Three consecutive runs failing the same way is one fact, not three.
 */
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

/** Reads a metrics pair as a sentence instead of "0/0". */
export function describeMetrics(event: RepairEvent): string {
  const phrase = (valid: number, total: number): string => {
    if (total === 0) return "no rows returned";
    if (valid === total) return `all ${String(total)} row(s) valid`;
    return `${String(valid)} of ${String(total)} row(s) valid`;
  };

  const before = phrase(event.beforeMetrics.validRowCount, event.beforeMetrics.rowCount);
  if (event.afterMetrics === null) {
    return before;
  }
  return `${before}, then ${phrase(
    event.afterMetrics.validRowCount,
    event.afterMetrics.rowCount,
  )} after the repair`;
}

export function renderRunHistory(events: readonly RepairEvent[]): string {
  if (events.length === 0) {
    return `<p class="muted small">No scrapes recorded yet.</p>`;
  }

  const rows = groupEvents(events)
    .map((entry) => {
      const { event, repeats } = entry;
      const headline =
        CLASSIFICATION_HEADLINES[event.classification] ?? event.classification;
      const verified =
        event.verification === "not_started"
          ? ""
          : ` &middot; ${event.verification === "passed" ? "verified recovered" : "verification failed"}`;
      const count = repeats > 1 ? ` &middot; ${String(repeats)} runs, same outcome` : "";
      const prompt =
        event.healPrompt === null
          ? ""
          : `<details><summary>Repair instruction sent to Scraper Studio</summary><p class="prompt">${escapeHtml(event.healPrompt)}</p></details>`;

      return `<li>
              <span class="bullet ${
                event.classification === "healthy" ||
                event.classification === "legitimate_change"
                  ? "good"
                  : "bad"
              }" aria-hidden="true">●</span>
              <span class="at">${escapeHtml(clockTime(event.createdAt))}</span>
              <span class="what">${escapeHtml(headline)}
                <span class="why">${escapeHtml(event.evidence[0] ?? "")}</span>
                <span class="why">${escapeHtml(describeMetrics(event))}${verified}${count}</span>
                ${prompt}
              </span>
            </li>`;
    })
    .join("\n            ");

  return `<ul class="feed">
            ${rows}
          </ul>`;
}

// ---------------------------------------------------------------------------
// Situation
// ---------------------------------------------------------------------------

export interface Situation {
  readonly summary: string;
  readonly nextStep: string | null;
}

/**
 * What is happening to this target, in plain language.
 *
 * The diagnosis is not recomputed here: the classifier already wrote a human
 * sentence into the run's evidence, and repeating that reasoning in the view
 * would let the two drift apart. This only decides what the reader should do.
 */
export function describeSituation(
  target: TargetStatus,
  autoHealEnabled: boolean,
): Situation {
  if (target.provisioning !== null) {
    return {
      summary: target.provisioning,
      nextStep: "Nothing to do. It collects automatically once the extractor exists.",
    };
  }
  if (target.busy) {
    return {
      summary: "Scraping, then validating the result against this site's contract.",
      nextStep: "A repair can take several minutes. This page refreshes on its own.",
    };
  }
  if (target.lastError !== null) {
    return {
      summary: `The scrape could not be started: ${target.lastError}`,
      nextStep: "Check that the Bright Data CLI is authenticated and the collector still exists.",
    };
  }

  const latest = target.events[0];
  if (latest === undefined) {
    return {
      summary:
        target.records.length > 0
          ? "Holding previously verified data. No scrape has been recorded since."
          : "Never scraped. Nothing has been verified for this site yet.",
      nextStep: "Choose Scrape now to run it.",
    };
  }

  const reason = latest.evidence[0] ?? "No explanation was recorded.";

  switch (latest.classification) {
    case "healthy":
      return {
        summary: `${reason} ${String(target.records.length)} row(s) published.`,
        nextStep: null,
      };
    case "legitimate_change":
      return {
        summary: `Values on the page changed but the structure held, so the new data was published. ${reason}`,
        nextStep: null,
      };
    case "structural_break":
      return {
        summary: `The page still loads, but extraction no longer matches it. ${reason}`,
        nextStep: autoHealEnabled
          ? "A repair should start on its own. If this persists, the proposed fix was rejected as implausible."
          : "Automatic repair is off. Set SUPASCRAPER_AUTO_HEAL=true to let it repair itself.",
      };
    case "transient_error":
      return {
        summary: reason,
        nextStep: "Nothing was repaired, because nothing reached the site.",
      };
    default:
      return {
        summary: reason,
        nextStep: "The evidence does not support a confident conclusion, so no repair was attempted.",
      };
  }
}
