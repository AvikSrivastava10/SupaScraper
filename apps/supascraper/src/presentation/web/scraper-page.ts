import { formatScore } from "../../domain/health/health-score.js";
import {
  badgeFor,
  describeSituation,
  eventsToFeed,
  hostOf,
  isShowingStaleData,
  relativeAge,
  renderContractFields,
  renderDataTable,
  renderExportChips,
  renderFeed,
  renderHealth,
  renderRunHistory,
  renderStatus,
  stepsToFeed,
  type DashboardStatus,
  type TargetStatus,
} from "./components.js";
import { escapeHtml, renderPage } from "./layout.js";

export const SCRAPER_TABS = ["overview", "data", "contract", "activity"] as const;
export type ScraperTab = (typeof SCRAPER_TABS)[number];

export function isScraperTab(value: string): value is ScraperTab {
  return (SCRAPER_TABS as readonly string[]).includes(value);
}

const TAB_LABELS: Readonly<Record<ScraperTab, string>> = {
  overview: "Overview",
  data: "Data",
  contract: "Contract",
  activity: "Activity",
};

function renderTabs(targetId: string, active: ScraperTab): string {
  const base = `/scrapers/${encodeURIComponent(targetId)}`;
  const links = SCRAPER_TABS.map(
    (tab) =>
      `<a href="${base}${tab === "overview" ? "" : `?tab=${tab}`}"${
        tab === active ? ' aria-current="page"' : ""
      }>${TAB_LABELS[tab]}</a>`,
  ).join("\n          ");

  return `      <nav class="tabs" aria-label="Scraper sections">
          ${links}
      </nav>`;
}

function renderOverview(target: TargetStatus, autoHealEnabled: boolean): string {
  const situation = describeSituation(target, autoHealEnabled);
  const stale = isShowingStaleData(target.state, target.records.length > 0);

  return `      <section class="panel">
        <h3>Current state</h3>
        <p>${escapeHtml(situation.summary)}</p>
        ${situation.nextStep === null ? "" : `<p class="hint">${escapeHtml(situation.nextStep)}</p>`}
        ${stale ? `<p class="notice">Showing the last verified data. The most recent scrape did not satisfy the contract, so its output was withheld.</p>` : ""}
        ${target.lastError === null ? "" : `<p class="notice bad">${escapeHtml(target.lastError)}</p>`}
      </section>

      <div class="split">
        <section class="panel" style="margin:0">
          <h3>Live activity</h3>
          ${renderFeed(stepsToFeed(target.steps), "Nothing has run yet. Steps appear here as they happen.")}
        </section>
        ${renderHealth(target)}
      </div>

      <section class="panel">
        <h3>Extraction target</h3>
        <p class="small">Bright Data was asked for this, in these words:</p>
        <p class="prompt">${escapeHtml(target.fieldDescription)}</p>
        <p class="hint">Collector <code>${escapeHtml(target.collectorId)}</code> &middot; every repair reuses this same id, so nothing downstream changes.</p>
      </section>`;
}

function renderData(target: TargetStatus): string {
  return `      <section class="panel">
        <div class="row-between">
          <h3 style="margin:0">Verified data</h3>
          <span class="hint">${String(target.records.length)} record(s) &middot; last verified <span class="time">${escapeHtml(relativeAge(target.collectedAt))}</span></span>
        </div>
        <p class="hint" style="margin-bottom:.8rem">Only output that satisfied the contract appears here. There is no endpoint that returns unverified rows.</p>
        ${renderDataTable(target.records, target.contract, 50)}
      </section>

      ${
        target.records.length === 0
          ? ""
          : `<section class="panel">
        <h3>Download</h3>
        <p class="hint" style="margin-bottom:.7rem">Every field the site returned, not just the columns shown above.</p>
        ${renderExportChips(target)}
      </section>`
      }`;
}

