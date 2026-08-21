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

function productPath(sku: string): string {
  return `/product/${encodeURIComponent(sku)}`;
}

function htmlResponse(statusCode: number, body: string): HttpResponse {
  return {
    statusCode,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
    body,
  };
}

const TRANSIENT_RESPONSE: HttpResponse = {
  statusCode: 503,
  headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "retry-after": "30",
  },
  body: "<!doctype html><title>Temporarily unavailable</title><h1>Temporarily unavailable</h1>",
};

function page(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <main>
${content}
    </main>
  </body>
</html>`;
}

// ---------------------------------------------------------------------------
// Listing page. Used by the collector for discovery, so every product must
// expose a real link rather than leaving the URL pattern to be guessed.
// ---------------------------------------------------------------------------

function renderBaselineCard(record: CatalogRecord): string {
  return `
      <article class="product-card" data-sku="${escapeHtml(record.sku)}">
        <h2 class="product-name">${escapeHtml(record.name)}</h2>
        <p class="product-sku">SKU: ${escapeHtml(record.sku)}</p>
        <p class="product-price">${formatPrice(record.price)}</p>
        <p class="product-availability">${escapeHtml(record.availability)}</p>
        <a class="product-link" href="${productPath(record.sku)}">View details</a>
      </article>`;
}

function renderStructuralCard(record: CatalogRecord): string {
  return `
      <li class="inventory-entry" data-item-code="${escapeHtml(record.sku)}">
        <header><span data-field="title">${escapeHtml(record.name)}</span></header>
        <dl>
          <div><dt>Part number</dt><dd data-field="part-number">${escapeHtml(record.sku)}</dd></div>
          <div><dt>Current cost</dt><dd data-field="cost"><strong>${formatPrice(record.price)}</strong></dd></div>
          <div><dt>Stock status</dt><dd data-field="stock">${escapeHtml(record.availability)}</dd></div>
        </dl>
        <a class="inventory-link" href="${productPath(record.sku)}">Open item</a>
      </li>`;
}

function renderListing(
  scenario: ScenarioMode,
  records: readonly CatalogRecord[],
): string {
  const structural = scenario === "structural_break";
  const items = records
    .map((record) => (structural ? renderStructuralCard(record) : renderBaselineCard(record)))
    .join("\n");

  const collection = structural
    ? `      <ul class="inventory-list">\n${items}\n      </ul>`
    : `      <section class="product-grid">\n${items}\n      </section>`;

  return page(
    "Demo Supplier Catalog",
    `      <h1>Demo Supplier Catalog</h1>
      <p>Public industrial component availability and pricing.</p>
${collection}`,
  );
}

export function buildCatalogResponse(scenario: ScenarioMode): HttpResponse {
  if (scenario === "transient_error") {
    return TRANSIENT_RESPONSE;
  }

  return htmlResponse(200, renderListing(scenario, recordsForScenario(scenario)));
}

// ---------------------------------------------------------------------------
// Product detail page. This is where the collector extracts its fields, so the
// structural break has to change this markup to produce a real extraction
// failure rather than a transport failure.
// ---------------------------------------------------------------------------

function renderBaselineDetail(record: CatalogRecord): string {
  return `      <article class="product-detail" data-sku="${escapeHtml(record.sku)}">
        <h1 class="product-name">${escapeHtml(record.name)}</h1>
        <p class="product-sku">SKU: ${escapeHtml(record.sku)}</p>
        <p class="product-price">${formatPrice(record.price)}</p>
        <p class="product-availability">${escapeHtml(record.availability)}</p>
      </article>
      <a class="back-link" href="/catalog">Back to catalog</a>`;
}

function renderStructuralDetail(record: CatalogRecord): string {
  return `      <section class="item-sheet" data-item-code="${escapeHtml(record.sku)}">
        <header>
          <span data-field="title">${escapeHtml(record.name)}</span>
        </header>
        <table class="spec-table">
          <tbody>
            <tr><th>Part number</th><td data-field="part-number">${escapeHtml(record.sku)}</td></tr>
            <tr><th>Current cost</th><td data-field="cost"><strong class="amount">${formatPrice(record.price)}</strong></td></tr>
            <tr><th>Stock status</th><td data-field="stock">${escapeHtml(record.availability)}</td></tr>
          </tbody>
        </table>
      </section>
      <a class="inventory-link" href="/catalog">Back to inventory</a>`;
}

export function buildProductResponse(
  scenario: ScenarioMode,
  sku: string,
): HttpResponse {
  if (scenario === "transient_error") {
    return TRANSIENT_RESPONSE;
  }

  const record = recordsForScenario(scenario).find(
    (candidate) => candidate.sku.toLowerCase() === sku.toLowerCase(),
  );

  if (!record) {
    return htmlResponse(
      404,
      page("Product not found", "      <h1>Product not found</h1>"),
    );
  }

  const content =
    scenario === "structural_break"
      ? renderStructuralDetail(record)
      : renderBaselineDetail(record);

  return htmlResponse(200, page(`${record.name} — ${record.sku}`, content));
}
