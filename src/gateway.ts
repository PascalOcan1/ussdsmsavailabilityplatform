import { randomUUID } from 'node:crypto';
import { config } from './config.ts';
import { all, get, run, nowIso } from './db.ts';

/**
 * Transport boundary. The mock below implements Africa's Talking's asynchronous
 * delivery model (queued -> sent -> delivered/failed) so a real adapter only has
 * to replace `dispatch` with the POST /messaging call and read credentials from env.
 */
export interface SmsTransport {
  readonly name: string;
  dispatch(input: { to: string; content: string }): { providerId: string };
}

export type DeliveryStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED' | 'READ';

const timers = new Set<ReturnType<typeof setTimeout>>();

export const mockTransport: SmsTransport = {
  name: 'mock',
  dispatch() {
    return { providerId: `mock-${randomUUID().slice(0, 12)}` };
  },
};

export const transport: SmsTransport = mockTransport;

/** Attempts before an outbound message is given up on and surfaced to admins. */
const MAX_ATTEMPTS = 3;

export interface OutboundMessage {
  id: number;
  direction: string;
  channel: string;
  msisdn: string;
  body: string;
  status: DeliveryStatus;
  provider_id: string | null;
  error: string | null;
  attempts: number;
  related_update_id: number | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

function simulateOutcome(): { status: DeliveryStatus; error: string | null } {
  if (Math.random() < config.simulatedFailureRate) {
    return { status: 'FAILED', error: 'Suspended line / handset switched off' };
  }
  return { status: 'DELIVERED', error: null };
}

function settle(row: OutboundMessage): void {
  const { status, error } = simulateOutcome();
  const timestamp = nowIso();
  if (status === 'FAILED' && row.attempts < MAX_ATTEMPTS) {
    // Keep it QUEUED so the next flush retries it — the proposal's delayed-delivery fallback.
    run('UPDATE messages SET status = ?, error = ?, updated_at = ? WHERE id = ?', 'QUEUED', error, timestamp, row.id);
    return;
  }
  run(
    'UPDATE messages SET status = ?, error = ?, provider_id = ?, updated_at = ?, delivered_at = ? WHERE id = ?',
    status,
    error,
    row.provider_id ?? transport.dispatch({ to: row.msisdn, content: row.body }).providerId,
    timestamp,
    status === 'DELIVERED' ? timestamp : null,
    row.id,
  );
}

function insertOutbound(
  to: string,
  body: string,
  channel: 'SMS' | 'USSD' | 'WHATSAPP',
  relatedUpdateId?: number,
): number {
  const timestamp = nowIso();
  const inserted = run(
    `INSERT INTO messages (direction, channel, msisdn, body, status, related_update_id, created_at, updated_at, attempts)
     VALUES ('OUT', ?, ?, ?, 'QUEUED', ?, ?, ?, 0)`,
    channel,
    to,
    body,
    relatedUpdateId ?? null,
    timestamp,
    timestamp,
  );
  return inserted.lastInsertRowid;
}

async function dispatchAfricaTalking(row: OutboundMessage): Promise<void> {
  if (!config.atApiKey || !config.atUsername) {
    run('UPDATE messages SET status = ?, error = ?, updated_at = ? WHERE id = ?',
      'FAILED', 'AT_USERNAME and AT_API_KEY are required when AT_MODE=africastalking', nowIso(), row.id);
    return;
  }

  const whatsapp = row.channel === 'WHATSAPP';
  if (whatsapp && !config.atWhatsappNumber) {
    run('UPDATE messages SET status = ?, error = ?, updated_at = ? WHERE id = ?',
      'FAILED', 'AT_WHATSAPP_NUMBER is required for WhatsApp delivery', nowIso(), row.id);
    return;
  }
  if (!whatsapp && !config.atSmsSenderId) {
    run('UPDATE messages SET status = ?, error = ?, updated_at = ? WHERE id = ?',
      'FAILED', 'AT_SMS_SENDER_ID is required for Africa\'s Talking bulk SMS', nowIso(), row.id);
    return;
  }

  const endpoint = whatsapp ? config.atWhatsappUrl : config.atSmsUrl;
  const payload = whatsapp
    ? {
        username: config.atUsername,
        waNumber: config.atWhatsappNumber,
        phoneNumber: row.msisdn,
        body: { message: row.body },
      }
    : {
        username: config.atUsername,
        phoneNumbers: [row.msisdn],
        message: row.body,
        ...(config.atSmsSenderId ? { senderId: config.atSmsSenderId } : {}),
      };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { apiKey: config.atApiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`Africa's Talking returned HTTP ${response.status}`);

    let providerId: string | undefined;
    let providerStatus = 'SENT';
    if (whatsapp) {
      providerId = typeof result.messageId === 'string' ? result.messageId : undefined;
      providerStatus = typeof result.status === 'string' ? result.status.toUpperCase() : 'SENT';
    } else {
      const data = result.SMSMessageData as { Recipients?: { messageId?: string; statusCode?: number; status?: string }[] } | undefined;
      const recipient = data?.Recipients?.[0];
      providerId = recipient?.messageId;
      providerStatus = recipient?.status?.toUpperCase() ?? 'SENT';
      if (!recipient || (recipient.statusCode !== undefined && recipient.statusCode >= 400)) {
        throw new Error(recipient?.status ?? 'Africa\'s Talking rejected the SMS');
      }
    }
    if (!providerId) throw new Error('Africa\'s Talking response did not include a message ID');

    const delivered = ['DELIVERED', 'SUCCESS'].includes(providerStatus);
    const failed = ['FAILED', 'DELETED'].includes(providerStatus);
    run(
      'UPDATE messages SET status = ?, provider_id = ?, error = NULL, updated_at = ?, delivered_at = ? WHERE id = ?',
      failed ? 'FAILED' : delivered ? 'DELIVERED' : 'SENT',
      providerId,
      nowIso(),
      delivered ? nowIso() : null,
      row.id,
    );
  } catch (error) {
    const attempts = row.attempts;
    const retry = attempts < MAX_ATTEMPTS;
    run(
      'UPDATE messages SET status = ?, error = ?, updated_at = ? WHERE id = ?',
      retry ? 'QUEUED' : 'FAILED',
      error instanceof Error ? error.message : String(error),
      nowIso(),
      row.id,
    );
  }
}

