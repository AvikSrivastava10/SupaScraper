import type { ScenarioMode } from "@supascraper/shared";

export interface ScenarioStore {
  get(): ScenarioMode;
  set(mode: ScenarioMode): void;
  reset(): void;
}

export class InMemoryScenarioStore implements ScenarioStore {
  #mode: ScenarioMode;

  constructor(initialMode: ScenarioMode = "baseline") {
    this.#mode = initialMode;
  }

  get(): ScenarioMode {
    return this.#mode;
  }

  set(mode: ScenarioMode): void {
    this.#mode = mode;
  }

  reset(): void {
    this.#mode = "baseline";
  }
}
