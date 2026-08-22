/** Bright Data's `scraper create` rejects a longer description. */
export const MAX_DESCRIPTION_LENGTH = 500;

/** Long enough to name a few fields; shorter input produces a useless scraper. */
export const MIN_DESCRIPTION_LENGTH = 10;

export const MAX_URL_LENGTH = 2000;
export const MAX_LABEL_LENGTH = 60;

export interface SiteInput {
  readonly url: string;
  readonly description: string;
  readonly label?: string | undefined;
}

export interface ValidatedSite {
  readonly url: string;
  readonly description: string;
  readonly label: string;
  readonly id: string;
}

export class SiteInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteInputError";
  }
}

/** Hostnames that never refer to a public page worth scraping. */
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".localdomain",
];

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "instance-data",
]);

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;

  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [a = 0, b = 0] = octets;

  return (
    a === 0 || // "this network"
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, including cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    a >= 224 // multicast and reserved
  );
}

function isPrivateIpv6(host: string): boolean {
  // URL hostnames keep IPv6 literals in brackets.
  const inner = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const lowered = inner.toLowerCase();

  if (lowered === "::1" || lowered === "::") return true;
  if (lowered.startsWith("fe8") || lowered.startsWith("fe9")) return true;
  if (lowered.startsWith("fea") || lowered.startsWith("feb")) return true;
  // fc00::/7, unique local addresses.
  if (lowered.startsWith("fc") || lowered.startsWith("fd")) return true;
  // IPv4-mapped, for example ::ffff:127.0.0.1
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lowered);
  return mapped?.[1] !== undefined && isPrivateIpv4(mapped[1]);
}

/**
 * Rejects anything that is not a public web page.
 *
 * Bright Data fetches the page, not this process, so a private address could not
 * reach this network anyway. It is still refused: an internal hostname is never
 * a legitimate target, and accepting one would turn a hosted deployment into a
 * probe for whoever can reach the form.
 */
function requirePublicHttpUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new SiteInputError("A page URL is required.");
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new SiteInputError(
      `A page URL must be at most ${String(MAX_URL_LENGTH)} characters.`,
    );
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SiteInputError(
      "That is not a valid URL. Include the scheme, for example https://example.com/products.",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SiteInputError("Only http and https pages can be scraped.");
  }
  if (url.protocol === "http:") {
    throw new SiteInputError("Use an https URL so the page is fetched over TLS.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new SiteInputError("Remove the credentials from the URL. Only public pages are supported.");
  }

  const host = url.hostname.toLowerCase();
  if (
    BLOCKED_HOSTS.has(host) ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    isPrivateIpv4(host) ||
    isPrivateIpv6(host)
  ) {
    throw new SiteInputError(
      "That address is not a public website. Enter a page reachable on the open internet.",
    );
  }
  if (!host.includes(".") && !host.startsWith("[")) {
    throw new SiteInputError("Enter a full public hostname, for example example.com.");
  }

  return url;
}

/** Turns a hostname and path into a stable, readable identifier. */
export function deriveTargetId(url: URL, taken: (id: string) => boolean): string {
  const base = `${url.hostname}${url.pathname}`
    .toLowerCase()
    .replace(/^www\./, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    // Truncate before trimming separators, so a cut that lands on one cannot
    // leave a trailing dash in the identifier.
    .slice(0, 40)
    .replaceAll(/^-+|-+$/g, "");

  const root = base.length > 0 ? base : "site";
  if (!taken(root)) {
    return root;
  }

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${root}-${String(suffix)}`;
    if (!taken(candidate)) {
      return candidate;
    }
  }
  throw new SiteInputError("Too many sites share that address.");
}

function defaultLabel(url: URL): string {
  const host = url.hostname.replace(/^www\./, "");
  return host.slice(0, MAX_LABEL_LENGTH);
}

/**
 * Validates one submitted site.
 *
 * `taken` is supplied by the caller so identifier collisions are resolved
 * against whatever is already registered, without this module knowing how
 * targets are stored.
 */
export function validateSite(
  input: SiteInput,
  taken: (id: string) => boolean,
): ValidatedSite {
  const url = requirePublicHttpUrl(input.url);

  const description = input.description.replaceAll(/\s+/g, " ").trim();
  if (description.length < MIN_DESCRIPTION_LENGTH) {
    throw new SiteInputError(
      `Describe the data to extract in at least ${String(MIN_DESCRIPTION_LENGTH)} characters, naming the fields you want.`,
    );
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new SiteInputError(
      `A description must be at most ${String(MAX_DESCRIPTION_LENGTH)} characters.`,
    );
  }

  const rawLabel = (input.label ?? "").replaceAll(/\s+/g, " ").trim();
  if (rawLabel.length > MAX_LABEL_LENGTH) {
    throw new SiteInputError(
      `A display name must be at most ${String(MAX_LABEL_LENGTH)} characters.`,
    );
  }

  return {
    url: url.toString(),
    description,
    label: rawLabel.length > 0 ? rawLabel : defaultLabel(url),
    id: deriveTargetId(url, taken),
  };
}
