import type { CatalogRecord, ScenarioMode } from "@supascraper/shared";

import { recordsForScenario } from "../scenarios/catalog-scenarios.js";
import type { HttpResponse } from "./http-response.js";

function escapeHtml(value: string): string {
  return value.replaceAll(/[&<>"]/g, (character) => {
    const entities: Readonly<Record<string, string>> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
    };

    return entities[character] ?? character;
  });
}

function formatPrice(price: number): string {
  return `$${price.toFixed(2)}`;
}

function renderBaselineRecord(record: CatalogRecord): string {
  return `
    <article class="product-card" data-sku="${escapeHtml(record.sku)}">
      <h2 class="product-name">${escapeHtml(record.name)}</h2>
      <p class="product-sku">SKU: ${escapeHtml(record.sku)}</p>
      <p class="product-price">${formatPrice(record.price)}</p>
      <p class="product-availability">${escapeHtml(record.availability)}</p>
    </article>`;
}

function renderStructuralRecord(record: CatalogRecord): string {
  return `
    <li class="inventory-entry" data-item-code="${escapeHtml(record.sku)}">
      <header><span data-field="title">${escapeHtml(record.name)}</span></header>
      <dl>
        <div><dt>Part number</dt><dd data-field="part-number">${escapeHtml(record.sku)}</dd></div>
        <div><dt>Current cost</dt><dd data-field="cost"><strong>${formatPrice(record.price)}</strong></dd></div>
        <div><dt>Stock status</dt><dd data-field="stock">${escapeHtml(record.availability)}</dd></div>
      </dl>
    </li>`;
}

function renderPage(scenario: ScenarioMode, records: readonly CatalogRecord[]): string {
  const structurallyChanged = scenario === "structural_break";
  const items = records
    .map((record) =>
      structurallyChanged
        ? renderStructuralRecord(record)
        : renderBaselineRecord(record),
    )
    .join("\n");

  const collection = structurallyChanged
    ? `<ul class="inventory-list">${items}</ul>`
    : `<section class="product-grid">${items}</section>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>SupaScraper Demo Supplier Catalog</title>
  </head>
  <body>
    <main>
      <h1>Demo Supplier Catalog</h1>
      <p>Public industrial component availability and pricing.</p>
      ${collection}
    </main>
  </body>
</html>`;
}

export function buildCatalogResponse(scenario: ScenarioMode): HttpResponse {
  if (scenario === "transient_error") {
    return {
      statusCode: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "30",
      },
      body: "<!doctype html><title>Temporarily unavailable</title><h1>Temporarily unavailable</h1>",
    };
  }

  return {
    statusCode: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
    body: renderPage(scenario, recordsForScenario(scenario)),
  };
}
