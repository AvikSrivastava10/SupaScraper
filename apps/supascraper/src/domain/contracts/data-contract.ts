import {
  IDENTITY_HINTS,
  isVendorField,
  type FieldType,
  type ScrapedRecord,
} from "@supascraper/shared";

export interface DataContract {
  readonly version: number;
  /** Fields that must be present and non-empty in every row. */
  readonly requiredFields: readonly string[];
  readonly fieldTypes: Readonly<Record<string, FieldType>>;
  /** Field used to identify a row, when one could be determined. */
  readonly identityField: string | null;
  readonly minimumRows: number;
  readonly maximumRows: number;
  readonly profiledAt: string;
}

export interface ContractViolation {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ContractMetrics {
  readonly rowCount: number;
  readonly validRowCount: number;
  readonly missingByField: Readonly<Record<string, number>>;
  readonly nullByField: Readonly<Record<string, number>>;
}

export interface ContractEvaluation {
  readonly valid: boolean;
  readonly metrics: ContractMetrics;
  readonly violations: readonly ContractViolation[];
  readonly acceptedRecords: readonly ScrapedRecord[];
}

/**
 * The contract used before a site has ever produced a good run.
 *
 * It asserts only what is true of all scraped data everywhere: at least one row,
 * and every row carrying at least one real value. That is enough to recognise a
 * first successful run and profile a real contract from it, without pretending
 * to know field names nobody has seen yet.
 */
export const BOOTSTRAP_CONTRACT: DataContract = {
  version: 0,
  requiredFields: [],
  fieldTypes: {},
  identityField: null,
  minimumRows: 1,
  maximumRows: Number.MAX_SAFE_INTEGER,
  profiledAt: "1970-01-01T00:00:00.000Z",
};

/** True when a contract was learned from real output rather than assumed. */
export function isProfiled(contract: DataContract): boolean {
  return contract.version > 0;
}

function isObjectRecord(value: unknown): value is ScrapedRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOfValue(value: unknown): FieldType | null {
  if (typeof value === "string") return "string";
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (typeof value === "boolean") return "boolean";
  return null;
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim().length === 0)
  );
}

function dataFields(records: readonly ScrapedRecord[]): string[] {
  const names = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!isVendorField(key)) {
        names.add(key);
      }
    }
  }
  return [...names];
}

/**
 * Chooses the field that identifies a row.
 *
 * Preference goes to conventional identifier names, then to any field whose
 * values are unique across every row. Without one, duplicate detection and
 * change comparison fall back to weaker signals, so it is worth finding.
 */
export function chooseIdentityField(
  records: readonly ScrapedRecord[],
  fields: readonly string[],
): string | null {
  const isUsableIdentity = (field: string): boolean => {
    const values = records.map((record) => record[field]);
    if (values.some((value) => isEmpty(value))) return false;
    if (values.some((value) => typeOfValue(value) === null)) return false;
    return new Set(values.map((value) => String(value))).size === records.length;
  };

  const lowered = new Map(fields.map((field) => [field.toLowerCase(), field]));
  for (const hint of IDENTITY_HINTS) {
    for (const [lower, original] of lowered) {
      if (lower === hint || lower.endsWith(`_${hint}`)) {
        if (isUsableIdentity(original)) return original;
      }
    }
  }

  return fields.find((field) => isUsableIdentity(field)) ?? null;
}

/**
 * Derives a contract from a run that a human accepted as correct.
 *
 * The alternative would be asking the user to describe the shape of data they
 * have not seen yet. Profiling the first good run means the contract always
 * reflects what the site actually returns.
 */
export function profileContract(records: readonly ScrapedRecord[]): DataContract {
  const rows = records.filter((record) => isObjectRecord(record));
  const fields = dataFields(rows);

  const fieldTypes: Record<string, FieldType> = {};
  const requiredFields: string[] = [];

  for (const field of fields) {
    const present = rows.filter(
      (row) => field in row && !isEmpty(row[field]),
    );

    // A field only becomes required if every row had it. Anything sparser is
    // treated as optional, so a legitimately blank field cannot fail a run.
    if (present.length === rows.length && rows.length > 0) {
      requiredFields.push(field);
    }

    const counts = new Map<FieldType, number>();
    for (const row of present) {
      const type = typeOfValue(row[field]);
      if (type !== null) {
        counts.set(type, (counts.get(type) ?? 0) + 1);
      }
    }
    const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (dominant !== undefined) {
      fieldTypes[field] = dominant[0];
    }
  }

  return {
    version: 1,
    requiredFields,
    fieldTypes,
    identityField: chooseIdentityField(rows, requiredFields),
    minimumRows: 1,
    // Generous upper bound: a real catalogue can grow, and an unbounded jump is
    // caught by the baseline comparison rather than by this limit.
    maximumRows: Math.max(rows.length * 5, 50),
    profiledAt: new Date().toISOString(),
  };
}

