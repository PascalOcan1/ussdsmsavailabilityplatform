import { all, get, run, nowIso, audit } from '../db.ts';
import { config } from '../config.ts';
import type { Channel, Facility, Language, Role, ServiceType, State, StatusUpdate, Verification } from '../types.ts';
import { serviceLabel, stateLabel, t } from './language.ts';
import { notifySupervisors } from './verification.ts';

export interface NewReport {
  facilityId: number;
  serviceCode: string;
  state: State;
  detail?: string;
  rawMessage: string;
  channel: Channel;
  sourceMsisdn: string;
  role: Role;
}

const SELECT_BASE = `
  SELECT u.*, f.code AS facility_code, f.name AS facility_name, f.district, f.parish
  FROM status_updates u
  JOIN facilities f ON f.id = u.facility_id
  WHERE f.active = 1 AND `;

/**
 * Supervisors and admins settle their own reports; everyone else needs verification
 * for services flagged critical. This is the anti-fabrication control from the proposal.
 */
export function verificationFor(role: Role, requiresVerification: boolean): Verification {
  if (role === 'SUPERVISOR' || role === 'ADMIN') return 'VERIFIED';
  return requiresVerification ? 'PENDING' : 'NOT_REQUIRED';
}

export function recordUpdate(report: NewReport): StatusUpdate {
  const service = get<ServiceType>('SELECT * FROM service_types WHERE code = ?', report.serviceCode);
  if (!service) throw new Error(`Unknown service ${report.serviceCode}`);
  const facility = get<Facility>('SELECT * FROM facilities WHERE id = ?', report.facilityId);
  if (!facility) throw new Error(`Unknown facility ${report.facilityId}`);

  const verification = verificationFor(report.role, service.requires_verification === 1);
  const timestamp = nowIso();
  const inserted = run(
    `INSERT INTO status_updates
       (facility_id, service_code, state, detail, raw_message, channel, source_msisdn,
        reporter_role, verification, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    report.facilityId,
    report.serviceCode,
    report.state,
    report.detail ?? null,
    report.rawMessage,
    report.channel,
    report.sourceMsisdn,
    report.role,
    verification,
    timestamp,
  );

  audit(report.sourceMsisdn, 'REPORT', `update:${inserted.lastInsertRowid}`,
    `${report.facilityId}/${report.serviceCode}=${report.state} via ${report.channel}`);

  if (verification === 'PENDING') {
    notifySupervisors({
      updateId: inserted.lastInsertRowid,
      facilityCode: facility.code,
      serviceName: service.name,
      state: report.state,
      sourceMsisdn: report.sourceMsisdn,
    });
  }

  return {
    id: inserted.lastInsertRowid,
    facility_id: report.facilityId,
    service_code: report.serviceCode,
    state: report.state,
    detail: report.detail ?? null,
    raw_message: report.rawMessage,
    channel: report.channel,
    source_msisdn: report.sourceMsisdn,
    reporter_role: report.role,
    verification,
    verified_by: verification === 'VERIFIED' ? report.sourceMsisdn : null,
    verified_at: verification === 'VERIFIED' ? timestamp : null,
    reject_reason: null,
    created_at: timestamp,
  };
}

export interface CurrentStatus extends StatusUpdate {
  facility_code: string;
  facility_name: string;
  district: string;
  parish: string;
  service_name: string;
  minutes_old: number;
  stale: boolean;
}

function decorate(row: StatusUpdate & Record<string, unknown>, service: ServiceType): CurrentStatus {
  const minutesOld = minutesSince(row.created_at);
  const limit = Math.min(service.ttl_minutes, config.staleAfterMinutes);
  return {
    ...(row as StatusUpdate),
    facility_code: row.facility_code as string,
    facility_name: row.facility_name as string,
    district: row.district as string,
    parish: row.parish as string,
    service_name: service.name,
    state: row.state as State,
    verification: row.verification as Verification,
    minutes_old: minutesOld,
    stale: minutesOld > limit,
  };
}

export function minutesSince(iso: string, at = Date.now()): number {
  return Math.max(0, Math.floor((at - Date.parse(iso)) / 60000));
}

/** Newest update that has not been rejected by a supervisor. */
export function currentStatus(facilityId: number, serviceCode: string): CurrentStatus | undefined {
  const row = get<StatusUpdate & Record<string, unknown>>(
    `${SELECT_BASE}u.facility_id = ? AND u.service_code = ? AND u.verification != 'REJECTED'
     ORDER BY u.created_at DESC, u.id DESC LIMIT 1`,
    facilityId,
    serviceCode,
  );
  const service = get<ServiceType>('SELECT * FROM service_types WHERE code = ?', serviceCode);
  if (!row || !service) return undefined;
  return decorate(row, service);
}

export function facilityServices(facilityId: number): ServiceType[] {
  return all<ServiceType>(
    `SELECT s.* FROM service_types s
     JOIN facility_services fs ON fs.service_code = s.code
     WHERE fs.facility_id = ? ORDER BY s.name`,
    facilityId,
  );
}

export function facilityStatusBoard(facilityId: number): CurrentStatus[] {
  return facilityServices(facilityId)
    .map((service) => currentStatus(facilityId, service.code))
    .filter((status): status is CurrentStatus => status !== undefined);
}

export interface SummaryLine {
  service: string;
  state: State;
  verification: Verification;
  minutes_old: number;
  stale: boolean;
}

/** Compact, feature-phone friendly summary of everything known about one facility. */
export function summarizeFacility(facility: Facility, lang: Language): string[] {
  const board = facilityStatusBoard(facility.id);
  if (board.length === 0) return [t('noData', lang)];
  return board.map((status) => {
    const service = get<ServiceType>('SELECT * FROM service_types WHERE code = ?', status.service_code);
    const verified = status.verification === 'VERIFIED' ? '' : ` [${t('unverified', lang)}]`;
    const stale = status.stale ? ` [${t('staleWarning', lang)}]` : '';
    return `${service ? serviceLabel(service, lang) : status.service_code}: ${stateLabel(status.state, lang)}${ago(status.minutes_old, lang)}${verified}${stale}`;
  });
}

export function ago(minutes: number, lang: Language): string {
  if (minutes < 1) return ` (${t('agoJustNow', lang)})`;
  if (minutes < 60) return ` (${minutes} ${t('agoMinutes', lang)})`;
  if (minutes < 1440) return ` (${Math.round(minutes / 60)} ${t('agoHours', lang)})`;
  return ` (${Math.round(minutes / 1440)} ${t('agoDays', lang)})`;
}

/**
 * Updates awaiting a supervisor decision, limited to those still serving as the
 * current status — a later verified report makes older pending ones moot.
 */
export function pendingVerifications(limit = 200): CurrentStatus[] {
  const rows = all<StatusUpdate & Record<string, unknown>>(
    `${SELECT_BASE}u.verification = 'PENDING' ORDER BY u.created_at DESC LIMIT ?`,
    limit,
  );
  const services = new Map(serviceIndex());
  return rows
    .filter((row) => services.get(row.service_code as string) !== undefined)
    .map((row) => decorate(row, services.get(row.service_code as string)!))
    .filter((row) => currentStatus(row.facility_id, row.service_code)?.id === row.id);
}

function serviceIndex(): [string, ServiceType][] {
  return all<ServiceType>('SELECT * FROM service_types').map((service) => [service.code, service]);
}

export function supervisors(): { msisdn: string; name: string }[] {
  return all<{ msisdn: string; name: string }>(
    `SELECT msisdn, name FROM app_users WHERE role = 'SUPERVISOR' AND active = 1`,
  );
}

export function findReporter(msisdn: string): { role: Role; language: Language; facility_id: number | null } | undefined {
  return get(`SELECT role, language, facility_id FROM app_users WHERE msisdn = ? AND active = 1`, msisdn);
}
