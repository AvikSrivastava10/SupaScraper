export const AVAILABILITY_VALUES = [
  "in_stock",
  "low_stock",
  "out_of_stock",
] as const;

export type Availability = (typeof AVAILABILITY_VALUES)[number];

export interface CatalogRecord {
  readonly name: string;
  readonly sku: string;
  readonly price: number;
  readonly availability: Availability;
}

export const CATALOG_FIELD_NAMES = [
  "name",
  "sku",
  "price",
  "availability",
] as const satisfies readonly (keyof CatalogRecord)[];
