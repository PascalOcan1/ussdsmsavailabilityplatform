import path from 'node:path';
import { readFileSync } from 'node:fs';

/** Real environment wins over the .env file, so a deployed service can override a committed default. */
function loadDotEnv(): void {
  try {
    const raw = readFileSync(path.join(process.cwd(), '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // No .env file is the normal case.
  }
}

loadDotEnv();

const num = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));
const bool = (v: string | undefined, d: boolean) =>
  v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

export const config = {
  port: num(process.env.PORT, 3000),
  host: process.env.HOST ?? '127.0.0.1',
  dataDir: process.env.DATA_DIR ?? path.join(process.cwd(), 'data'),
  adminPin: process.env.ADMIN_PIN ?? '1234',
  shortCode: process.env.SHORT_CODE ?? '22888',
  atMode: process.env.AT_MODE ?? 'mock',
  atUsername: process.env.AT_USERNAME ?? '',
  atApiKey: process.env.AT_API_KEY ?? '',
  atUssdCallbackUrl: process.env.AT_USSD_CALLBACK_URL ?? '',
  atSmsSenderId: process.env.AT_SMS_SENDER_ID ?? '',
  atWhatsappNumber: process.env.AT_WHATSAPP_NUMBER ?? '',
  atSmsUrl: process.env.AT_SMS_URL ?? 'https://api.africastalking.com/version1/messaging/bulk',
  atWhatsappUrl: process.env.AT_WHATSAPP_URL ?? 'https://chat.africastalking.com/whatsapp/message/send',

  /** Updates older than this are reported as "possibly outdated" to citizens. */
  staleAfterMinutes: num(process.env.STALE_AFTER_MINUTES, 360),

  /** A critical update left unverified for this long is flagged to supervisors again. */
  verificationEscalateAfterMinutes: num(process.env.ESCALATE_AFTER_MINUTES, 180),

  /** Mock gateway simulates the network dropping this fraction of deliveries. */
  simulatedFailureRate: num(process.env.SIM_FAILURE_RATE, 0),
  autoDeliver: bool(process.env.SIM_AUTO_DELIVER, true),
};

export function getAtUssdCallbackUrl(): string | undefined {
  const configuredUrl = config.atUssdCallbackUrl.trim();
  if (!configuredUrl) return undefined;

  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error('AT_USSD_CALLBACK_URL must be an absolute HTTPS URL for /gateway/ussd');
  }

  if (
    url.protocol !== 'https:'
    || !url.hostname
    || url.username
    || url.password
    || url.pathname !== '/gateway/ussd'
    || url.search
    || url.hash
  ) {
    throw new Error('AT_USSD_CALLBACK_URL must be an absolute HTTPS URL for /gateway/ussd');
  }

  return url.href;
}

export type Config = typeof config;
