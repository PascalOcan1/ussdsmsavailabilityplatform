export const STATES = ['AVAILABLE', 'LIMITED', 'UNAVAILABLE', 'CLOSED'] as const;
export type State = (typeof STATES)[number];

export const VERIFICATION = ['NOT_REQUIRED', 'PENDING', 'VERIFIED', 'REJECTED'] as const;
export type Verification = (typeof VERIFICATION)[number];

export const ROLES = ['STAFF', 'VOLUNTEER', 'SUPERVISOR', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export const CHANNELS = ['SMS', 'USSD', 'WHATSAPP'] as const;
export type Channel = (typeof CHANNELS)[number];

export const LANGUAGES = ['en', 'lg', 'sw'] as const;
export type Language = (typeof LANGUAGES)[number];

export interface Facility {
  id: number;
  code: string;
  name: string;
  district: string;
  parish: string;
  category: string;
  phone: string | null;
  active: number;
  created_at: string;
}

export interface ServiceType {
  code: string;
  name: string;
  name_lg: string | null;
  name_sw: string | null;
  requires_verification: number;
  ttl_minutes: number;
}

export interface StatusUpdate {
  id: number;
  facility_id: number;
  service_code: string;
  state: State;
  detail: string | null;
  raw_message: string;
  channel: Channel;
  source_msisdn: string;
  reporter_role: Role;
  verification: Verification;
  verified_by: string | null;
  verified_at: string | null;
  reject_reason: string | null;
  created_at: string;
}

export interface ParsedReport {
  ok: boolean;
  facilityCode?: string;
  serviceCode?: string;
  state?: State;
  detail?: string;
  error?: string;
  hint?: string;
}
