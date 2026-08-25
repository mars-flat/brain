/**
 * Queue port (§3) over SQLite. Lease semantics make the single-writer
 * consolidator hold under crashes (§5.7): a leased item is invisible to
 * other consumers until acked, nacked, or lease expiry; `attempt` drives
 * the max-3-backoff rule. Owns only its `queue_items` table — safe to
 * share a database file with the brain index, whose rebuild never touches
 * foreign tables.
 */

import type { Database } from "bun:sqlite";
import type { LeasedItem, Queue } from "@brain/contracts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queue_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item          TEXT NOT NULL,
  visible_at    INTEGER NOT NULL DEFAULT 0,
  lease_token   TEXT,
  lease_expires INTEGER,
  attempt       INTEGER NOT NULL DEFAULT 0,
  enqueued_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS queue_visible ON queue_items (visible_at, id);
`;

export class SqliteQueue<T> implements Queue<T> {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = () => Date.now(),
  ) {
    db.exec(SCHEMA);
  }

  enqueue(item: T): Promise<string> {
    const row = this.db
      .query("INSERT INTO queue_items (item, enqueued_at) VALUES (?, ?) RETURNING id")
      .get(JSON.stringify(item), this.now()) as { id: number };
    return Promise.resolve(String(row.id));
  }

  lease(count: number, leaseMs: number): Promise<Array<LeasedItem<T>>> {
    const t = this.now();
    const token = crypto.randomUUID();
    const tx = this.db.transaction(() => {
      return this.db
        .query(
          `UPDATE queue_items
           SET lease_token = ?1, lease_expires = ?2, attempt = attempt + 1
           WHERE id IN (
             SELECT id FROM queue_items
             WHERE visible_at <= ?3 AND (lease_token IS NULL OR lease_expires < ?3)
             ORDER BY id LIMIT ?4
           )
           RETURNING id, item, attempt`,
        )
        .all(token, t + leaseMs, t, count) as Array<{ id: number; item: string; attempt: number }>;
    });
    const rows = tx();
    return Promise.resolve(
      rows.map((r) => ({
        leaseId: `${token}:${r.id}`,
        item: JSON.parse(r.item) as T,
        attempt: r.attempt,
      })),
    );
  }

  ack(leaseId: string): Promise<void> {
    const [token, id] = splitLease(leaseId);
    this.db.query("DELETE FROM queue_items WHERE id = ? AND lease_token = ?").run(id, token);
    return Promise.resolve();
  }

  nack(leaseId: string, delayMs = 0): Promise<void> {
    const [token, id] = splitLease(leaseId);
    this.db
      .query(
        `UPDATE queue_items SET lease_token = NULL, lease_expires = NULL, visible_at = ?
         WHERE id = ? AND lease_token = ?`,
      )
      .run(this.now() + delayMs, id, token);
    return Promise.resolve();
  }

  /** Items neither leased nor delayed — for doctor and tests. */
  pending(): number {
    const t = this.now();
    const row = this.db
      .query(
        "SELECT COUNT(*) AS c FROM queue_items WHERE visible_at <= ?1 AND (lease_token IS NULL OR lease_expires < ?1)",
      )
      .get(t) as { c: number };
    return row.c;
  }

  size(): number {
    const row = this.db.query("SELECT COUNT(*) AS c FROM queue_items").get() as { c: number };
    return row.c;
  }
}

function splitLease(leaseId: string): [string, number] {
  const idx = leaseId.lastIndexOf(":");
  return [leaseId.slice(0, idx), Number(leaseId.slice(idx + 1))];
}
