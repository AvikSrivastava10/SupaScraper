import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { isScenarioMode, type ScenarioMode } from "@supascraper/shared";

import type { ScenarioStore } from "./scenario-store.js";

interface PersistedScenarioState {
  readonly mode: ScenarioMode;
  readonly updatedAt: string;
}

/**
 * Persists the active scenario to disk so Bright Data's independent scraping
 * session observes the same server-side state that the operator selected.
 *
 * A restart intentionally falls back to `baseline`, which is the desired
 * pre-demo state on hosts with ephemeral filesystems.
 */
export class FileScenarioStore implements ScenarioStore {
  readonly #filePath: string;
  #mode: ScenarioMode;

  constructor(filePath: string) {
    this.#filePath = resolve(filePath);
    this.#mode = this.#readFromDisk();
  }

  get(): ScenarioMode {
    return this.#mode;
  }

  set(mode: ScenarioMode): void {
    this.#mode = mode;
    this.#writeToDisk(mode);
  }

  reset(): void {
    this.set("baseline");
  }

  #readFromDisk(): ScenarioMode {
    try {
      const raw = readFileSync(this.#filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedScenarioState>;
      return isScenarioMode(parsed.mode) ? parsed.mode : "baseline";
    } catch {
      return "baseline";
    }
  }

  #writeToDisk(mode: ScenarioMode): void {
    const state: PersistedScenarioState = {
      mode,
      updatedAt: new Date().toISOString(),
    };

    mkdirSync(dirname(this.#filePath), { recursive: true });

    // Write to a sibling temp file first so a crash cannot leave a partial file.
    const temporaryPath = `${this.#filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(state, null, 2), "utf8");
    renameSync(temporaryPath, this.#filePath);
  }
}
