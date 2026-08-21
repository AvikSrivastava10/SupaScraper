import { readFileSync } from "node:fs";

import type { CollectorConfig } from "../domain/contracts/collector-run.js";

export interface TargetConfig extends CollectorConfig {
  /** Stable key used in URLs and storage. */
  readonly id: string;
  /** Shown on the dashboard. */
  readonly label: string;
  /**
   * Whether this target's markup can be changed on demand.
   *
   * Only the controlled demo site can be broken deliberately. A real external
   * site cannot, which is precisely why both exist: one proves the pipeline
   * works on the open web, the other proves the repair works on cue.
   */
  readonly controllable: boolean;
}

export class TargetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetConfigError";
  }
}

function requireString(
  source: Record<string, unknown>,
  key: string,
  index: number,
): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TargetConfigError(`Target ${String(index)} is missing "${key}".`);
  }
  return value.trim();
}

function validate(target: TargetConfig): TargetConfig {
  if (!target.collectorId.startsWith("c_")) {
    throw new TargetConfigError(
      `Target "${target.id}" has collector id "${target.collectorId}", which must start with c_.`,
    );
  }

  const url = new URL(target.targetUrl);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new TargetConfigError(
      `Target "${target.id}" must use HTTPS unless it is localhost.`,
    );
  }

  return target;
}

/**
 * Loads target definitions from a JSON file.
 *
 * Targets live in a file rather than environment variables because there are
 * several of them with several fields each, and a file can be committed without
 * containing anything secret.
 */
export function parseTargetsFile(contents: string, defaultTimeoutMs: number): TargetConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new TargetConfigError("The targets file is not valid JSON.");
  }

  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { targets?: unknown }).targets)
      ? ((parsed as { targets: unknown[] }).targets)
      : null;

  if (list === null) {
    throw new TargetConfigError("The targets file must contain an array of targets.");
  }

  const targets = list.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new TargetConfigError(`Target ${String(index)} is not an object.`);
    }
    const source = entry as Record<string, unknown>;
    const timeout = source["timeoutMs"];

    return validate({
      id: requireString(source, "id", index),
      label: requireString(source, "label", index),
      collectorId: requireString(source, "collectorId", index),
      targetUrl: requireString(source, "targetUrl", index),
      fieldDescription: requireString(source, "fieldDescription", index),
      controllable: source["controllable"] === true,
      timeoutMs:
        typeof timeout === "number" && Number.isInteger(timeout) && timeout > 0
          ? timeout
          : defaultTimeoutMs,
    });
  });

  const ids = new Set<string>();
  for (const target of targets) {
    if (ids.has(target.id)) {
      throw new TargetConfigError(`Duplicate target id "${target.id}".`);
    }
    ids.add(target.id);
  }

  return targets;
}

export function loadTargetsFile(path: string, defaultTimeoutMs: number): TargetConfig[] {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    throw new TargetConfigError(`Could not read the targets file at ${path}.`);
  }
  return parseTargetsFile(contents, defaultTimeoutMs);
}

/** Wraps a single environment-configured collector as one target. */
export function singleTarget(collector: CollectorConfig): TargetConfig {
  return {
    ...collector,
    id: "primary",
    label: "Primary target",
    controllable: false,
  };
}
