import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { CatalogRecord } from "@supascraper/shared";

import type { CollectorLock } from "../../application/heal-and-verify/heal-and-verify.js";
import type {
  CatalogDataStore,
  RepairEventStore,
} from "../../application/process-run/process-run.js";
import type { RepairEvent } from "../../domain/repair/repair-event.js";
import type {
  DashboardDataReader,
  StoredCatalogSnapshot,
} from "./in-memory-repository.js";

interface PersistedState {
  readonly version: 1;
  readonly catalog: Record<string, StoredCatalogSnapshot>;
  readonly events: RepairEvent[];
}

const MAX_EVENTS = 200;

const EMPTY: PersistedState = { version: 1, catalog: {}, events: [] };

/**
 * File-backed store so verified data and repair history survive a restart.
 *
 * Locks are intentionally kept in memory: a lock represents an operation held
 * by this process, and persisting one would risk a stale lock outliving the
 * process that owned it and blocking every future repair.
 */
export class JsonFileRepository
  implements CatalogDataStore, RepairEventStore, CollectorLock, DashboardDataReader
{
  readonly #filePath: string;
  readonly #locks = new Map<string, string>();
  #state: PersistedState;

  constructor(filePath: string) {
    this.#filePath = resolve(filePath);
    this.#state = this.#read();
  }

  #read(): PersistedState {
    try {
      const parsed = JSON.parse(readFileSync(this.#filePath, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null) {
        return { ...EMPTY };
      }
      const candidate = parsed as Partial<PersistedState>;
      return {
        version: 1,
        catalog:
          typeof candidate.catalog === "object" && candidate.catalog !== null
            ? candidate.catalog
            : {},
        events: Array.isArray(candidate.events) ? candidate.events : [],
      };
    } catch {
      // Missing or corrupt state must not prevent the app from starting.
      return { ...EMPTY };
    }
  }

  #write(): void {
    mkdirSync(dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(this.#state, null, 2), "utf8");
    renameSync(temporaryPath, this.#filePath);
  }

  saveLastKnownGood(
    collectorId: string,
    records: readonly CatalogRecord[],
    collectedAt: string,
  ): Promise<void> {
    this.#state = {
      ...this.#state,
      catalog: {
        ...this.#state.catalog,
        [collectorId]: {
          collectorId,
          records: records.map((record) => ({ ...record })),
          collectedAt,
        },
      },
    };
    this.#write();
    return Promise.resolve();
  }

  getLastKnownGood(collectorId: string): Promise<StoredCatalogSnapshot | null> {
    const snapshot = this.#state.catalog[collectorId];
    if (!snapshot) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      ...snapshot,
      records: snapshot.records.map((record) => ({ ...record })),
    });
  }

  appendEvent(event: RepairEvent): Promise<void> {
    const events = [...this.#state.events, { ...event }];
    this.#state = {
      ...this.#state,
      events: events.slice(Math.max(0, events.length - MAX_EVENTS)),
    };
    this.#write();
    return Promise.resolve();
  }

  listEvents(collectorId: string): Promise<readonly RepairEvent[]> {
    return Promise.resolve(
      this.#state.events
        .filter((event) => event.collectorId === collectorId)
        .map((event) => ({ ...event })),
    );
  }

  acquire(collectorId: string): Promise<string | null> {
    if (this.#locks.has(collectorId)) {
      return Promise.resolve(null);
    }
    const token = randomUUID();
    this.#locks.set(collectorId, token);
    return Promise.resolve(token);
  }

  release(collectorId: string, token: string): Promise<void> {
    if (this.#locks.get(collectorId) !== token) {
      return Promise.reject(
        new Error("Cannot release a collector lock owned by another operation."),
      );
    }
    this.#locks.delete(collectorId);
    return Promise.resolve();
  }
}
