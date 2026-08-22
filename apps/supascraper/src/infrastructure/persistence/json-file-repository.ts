import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { FIELD_TYPES, type FieldType, type ScrapedRecord } from "@supascraper/shared";

import type { CollectorLock } from "../../application/heal-and-verify/heal-and-verify.js";
import type {
  RepairEventStore,
  ScrapedDataStore,
} from "../../application/process-run/process-run.js";
import type { DataContract } from "../../domain/contracts/data-contract.js";
import type { RepairEvent } from "../../domain/repair/repair-event.js";
import type {
  DashboardDataReader,
  StoredSnapshot,
} from "./in-memory-repository.js";

interface PersistedState {
  readonly version: 2;
  readonly snapshots: Record<string, StoredSnapshot>;
  readonly contracts: Record<string, DataContract>;
  readonly events: RepairEvent[];
}

const MAX_EVENTS = 200;

const EMPTY: PersistedState = {
  version: 2,
  snapshots: {},
  contracts: {},
  events: [],
};

const KNOWN_FIELD_TYPES = new Set<string>(FIELD_TYPES);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Rebuilds a contract from the file, or discards it.
 *
 * A malformed contract is worse than a missing one: it would silently hold every
 * future run to rules nobody chose. Dropping it means the next good run simply
 * profiles a fresh one.
 */
function readContract(value: unknown): DataContract | null {
  if (!isPlainObject(value)) return null;

  const version = value["version"];
  const minimumRows = value["minimumRows"];
  const maximumRows = value["maximumRows"];
  const profiledAt = value["profiledAt"];
  const identityField = value["identityField"];

  if (typeof version !== "number" || !Number.isFinite(version)) return null;
  if (typeof minimumRows !== "number" || !Number.isInteger(minimumRows)) return null;
  if (typeof maximumRows !== "number" || !Number.isInteger(maximumRows)) return null;
  if (typeof profiledAt !== "string") return null;
  if (identityField !== null && typeof identityField !== "string") return null;

  const fieldTypes: Record<string, FieldType> = {};
  if (isPlainObject(value["fieldTypes"])) {
    for (const [field, type] of Object.entries(value["fieldTypes"])) {
      if (typeof type === "string" && KNOWN_FIELD_TYPES.has(type)) {
        fieldTypes[field] = type as FieldType;
      }
    }
  }

  return {
    version,
    requiredFields: readStringArray(value["requiredFields"]),
    fieldTypes,
    identityField,
    minimumRows,
    maximumRows,
    profiledAt,
  };
}

/**
 * File-backed store so verified data, learned contracts, and repair history
 * survive a restart.
 *
 * Locks are intentionally kept in memory: a lock represents an operation held
 * by this process, and persisting one would risk a stale lock outliving the
 * process that owned it and blocking every future repair.
 */
export class JsonFileRepository
  implements ScrapedDataStore, RepairEventStore, CollectorLock, DashboardDataReader
{
  readonly #filePath: string;
  readonly #locks = new Map<string, string>();
  #state: PersistedState;

  constructor(filePath: string) {
    this.#filePath = resolve(filePath);
    this.#state = this.#read();
  }

  /**
   * Validates each entry rather than trusting the file.
   *
   * A file that is valid JSON but the wrong shape would otherwise pass straight
   * through and throw later while rendering, turning bad state into a crash far
   * from its cause.
   */
  #read(): PersistedState {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#filePath, "utf8"));
      if (!isPlainObject(parsed)) {
        return { ...EMPTY };
      }

      // Version 1 stored rows under "catalog". Reading both keys keeps data
      // collected before contracts existed.
      const rawSnapshots = parsed["snapshots"] ?? parsed["catalog"];
      const snapshots: Record<string, StoredSnapshot> = {};

      if (isPlainObject(rawSnapshots)) {
        for (const [key, value] of Object.entries(rawSnapshots)) {
          if (!isPlainObject(value)) continue;
          if (!Array.isArray(value["records"])) continue;
          if (typeof value["collectedAt"] !== "string") continue;
          snapshots[key] = {
            collectorId: key,
            records: value["records"].filter((record): record is ScrapedRecord =>
              isPlainObject(record),
            ),
            collectedAt: value["collectedAt"],
          };
        }
      }

      const contracts: Record<string, DataContract> = {};
      if (isPlainObject(parsed["contracts"])) {
        for (const [key, value] of Object.entries(parsed["contracts"])) {
          const contract = readContract(value);
          if (contract !== null) {
            contracts[key] = contract;
          }
        }
      }

      const rawEvents = parsed["events"];
      const events = Array.isArray(rawEvents)
        ? rawEvents.filter(
            (event): event is RepairEvent =>
              isPlainObject(event) && typeof event["collectorId"] === "string",
          )
        : [];

      return { version: 2, snapshots, contracts, events };
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
    records: readonly ScrapedRecord[],
    collectedAt: string,
  ): Promise<void> {
    this.#state = {
      ...this.#state,
      snapshots: {
        ...this.#state.snapshots,
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

  getLastKnownGood(collectorId: string): Promise<StoredSnapshot | null> {
    const snapshot = this.#state.snapshots[collectorId];
    if (!snapshot) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      ...snapshot,
      records: snapshot.records.map((record) => ({ ...record })),
    });
  }

  getContract(collectorId: string): Promise<DataContract | null> {
    return Promise.resolve(this.#state.contracts[collectorId] ?? null);
  }

  saveContract(collectorId: string, contract: DataContract): Promise<void> {
    this.#state = {
      ...this.#state,
      contracts: { ...this.#state.contracts, [collectorId]: contract },
    };
    this.#write();
    return Promise.resolve();
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
