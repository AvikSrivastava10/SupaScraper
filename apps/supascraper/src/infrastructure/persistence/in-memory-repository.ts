import { randomUUID } from "node:crypto";

import type { ScrapedRecord } from "@supascraper/shared";

import type { CollectorLock } from "../../application/heal-and-verify/heal-and-verify.js";
import type {
  RepairEventStore,
  ScrapedDataStore,
} from "../../application/process-run/process-run.js";
import type { DataContract } from "../../domain/contracts/data-contract.js";
import type { RepairEvent } from "../../domain/repair/repair-event.js";

export interface StoredSnapshot {
  readonly collectorId: string;
  readonly records: readonly ScrapedRecord[];
  readonly collectedAt: string;
}

export interface DashboardDataReader {
  getLastKnownGood(collectorId: string): Promise<StoredSnapshot | null>;
  listEvents(collectorId: string): Promise<readonly RepairEvent[]>;
  getContract(collectorId: string): Promise<DataContract | null>;
}

export class InMemoryRepository
  implements ScrapedDataStore, RepairEventStore, CollectorLock, DashboardDataReader
{
  readonly #snapshots = new Map<string, StoredSnapshot>();
  readonly #contracts = new Map<string, DataContract>();
  readonly #events: RepairEvent[] = [];
  readonly #locks = new Map<string, string>();

  saveLastKnownGood(
    collectorId: string,
    records: readonly ScrapedRecord[],
    collectedAt: string,
  ): Promise<void> {
    this.#snapshots.set(collectorId, {
      collectorId,
      records: records.map((record) => ({ ...record })),
      collectedAt,
    });
    return Promise.resolve();
  }

  getLastKnownGood(collectorId: string): Promise<StoredSnapshot | null> {
    const snapshot = this.#snapshots.get(collectorId);
    if (!snapshot) {
      return Promise.resolve(null);
    }

    return Promise.resolve({
      ...snapshot,
      records: snapshot.records.map((record) => ({ ...record })),
    });
  }

  getContract(collectorId: string): Promise<DataContract | null> {
    return Promise.resolve(this.#contracts.get(collectorId) ?? null);
  }

  saveContract(collectorId: string, contract: DataContract): Promise<void> {
    this.#contracts.set(collectorId, contract);
    return Promise.resolve();
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
