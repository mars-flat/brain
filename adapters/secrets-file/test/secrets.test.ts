import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../src/index.ts";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "brain-secrets-"));
  return {
    dir,
    store: new FileSecretStore(join(dir, "store.json"), join(dir, "master.key")),
  };
}

describe("secrets-file (§4.3)", () => {
  test("round-trip, list by prefix, delete", async () => {
    const { store } = fresh();
    await store.set("upstream/github/token", "ghp_SUPERSECRETVALUE123");
    await store.set("upstream/openai/key", "sk-another");
    expect(await store.get("upstream/github/token")).toBe("ghp_SUPERSECRETVALUE123");
    expect(await store.list("upstream/")).toEqual(["upstream/github/token", "upstream/openai/key"]);
    await store.delete("upstream/github/token");
    expect(await store.get("upstream/github/token")).toBeNull();
  });

  test("the store file never contains plaintext; the key file is 0600", async () => {
    const { dir, store } = fresh();
    await store.set("x", "EXTREMELY_SECRET_PLAINTEXT");
    const raw = readFileSync(join(dir, "store.json"), "utf8");
    expect(raw).not.toContain("EXTREMELY_SECRET_PLAINTEXT");
    expect(raw).not.toContain(readFileSync(join(dir, "master.key"), "utf8").trim());
    const mode = statSync(join(dir, "master.key")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("reopening with the right key decrypts; a wrong key fails loudly", async () => {
    const { dir, store } = fresh();
    await store.set("k", "v");
    const reopened = new FileSecretStore(join(dir, "store.json"), join(dir, "master.key"));
    expect(await reopened.get("k")).toBe("v");

    const wrong = new FileSecretStore(join(dir, "store.json"), join(dir, "other.key"));
    await expect(wrong.get("k")).rejects.toThrow(/decryption failed/);
  });
});
