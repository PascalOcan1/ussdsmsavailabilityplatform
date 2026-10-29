import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

export type Row = Record<string, unknown>;

let db: DatabaseSync | undefined;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS service_types (
  code                  TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  name_lg               TEXT,
  name_sw               TEXT,
  requires_verification INTEGER NOT NULL DEFAULT 0,
  ttl_minutes           INTEGER NOT NULL DEFAULT 1440
);

CREATE TABLE IF NOT EXISTS facilities (
  id           INTEGER PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  district     TEXT NOT NULL,
  parish       TEXT NOT NULL,
  category     TEXT NOT NULL,
  phone        TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facilities_lookup ON facilities (district, parish, category);

CREATE TABLE IF NOT EXISTS facility_services (
  facility_id  INTEGER NOT NULL REFERENCES facilities(id),
  service_code TEXT NOT NULL REFERENCES service_types(code),
  PRIMARY KEY (facility_id, service_code)
);

CREATE TABLE IF NOT EXISTS status_updates (
  id             INTEGER PRIMARY KEY,
  facility_id    INTEGER NOT NULL REFERENCES facilities(id),
  service_code   TEXT NOT NULL REFERENCES service_types(code),
  state          TEXT NOT NULL,
  detail         TEXT,
  raw_message    TEXT NOT NULL,
  channel        TEXT NOT NULL,
  source_msisdn  TEXT NOT NULL,
  reporter_role  TEXT NOT NULL,
  verification   TEXT NOT NULL,
  verified_by    TEXT,
  verified_at    TEXT,
  reject_reason  TEXT,
  notified_at    TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_updates_lookup ON status_updates (facility_id, service_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_updates_pending ON status_updates (verification, created_at);

CREATE TABLE IF NOT EXISTS app_users (
  msisdn      TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,
  facility_id INTEGER REFERENCES facilities(id),
  language    TEXT NOT NULL DEFAULT 'en',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ussd_sessions (
  id         TEXT PRIMARY KEY,
  msisdn     TEXT NOT NULL,
  language   TEXT NOT NULL DEFAULT 'en',
  flow       TEXT NOT NULL DEFAULT 'start',
  state      TEXT NOT NULL,
  context    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at  TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER PRIMARY KEY,
  direction         TEXT NOT NULL,
  channel           TEXT NOT NULL DEFAULT 'SMS',
  msisdn            TEXT NOT NULL,
  body              TEXT NOT NULL,
  status            TEXT NOT NULL,
  provider_id       TEXT,
  error             TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  related_update_id INTEGER REFERENCES status_updates(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  delivered_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at DESC);

CREATE TABLE IF NOT EXISTS service_queries (
  id           INTEGER PRIMARY KEY,
  msisdn       TEXT NOT NULL,
  channel      TEXT NOT NULL,
  facility_id  INTEGER REFERENCES facilities(id),
  service_code TEXT REFERENCES service_types(code),
  answered     INTEGER NOT NULL,
  result_state TEXT,
  avoided_trip INTEGER,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queries_created ON service_queries (created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);
`;

export function openDb(file = path.join(config.dataDir, 'platform.sqlite')): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true });
  const handle = new DatabaseSync(file);
  handle.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  handle.exec(SCHEMA);
  // Older pilot databases predate the reminder column; CREATE TABLE IF NOT EXISTS cannot add it.
  const columns = handle.prepare(`SELECT name FROM pragma_table_info('status_updates')`).all() as { name: string }[];
  if (!columns.some((c) => c.name === 'notified_at')) {
    handle.exec('ALTER TABLE status_updates ADD COLUMN notified_at TEXT');
  }
  db = handle;
  return handle;
}

function requireDb(): DatabaseSync {
  if (!db) throw new Error('Database not opened — call openDb() first');
  return db;
}

export const nowIso = () => new Date().toISOString();

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return requireDb().prepare(sql).all(...(params as never[])) as T[];
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return requireDb().prepare(sql).get(...(params as never[])) as T | undefined;
}

export function run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
  const result = requireDb().prepare(sql).run(...(params as never[]));
  return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
}

export function exec(sql: string): void {
  requireDb().exec(sql);
}

export function closeDb(): void {
  db?.close();
  db = undefined;
}

export function tx<T>(fn: () => T): T {
  const handle = requireDb();
  handle.exec('BEGIN');
  try {
    const result = fn();
    handle.exec('COMMIT');
    return result;
  } catch (error) {
    handle.exec('ROLLBACK');
    throw error;
  }
}

export function audit(actor: string, action: string, entity: string, detail?: string): void {
  run(
    'INSERT INTO audit_log (actor, action, entity, detail, created_at) VALUES (?, ?, ?, ?, ?)',
    actor,
    action,
    entity,
    detail ?? null,
    nowIso(),
  );
}
