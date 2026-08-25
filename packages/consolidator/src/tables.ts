/**
 * The consolidator's operational tables (§5.7): atomic id reservations,
 * the processed-episode ledger (idempotency), and the single-writer run
 * lock. All survive `brain rebuild` — like salience, they are state the
 * vault markdown cannot reproduce.
 */

import type { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reservations (
  id          TEXT PRIMARY KEY,
  episode_id  TEXT NOT NULL,
  reserved_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS consolidated_episodes (
  episode_id TEXT PRIMARY KEY,
  basename   TEXT NOT NULL,
  at         TEXT NOT NULL,
  new_nodes  INTEGER NOT NULL,
  quarantined INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS run_lock (
  name    TEXT PRIMARY KEY,
  holder  TEXT NOT NULL,
  expires INTEGER NOT NULL
) WITHOUT ROWID;
`;

export function ensureConsolidatorTables(db: Database): void {
  db.exec(SCHEMA);
}

export class ReservationConflict extends Error {
  constructor(readonly id: string) {
    super(`node id already reserved: ${id}`);
  }
}

/** ATOMIC node-id reservation (§5.7) — the transaction throws on any clash. */
export function reserveIds(db: Database, ids: string[], episodeId: string, nowIso: string): void {
  const q = db.query("INSERT INTO reservations (id, episode_id, reserved_at) VALUES (?, ?, ?)");
  const tx = db.transaction(() => {
    for (const id of ids) {
      try {
        q.run(id, episodeId, nowIso);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/unique|primary key|constraint/i.test(msg)) throw e;
        // Re-reserving your own id (a crashed prior attempt) is idempotent;
        // someone else's reservation is the conflict (§5.7).
        const owner = db.query("SELECT episode_id FROM reservations WHERE id = ?").get(id) as {
          episode_id: string;
        } | null;
        if (owner?.episode_id !== episodeId) throw new ReservationConflict(id);
      }
    }
  });
  tx();
}

export function reservedIds(db: Database): Set<string> {
  const rows = db.query("SELECT id FROM reservations").all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

export function releaseReservations(db: Database, episodeId: string): void {
  db.query("DELETE FROM reservations WHERE episode_id = ?").run(episodeId);
}

export function alreadyConsolidated(db: Database, episodeId: string): boolean {
  return (
    db.query("SELECT 1 AS x FROM consolidated_episodes WHERE episode_id = ?").get(episodeId) !==
    null
  );
}

export function markConsolidated(
  db: Database,
  episodeId: string,
  basename: string,
  nowIso: string,
  newNodes: number,
  quarantined: number,
): void {
  db.query(
    `INSERT OR IGNORE INTO consolidated_episodes (episode_id, basename, at, new_nodes, quarantined)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(episodeId, basename, nowIso, newNodes, quarantined);
}

/**
 * Advisory single-writer lock. Returns a release function, or null if
 * another live holder exists — the caller backs off and retries later.
 */
export function acquireRunLock(db: Database, holder: string, ttlMs: number): (() => void) | null {
  const now = Date.now();
  const tx = db.transaction(() => {
    const row = db
      .query("SELECT holder, expires FROM run_lock WHERE name = 'consolidator'")
      .get() as {
      holder: string;
      expires: number;
    } | null;
    if (row && row.expires > now && row.holder !== holder) return false;
    db.query(
      "INSERT OR REPLACE INTO run_lock (name, holder, expires) VALUES ('consolidator', ?, ?)",
    ).run(holder, now + ttlMs);
    return true;
  });
  if (!tx()) return null;
  return () => {
    db.query("DELETE FROM run_lock WHERE name = 'consolidator' AND holder = ?").run(holder);
  };
}
