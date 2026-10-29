import { get, all } from '../db.ts';
import type { Facility, ParsedReport, ServiceType, State } from '../types.ts';
import { stateFromWord } from './language.ts';

/** Synonyms accepted for each service code so reporters need only short words. */
const SERVICE_ALIASES: Record<string, string[]> = {
  VACCINE: ['VACCINE', 'VACCINES', 'IMMUNIZATION', 'IMMUNISATION', 'EPI', 'JAB', 'JABS'],
  MEDICINE: ['MEDICINE', 'MEDICINES', 'MEDS', 'DRUG', 'DRUGS', 'PHARMACY', 'DRUGSOK'],
  STAFF: ['STAFF', 'CLINICIAN', 'CLINICIANS', 'DOCTOR', 'DOCTORS', 'NURSE', 'NURSES', 'OFFICERINCHARGE', 'STAFFED'],
  LAB: ['LAB', 'LABORATORY', 'TESTS', 'TESTING'],
  MORTUARY: ['MORTUARY'],
  PASSPORT: ['PASSPORT', 'PASSPORTS', 'NRA', 'IMMIGRATION'],
  NATIONALID: ['NATIONALID', 'ID', 'IDS', 'NIN', 'REGISTER'],
  BIRTH: ['BIRTH', 'BIRTHCERT', 'BIRTHCERTIFICATE', 'REGISTRATION'],
  LAND: ['LAND', 'TITLE', 'TITLES', 'DEED', 'DEEDS'],
  COURT: ['COURT', 'MAGISTRATE', 'CASE'],
  TEACHERS: ['TEACHERS', 'TEACHER', 'STAFF', 'ENROLLMENT', 'ENROLMENT'],
};

const NON_WORD = /[^A-Z0-9]+/g;

export function normalizeText(input: string): string {
  return input.toUpperCase().replace(NON_WORD, ' ').trim().replace(/ {1,}/g, ' ');
}

/** Accepts 07xx, 7xx, 2567xx and +2567xx forms and returns a +256 E.164 number. */
export function normalizeMsisdn(raw: string): string {
  const digits = raw.replace(/[^0-9+]/g, '');
  const body = digits.replace('+', '');
  if (body.startsWith('256')) return `+${body}`;
  if (body.startsWith('00256')) return `+${body.slice(2)}`;
  if (body.startsWith('0') && body.length === 10) return `+256${body.slice(1)}`;
  if (body.length === 9) return `+256${body}`;
  return `+${body}`;
}

export function findFacility(token: string): Facility | undefined {
  return get<Facility>(
    'SELECT * FROM facilities WHERE code = ? AND active = 1',
    token.toUpperCase(),
  );
}

export function serviceDictionary(): ServiceType[] {
  return all<ServiceType>(
    `SELECT DISTINCT s.* FROM service_types s
     JOIN facility_services fs ON fs.service_code = s.code
     JOIN facilities f ON f.id = fs.facility_id
     WHERE f.active = 1`,
  );
}

/** The single tracked service of a facility, when there is exactly one and it can be implied. */
function soleServiceOf(facilityId: number): string | undefined {
  const rows = all<{ service_code: string }>(
    `SELECT service_code FROM facility_services WHERE facility_id = ?`,
    facilityId,
  );
  return rows.length === 1 ? rows[0].service_code : undefined;
}

/** Merge a split facility code like "CLINIC 1" into "CLINIC1" when that is a real code. */
function mergeSplitCode(tokens: string[]): string[] {
  if (tokens.length < 2) return tokens;
  const joined = `${tokens[0]}${tokens[1]}`;
  if (findFacility(joined)) return [joined, ...tokens.slice(2)];
  return tokens;
}

function matchService(tokens: string[]): { code: string; index: number } | undefined {
  for (const service of serviceDictionary()) {
    const aliases = SERVICE_ALIASES[service.code] ?? [service.code];
    const candidates = new Set([...aliases, normalizeText(service.name)]);
    for (let index = 0; index < tokens.length; index += 1) {
      if (candidates.has(tokens[index])) return { code: service.code, index };
    }
  }
  return undefined;
}

function matchStateExcluding(tokens: string[], skip: number): { state: State; index: number } | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    if (index === skip) continue;
    const state = stateFromWord(tokens[index]);
    if (state) return { state, index };
  }
  return undefined;
}

export const SYNTAX_HELP =
  `Send: FACILITY SERVICE STATUS. Example: CLINIC1 VACCINE YES`;

/**
 * Parse a coded status report, e.g. "CLINIC 1 VACCINE YES" or "CLINIC2 STAFF LIMITED".
 * Tolerant of case, spacing and punctuation, and of split facility codes.
 */
export function parseReport(raw: string): ParsedReport {
  const text = normalizeText(raw);
  if (!text) return { ok: false, error: 'EMPTY', hint: SYNTAX_HELP };

  let tokens = text.split(' ');
  tokens = mergeSplitCode(tokens);

  const facility = findFacility(tokens[0]);
  if (!facility) {
    return { ok: false, error: 'UNKNOWN_FACILITY', hint: `Code "${tokens[0]}" is not registered. ${SYNTAX_HELP}` };
  }

  const rest = tokens.slice(1);
  let service = matchService(rest);
  const stateMatch = matchStateExcluding(rest, service?.index ?? -1);

  // A facility with one tracked service can omit the service name.
  if (!service && stateMatch) {
    const sole = soleServiceOf(facility.id);
    if (sole) service = { code: sole, index: -1 };
  }

  if (!service) {
    return {
      ok: false,
      facilityCode: facility.code,
      error: 'UNKNOWN_SERVICE',
      hint: `Unknown service for ${facility.code}. Try: ${[...new Set(Object.values(SERVICE_ALIASES).flat())].slice(0, 8).join(', ')}`,
    };
  }

  if (!stateMatch) {
    return {
      ok: false,
      facilityCode: facility.code,
      serviceCode: service.code,
      error: 'MISSING_STATUS',
      hint: `Add a status word: YES, NO, LIMITED, BROKEN or CLOSED. Example: ${facility.code} ${service.code} YES`,
    };
  }

  const detail = rest
    .filter((_, index) => index !== service!.index && index !== stateMatch.index)
    .join(' ')
    .toLowerCase();

  return {
    ok: true,
    facilityCode: facility.code,
    serviceCode: service.code,
    state: stateMatch.state,
    detail: detail.slice(0, 120) || undefined,
  };
}
