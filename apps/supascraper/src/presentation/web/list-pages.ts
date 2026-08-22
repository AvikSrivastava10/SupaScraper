import { formatScore } from "../../domain/health/health-score.js";
import {
  badgeFor,
  clockTime,
  eventsToFeed,
  hostOf,
  relativeAge,
  renderDataTable,
  renderExportChips,
  renderFeed,
  renderStatus,
  type DashboardStatus,
  type TargetStatus,
} from "./components.js";
import { escapeHtml, renderPage } from "./layout.js";

function pageHeader(title: string, lede: string): string {
  return `      <section class="hero" style="padding:1.35rem 1.5rem">
        <h1 style="font-size:1.7rem">${escapeHtml(title)}</h1>
        <p class="lede small">${escapeHtml(lede)}</p>
      </section>`;
}

function anyBusy(status: DashboardStatus): number | null {
  const busy = status.targets.some(
    (target) => target.busy || target.provisioning !== null,
  );
  if (!busy) return null;
  return status.targets.some((target) =>
    target.steps.some((step) => step.status === "started"),
  )
    ? 6
    : 15;
}

// ---------------------------------------------------------------------------
// Scrapers
// ---------------------------------------------------------------------------

function renderRow(target: TargetStatus): string {
  const detail = `/scrapers/${encodeURIComponent(target.id)}`;
  return `            <tr>
              <td>${renderStatus(badgeFor(target))}</td>
              <td><a href="${detail}"><strong>${escapeHtml(target.label)}</strong></a><br><span class="muted small">${escapeHtml(hostOf(target.targetUrl))}</span></td>
              <td class="num">${String(target.records.length)}</td>
              <td class="num">${formatScore(target.health.overall)}</td>
              <td><span class="time">${escapeHtml(relativeAge(target.collectedAt))}</span></td>
              <td><a class="chip" href="${detail}">Open</a></td>
            </tr>`;
}

