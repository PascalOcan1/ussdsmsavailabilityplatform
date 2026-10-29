import { all, get, run, nowIso } from '../db.ts';
import type { Facility, ServiceType, State } from '../types.ts';
import { isLanguage, serviceLabel, stateLabel, t, type Language } from './language.ts';
import { facilityServices, findReporter, minutesSince, recordUpdate, summarizeFacility } from './status.ts';
import { config } from '../config.ts';

export const SESSION_TTL_MS = 90_000;

/** Items shown per USSD screen before paging; "9. More" advances the list. */
const PAGE_SIZE = 8;

export type SessionState =
  | 'start'
  | 'lang'
  | 'main'
  | 'cat'
  | 'district'
  | 'facility'
  | 'service'
  | 'trip'
  | 'rpt_facility'
  | 'rpt_service'
  | 'rpt_state'
  | 'help'
  | 'end';

interface SessionContext {
  language?: Language;
  category?: string;
  district?: string;
  facilityId?: number;
  serviceCode?: string;
  page?: number;
  lastFacilityId?: number;
  lastService?: string;
}

export interface UssdRequest {
  sessionId: string;
  msisdn: string;
  text: string;
  action?: 'CON' | 'CFG' | 'COM' | 'END';
}

export interface UssdReply {
  text: string;
  continues: boolean;
  sessionId: string;
}

interface SessionRow {
  id: string;
  msisdn: string;
  language: string;
  state: string;
  context: string;
  updated_at: string;
}

const STATE_OPTIONS: State[] = ['AVAILABLE', 'LIMITED', 'UNAVAILABLE', 'CLOSED'];
const LANGUAGE_CODES: Record<string, Language> = { '1': 'en', '2': 'lg', '3': 'sw' };
const CATEGORY_KEYS: Record<string, string> = { HEALTH: 'health', GOVERNMENT: 'government' };

function currentLanguage(session: SessionRow): Language {
  return isLanguage(session.language) ? session.language : 'en';
}

function readContext(session: SessionRow): SessionContext {
  try {
    return JSON.parse(session.context) as SessionContext;
  } catch {
    return {};
  }
}

function title(text: string, items: string[], extras: string[] = []): string {
  return [text, '', ...items.map((item, index) => `${index + 1}. ${item}`), ...extras].join('\n');
}

function menu(items: string[], language: Language, extras: string[] = []): string {
  return items
    .map((item, index) => `${index + 1}. ${item}`)
    .concat(extras)
    .join('\n');
}

function mainMenu(language: Language): string {
  return title(
    `${t('welcome', language)}\n\n${t('mainMenu', language)}`,
    [t('checkStatus', language), t('reportStatus', language), t('help', language)],
    [t('exit', language)],
  );
}

function languageMenu(): string {
  return title(`${t('welcome', 'en')}\n\n${t('chooseLanguage', 'en')}`, ['English', 'Luganda', 'Swahili']);
}

function categories(): string[] {
  return all<{ category: string }>(
    `SELECT DISTINCT category FROM facilities WHERE active = 1 ORDER BY category`,
  ).map((row) => row.category);
}

function districts(category?: string): string[] {
  const rows = category
    ? all<{ district: string }>(
        `SELECT DISTINCT district FROM facilities WHERE active = 1 AND category = ? ORDER BY district`,
        category,
      )
    : all<{ district: string }>(`SELECT DISTINCT district FROM facilities WHERE active = 1 ORDER BY district`);
  return rows.map((row) => row.district);
}

function facilitiesFor(category: string | undefined, district: string | undefined): Facility[] {
  return all<Facility>(
    `SELECT * FROM facilities
     WHERE active = 1 AND (? IS NULL OR category = ?) AND (? IS NULL OR district = ?)
     ORDER BY code`,
    category ?? null, category ?? null, district ?? null, district ?? null,
  );
}

function facilityById(id: number): Facility | undefined {
  return get<Facility>('SELECT * FROM facilities WHERE id = ?', id);
}

function reporterFacilities(msisdn: string): Facility[] {
  const reporter = findReporter(msisdn);
  if (!reporter) return [];
  if (reporter.role === 'SUPERVISOR' || reporter.role === 'ADMIN') {
    return all<Facility>(`SELECT * FROM facilities WHERE active = 1 ORDER BY code`);
  }
  if (reporter.facility_id) {
    return all<Facility>(`SELECT * FROM facilities WHERE id = ? AND active = 1`, reporter.facility_id);
  }
  return [];
}

