import { all, get } from '../db.ts';
import { config } from '../config.ts';
import { minutesSince } from './status.ts';

export interface Kpis {
  facilities: number;
  reporters: number;
  updatesTotal: number;
  updates30d: number;
  queriesTotal: number;
  queriesAnswered: number;
  answerRate: number;
  pendingVerification: number;
  verifiedRate: number;
  avoidedTrips: number;
  tripResponses: number;
  avoidedTripRate: number;
  outbound: number;
  delivered: number;
  failed: number;
  staleUpdates: number;
}

const scalar = (sql: string, ...params: unknown[]): number => {
  const row = get<Record<string, number | bigint>>(sql, ...params);
  return row ? Number(Object.values(row)[0] ?? 0) : 0;
};

export function kpis(): Kpis {
  const activeUpdates = `facility_id IN (SELECT id FROM facilities WHERE active = 1)`;
  const activeQueries = `facility_id IN (SELECT id FROM facilities WHERE active = 1)`;
  const updatesTotal = scalar(`SELECT COUNT(*) FROM status_updates WHERE ${activeUpdates}`);
  const updates30d = scalar(
    `SELECT COUNT(*) FROM status_updates WHERE ${activeUpdates} AND created_at > datetime('now', '-30 days')`,
  );
  const queriesTotal = scalar(`SELECT COUNT(*) FROM service_queries WHERE ${activeQueries}`);
  const queriesAnswered = scalar(`SELECT COUNT(*) FROM service_queries WHERE ${activeQueries} AND answered = 1`);
  const critical = scalar(`SELECT COUNT(*) FROM status_updates WHERE ${activeUpdates} AND verification != 'NOT_REQUIRED'`);
  const verified = scalar(`SELECT COUNT(*) FROM status_updates WHERE ${activeUpdates} AND verification = 'VERIFIED'`);
  const pending = scalar(`SELECT COUNT(*) FROM status_updates WHERE ${activeUpdates} AND verification = 'PENDING'`);
  const tripResponses = scalar(`SELECT COUNT(*) FROM service_queries WHERE ${activeQueries} AND avoided_trip IS NOT NULL`);
  const avoided = scalar(`SELECT COUNT(*) FROM service_queries WHERE ${activeQueries} AND avoided_trip = 1`);
  const stale = all<{ created_at: string }>(`SELECT created_at FROM status_updates WHERE ${activeUpdates}`)
    .filter((row) => minutesSince(row.created_at) > config.staleAfterMinutes).length;

  return {
    facilities: scalar(`SELECT COUNT(*) FROM facilities WHERE active = 1`),
    reporters: scalar(`SELECT COUNT(*) FROM app_users WHERE active = 1`),
    updatesTotal,
    updates30d,
    queriesTotal,
    queriesAnswered,
    answerRate: queriesTotal ? Math.round((queriesAnswered / queriesTotal) * 1000) / 10 : 0,
    pendingVerification: pending,
    verifiedRate: critical ? Math.round((verified / critical) * 1000) / 10 : 0,
    avoidedTrips: avoided,
    tripResponses,
    avoidedTripRate: tripResponses ? Math.round((avoided / tripResponses) * 1000) / 10 : 0,
    outbound: scalar(`SELECT COUNT(*) FROM messages WHERE direction = 'OUT'`),
    delivered: scalar(`SELECT COUNT(*) FROM messages WHERE direction = 'OUT' AND status = 'DELIVERED'`),
    failed: scalar(`SELECT COUNT(*) FROM messages WHERE direction = 'OUT' AND status = 'FAILED'`),
    staleUpdates: stale,
  };
}

export interface MonthlyRow {
  month: string;
  updates: number;
  queries: number;
}

export function monthly(limit = 12): MonthlyRow[] {
  const updates = all<{ month: string; n: number }>(
    `SELECT strftime('%Y-%m', u.created_at) AS month, COUNT(*) AS n
     FROM status_updates u JOIN facilities f ON f.id = u.facility_id
     WHERE f.active = 1 GROUP BY month ORDER BY month DESC LIMIT ?`,
    limit,
  );
  const queries = new Map(
    all<{ month: string; n: number }>(
      `SELECT strftime('%Y-%m', q.created_at) AS month, COUNT(*) AS n
       FROM service_queries q JOIN facilities f ON f.id = q.facility_id
       WHERE f.active = 1 GROUP BY month`,
    ).map((row) => [row.month, Number(row.n)]),
  );
  return updates
    .map((row) => ({ month: row.month, updates: Number(row.n), queries: Number(queries.get(row.month) ?? 0) }))
    .reverse();
}

export interface CoverageRow {
  code: string;
  name: string;
  district: string;
  services: number;
  reported: number;
  minutes_since_last: number | null;
}

/** Per-facility reporting coverage — shows supervisors which sites have gone quiet. */
export function coverage(): CoverageRow[] {
  const rows = all<{ id: number; code: string; name: string; district: string; services: number }>(
    `SELECT f.id, f.code, f.name, f.district,
            (SELECT COUNT(*) FROM facility_services fs WHERE fs.facility_id = f.id) AS services
     FROM facilities f WHERE f.active = 1 ORDER BY f.code`,
  );
  return rows.map((row) => {
    const last = get<{ created_at: string }>(
      `SELECT created_at FROM status_updates WHERE facility_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      row.id,
    );
    const distinct = scalar(`SELECT COUNT(DISTINCT service_code) FROM status_updates WHERE facility_id = ?`, row.id);
    return {
      code: row.code,
      name: row.name,
      district: row.district,
      services: Number(row.services),
      reported: distinct,
      minutes_since_last: last ? minutesSince(last.created_at) : null,
    };
  });
}

export interface ChannelSplit {
  channel: string;
  count: number;
}

export function channelSplit(): ChannelSplit[] {
  return all<ChannelSplit>(
    `SELECT q.channel, COUNT(*) AS count FROM service_queries q
     JOIN facilities f ON f.id = q.facility_id WHERE f.active = 1
     GROUP BY q.channel ORDER BY count DESC`,
  ).map((row) => ({ channel: row.channel, count: Number(row.count) }));
}