export function renderScrapersPage(status: DashboardStatus): string {
  const body =
    status.targets.length === 0
      ? `      <section class="panel"><div class="empty">
          <strong>No scrapers yet</strong>
          Add a website from the dashboard to get started.
        </div></section>`
      : `      <section class="panel">
        <div class="scroll">
          <table>
            <thead><tr>
              <th scope="col">Status</th><th scope="col">Scraper</th>
              <th scope="col">Records</th><th scope="col">Health</th>
              <th scope="col">Last scrape</th><th scope="col"></th>
            </tr></thead>
            <tbody>
${status.targets.map((target) => renderRow(target)).join("\n")}
            </tbody>
          </table>
        </div>
      </section>`;

  return renderPage({
    title: "Scrapers — SupaScraper",
    nav: "scrapers",
    refreshSeconds: anyBusy(status),
    requiresToken: status.requiresToken,
    canAddTargets: status.canAddTargets,
    body: `${pageHeader("Scrapers", "Every site being watched, and the health of its extractor.")}

${body}`,
  });
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

interface DatedItem {
  readonly at: string;
  readonly html: string;
}

/**
 * One feed across every scraper, newest first.
 *
 * Each line names its scraper, because the whole point of this page is seeing
 * that a repair happened somewhere without having to open each site in turn.
 */
export function renderActivityPage(status: DashboardStatus): string {
  const items: DatedItem[] = [];

  for (const target of status.targets) {
    for (const item of eventsToFeed(target.events)) {
      items.push({
        at: item.at,
        html: `            <li>
              <span class="bullet ${item.tone === "plain" ? "" : item.tone}" aria-hidden="true">${item.tone === "good" ? "✓" : "●"}</span>
              <span class="at">${escapeHtml(clockTime(item.at))}</span>
              <span class="what">${escapeHtml(item.what)}
                <span class="why">${escapeHtml(target.label)} &middot; ${escapeHtml(item.why)}</span>
                <span class="why"><a href="/scrapers/${encodeURIComponent(target.id)}?tab=activity">Open scraper</a> &middot; <span class="time">${escapeHtml(relativeAge(item.at))}</span></span>
              </span>
            </li>`,
      });
    }
  }

  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const repairs = status.targets.reduce(
    (total, target) =>
      total + target.events.filter((event) => event.verification === "passed").length,
    0,
  );
  const drift = status.targets.reduce(
    (total, target) =>
      total +
      target.events.filter((event) => event.classification === "structural_break").length,
    0,
  );

  const feed =
    items.length === 0
      ? `<p class="muted small">Nothing recorded yet.</p>`
      : `<ul class="feed">
${items.slice(0, 60).map((item) => item.html).join("\n")}
          </ul>`;

  return renderPage({
    title: "Activity — SupaScraper",
    nav: "activity",
    refreshSeconds: anyBusy(status),
    requiresToken: status.requiresToken,
    canAddTargets: status.canAddTargets,
    body: `${pageHeader("Activity", "Every scrape, drift detection, and repair across all scrapers.")}

      <section class="panel">
        <div class="tiles">
          <div class="tile"><div class="figure">${String(items.length)}</div><div class="caption">recorded runs</div></div>
          <div class="tile"><div class="figure">${String(drift)}</div><div class="caption">drift events</div></div>
          <div class="tile accent"><div class="figure">${String(repairs)}</div><div class="caption">verified repairs</div></div>
        </div>
      </section>

      <section class="panel">
        <h3>Newest first</h3>
        ${feed}
      </section>`,
  });
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export function renderDataPage(status: DashboardStatus): string {
  const withData = status.targets.filter((target) => target.records.length > 0);
  const total = withData.reduce((sum, target) => sum + target.records.length, 0);

  const sections =
    withData.length === 0
      ? `      <section class="panel"><div class="empty">
          <strong>Nothing verified yet</strong>
          Verified data appears here once a scrape satisfies its contract.
        </div></section>`
      : withData
          .map(
            (target) => `      <section class="panel">
        <div class="row-between">
          <h2><a href="/scrapers/${encodeURIComponent(target.id)}?tab=data">${escapeHtml(target.label)}</a></h2>
          <span class="hint">${String(target.records.length)} record(s) &middot; <span class="time">${escapeHtml(relativeAge(target.collectedAt))}</span></span>
        </div>
        <div style="margin-top:.8rem">${renderDataTable(target.records, target.contract, 10)}</div>
        <div style="margin-top:.9rem"><h3>Download</h3>${renderExportChips(target)}</div>
      </section>`,
          )
          .join("\n");

  return renderPage({
    title: "Data — SupaScraper",
    nav: "data",
    refreshSeconds: anyBusy(status),
    requiresToken: status.requiresToken,
    canAddTargets: status.canAddTargets,
    body: `${pageHeader("Data", `${String(total)} verified record(s) across ${String(withData.length)} scraper(s). Unverified output never appears here.`)}

${sections}`,
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function toggle(label: string, on: boolean, detail: string): string {
  return `          <div class="health-row" style="grid-template-columns:1fr auto">
            <span class="k">${escapeHtml(label)}<span class="why muted small" style="display:block">${escapeHtml(detail)}</span></span>
            <span class="v">${on ? `<span style="color:var(--good)">On</span>` : `<span class="muted">Off</span>`}</span>
          </div>`;
}

/**
 * A read-only view of how this instance is configured.
 *
 * Deliberately shows no secret and no value that could reveal one, only whether
 * each capability is active.
 */
export function renderSettingsPage(status: DashboardStatus): string {
  return renderPage({
    title: "Settings — SupaScraper",
    nav: "settings",
    refreshSeconds: null,
    requiresToken: status.requiresToken,
    canAddTargets: status.canAddTargets,
    body: `${pageHeader("Settings", "How this instance is configured. Values are read from the environment; no secret is shown here.")}

      <section class="panel">
        <h3>Capabilities</h3>
        <div class="health-rows">
${toggle("Automatic repair", status.autoHealEnabled, "A confident schema drift repairs itself, then must pass verification before publishing.")}
${toggle("Gemini second opinion", status.geminiEnabled, "Consulted only on ambiguous and drift verdicts. It can downgrade a repair, never trigger one.")}
${toggle("Build new extractors", status.canAddTargets, "Requires the Bright Data CLI to be reachable from this process.")}
${toggle("Write endpoints protected", status.requiresToken, "A bearer token is required to start a scrape or add a site.")}
        </div>
      </section>

      <section class="panel">
        <h3>Schedule</h3>
        <p>${
          status.scheduleMinutes === null
            ? "No unattended scrapes. Everything runs on demand."
            : `Every <strong>${String(status.scheduleMinutes)}</strong> minutes, roughly <strong>${String(
                Math.round((24 * 60) / status.scheduleMinutes),
              )}</strong> scrapes per scraper per day.`
        }</p>
        <p class="hint">Each scrape consumes Bright Data credit, so the interval has a five-minute floor and unattended runs are opt-in. Change it with <code>SUPASCRAPER_SCHEDULE_MINUTES</code> and restart.</p>
      </section>

      <section class="panel">
        <h3>How health is measured</h3>
        <ul class="small" style="margin:0; padding-left:1.1rem">
          <li><strong>Extraction</strong> is the share of returned rows that satisfied the contract.</li>
          <li><strong>Schema</strong> is the share of contract fields present and non-empty in every row, counted per field so one field vanishing everywhere is not averaged away.</li>
          <li><strong>Freshness</strong> compares the age of the verified data against the expected cadence. Without a schedule there is no cadence, so it reads as a dash rather than a number.</li>
        </ul>
        <p class="hint">A component that cannot be measured shows a dash. Nothing here is defaulted to a flattering value.</p>
      </section>`,
  });
}
