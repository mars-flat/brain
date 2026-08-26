/**
 * SSRF guard (§8.4). Option B (hosted/local IdP, §4.3) removes the
 * attacker-controlled CIMD fetch entirely, so this is defense-in-depth for
 * the outbound fetches that DO remain — issuer discovery and JWKS — plus a
 * reusable guard for any future upstream fetch. HTTPS-only in production;
 * localhost HTTP is allowed only when explicitly opted in (the local
 * Keycloak dev case). Blocks RFC1918 / loopback / link-local, and the
 * cloud metadata endpoint 169.254.169.254 specifically (§7).
 */

export interface SsrfPolicy {
  /** Allow http:// and loopback hosts — true only for local-IdP dev (§4.3). */
  allowLoopbackHttp: boolean;
}

const BLOCKED_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./, // link-local INCLUDING 169.254.169.254 cloud metadata
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10
];

export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "metadata.google.internal") return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return BLOCKED_V4.some((re) => re.test(h));
  // IPv6 loopback / link-local / unique-local.
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  if (h.startsWith("::ffff:")) return isBlockedHost(h.slice(7)); // v4-mapped
  return false;
}

export class SsrfError extends Error {}

/** Throws if `url` must not be fetched under `policy`. Call before every outbound fetch. */
export function assertFetchAllowed(url: string, policy: SsrfPolicy): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfError(`not a valid URL: ${url}`);
  }
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1";

  if (parsed.protocol === "http:") {
    if (!(policy.allowLoopbackHttp && loopback))
      throw new SsrfError(`refusing http:// to non-loopback host: ${parsed.hostname}`);
    return parsed;
  }
  if (parsed.protocol !== "https:") throw new SsrfError(`refusing scheme ${parsed.protocol}`);
  if (isBlockedHost(parsed.hostname))
    throw new SsrfError(`refusing private/link-local/metadata host: ${parsed.hostname}`);
  return parsed;
}

/**
 * fetch with SSRF guard, size cap, timeout, and redirect refusal — the
 * hardened outbound primitive (§4.3 SSRF-harden requirements).
 */
export async function guardedFetch(
  url: string,
  policy: SsrfPolicy,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<Response> {
  assertFetchAllowed(url, policy);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await fetch(url, { redirect: "error", signal: controller.signal });
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len && len > (opts.maxBytes ?? 1_000_000))
      throw new SsrfError(`response too large: ${len} bytes`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}
