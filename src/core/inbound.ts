import { get, run, nowIso } from '../db.ts';
import { config } from '../config.ts';
import { normalizeMsisdn, parseReport, SYNTAX_HELP, findFacility } from './parser.ts';
import { facilityStatusBoard, findReporter, recordUpdate, summarizeFacility } from './status.ts';
import { applyDecision, parseSupervisorCommand } from './verification.ts';
import type { Channel, Language, Role } from '../types.ts';

export interface InboundResult {
  msisdn: string;
  reply: string;
  kind: 'REPORT' | 'QUERY' | 'VERIFY' | 'HELP' | 'ERROR';
  updateId?: number;
}

/**
 * Single entry point for every inbound SMS, whatever channel delivered it.
 * Order matters: supervisor commands are checked before the report grammar because
 * they share the YES/NO vocabulary.
 */
export function handleInboundSms(from: string, text: string, channel: Channel = 'SMS'): InboundResult {
  const msisdn = normalizeMsisdn(from);
  const reporter = findReporter(msisdn);
  const language: Language = reporter?.language ?? 'en';
  const body = text.trim();

  recordInbound(msisdn, body, channel);

  if (!body) return { msisdn, kind: 'ERROR', reply: SYNTAX_HELP };

  if (/^HELP(\s|$)/i.test(body)) {
    return { msisdn, kind: 'HELP', reply: helpText() };
  }

  const command = parseSupervisorCommand(body);
  if (command) {
    if (!reporter || (reporter.role !== 'SUPERVISOR' && reporter.role !== 'ADMIN')) {
      return {
        msisdn,
        kind: 'ERROR',
        reply: `Only supervisors can confirm reports. To report status send: ${SYNTAX_HELP}`,
      };
    }
    const decision = applyDecision(command, msisdn);
    return { msisdn, kind: 'VERIFY', reply: decision.message };
  }

  const check = /^(CHECK|CHK|STATUS)\s+(\S+)(\s+\S+)?$/i.exec(body);
  if (check) {
    return citizenQuery(msisdn, check[2], check[3]?.slice(1), language, channel);
  }

  const parsed = parseReport(body);
  if (!parsed.ok) {
    return { msisdn, kind: 'ERROR', reply: `${parsed.error}: ${parsed.hint ?? SYNTAX_HELP}` };
  }

  const facility = findFacility(parsed.facilityCode!);
  if (!facility) return { msisdn, kind: 'ERROR', reply: `Facility ${parsed.facilityCode} not found` };

  const update = recordUpdate({
    facilityId: facility.id,
    serviceCode: parsed.serviceCode!,
    state: parsed.state!,
    detail: parsed.detail,
    rawMessage: body,
    channel,
    sourceMsisdn: msisdn,
    role: (reporter?.role ?? 'VOLUNTEER') as Role,
  });

  const service = get<{ name: string }>('SELECT name FROM service_types WHERE code = ?', parsed.serviceCode!);
  const pendingNote =
    update.verification === 'PENDING' ? '\nSent to your supervisor for confirmation.' : '';
  return {
    msisdn,
    kind: 'REPORT',
    updateId: update.id,
    reply: `RECEIVED #${update.id}: ${facility.code} ${service?.name ?? parsed.serviceCode} = ${update.state}.${pendingNote}`,
  };
}

function citizenQuery(
  msisdn: string,
  codeToken: string,
  serviceToken: string | undefined,
  language: Language,
  channel: Channel,
): InboundResult {
  const facility = findFacility(codeToken);
  if (!facility) {
    return { msisdn, kind: 'ERROR', reply: `No facility with code ${codeToken.toUpperCase()}. ${SYNTAX_HELP}` };
  }

  if (serviceToken) {
    const parsed = parseReport(`${facility.code} ${serviceToken} YES`);
    const serviceCode = parsed.ok ? parsed.serviceCode : undefined;
    if (!serviceCode) {
      return { msisdn, kind: 'ERROR', reply: `Unknown service ${serviceToken}. ${SYNTAX_HELP}` };
    }
    const board = facilityStatusBoard(facility.id).filter((row) => row.service_code === serviceCode);
    recordQuery(msisdn, facility.id, serviceCode, board.length > 0, channel);
    if (board.length === 0) return { msisdn, kind: 'QUERY', reply: `${facility.name}: ${serviceCode} - no update yet.` };
    return { msisdn, kind: 'QUERY', reply: formatBoard(facility.name, board, language) };
  }

  const board = facilityStatusBoard(facility.id);
  recordQuery(msisdn, facility.id, null, board.length > 0, channel);
  const lines = summarizeFacility(facility, language);
  return { msisdn, kind: 'QUERY', reply: formatBoard(`${facility.name} (${facility.parish})`, lines, language) };
}

function formatBoard(heading: string, rows: unknown[], language: Language): string {
  void language;
  if (typeof rows[0] === 'string') {
    return [heading, ...(rows as string[])].join('\n');
  }
  const list = rows as { service_name: string; state: string; minutes_old: number; verification: string }[];
  return [
    heading,
    ...list.map(
      (row) =>
        `${row.service_name}: ${row.state} (${row.minutes_old}m)${row.verification === 'VERIFIED' ? '' : ' [unconfirmed]'}`,
    ),
  ].join('\n');
}

function helpText(): string {
  return (
    `ServiceAlert ${config.shortCode}\n` +
    `Report: CLINIC1 VACCINE YES\n` +
    `Check: CHECK CLINIC1 or CHECK CLINIC1 VACCINE\n` +
    `Words: YES NO LIMITED BROKEN CLOSED\n` +
    `Supervisors: OK 12 / NO 12 reason`
  );
}

function recordInbound(msisdn: string, body: string, channel: Channel): void {
  const timestamp = nowIso();
  run(
    `INSERT INTO messages (direction, channel, msisdn, body, status, created_at, updated_at)
    VALUES ('IN', ?, ?, ?, 'RECEIVED', ?, ?)`,
      channel,
    msisdn,
    body,
    timestamp,
    timestamp,
  );
}

function recordQuery(
  msisdn: string,
  facilityId: number,
  serviceCode: string | null,
  answered: boolean,
  channel: Channel,
): void {
  run(
    `INSERT INTO service_queries (msisdn, channel, facility_id, service_code, answered, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
    msisdn,
      channel,
    facilityId,
    serviceCode,
    answered ? 1 : 0,
    nowIso(),
  );
}
