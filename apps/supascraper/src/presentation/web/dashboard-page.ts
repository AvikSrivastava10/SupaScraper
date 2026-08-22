import { MAX_DESCRIPTION_LENGTH } from "../../application/add-target/validate-site.js";
import { formatScore } from "../../domain/health/health-score.js";
import {
  badgeFor,
  describeSituation,
  hostOf,
  isShowingStaleData,
  relativeAge,
  renderContractFields,
  renderExportChips,
  renderFeed,
  renderHealth,
  renderStatus,
  stepsToFeed,
  type DashboardStatus,
  type TargetStatus,
} from "./components.js";
import { escapeHtml, renderPage } from "./layout.js";

export type { DashboardStatus, TargetStatus } from "./components.js";
export { groupEvents, isShowingStaleData } from "./components.js";

/** Fields the contract watches, falling back to what the data actually has. */
function fieldCount(target: TargetStatus): number {
  if (target.contract !== null && target.contract.requiredFields.length > 0) {
    return target.contract.requiredFields.length;
  }
  const first = target.records[0];
  return first === undefined ? 0 : Object.keys(first).length;
}

function renderHero(status: DashboardStatus): string {
  const cta = status.canAddTargets
    ? `<div class="actions">
            <button id="reveal-form" type="button" aria-expanded="false" aria-controls="create-panel">+ Add a website</button>
          </div>`
    : `<p class="notice">The Bright Data CLI is not reachable from this process, so new extractors cannot be built.</p>`;

  return `      <section class="hero">
        <p class="eyebrow">Self-healing web intelligence</p>
        <h1>SupaScraper</h1>
        <p class="tagline">Your scraper shouldn't break when the web changes.</p>
        <p class="lede">Describe what you need. SupaScraper builds the extractor, validates the output, detects schema drift, and repairs itself.</p>
        ${cta}
        <div class="capabilities">
          <span class="capability"><span class="dot" aria-hidden="true"></span>Auto-healing</span>
          <span class="capability"><span class="dot" aria-hidden="true"></span>Data validation</span>
          <span class="capability"><span class="dot" aria-hidden="true"></span>Schema monitoring</span>
        </div>
      </section>`;
}

/**
 * The create panel, hidden until the hero's call to action reveals it.
 *
 * It starts closed because a large form is the wrong first impression for a
 * monitoring product: what matters on arrival is the state of what is already
 * being watched.
 */
function renderCreatePanel(status: DashboardStatus): string {
  if (!status.canAddTargets) {
    return "";
  }

  return `      <section class="panel" id="create-panel" aria-labelledby="create-heading" hidden>
        <h2 id="create-heading">Create a scraper</h2>
        <form id="add-form">
          <div class="two-col">
            <div>
              <label for="add-url">Website URL</label>
              <input id="add-url" name="url" type="url" required inputmode="url"
                     autocomplete="off" placeholder="https://github.com/trending">
              <p class="hint">A public HTTPS page. Scrape only data you are permitted to collect.</p>
            </div>
            <div>
              <label for="add-description">What do you need?</label>
              <textarea id="add-description" name="description" required rows="3"
                        maxlength="${String(MAX_DESCRIPTION_LENGTH)}"
                        placeholder="Extract repository name, stars, forks, language and URL."></textarea>
              <p class="hint">Plain language. Name the fields; Bright Data works out the markup.</p>
            </div>
          </div>
          <div>
            <label for="add-label">Name <span class="muted">(optional)</span></label>
            <input id="add-label" name="label" type="text" maxlength="60" placeholder="Open Source Radar">
          </div>
          <div class="form-foot">
            <span id="add-status" class="hint" role="status" aria-live="polite">Building takes 5 to 10 minutes. Everything else keeps running.</span>
            <button type="submit">Build intelligent scraper</button>
          </div>
        </form>
      </section>`;
}

function renderFleetStats(status: DashboardStatus): string {
  const scored = status.targets
    .map((target) => target.health.overall)
    .filter((score): score is number => score !== null);

  const fleetHealth =
    scored.length === 0
      ? null
      : scored.reduce((total, score) => total + score, 0) / scored.length;

  const records = status.targets.reduce(
    (total, target) => total + target.records.length,
    0,
  );
  const fields = status.targets.reduce(
    (total, target) => total + fieldCount(target),
    0,
  );
  const repairs = status.targets.reduce(
    (total, target) =>
      total + target.events.filter((event) => event.verification === "passed").length,
    0,
  );

  return `      <section class="panel">
        <div class="tiles">
          <div class="tile"><div class="figure">${String(status.targets.length)}</div><div class="caption">scrapers</div></div>
          <div class="tile accent"><div class="figure">${formatScore(fleetHealth)}</div><div class="caption">fleet health</div></div>
          <div class="tile"><div class="figure">${String(records)}</div><div class="caption">records</div></div>
          <div class="tile"><div class="figure">${String(fields)}</div><div class="caption">fields monitored</div></div>
          <div class="tile"><div class="figure">${String(repairs)}</div><div class="caption">self-repairs</div></div>
        </div>
      </section>`;
}

