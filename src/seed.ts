import { all, exec, get, nowIso, run, tx } from './db.ts';

interface SeedService {
  code: string;
  name: string;
  name_lg: string;
  name_sw: string;
  critical: boolean;
  ttl: number;
}

/** Critical services are the ones that must be supervisor-verified before citizens see them as settled. */
const SERVICES: SeedService[] = [
  { code: 'VACCINE', name: 'Vaccines', name_lg: 'Ekifoza', name_sw: 'Chanjo', critical: true, ttl: 1440 },
  { code: 'MEDICINE', name: 'Essential medicines', name_lg: 'Edagala', name_sw: 'Dawa', critical: true, ttl: 1440 },
  { code: 'STAFF', name: 'Staff on duty', name_lg: 'Abakozi', name_sw: 'Wafanyakazi', critical: true, ttl: 720 },
  { code: 'LAB', name: 'Lab tests', name_lg: 'Emikwakkula y’omulongo', name_sw: 'Vipimo', critical: false, ttl: 1440 },
  { code: 'MORTUARY', name: 'Mortuary services', name_lg: 'Mwalimu', name_sw: 'Mortuary', critical: false, ttl: 2880 },
  { code: 'PASSPORT', name: 'Passport desk', name_lg: 'Pasipoota', name_sw: 'Pasipoti', critical: true, ttl: 1440 },
  { code: 'NATIONALID', name: 'National ID desk', name_lg: 'Yanja', name_sw: 'Kitambulisho', critical: true, ttl: 1440 },
  { code: 'BIRTH', name: 'Birth certificates', name_lg: 'Yalisa y’omwana', name_sw: 'Cheti ya kuzaliwa', critical: false, ttl: 2880 },
  { code: 'LAND', name: 'Land title desk', name_lg: 'Eddoboozi ly’ettaka', name_sw: 'Ambani', critical: false, ttl: 2880 },
];

const FACILITIES = [
  { code: 'CLINIC1', name: 'Kigungu HC II', district: 'Wakiso', parish: 'Kigungu', category: 'HEALTH', services: ['VACCINE', 'MEDICINE', 'STAFF', 'LAB'] },
  { code: 'CLINIC2', name: 'Nansana HC III', district: 'Wakiso', parish: 'Nansana', category: 'HEALTH', services: ['VACCINE', 'MEDICINE', 'STAFF', 'LAB'] },
  { code: 'HOSP1', name: 'Wakiso General Hospital', district: 'Wakiso', parish: 'Wakiso Town', category: 'HEALTH', services: ['VACCINE', 'MEDICINE', 'STAFF', 'LAB', 'MORTUARY'] },
  { code: 'CLINIC3', name: 'Mukono HC IV', district: 'Mukono', parish: 'Mukono Town', category: 'HEALTH', services: ['VACCINE', 'MEDICINE', 'STAFF', 'LAB'] },
  { code: 'GOV1', name: 'Wakiso District Office', district: 'Wakiso', parish: 'Wakiso Town', category: 'GOVERNMENT', services: ['PASSPORT', 'NATIONALID', 'BIRTH', 'LAND'] },
  { code: 'GOV2', name: 'Nansana Sub-county Office', district: 'Wakiso', parish: 'Nansana', category: 'GOVERNMENT', services: ['NATIONALID', 'BIRTH'] },
];

const USERS = [
  { msisdn: '+256700111222', name: 'S. Namuli', role: 'SUPERVISOR', facility: null, language: 'lg' },
  { msisdn: '+256778715187', name: 'P. Ocan', role: 'ADMIN', facility: null, language: 'en' },
  { msisdn: '+256701234567', name: 'G. Nakato', role: 'STAFF', facility: 'CLINIC1', language: 'lg' },
  { msisdn: '+256702345678', name: 'J. Ssekandi', role: 'STAFF', facility: 'HOSP1', language: 'en' },
  { msisdn: '+256703456789', name: 'P. Ojera', role: 'VOLUNTEER', facility: 'CLINIC2', language: 'lg' },
  { msisdn: '+256704567890', name: 'M. Kirumira', role: 'VOLUNTEER', facility: 'GOV1', language: 'en' },
  { msisdn: '+256705678901', name: 'T. Wasswa', role: 'VOLUNTEER', facility: 'CLINIC3', language: 'sw' },
];

