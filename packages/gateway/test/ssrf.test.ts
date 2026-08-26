/**
 * §8.4 SSRF guard, table-driven: every private/loopback/metadata target is
 * refused; the cloud metadata IP is called out explicitly.
 */

import { describe, expect, test } from "bun:test";
import { assertFetchAllowed, isBlockedHost, SsrfError } from "../src/ssrf.ts";

describe("SSRF host classification (§8.4)", () => {
  test.each([
    "169.254.169.254", // cloud metadata — the live credential-theft target
    "127.0.0.1",
    "10.0.0.1",
    "172.16.5.5",
    "192.168.1.1",
    "0.0.0.0",
    "100.64.0.1", // CGNAT 100.64/10
    "localhost",
    "foo.localhost",
    "metadata.google.internal",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:169.254.169.254",
  ])("blocks %s", (host) => {
    expect(isBlockedHost(host)).toBe(true);
  });

  test.each(["140.82.121.4", "8.8.8.8", "100.128.0.1", "example.com", "keycloak.example.org"])(
    "allows public host %s",
    (host) => {
      expect(isBlockedHost(host)).toBe(false);
    },
  );
});

describe("assertFetchAllowed (§4.3)", () => {
  const strict = { allowLoopbackHttp: false };
  const dev = { allowLoopbackHttp: true };

  test("https to a public host is allowed", () => {
    expect(assertFetchAllowed("https://idp.example.com/jwks", strict).hostname).toBe(
      "idp.example.com",
    );
  });

  test.each([
    "http://169.254.169.254/latest/meta-data/",
    "https://169.254.169.254/",
    "https://10.0.0.5/internal",
    "http://example.com/",
    "ftp://example.com/",
    "https://metadata.google.internal/",
  ])("refuses %s under strict policy", (url) => {
    expect(() => assertFetchAllowed(url, strict)).toThrow(SsrfError);
  });

  test("localhost http is allowed ONLY when opted in (local Keycloak dev, §4.3)", () => {
    expect(() => assertFetchAllowed("http://localhost:8081/realms/brain", strict)).toThrow(
      SsrfError,
    );
    expect(assertFetchAllowed("http://localhost:8081/realms/brain", dev).hostname).toBe(
      "localhost",
    );
    // …but opt-in never reaches a non-loopback host over http.
    expect(() => assertFetchAllowed("http://10.0.0.5/", dev)).toThrow(SsrfError);
  });
});