function dispatchQueued(id: number): void {
  const row = get<OutboundMessage>('SELECT * FROM messages WHERE id = ?', id);
  if (!row || row.status !== 'QUEUED') return;
  const attempts = row.attempts + 1;
  run('UPDATE messages SET attempts = ?, status = ? WHERE id = ?', attempts, 'SENT', id);
  if (config.atMode === 'africastalking') {
    void dispatchAfricaTalking({ ...row, attempts, status: 'SENT' });
    return;
  }
  settle({ ...row, attempts, status: 'SENT' });
}

function queueOutbound(id: number): void {
  if (config.atMode === 'africastalking') {
    dispatchQueued(id);
    return;
  }

  if (config.autoDeliver) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      dispatchQueued(id);
    }, 40);
    timers.add(timer);
  }
}

/** Queue an outbound SMS. Africa's Talking delivery is selected with AT_MODE. */
export function sendSms(
  to: string,
  body: string,
  options: { relatedUpdateId?: number; channel?: 'SMS' | 'USSD' } = {},
): number {
  const id = insertOutbound(to, body, options.channel ?? 'SMS', options.relatedUpdateId);
  queueOutbound(id);
  return id;
}

/** Queue an outbound WhatsApp text message through the same audit/retry table. */
export function sendWhatsApp(to: string, body: string, relatedUpdateId?: number): number {
  const id = insertOutbound(to, body, 'WHATSAPP', relatedUpdateId);
  queueOutbound(id);
  return id;
}

/** Retry anything still queued (gateway was down, handset off, or auto-delivery was paused). */
export function flushQueue(limit = 50): { retried: number; delivered: number; failed: number } {
  const rows = all<OutboundMessage>(
    `SELECT * FROM messages WHERE status = 'QUEUED' ORDER BY id LIMIT ?`,
    limit,
  );
  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    dispatchQueued(row.id);
    const after = get<OutboundMessage>('SELECT * FROM messages WHERE id = ?', row.id);
    if (after?.status === 'DELIVERED') delivered += 1;
    else if (after?.status === 'FAILED') failed += 1;
  }
  return { retried: rows.length, delivered, failed };
}

export function markRead(ids: number[]): void {
  for (const id of ids) {
    run('UPDATE messages SET status = ?, updated_at = ? WHERE id = ? AND status = ?', 'READ', nowIso(), id, 'DELIVERED');
  }
}

export async function waitForDeliveries(): Promise<void> {
  for (let pass = 0; pass < 50; pass += 1) {
    if (timers.size === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function cancelPendingTimers(): void {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
}