function renderContract(target: TargetStatus): string {
  const contract = target.contract;
  const monitored =
    contract === null ? 0 : contract.requiredFields.length;

  return `      <section class="panel">
        <div class="row-between">
          <h3 style="margin:0">Data contract</h3>
          <span class="hint">${String(monitored)} field(s) monitored</span>
        </div>
        <p class="hint" style="margin-bottom:.9rem">Learned from the first scrape that satisfied validation. Nobody wrote this down; it was taken from the data.</p>
        ${renderContractFields(contract)}
      </section>

      <section class="panel">
        <h3>Schema integrity</h3>
        <div class="tiles">
          <div class="tile accent"><div class="figure">${formatScore(target.health.schema)}</div><div class="caption">fields intact</div></div>
          <div class="tile"><div class="figure">${formatScore(target.health.extraction)}</div><div class="caption">rows valid</div></div>
          <div class="tile"><div class="figure">${String(
            target.events.filter((event) => event.classification === "structural_break").length,
          )}</div><div class="caption">drift events</div></div>
          <div class="tile"><div class="figure">${String(
            target.events.filter((event) => event.verification === "passed").length,
          )}</div><div class="caption">verified repairs</div></div>
        </div>
      </section>

      ${
        contract === null
          ? ""
          : `<section class="panel">
        <h3>Rules being enforced</h3>
        <ul class="small" style="margin:0; padding-left:1.1rem">
          <li>Every scrape must return between ${String(contract.minimumRows)} and ${String(contract.maximumRows)} rows.</li>
          <li>Each listed field must be present and non-empty in every row.</li>
          <li>Each field must keep the type it was learned with. A list that becomes a string is a violation.</li>
          <li>${
            contract.identityField === null
              ? "No unique identifier was found, so rows are compared whole."
              : `<code>${escapeHtml(contract.identityField)}</code> must be unique. A repeat means extraction matched the same element twice.`
          }</li>
        </ul>
        <p class="hint">Learned <span class="time">${escapeHtml(relativeAge(contract.profiledAt))}</span>.</p>
      </section>`
      }`;
}

function renderActivity(target: TargetStatus): string {
  const healing = target.events.filter(
    (event) =>
      event.healPrompt !== null || event.classification === "structural_break",
  );

  return `      <section class="panel">
        <h3>This attempt</h3>
        ${renderFeed(stepsToFeed(target.steps), "Nothing has run yet. Steps appear here as they happen.")}
      </section>

      <section class="panel">
        <h3>Self-healing events</h3>
        ${
          healing.length === 0
            ? `<p class="muted small">No schema drift has been detected for this site yet.</p>`
            : renderFeed(eventsToFeed(healing), "")
        }
      </section>

      <section class="panel">
        <h3>Scrape history</h3>
        ${renderRunHistory(target.events)}
      </section>`;
}

export function renderScraperPage(
  target: TargetStatus,
  tab: ScraperTab,
  status: DashboardStatus,
): string {
  const badge = badgeFor(target);
  const provisioning = target.provisioning !== null;
  const stepInFlight = target.steps.some((step) => step.status === "started");

  const panel =
    tab === "data"
      ? renderData(target)
      : tab === "contract"
        ? renderContract(target)
        : tab === "activity"
          ? renderActivity(target)
          : renderOverview(target, status.autoHealEnabled);

  return renderPage({
    title: `${target.label} — SupaScraper`,
    nav: "scrapers",
    refreshSeconds:
      target.busy || provisioning ? (stepInFlight ? 6 : 15) : null,
    requiresToken: status.requiresToken,
    canAddTargets: status.canAddTargets,
    body: `      <p class="small"><a href="/scrapers">&larr; Scrapers</a></p>
      <section class="hero" style="padding:1.35rem 1.5rem">
        <div class="row-between">
          <div>
            <h1 style="font-size:1.7rem">${escapeHtml(target.label)}</h1>
            <p class="host"><a href="${escapeHtml(target.targetUrl)}" rel="noreferrer noopener nofollow" target="_blank">${escapeHtml(hostOf(target.targetUrl))}</a>
              &middot; ${target.controllable ? "layout switchable" : "site we do not control"}</p>
          </div>
          ${renderStatus(badge)}
        </div>
        <div class="actions">
          <button data-target="${escapeHtml(target.id)}" ${target.busy || provisioning ? "disabled" : ""}>${target.busy ? "Scraping..." : "Scrape now"}</button>
          <span class="hint">${
            provisioning
              ? "Available once the extractor is built."
              : "Runs the collector once and validates the result."
          }</span>
        </div>
      </section>

${renderTabs(target.id, tab)}

${panel}`,
  });
}