export function evaluateContract(
  records: readonly unknown[],
  contract: DataContract,
): ContractEvaluation {
  const violations: ContractViolation[] = [];
  const accepted: ScrapedRecord[] = [];
  const missingByField: Record<string, number> = {};
  const nullByField: Record<string, number> = {};
  const seenIdentities = new Set<string>();

  for (const field of contract.requiredFields) {
    missingByField[field] = 0;
    nullByField[field] = 0;
  }

  if (records.length < contract.minimumRows) {
    violations.push({
      code: "row_count_too_low",
      path: "$",
      message: `Expected at least ${String(contract.minimumRows)} record(s) but received ${String(records.length)}.`,
    });
  }
  if (records.length > contract.maximumRows) {
    violations.push({
      code: "row_count_too_high",
      path: "$",
      message: `Expected at most ${String(contract.maximumRows)} record(s) but received ${String(records.length)}.`,
    });
  }

  records.forEach((value, index) => {
    const path = `$[${index}]`;

    if (!isObjectRecord(value)) {
      violations.push({
        code: "record_type_invalid",
        path,
        message: "Row must be an object.",
      });
      for (const field of contract.requiredFields) {
        missingByField[field] = (missingByField[field] ?? 0) + 1;
      }
      return;
    }

    let rowValid = true;

    // A row made only of vendor keys, or of empty values, is not data. This holds
    // for every site, so it is the one row-level rule that applies even before a
    // contract has been profiled.
    const carriesData = Object.entries(value).some(
      ([key, entry]) => !isVendorField(key) && !isEmpty(entry),
    );
    if (!carriesData) {
      rowValid = false;
      violations.push({
        code: "record_has_no_data",
        path,
        message: "Row contains no extracted values.",
      });
    }

    for (const field of contract.requiredFields) {
      if (!(field in value)) {
        missingByField[field] = (missingByField[field] ?? 0) + 1;
        rowValid = false;
        violations.push({
          code: `${field}_missing`,
          path: `${path}.${field}`,
          message: `${field} is missing.`,
        });
        continue;
      }

      if (isEmpty(value[field])) {
        nullByField[field] = (nullByField[field] ?? 0) + 1;
        rowValid = false;
        violations.push({
          code: `${field}_empty`,
          path: `${path}.${field}`,
          message: `${field} is present but empty.`,
        });
        continue;
      }

      const expected = contract.fieldTypes[field];
      const actual = typeOfValue(value[field]);
      if (expected !== undefined && actual !== expected) {
        rowValid = false;
        violations.push({
          code: `${field}_type_invalid`,
          path: `${path}.${field}`,
          message: `${field} should be a ${expected} but was ${actual ?? "not a primitive"}.`,
        });
      }
    }

    // A repeated identity means extraction matched the same element for several
    // inputs: every row can look valid while most of the data is lost.
    if (contract.identityField !== null) {
      const identity = value[contract.identityField];
      if (!isEmpty(identity)) {
        const key = String(identity).trim().toLowerCase();
        if (seenIdentities.has(key)) {
          rowValid = false;
          violations.push({
            code: "identity_duplicated",
            path: `${path}.${contract.identityField}`,
            message: `${contract.identityField} "${String(identity)}" appears more than once, which means extraction matched the same row repeatedly.`,
          });
        }
        seenIdentities.add(key);
      }
    }

    if (rowValid) {
      accepted.push(value);
    }
  });

  return {
    valid: violations.length === 0,
    metrics: {
      rowCount: records.length,
      validRowCount: accepted.length,
      missingByField,
      nullByField,
    },
    violations,
    acceptedRecords: accepted,
  };
}

/** Fields worth showing as table columns, identity first. */
export function displayFields(contract: DataContract, limit = 6): string[] {
  const ordered = [
    ...(contract.identityField === null ? [] : [contract.identityField]),
    ...contract.requiredFields.filter((field) => field !== contract.identityField),
  ];
  return ordered.slice(0, limit);
}

/** Every data field the rows actually contain, in first-seen order. */
export function fieldsInRecords(records: readonly ScrapedRecord[]): string[] {
  const names: string[] = [];
  for (const record of records) {
    if (!isObjectRecord(record)) continue;
    for (const key of Object.keys(record)) {
      if (!isVendorField(key) && !names.includes(key)) {
        names.push(key);
      }
    }
  }
  return names;
}

/**
 * Every field present in the data, identity first.
 *
 * Used for export, where dropping a field because the contract did not require
 * it would silently lose data the site actually returned.
 */
export function orderedFields(
  contract: DataContract | null,
  records: readonly ScrapedRecord[],
): string[] {
  const all = fieldsInRecords(records);
  const identity = contract?.identityField ?? null;
  if (identity === null || !all.includes(identity)) {
    return all;
  }
  return [identity, ...all.filter((field) => field !== identity)];
}

/**
 * Columns to show for a target, preferring the contract and falling back to the
 * data itself so a site scraped before any contract was learned still renders.
 */
export function tableColumns(
  contract: DataContract | null,
  records: readonly ScrapedRecord[],
  limit = 6,
): string[] {
  if (contract !== null && isProfiled(contract) && contract.requiredFields.length > 0) {
    return displayFields(contract, limit);
  }
  return fieldsInRecords(records).slice(0, limit);
}
