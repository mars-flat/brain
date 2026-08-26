/**
 * secrets-file (§4.3): envelope encryption with Bun's node:crypto — a
 * per-record data key wrapped by a master key that never sits in the store.
 * The master key is scrypt-derived from a random 0600 key file; the store
 * file holds only ciphertext and can safely live (and be committed) inside
 * the private vault — offsite backup of secrets for free, while the key
 * file stays local-only.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SecretStore } from "@brain/contracts";

interface EncryptedRecord {
  /** Data key wrapped by the master key. */
  dk_iv: string;
  dk_ct: string;
  dk_tag: string;
  /** Value encrypted by the data key. */
  iv: string;
  ct: string;
  tag: string;
}

interface StoreFile {
  version: 1;
  salt: string;
  records: Record<string, EncryptedRecord>;
}

const hex = (b: Buffer | Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => Buffer.from(s, "hex");

function seal(key: Buffer, plaintext: Buffer): { iv: string; ct: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: hex(iv), ct: hex(ct), tag: hex(cipher.getAuthTag()) };
}

function open(key: Buffer, box: { iv: string; ct: string; tag: string }): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, unhex(box.iv));
  decipher.setAuthTag(unhex(box.tag));
  return Buffer.concat([decipher.update(unhex(box.ct)), decipher.final()]);
}

export class FileSecretStore implements SecretStore {
  private readonly masterKey: Buffer;
  private store: StoreFile;

  constructor(
    private readonly storePath: string,
    keyPath: string,
  ) {
    mkdirSync(dirname(keyPath), { recursive: true });
    mkdirSync(dirname(storePath), { recursive: true });
    if (!existsSync(keyPath)) {
      writeFileSync(keyPath, `${hex(randomBytes(32))}\n`, { mode: 0o600 });
    }
    chmodSync(keyPath, 0o600);
    const keyMaterial = readFileSync(keyPath, "utf8").trim();

    if (existsSync(storePath)) {
      this.store = JSON.parse(readFileSync(storePath, "utf8")) as StoreFile;
    } else {
      this.store = { version: 1, salt: hex(randomBytes(16)), records: {} };
      this.flush();
    }
    this.masterKey = scryptSync(keyMaterial, unhex(this.store.salt), 32);
  }

  private flush(): void {
    writeFileSync(this.storePath, `${JSON.stringify(this.store, null, 2)}\n`);
  }

  get(key: string): Promise<string | null> {
    const record = this.store.records[key];
    if (!record) return Promise.resolve(null);
    try {
      const dataKey = open(this.masterKey, {
        iv: record.dk_iv,
        ct: record.dk_ct,
        tag: record.dk_tag,
      });
      const value = open(dataKey, { iv: record.iv, ct: record.ct, tag: record.tag });
      return Promise.resolve(value.toString("utf8"));
    } catch {
      return Promise.reject(new Error(`secret "${key}": decryption failed — wrong master key?`));
    }
  }

  set(key: string, value: string): Promise<void> {
    const dataKey = randomBytes(32);
    const box = seal(dataKey, Buffer.from(value, "utf8"));
    const wrapped = seal(this.masterKey, dataKey);
    this.store.records[key] = {
      dk_iv: wrapped.iv,
      dk_ct: wrapped.ct,
      dk_tag: wrapped.tag,
      ...box,
    };
    this.flush();
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    delete this.store.records[key];
    this.flush();
    return Promise.resolve();
  }

  list(prefix = ""): Promise<string[]> {
    return Promise.resolve(
      Object.keys(this.store.records)
        .filter((k) => k.startsWith(prefix))
        .sort(),
    );
  }

  /** Constant-time comparison helper for adapters that verify stored tokens. */
  static equals(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}
