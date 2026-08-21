import {
  AVAILABILITY_VALUES,
  CATALOG_FIELD_NAMES,
  type Availability,
  type CatalogRecord,
} from "@supascraper/shared";

export type CatalogFieldName = (typeof CATALOG_FIELD_NAMES)[number];

export interface CatalogContract {
  readonly version: number;
  readonly minimumRows: number;
  readonly maximumRows: number;
  readonly minimumPrice: number;
}

export interface ContractViolation {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface FieldCounts {
  readonly name: number;
  readonly sku: number;
  readonly price: number;
  readonly availability: number;
}

export interface ContractMetrics {
  readonly rowCount: number;
  readonly validRowCount: number;
  readonly missingByField: FieldCounts;
  readonly nullByField: FieldCounts;
}

export interface ContractEvaluation {
  readonly valid: boolean;
  readonly metrics: ContractMetrics;
  readonly violations: readonly ContractViolation[];
  readonly acceptedRecords: readonly CatalogRecord[];
}

export const DEFAULT_CATALOG_CONTRACT: CatalogContract = {
  version: 1,
  minimumRows: 1,
  maximumRows: 100,
  minimumPrice: 0,
};

function emptyFieldCounts(): Record<CatalogFieldName, number> {
  return {
    name: 0,
    sku: 0,
    price: 0,
    availability: 0,
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAvailability(value: unknown): value is Availability {
  return (
    typeof value === "string" &&
    (AVAILABILITY_VALUES as readonly string[]).includes(value)
  );
}

function countAbsentField(
  row: Record<string, unknown>,
  field: CatalogFieldName,
  missing: Record<CatalogFieldName, number>,
  nulls: Record<CatalogFieldName, number>,
): void {
  if (!(field in row)) {
    missing[field] += 1;
  } else if (row[field] === null) {
    nulls[field] += 1;
  }
}

export function evaluateCatalogContract(
  records: readonly unknown[],
  contract: CatalogContract = DEFAULT_CATALOG_CONTRACT,
): ContractEvaluation {
  const violations: ContractViolation[] = [];
  const acceptedRecords: CatalogRecord[] = [];
  const missing = emptyFieldCounts();
  const nulls = emptyFieldCounts();

  if (records.length < contract.minimumRows || records.length > contract.maximumRows) {
    violations.push({
      code: "row_count_out_of_range",
      path: "$",
      message: `Expected ${contract.minimumRows}-${contract.maximumRows} records but received ${records.length}.`,
    });
  }

  records.forEach((value, index) => {
    const path = `$[${index}]`;
    if (!isObjectRecord(value)) {
      violations.push({
        code: "record_type_invalid",
        path,
        message: "Catalog row must be an object.",
      });
      for (const field of CATALOG_FIELD_NAMES) {
        missing[field] += 1;
      }
      return;
    }

    for (const field of CATALOG_FIELD_NAMES) {
      countAbsentField(value, field, missing, nulls);
    }

    const name = value["name"];
    const sku = value["sku"];
    const price = value["price"];
    const availability = value["availability"];
    let rowIsValid = true;

    if (typeof name !== "string" || name.trim().length === 0) {
      rowIsValid = false;
      violations.push({
        code: "name_invalid",
        path: `${path}.name`,
        message: "name must be a non-empty string.",
      });
    }

    if (typeof sku !== "string" || sku.trim().length === 0) {
      rowIsValid = false;
      violations.push({
        code: "sku_invalid",
        path: `${path}.sku`,
        message: "sku must be a non-empty string.",
      });
    }

    if (
      typeof price !== "number" ||
      !Number.isFinite(price) ||
      price < contract.minimumPrice
    ) {
      rowIsValid = false;
      violations.push({
        code: "price_invalid",
        path: `${path}.price`,
        message: `price must be a finite number greater than or equal to ${contract.minimumPrice}.`,
      });
    }

    if (!isAvailability(availability)) {
      rowIsValid = false;
      violations.push({
        code: "availability_invalid",
        path: `${path}.availability`,
        message: `availability must be one of: ${AVAILABILITY_VALUES.join(", ")}.`,
      });
    }

    if (
      rowIsValid &&
      typeof name === "string" &&
      typeof sku === "string" &&
      typeof price === "number" &&
      isAvailability(availability)
    ) {
      acceptedRecords.push({ name, sku, price, availability });
    }
  });

  return {
    valid: violations.length === 0,
    metrics: {
      rowCount: records.length,
      validRowCount: acceptedRecords.length,
      missingByField: missing,
      nullByField: nulls,
    },
    violations,
    acceptedRecords,
  };
}
