import type { CatalogRecord } from "@supascraper/shared";

export const BASELINE_CATALOG = [
  {
    name: "Precision Stepper Motor",
    sku: "MTR-100",
    price: 49.95,
    availability: "in_stock",
  },
  {
    name: "Industrial Sensor Module",
    sku: "SNS-240",
    price: 84.5,
    availability: "low_stock",
  },
  {
    name: "Compact Control Relay",
    sku: "RLY-310",
    price: 29.75,
    availability: "out_of_stock",
  },
] as const satisfies readonly CatalogRecord[];

export const CHANGED_CATALOG = [
  {
    name: "Precision Stepper Motor",
    sku: "MTR-100",
    price: 52.25,
    availability: "low_stock",
  },
  {
    name: "Industrial Sensor Module",
    sku: "SNS-240",
    price: 84.5,
    availability: "in_stock",
  },
  {
    name: "Compact Control Relay",
    sku: "RLY-310",
    price: 31.0,
    availability: "in_stock",
  },
] as const satisfies readonly CatalogRecord[];
