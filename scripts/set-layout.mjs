#!/usr/bin/env node
/**
 * Selects the controlled target's active layout.
 *
 * Why this exists: the target stores its scenario in an ephemeral location, so
 * every Render deploy resets it to `baseline`. A healed collector only handles
 * the layout it was healed for, so after any deploy the layout must be set back
 * to the one the collector currently expects. Use this instead of `reset`.
 *
 * Usage:
 *   node scripts/set-layout.mjs <baseline|legitimate_change|structural_break|transient_error|reset>
 *
 * Reads TARGET_CONTROL_TOKEN and TARGET_BASE_URL from the environment, falling
 * back to a local .env file. The token is never printed.
 */
import { readFileSync } from "node:fs";

const MODES = new Set([
  "baseline",
  "legitimate_change",
  "structural_break",
  "transient_error",
  "reset",
]);

const DEFAULT_BASE_URL = "https://supascraper-target.onrender.com";

function readEnvFile() {
  const values = new Map();
  try {
    const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.trimStart().startsWith("#")) continue;
      const index = line.indexOf("=");
      if (index === -1) continue;
      values.set(
        line.slice(0, index).trim(),
        line.slice(index + 1).trim().replace(/^["']|["']$/g, ""),
      );
    }
  } catch {
    // A missing .env is fine when the values come from the environment.
  }
  return values;
}

const fileValues = readEnvFile();

/**
 * Environment wins over .env, which is conventional but can bite: a stale shell
 * variable silently shadows the real token and yields a baffling 401. Report the
 * source so that is diagnosable in seconds rather than mid-demo.
 */
function setting(key) {
  if (process.env[key]) {
    return { value: process.env[key], source: "environment" };
  }
  const fromFile = fileValues.get(key);
  if (fromFile) {
    return { value: fromFile, source: ".env" };
  }
  return { value: "", source: "missing" };
}

const mode = process.argv[2];
if (!mode || !MODES.has(mode)) {
  console.error(`usage: node scripts/set-layout.mjs <${[...MODES].join("|")}>`);
  process.exit(1);
}

const token = setting("TARGET_CONTROL_TOKEN");
if (!token.value) {
  console.error(
    "TARGET_CONTROL_TOKEN is not set. Copy it from the Render dashboard into .env.",
  );
  process.exit(1);
}
console.log(`token source: ${token.source} (length ${String(token.value.length)})`);

const baseSetting = setting("TARGET_BASE_URL");
const base = (baseSetting.value || DEFAULT_BASE_URL).replace(/\/+$/, "");

const response = await fetch(`${base}/__control/scenario`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token.value}` },
  body: JSON.stringify({ mode }),
});

if (!response.ok) {
  console.error(`failed: HTTP ${String(response.status)}`);
  if (response.status === 401 && token.source === "environment") {
    console.error(
      "The token came from the environment, not .env. A stale shell variable may be shadowing the real value.",
    );
  }
  process.exit(1);
}

const body = await response.json().catch(() => ({}));
console.log(`active layout: ${body.mode ?? "unknown"}`);

// Show which markup the detail pages now serve, so a mismatch with the
// collector is obvious before a demo rather than during one.
const detail = await fetch(`${base}/product/MTR-100`);
const html = await detail.text();
console.log(`detail page: HTTP ${String(detail.status)}`);
console.log(`  baseline markup:   ${html.includes("product-detail")}`);
console.log(`  restructured markup: ${html.includes("item-sheet")}`);