function renderCard(target: TargetStatus, autoHealEnabled: boolean): string {
  const badge = badgeFor(target);
  const situation = describeSituation(target, autoHealEnabled);
  const stale = isShowingStaleData(target.state, target.records.length > 0);
  const provisioning = target.provisioning !== null;
  const detail = `/scrapers/${encodeURIComponent(target.id)}`;
  const drift = target.events.filter(
    (event) => event.classification === "structural_break",
  ).length;

  return `        <article class="card" aria-labelledby="s-${escapeHtml(target.id)}">
          <div class="card-top">
            <div>
              ${renderStatus(badge)}
              <h2 id="s-${escapeHtml(target.id)}" style="margin-top:.5rem"><a href="${detail}">${escapeHtml(target.label)}</a></h2>
              <p class="host">${escapeHtml(hostOf(target.targetUrl))} &middot; <code>${escapeHtml(target.collectorId)}</code></p>
            </div>
            <a class="open" href="${detail}">Open &rarr;</a>
          </div>

          <p class="small" style="margin-top:.85rem">${escapeHtml(situation.summary)}</p>
          ${situation.nextStep === null ? "" : `<p class="hint">${escapeHtml(situation.nextStep)}</p>`}
          ${stale ? `<p class="notice">Showing the last verified data. The most recent scrape did not satisfy the contract, so its output was withheld.</p>` : ""}

          <div class="split">
            <div>
              <div class="tiles">
                <div class="tile"><div class="figure">${String(target.records.length)}</div><div class="caption">records</div></div>
                <div class="tile"><div class="figure">${String(fieldCount(target))}</div><div class="caption">fields</div></div>
                <div class="tile"><div class="figure">${formatScore(target.health.extraction)}</div><div class="caption">valid</div></div>
                <div class="tile"><div class="figure" style="font-size:1.05rem">${escapeHtml(relativeAge(target.collectedAt))}</div><div class="caption">last scrape</div></div>
              </div>

              <div style="margin-top:1.1rem">
                <h3>Data contract</h3>
                ${renderContractFields(target.contract)}
              </div>

              <div style="margin-top:1.1rem">
                <h3>Activity</h3>
                ${renderFeed(stepsToFeed(target.steps).slice(-6), "Nothing has run yet. Steps appear here as they happen.")}
              </div>
            </div>
            ${renderHealth(target)}
          </div>

          <div class="form-foot">
            <span class="hint">Schema drift events: <strong>${String(drift)}</strong> &middot; scrapes recorded: <strong>${String(target.events.length)}</strong></span>
            <span class="actions" style="margin:0">
              <button data-target="${escapeHtml(target.id)}" ${target.busy || provisioning ? "disabled" : ""}>${target.busy ? "Scraping..." : "Scrape now"}</button>
              <a class="btn btn-quiet" href="${detail}">Details</a>
            </span>
          </div>

          ${target.records.length === 0 ? "" : `<div style="margin-top:1rem"><h3>Download</h3>${renderExportChips(target)}</div>`}
        </article>`;
}

export function renderDashboardPage(status: DashboardStatus): string {
  const busy = status.targets.some(
    (target) => target.busy || target.provisioning !== null,
  );
  const stepInFlight = status.targets.some((target) =>
    target.steps.some((step) => step.status === "started"),
  );

  const cards =
    status.targets.length === 0
      ? `      <section class="panel"><div class="empty">
          <strong>No scrapers yet</strong>
          Add a website above. SupaScraper builds the extractor and learns what its data should look like.
        </div></section>`
      : `      <section>
        <div class="cards">
${status.targets.map((target) => renderCard(target, status.autoHealEnabled)).join("\n")}
        </div>
      </section>`;

  return renderPage({
    title: `SupaScraper${busy ? " — working" : ""}`,
    nav: "dashboard",
    refreshSeconds: busy ? (stepInFlight ? 6 : 15) : null,
    requiresToken: status.requiresToken,
    canAddTargets: status.canAddTargets,
    body: `${renderHero(status)}

${renderCreatePanel(status)}

${renderFleetStats(status)}

${cards}`,
  });
}
