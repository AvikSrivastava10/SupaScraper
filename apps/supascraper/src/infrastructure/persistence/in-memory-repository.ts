import { randomUUID } from "node:crypto";

import type { CatalogRecord } from "@supascraper/shared";

import type { CollectorLock } from "../../application/heal-and-verify/heal-and-verify.js";
import type {
  CatalogDataStore,
  RepairEventStore,
} from "../../application/process-run/process-run.js";
import type { RepairEvent } from "../../domain/repair/repair-event.js";

export interface StoredCatalogSnapshot {
  readonly collectorId: string;
  readonly records: readonly CatalogRecord[];
  readonly collectedAt: string;
}

export interface DashboardDataReader {
  getLastKnownGood(collectorId: string): Promise<StoredCatalogSnapshot | null>;
  listEvents(collectorId: string): Promise<readonly RepairEvent[]>;
}

export class InMemoryRepository
  implements CatalogDataStore, RepairEventStore, CollectorLock, DashboardDataReader
{
  readonly #catalog = new Map<string, StoredCatalogSnapshot>();
  readonly #events: RepairEvent[] = [];
  readonly #locks = new Map<string, string>();

  saveLastKnownGood(
    collectorId: string,
    records: readonly CatalogRecord[],
    collectedAt: string,
  ): Promise<void> {
    this.#catalog.set(collectorId, {
      collectorId,
      records: records.map((record) => ({ ...record })),
      collectedAt,
    });
    return Promise.resolve();
  }

  getLastKnownGood(collectorId: string): Promise<StoredCatalogSnapshot | null> {
    const snapshot = this.#catalog.get(collectorId);
    if (!snapshot) {
      return Promise.resolve(null);
    }

    return Promise.resolve({
      ...snapshot,
      records: snapshot.records.map((record) => ({ ...record })),
    });
  }

  appendEvent(event: RepairEvent): Promise<void> {
    this.#events.push({ ...event });
    return Promise.resolve();
  }

  listEvents(collectorId: string): Promise<readonly RepairEvent[]> {
    return Promise.resolve(
      this.#events
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
      return Promise.reject(new Error("Cannot release a collector lock owned by another operation."));
    }

    this.#locks.delete(collectorId);
    return Promise.resolve();
  }
}
