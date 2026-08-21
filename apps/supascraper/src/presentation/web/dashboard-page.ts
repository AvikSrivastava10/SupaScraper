import type { CatalogRecord } from "@supascraper/shared";

import type { OrchestrationState } from "../../domain/state-machine/state-machine.js";

export interface DashboardStatus {
  readonly configured: boolean;
  readonly collectorId: string | null;
  readonly targetUrl: string | null;
  readonly state: OrchestrationState;
  readonly records: readonly CatalogRecord[];
  readonly collectedAt: string | null;
  readonly eventCount: number;
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

function renderRows(records: readonly CatalogRecord[]): string {
  if (records.length === 0) {
    return '<tr><td colspan="4">No verified catalog data has been collected yet.</td></tr>';
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

export function renderDashboardPage(status: DashboardStatus): string {
  const collector = status.collectorId ?? "Not configured";
  const freshness = status.collectedAt ?? "No successful run";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>SupaScraper</title>
    <style>
      :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #0b1020; color: #eef2ff; }
      body { margin: 0; }
      main { width: min(100% - 2rem, 72rem); margin: 0 auto; padding: 3rem 0; }
      header, section { background: #151d35; border: 1px solid #2b385f; border-radius: 1rem; padding: 1.25rem; margin-bottom: 1rem; }
      .status { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: 1rem; }
      .label { color: #9eabd0; font-size: .8rem; text-transform: uppercase; }
      .value { font-weight: 700; overflow-wrap: anywhere; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border-bottom: 1px solid #2b385f; padding: .75rem; text-align: left; }
      .notice { color: #f8d477; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <p class="label">Self-healing data contract guardian</p>
        <h1>SupaScraper</h1>
        <p class="notice">Initial scaffold: Bright Data execution remains disabled until the capability and manual vertical-slice phases are verified.</p>
      </header>
      <section class="status" aria-label="Collector status">
        <div><div class="label">Configured</div><div class="value">${status.configured ? "Yes" : "No"}</div></div>
        <div><div class="label">Collector</div><div class="value">${escapeHtml(collector)}</div></div>
        <div><div class="label">State</div><div class="value">${status.state}</div></div>
        <div><div class="label">Last verified data</div><div class="value">${escapeHtml(freshness)}</div></div>
        <div><div class="label">Events</div><div class="value">${status.eventCount}</div></div>
      </section>
      <section>
        <h2>Verified supplier catalog</h2>
        <table>
          <thead><tr><th>Name</th><th>SKU</th><th>Price</th><th>Availability</th></tr></thead>
          <tbody>${renderRows(status.records)}</tbody>
        </table>
      </section>
    </main>
  </body>
</html>`;
}
