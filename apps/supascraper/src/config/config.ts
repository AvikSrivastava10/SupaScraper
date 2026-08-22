import type { CollectorConfig } from "../domain/contracts/collector-run.js";
import {
  loadTargetsFile,
  singleTarget,
  type TargetConfig,
} from "./targets.js";

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly dataPath: string;
  readonly geminiEnabled: boolean;
  /**
   * Which Gemini model to call.
   *
   * Configurable because Google retires these on a schedule. The previous
   * default, `gemini-2.0-flash`, was shut down on 1 June 2026 and the failure was
   * invisible: every Gemini error degrades to "no opinion", so a dead model name
   * looks exactly like a model that had nothing to add.
   */
  readonly geminiModel: string;
  /** Off unless explicitly enabled: healing mutates a hosted collector. */
  readonly autoHealEnabled: boolean;
  /** Null means no unattended runs. */
  readonly scheduleIntervalMs: number | null;
  readonly apiToken: string | null;
  /** Sites defined ahead of time. Sites added at runtime live in the registry. */
  readonly targets: readonly TargetConfig[];
  /** Where sites added through the dashboard are persisted. */
  readonly addedTargetsPath: string;
  /** Run timeout given to a target added at runtime. */
  readonly defaultRunTimeoutMs: number;
  /** Retained for the single-collector path; prefer `targets`. */
  readonly collector: CollectorConfig | null;
}

/** Google's stated replacement for the retired `gemini-2.0-flash`. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
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

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "" || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new Error(`${name} must be true or false.`);
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
    // Observed live: a run polls for anywhere from seconds to a few minutes.
    // Two minutes was too tight and produced spurious timeouts.
    timeoutMs: parsePositiveInteger(
      environment["SUPASCRAPER_RUN_TIMEOUT_MS"],
      420_000,
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

  // Loopback by default: the run endpoint spends Bright Data credit, so it must
  // not be exposed to the network unless that is an explicit choice.
  const host = environment["SUPASCRAPER_HOST"] ?? "127.0.0.1";
  const apiToken = environment["SUPASCRAPER_API_TOKEN"] ?? null;

  // Absent means no schedule. Unattended runs are opt-in.
  const rawInterval = environment["SUPASCRAPER_SCHEDULE_MINUTES"];
  let scheduleIntervalMs: number | null = null;
  if (rawInterval !== undefined && rawInterval !== "" && rawInterval !== "0") {
    const minutes = parsePositiveInteger(
      rawInterval,
      0,
      "SUPASCRAPER_SCHEDULE_MINUTES",
    );
    if (minutes < 5) {
      throw new Error(
        "SUPASCRAPER_SCHEDULE_MINUTES must be at least 5, because every scheduled run consumes Bright Data credit.",
      );
    }
    scheduleIntervalMs = minutes * 60_000;
  }

  if (!isLoopbackHost(host) && (apiToken === null || apiToken.length < 16)) {
    throw new Error(
      "Binding SUPASCRAPER_HOST to a non-loopback address requires SUPASCRAPER_API_TOKEN of at least 16 characters, because the run endpoint consumes Bright Data credit.",
    );
  }

  const collector = loadCollectorConfig(environment);
  const targetsPath = environment["SUPASCRAPER_TARGETS_PATH"];
  const defaultTimeout = collector?.timeoutMs ?? 420_000;

  // A targets file supports several sites at once. Without one, the single
  // environment-configured collector is used, so existing setups keep working.
  const targets =
    targetsPath !== undefined && targetsPath !== ""
      ? loadTargetsFile(targetsPath, defaultTimeout)
      : collector === null
        ? []
        : [singleTarget(collector)];

  return {
    host,
    port,
    targets,
    addedTargetsPath:
      environment["SUPASCRAPER_ADDED_TARGETS_PATH"] ??
      "./data/supascraper-targets.json",
    defaultRunTimeoutMs: defaultTimeout,
    dataPath: environment["SUPASCRAPER_DATA_PATH"] ?? "./data/supascraper-state.json",
    geminiEnabled: parseBoolean(
      environment["SUPASCRAPER_GEMINI_ENABLED"],
      "SUPASCRAPER_GEMINI_ENABLED",
    ),
    geminiModel: environment["SUPASCRAPER_GEMINI_MODEL"]?.trim() || DEFAULT_GEMINI_MODEL,
    autoHealEnabled: parseBoolean(
      environment["SUPASCRAPER_AUTO_HEAL"],
      "SUPASCRAPER_AUTO_HEAL",
    ),
    scheduleIntervalMs,
    apiToken,
    collector,
  };
}