/** Sample reports so the pilot dashboard and analytics have something to show on first run. */
const SAMPLE_UPDATES = [
  { facility: 'CLINIC1', service: 'VACCINE', state: 'AVAILABLE', hoursAgo: 2, role: 'STAFF' as const, msisdn: '+256701234567', verification: 'VERIFIED' },
  { facility: 'CLINIC1', service: 'MEDICINE', state: 'LIMITED', hoursAgo: 3, role: 'STAFF' as const, msisdn: '+256701234567', verification: 'PENDING' },
  { facility: 'CLINIC2', service: 'STAFF', state: 'UNAVAILABLE', hoursAgo: 1, role: 'VOLUNTEER' as const, msisdn: '+256703456789', verification: 'PENDING' },
  { facility: 'HOSP1', service: 'LAB', state: 'AVAILABLE', hoursAgo: 5, role: 'STAFF' as const, msisdn: '+256702345678', verification: 'NOT_REQUIRED' },
  { facility: 'GOV1', service: 'PASSPORT', state: 'CLOSED', hoursAgo: 6, role: 'VOLUNTEER' as const, msisdn: '+256704567890', verification: 'PENDING' },
  { facility: 'GOV1', service: 'NATIONALID', state: 'AVAILABLE', hoursAgo: 26, role: 'VOLUNTEER' as const, msisdn: '+256704567890', verification: 'NOT_REQUIRED' },
  { facility: 'CLINIC3', service: 'VACCINE', state: 'AVAILABLE', hoursAgo: 4, role: 'VOLUNTEER' as const, msisdn: '+256705678901', verification: 'VERIFIED' },
];

function ago(hours: number): string {
  return new Date(Date.now() - hours * 3600000).toISOString();
}

export function seedIfEmpty(): boolean {
  archiveWaterFacilities();
  const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM facilities WHERE active = 1');
  if (count && Number(count.n) > 0) return false;

  tx(() => {
    for (const service of SERVICES) {
      run(
        `INSERT OR IGNORE INTO service_types (code, name, name_lg, name_sw, requires_verification, ttl_minutes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        service.code,
        service.name,
        service.name_lg,
        service.name_sw,
        service.critical ? 1 : 0,
        service.ttl,
      );
    }

    for (const facility of FACILITIES) {
      const inserted = run(
        `INSERT INTO facilities (code, name, district, parish, category, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        facility.code,
        facility.name,
        facility.district,
        facility.parish,
        facility.category,
        nowIso(),
      );
      for (const serviceCode of facility.services) {
        run(
          `INSERT INTO facility_services (facility_id, service_code) VALUES (?, ?)`,
          inserted.lastInsertRowid,
          serviceCode,
        );
      }
    }

    for (const user of USERS) {
      const facility = user.facility
        ? get<{ id: number }>('SELECT id FROM facilities WHERE code = ?', user.facility)
        : undefined;
      run(
        `INSERT OR REPLACE INTO app_users (msisdn, name, role, facility_id, language, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        user.msisdn,
        user.name,
        user.role,
        facility?.id ?? null,
        user.language,
        nowIso(),
      );
    }

    for (const update of SAMPLE_UPDATES) {
      const facility = get<{ id: number }>('SELECT id FROM facilities WHERE code = ?', update.facility);
      if (!facility) continue;
      run(
        `INSERT INTO status_updates
           (facility_id, service_code, state, raw_message, channel, source_msisdn, reporter_role,
            verification, verified_by, verified_at, created_at)
         VALUES (?, ?, ?, ?, 'SMS', ?, ?, ?, ?, ?, ?)`,
        facility.id,
        update.service,
        update.state,
        `${update.facility} ${update.service} ${update.state} (seed)`,
        update.msisdn,
        update.role,
        update.verification,
        update.verification === 'VERIFIED' ? '+256700111222' : null,
        update.verification === 'VERIFIED' ? ago(update.hoursAgo - 1) : null,
        ago(update.hoursAgo),
      );
      run(
        `INSERT INTO service_queries (msisdn, channel, facility_id, service_code, answered, result_state, avoided_trip, created_at)
         VALUES (?, 'USSD', ?, ?, 1, ?, ?, ?)`,
        '+256709999001',
        facility.id,
        update.service,
        update.state,
        update.state === 'UNAVAILABLE' || update.state === 'CLOSED' ? 1 : 0,
        ago(Math.max(0.5, update.hoursAgo - 0.5)),
      );
    }
  });

  return true;
}

function archiveWaterFacilities(): void {
  const water = all<{ id: number }>(`SELECT id FROM facilities WHERE category = 'WATER' AND active = 1`);
  if (water.length === 0) return;
  tx(() => {
    run(`UPDATE facilities SET active = 0 WHERE category = 'WATER'`);
    run(`UPDATE app_users SET active = 0 WHERE facility_id IN (SELECT id FROM facilities WHERE category = 'WATER')`);
    run(`DELETE FROM facility_services WHERE facility_id IN (SELECT id FROM facilities WHERE category = 'WATER')`);
  });
}

export function facilityCodes(): string[] {
  return all<{ code: string }>('SELECT code FROM facilities WHERE active = 1 ORDER BY code').map((row) => row.code);
}

export function resetAll(): void {
  exec(`DELETE FROM status_updates; DELETE FROM service_queries; DELETE FROM messages;
        DELETE FROM ussd_sessions; DELETE FROM audit_log; DELETE FROM app_users;
        DELETE FROM facility_services; DELETE FROM service_types; DELETE FROM facilities;`);
}
