import type { Language, State } from './types.ts';

/**
 * Menu copy for feature-phone screens (USSD strings are conventionally kept short).
 * lg/sw strings are MVP drafts for review by pilot-community speakers in Phase 1.
 */
export const T: Record<string, Record<Language, string>> = {
  welcome: {
    en: 'ServiceAlert: know before you go.',
    lg: 'ServiceAlert: manya ngoyi tekunnagenda.',
    sw: 'ServiceAlert: jua kabla ya kwenda.',
  },
  chooseLanguage: {
    en: 'Choose language',
    lg: 'Londa olulimi',
    sw: 'Chagua lugha',
  },
  mainMenu: { en: 'Main menu', lg: 'Menyu enkulu', sw: 'Menyu kuu' },
  checkStatus: { en: 'Check service status', lg: 'Kebera embeera y’enteeyo', sw: 'Angalia hali ya huduma' },
  reportStatus: { en: 'Report service status', lg: 'Tegeeza embeera', sw: 'Ripoti hali' },
  help: { en: 'Help', lg: 'Obuyambi', sw: 'Msaada' },
  chooseCategory: { en: 'Which service?', lg: 'Enteeyo ki?' },
  chooseDistrict: { en: 'Which district?', lg: 'Disituliki ki?', sw: 'Wilaya ipi?' },
  chooseFacility: { en: 'Which facility?', lg: 'Ekitongole ki?', sw: 'Chuo kipi?' },
  chooseService: { en: 'Which item?', lg: 'Ekyo ki?', sw: 'Huduma gani?' },
  chooseState: {
    en: 'Is it working?',
    lg: 'Kikola oba tekikola?',
    sw: 'Inafanya kazi?',
  },
  health: { en: 'Health', lg: 'Ebyobulamu', sw: 'Afya' },
  government: { en: 'Government office', lg: 'Ofiisi ya Gomeni', sw: 'Ofisi ya Serikali' },
  updated: { en: 'Updated', lg: 'Kyakyusiddwa', sw: 'Kisasulwa' },
  agoJustNow: { en: 'just now', lg: 'kati kano', sw: 'sasa hivi' },
  agoMinutes: { en: 'min ago', lg: 'edakiika emabegofun', sw: 'dakika ziyeyise' },
  agoHours: { en: 'hr ago', lg: 'essaawa emabegofun', sw: 'saa ziyeyise' },
  agoDays: { en: 'day ago', lg: 'olunaku emabegofun', sw: 'siku ziyeyise' },
  unverified: {
    en: 'NOT yet confirmed',
    lg: 'Tekiakkirizibwanga',
    sw: 'haijathibitishwa',
  },
  staleWarning: {
    en: 'Info may be out of date',
    lg: 'Amakuru gaayamba gaakuse',
    sw: 'Taarifa inaweza kuwa ya zamani',
  },
  sendThanks: { en: 'Thank you.', lg: 'Webale.', sw: 'Asante.' },
  savedTripQ: {
    en: 'Did this save you a trip?',
    lg: 'Kyokuddizaamu okutambula?',
    sw: 'Je, hii ilikuokoa safari?',
  },
  yes: { en: 'Yes', lg: 'Yee', sw: 'Ndiyo' },
  no: { en: 'No', lg: 'Nedda', sw: 'Hapana' },
  back: { en: '0. Back', lg: '0. Emabega', sw: '0. Rudi' },
  exit: { en: '9. Exit', lg: '9. Fuluma', sw: '9. Toka' },
  invalidChoice: { en: 'Wrong choice, try again', lg: 'Kiseera kya bulubi, ddiiriramu', sw: 'Chaguo baya, jaribu tena' },
  noData: { en: 'No update yet', lg: 'Tewakabaawo bubaka', sw: 'Hakuna taarifa bado' },
};

export function t(key: string, lang: Language): string {
  const entry = T[key];
  if (!entry) return key;
  return entry[lang] ?? entry.en ?? key;
}

export function isLanguage(value: string | undefined): value is Language {
  return value === 'en' || value === 'lg' || value === 'sw';
}

/** State words accepted in coded SMS/USSD input, across supported languages. */
const STATE_WORDS: Record<string, State> = {
  YES: 'AVAILABLE',
  OK: 'AVAILABLE',
  OPEN: 'AVAILABLE',
  AVAILABLE: 'AVAILABLE',
  WORKING: 'AVAILABLE',
  IN: 'AVAILABLE',
  HAVE: 'AVAILABLE',
  TERE: 'AVAILABLE',
  BALIPYO: 'AVAILABLE',
  BYALIWO: 'AVAILABLE',
  INAPATIKANA: 'AVAILABLE',
  NDIOYO: 'AVAILABLE',
  LIMITED: 'LIMITED',
  SOME: 'LIMITED',
  PARTIAL: 'LIMITED',
  FEW: 'LIMITED',
  SHORT: 'LIMITED',
  AKAKANA: 'LIMITED',
  CHACHE: 'LIMITED',
  NO: 'UNAVAILABLE',
  NONE: 'UNAVAILABLE',
  OUT: 'UNAVAILABLE',
  EMPTY: 'UNAVAILABLE',
  BROKEN: 'UNAVAILABLE',
  DOWN: 'UNAVAILABLE',
  DRY: 'UNAVAILABLE',
  UNAVAILABLE: 'UNAVAILABLE',
  AWAY: 'UNAVAILABLE',
  TEWALI: 'UNAVAILABLE',
  TEWABEREBYE: 'UNAVAILABLE',
  HAIPATIKANI: 'UNAVAILABLE',
  HAPANA: 'UNAVAILABLE',
  TEBIRIWO: 'UNAVAILABLE',
  CLOSED: 'CLOSED',
  SHUT: 'CLOSED',
  ZAGGUDDWA: 'CLOSED',
  IMEFUNGWA: 'CLOSED',
};

export function stateFromWord(word: string): State | undefined {
  return STATE_WORDS[word.toUpperCase()];
}

export const STATE_LABEL: Record<State, Record<Language, string>> = {
  AVAILABLE: {
    en: 'AVAILABLE',
    lg: 'KIRIWOO',
    sw: 'KINAPATIKANA',
  },
  LIMITED: {
    en: 'LIMITED',
    lg: 'AKAKANA',
    sw: 'CHACHE',
  },
  UNAVAILABLE: {
    en: 'NOT AVAILABLE',
    lg: 'TEWALI',
    sw: 'HAIPATIKANI',
  },
  CLOSED: {
    en: 'CLOSED',
    lg: 'KIGGUDDWA',
    sw: 'KIMEFUNGWA',
  },
};

export function stateLabel(state: State, lang: Language): string {
  return STATE_LABEL[state][lang] ?? STATE_LABEL[state].en;
}

/** Service names are stored per language so a citizen never sees a half-translated menu. */
export function serviceLabel(
  service: { name: string; name_lg?: string | null; name_sw?: string | null },
  lang: Language,
): string {
  if (lang === 'lg') return service.name_lg || service.name;
  if (lang === 'sw') return service.name_sw || service.name;
  return service.name;
}