function recordQuery(
  msisdn: string,
  channel: string,
  facilityId: number | null,
  serviceCode: string | null,
  resultState: string | null,
  avoidedTrip?: boolean,
): void {
  run(
    `INSERT INTO service_queries (msisdn, channel, facility_id, service_code, answered, result_state, avoided_trip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    msisdn,
    channel,
    facilityId,
    serviceCode,
    resultState === null ? 0 : 1,
    resultState,
    avoidedTrip === undefined ? null : avoidedTrip ? 1 : 0,
    nowIso(),
  );
}

/**
 * Pull-mode USSD session machine. Each request carries the previous screen's input;
 * the reply either continues (CON) or ends (END) the session.
 */
export function handleUssd(request: UssdRequest): UssdReply {
  const input = request.text.trim();
  const session = get<SessionRow>('SELECT * FROM ussd_sessions WHERE id = ?', request.sessionId);

  if (request.action === 'END') {
    if (session) closeSession(session.id);
    return { text: t('sendThanks', session ? currentLanguage(session) : 'en'), continues: false, sessionId: request.sessionId };
  }

  if (!session) return startSession(request.sessionId, request.msisdn);

  const stale = Date.now() - Date.parse(session.updated_at) > SESSION_TTL_MS;
  if (stale || session.state === 'end') {
    closeSession(session.id);
    return startSession(request.sessionId, request.msisdn);
  }

  const context = readContext(session);
  const language = currentLanguage(session);

  const go = (
    state: SessionState,
    text: string,
    next: SessionContext = context,
    continues = true,
    languageOverride?: Language,
  ): UssdReply => {
    const keep = languageOverride ?? language;
    run(
      `UPDATE ussd_sessions SET state = ?, context = ?, language = ?, updated_at = ? WHERE id = ?`,
      state,
      JSON.stringify(next),
      keep,
      nowIso(),
      session.id,
    );
    if (!continues) closeSession(session.id);
    return { text, continues, sessionId: session.id };
  };

  if (input === '###' || input === '9' && session.state === 'main') {
    return go('end', t('sendThanks', language), context, false);
  }

  switch (session.state as SessionState) {
    case 'lang': {
      const chosen = LANGUAGE_CODES[input];
      if (!chosen) return go('lang', t('invalidChoice', 'en'));
      return go('main', mainMenu(chosen), { ...context, language: chosen }, true, chosen);
    }

    case 'main': {
      if (input === '1') {
        const list = categories();
        return go('cat', title(t('chooseCategory', language), list.map((code) => t(CATEGORY_KEYS[code] ?? code, language))));
      }
      if (input === '2') return reporterMenu(request, go, language, context);
      if (input === '3') return go('help', helpText(language));
      return go('main', mainMenu(language));
    }

    case 'cat': {
      const list = categories();
      const chosen = list[Number(input) - 1];
      if (!chosen) return go('cat', title(t('chooseCategory', language), list.map((code) => t(CATEGORY_KEYS[code] ?? code, language))));
      return go(
        'district',
        title(t('chooseDistrict', language), districts(chosen)),
        { ...context, category: chosen, page: 0 },
      );
    }

    case 'district': {
      const options = districts(context.category);
      const chosen = options[Number(input) - 1];
      if (!chosen) return go('district', title(t('chooseDistrict', language), options));
      return facilityListScreen(go, { ...context, district: chosen, page: 0 }, language);
    }

    case 'facility': {
      if (input === '0') return go('district', title(t('chooseDistrict', language), districts(context.category)), { ...context, page: 0 });
      if (input === String(PAGE_SIZE + 1)) {
        return facilityListScreen(go, { ...context, page: (context.page ?? 0) + 1 }, language);
      }
      const facilities = facilitiesFor(context.category, context.district);
      const chosen = facilities[(context.page ?? 0) * PAGE_SIZE + Number(input) - 1];
      if (!chosen) return facilityListScreen(go, context, language);
      return facilityScreen(go, chosen, context, language);
    }

    case 'service': {
      if (input === '0') return go('facility', facilityListContent({ ...context, page: 0 }, language), { ...context, page: 0 });
      const facility = facilityById(context.facilityId ?? 0);
      if (!facility) return go('main', mainMenu(language));
      const services = facilityServices(facility.id);
      const chosen = services[Number(input) - 1];
      if (!chosen) return go('service', serviceScreen(facility, language, services));

      const status = get<{ state: State; verification: string; created_at: string; service_name?: string }>(
        `SELECT u.state, u.verification, u.created_at FROM status_updates u
         WHERE u.facility_id = ? AND u.service_code = ? AND u.verification != 'REJECTED'
         ORDER BY u.created_at DESC, u.id DESC LIMIT 1`,
        facility.id,
        chosen.code,
      );
      if (!status) {
        recordQuery(request.msisdn, 'USSD', facility.id, chosen.code, null);
        return go('service', `${serviceLabel(chosen, language)}: ${t('noData', language)}\n\n${t('back', language)}`);
      }
      recordQuery(request.msisdn, 'USSD', facility.id, chosen.code, status.state);
      const needsTrip = status.state === 'UNAVAILABLE' || status.state === 'CLOSED';
      return go(
        needsTrip ? 'trip' : 'service',
        resultText(facility, chosen, status, language),
        { ...context, lastFacilityId: facility.id, lastService: chosen.code },
      );
    }

    case 'trip': {
      if (input === '1' || input === '2') {
        recordQuery(request.msisdn, 'USSD', context.lastFacilityId ?? null, context.lastService ?? null, 'TRIP', input === '1');
        return go('main', `${t('sendThanks', language)}\n\n${mainMenu(language)}`, { ...context, page: 0 });
      }
      return go('main', mainMenu(language));
    }

    case 'rpt_facility': {
      if (input === '0') return go('main', mainMenu(language));
      const options = reporterFacilities(request.msisdn);
      const chosen = options[Number(input) - 1];
      if (!chosen) return reporterMenu(request, go, language, context);
      const services = facilityServices(chosen.id);
      return go(
        'rpt_service',
        title(t('chooseService', language), services.map((s) => serviceLabel(s, language)), [t('back', language)]),
        { ...context, facilityId: chosen.id },
      );
    }

    case 'rpt_service': {
      if (input === '0') return reporterMenu(request, go, language, context);
      const facility = facilityById(context.facilityId ?? 0);
      if (!facility) return go('main', mainMenu(language));
      const services = facilityServices(facility.id);
      const chosen = services[Number(input) - 1];
      if (!chosen) return go('rpt_service', title(t('chooseService', language), services.map((s) => serviceLabel(s, language)), [t('back', language)]));
      return go(
        'rpt_state',
        title(
          `${facility.code} ${serviceLabel(chosen, language)}\n${t('chooseState', language)}`,
          STATE_OPTIONS.map((state) => stateLabel(state, language)),
          [t('back', language)],
        ),
        { ...context, serviceCode: chosen.code },
      );
    }

    case 'rpt_state': {
      if (input === '0') {
        const facility = facilityById(context.facilityId ?? 0);
        const services = facility ? facilityServices(facility.id) : [];
        return go('rpt_service', title(t('chooseService', language), services.map((s) => serviceLabel(s, language)), [t('back', language)]));
      }
      const state = STATE_OPTIONS[Number(input) - 1];
      const facility = facilityById(context.facilityId ?? 0);
      if (!state || !facility) return go('rpt_state', t('invalidChoice', language));
      const result = recordUpdate({
        facilityId: facility.id,
        serviceCode: context.serviceCode ?? '',
        state,
        rawMessage: `USSD ${facility.code} ${context.serviceCode} ${state}`,
        channel: 'USSD',
        sourceMsisdn: request.msisdn,
        role: findReporter(request.msisdn)?.role ?? 'VOLUNTEER',
      });
      return go(
        'main',
        `${t('sendThanks', language)}\n${facility.code} ${context.serviceCode}: ${stateLabel(state, language)}` +
          (result.verification === 'PENDING' ? `\n${t('unverified', language)}` : ''),
        { language, page: 0 },
      );
    }

    case 'help':
      if (input === '0') return go('main', mainMenu(language));
      return go('help', helpText(language));

    default:
      return go('main', mainMenu(language));
  }
}

function startSession(sessionId: string, msisdn: string): UssdReply {
  const timestamp = nowIso();
  // A gateway may redeliver an id it already ended, so replace rather than fail on the key.
  run(
    `INSERT OR REPLACE INTO ussd_sessions (id, msisdn, language, flow, state, context, created_at, updated_at, closed_at)
     VALUES (?, ?, 'en', 'entry', 'lang', '{}', ?, ?, NULL)`,
    sessionId,
    msisdn,
    timestamp,
    timestamp,
  );
  return { text: languageMenu(), continues: true, sessionId };
}

function closeSession(sessionId: string): void {
  run('UPDATE ussd_sessions SET state = ?, closed_at = ? WHERE id = ?', 'end', nowIso(), sessionId);
}

function facilityListContent(context: SessionContext, language: Language): string {
  const facilities = facilitiesFor(context.category, context.district);
  const pageOffset = (context.page ?? 0) * PAGE_SIZE;
  const slice = facilities.slice(pageOffset, pageOffset + PAGE_SIZE);
  const extras = [
    facilities.length > pageOffset + PAGE_SIZE ? `${PAGE_SIZE + 1}. More` : '',
    t('back', language),
  ].filter(Boolean);
  return title(
    `${t('chooseFacility', language)} - ${context.district ?? ''}`,
    slice.map((f) => `${f.name} [${f.code}]`),
    extras,
  );
}

function facilityListScreen(
  go: (state: SessionState, text: string, next?: SessionContext, continues?: boolean, lang?: Language) => UssdReply,
  context: SessionContext,
  language: Language,
): UssdReply {
  if (facilitiesFor(context.category, context.district).length === 0) return go('main', mainMenu(language));
  return go('facility', facilityListContent(context, language), context);
}

function serviceScreen(facility: Facility, language: Language, services: ServiceType[]): string {
  return title(
    `${facility.name} (${facility.code})\n${t('chooseService', language)}`,
    services.map((s) => serviceLabel(s, language)),
    [t('back', language)],
  );
}

function resultText(
  facility: Facility,
  service: ServiceType,
  status: { state: State; verification: string; created_at: string },
  language: Language,
): string {
  const age = minutesSince(status.created_at);
  const verified = status.verification === 'VERIFIED';
  const lines = [
    `${facility.name}`,
    `${serviceLabel(service, language)}: ${stateLabel(status.state, language)}`,
    `${t('updated', language)} ${age} ${t('agoMinutes', language)}`,
  ];
  if (!verified) lines.push(t('unverified', language));
  if (status.state === 'UNAVAILABLE' || status.state === 'CLOSED') {
    lines.push('', `${t('savedTripQ', language)}`, `1. ${t('yes', language)}`, `2. ${t('no', language)}`);
  } else {
    lines.push('', t('back', language));
  }
  return lines.join('\n');
}

function reporterMenu(
  request: UssdRequest,
  go: (state: SessionState, text: string, next?: SessionContext, continues?: boolean) => UssdReply,
  language: Language,
  context: SessionContext,
): UssdReply {
  const options = reporterFacilities(request.msisdn);
  if (options.length === 0) {
    return {
      text: `No facility is linked to your number. Ask a district admin to register you.`,
      continues: false,
      sessionId: request.sessionId,
    };
  }
  return go(
    'rpt_facility',
    title(t('reportStatus', language), options.slice(0, PAGE_SIZE).map((f) => `${f.code} ${f.name}`), [t('back', language)]),
    { ...context, page: 0 },
  );
}

function facilityScreen(
  go: (state: SessionState, text: string, next?: SessionContext, continues?: boolean) => UssdReply,
  facility: Facility,
  context: SessionContext,
  language: Language,
): UssdReply {
  const services = facilityServices(facility.id);
  const summary = summarizeFacility(facility, language);
  const text = [
    `${facility.name} (${facility.code})`,
    `Parish: ${facility.parish}`,
    '',
    ...summary,
    '',
    menu(services.map((s) => serviceLabel(s, language)), language, [t('back', language)]),
  ].join('\n');
  return go('service', text, { ...context, facilityId: facility.id, page: 0 });
}

function helpText(language: Language): string {
  return [
    `SMS to ${config.shortCode}:`,
    `Report: CLINIC1 VACCINE YES`,
    `Check: CHECK CLINIC1`,
    `Verify: OK 12 / NO 12 reason`,
    '',
    t('back', language),
  ].join('\n');
}
