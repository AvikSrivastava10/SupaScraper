import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  PendingTarget,
  TargetRegistry,
} from "../../application/add-target/target-registry.js";
import { parseTargetsFile, type TargetConfig } from "../../config/targets.js";

interface PersistedTargets {
  readonly version: 1;
  readonly targets: TargetConfig[];
  readonly pending: PendingTarget[];
}

const PENDING_STATUSES = new Set(["building", "failed"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPending(value: unknown): PendingTarget | null {
  if (!isPlainObject(value)) return null;

  const id = value["id"];
  const label = value["label"];
  const targetUrl = value["targetUrl"];
  const fieldDescription = value["fieldDescription"];
  const requestedAt = value["requestedAt"];
  const status = value["status"];
  const message = value["message"];

  if (
    typeof id !== "string" ||
    typeof label !== "string" ||
    typeof targetUrl !== "string" ||
    typeof fieldDescription !== "string" ||
    typeof requestedAt !== "string" ||
    typeof status !== "string" ||
    !PENDING_STATUSES.has(status)
  ) {
    return null;
  }

  return {
    id,
    label,
    targetUrl,
    fieldDescription,
    requestedAt,
    status: status as PendingTarget["status"],
    message: typeof message === "string" ? message : "",
  };
}

/**
 * Targets that came from a committed file, plus targets added at runtime.
 *
 * The two are kept apart on purpose. Seeds are read-only and versioned with the
 * code, so a demo cannot be broken by dashboard activity, while anything a user
 * adds is written to a separate file under the data directory.
 */
export class FileTargetRegistry implements TargetRegistry {
  readonly #seeds: readonly TargetConfig[];
  readonly #filePath: string;
  readonly #defaultTimeoutMs: number;
  #added: TargetConfig[];
  #pending: PendingTarget[];

  constructor(
    seeds: readonly TargetConfig[],
    filePath: string,
    defaultTimeoutMs: number,
  ) {
    this.#seeds = seeds;
    this.#filePath = resolve(filePath);
    this.#defaultTimeoutMs = defaultTimeoutMs;

    const state = this.#read();
    this.#added = state.targets;
    this.#pending = state.pending;
  }

  #read(): { targets: TargetConfig[]; pending: PendingTarget[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#filePath, "utf8"));
    } catch {
      // No file yet, or unreadable. Starting from the seeds alone is correct.
      return { targets: [], pending: [] };
    }

    if (!isPlainObject(parsed)) {
      return { targets: [], pending: [] };
    }

    let targets: TargetConfig[] = [];
    try {
      // Reuse the same validator the committed file goes through, so a
      // hand-edited or corrupted store cannot introduce an invalid target.
      targets = parseTargetsFile(
        JSON.stringify({ targets: parsed["targets"] ?? [] }),
        this.#defaultTimeoutMs,
      ).filter((target) => !this.#seeds.some((seed) => seed.id === target.id));
    } catch {
      targets = [];
    }

    const rawPending = parsed["pending"];
    const pending = Array.isArray(rawPending)
      ? rawPending
          .map((entry) => readPending(entry))
          .filter((entry): entry is PendingTarget => entry !== null)
      : [];

    return { targets, pending };
  }

  #write(): void {
    mkdirSync(dirname(this.#filePath), { recursive: true });
    const state: PersistedTargets = {
      version: 1,
      targets: this.#added,
      pending: this.#pending,
    };
    const temporaryPath = `${this.#filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(state, null, 2), "utf8");
    renameSync(temporaryPath, this.#filePath);
  }

  list(): readonly TargetConfig[] {
    return [...this.#seeds, ...this.#added];
  }

  pending(): readonly PendingTarget[] {
    return [...this.#pending];
  }

  get(id: string): TargetConfig | null {
    return this.list().find((target) => target.id === id) ?? null;
  }

  isTaken(id: string): boolean {
    return (
      this.list().some((target) => target.id === id) ||
      this.#pending.some((entry) => entry.id === id)
    );
  }

  hasUrl(url: string): boolean {
    const normalize = (value: string): string => value.replace(/\/+$/, "").toLowerCase();
    const wanted = normalize(url);
    return (
      this.list().some((target) => normalize(target.targetUrl) === wanted) ||
      this.#pending.some(
        (entry) => entry.status === "building" && normalize(entry.targetUrl) === wanted,
      )
    );
  }

  addPending(target: PendingTarget): void {
    this.#pending = [...this.#pending.filter((entry) => entry.id !== target.id), target];
    this.#write();
  }

  resolvePending(id: string, collectorId: string, timeoutMs: number): TargetConfig {
    const entry = this.#pending.find((candidate) => candidate.id === id);
    if (entry === undefined) {
      throw new Error(`No pending target with id "${id}".`);
    }

    const target: TargetConfig = {
      id: entry.id,
      label: entry.label,
      collectorId,
      targetUrl: entry.targetUrl,
      fieldDescription: entry.fieldDescription,
      controllable: false,
      timeoutMs,
    };

    this.#added = [...this.#added.filter((existing) => existing.id !== id), target];
    this.#pending = this.#pending.filter((candidate) => candidate.id !== id);
    this.#write();
    return target;
  }

  failPending(id: string, message: string): void {
    this.#pending = this.#pending.map((entry) =>
      entry.id === id ? { ...entry, status: "failed", message } : entry,
    );
    this.#write();
  }

  /** Where runtime additions are persisted. Useful for diagnostics and tests. */
  get filePath(): string {
    return this.#filePath;
  }
}
