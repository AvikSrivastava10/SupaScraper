import type { CollectorConfig } from "../domain/contracts/collector-run.js";

export interface AppConfig {
  readonly port: number;
  readonly geminiEnabled: boolean;
  readonly collector: CollectorConfig | null;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function parseBoolean(value: string | undefined): boolean {
  if (value === undefined || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new Error("SUPASCRAPER_GEMINI_ENABLED must be true or false.");
}

function loadCollectorConfig(environment: NodeJS.ProcessEnv): CollectorConfig | null {
  const collectorId = environment["SUPASCRAPER_COLLECTOR_ID"];
  const targetUrl = environment["SUPASCRAPER_TARGET_URL"];

  if (!collectorId && !targetUrl) {
    return null;
  }
  if (!collectorId || !targetUrl) {
    throw new Error(
      "SUPASCRAPER_COLLECTOR_ID and SUPASCRAPER_TARGET_URL must be configured together.",
    );
  }
  if (!collectorId.startsWith("c_")) {
    throw new Error("SUPASCRAPER_COLLECTOR_ID must start with c_.");
  }

  const parsedTargetUrl = new URL(targetUrl);
  if (parsedTargetUrl.protocol !== "https:" && parsedTargetUrl.hostname !== "localhost") {
    throw new Error("SUPASCRAPER_TARGET_URL must use HTTPS unless it is localhost.");
  }

  return {
    collectorId,
    targetUrl: parsedTargetUrl.toString(),
    fieldDescription:
      environment["SUPASCRAPER_FIELD_DESCRIPTION"] ??
      "Extract product name, SKU, numeric price, and availability.",
    timeoutMs: parsePositiveInteger(
      environment["SUPASCRAPER_RUN_TIMEOUT_MS"],
      120_000,
      "SUPASCRAPER_RUN_TIMEOUT_MS",
    ),
  };
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const port = parsePositiveInteger(
    environment["SUPASCRAPER_PORT"],
    3000,
    "SUPASCRAPER_PORT",
  );
  if (port > 65_535) {
    throw new Error("SUPASCRAPER_PORT must not exceed 65535.");
  }

  return {
    port,
    geminiEnabled: parseBoolean(environment["SUPASCRAPER_GEMINI_ENABLED"]),
    collector: loadCollectorConfig(environment),
  };
}
