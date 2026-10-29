import { get, run, nowIso } from '../db.ts';
import { sendSms, sendWhatsApp } from '../gateway.ts';
import { handleInboundSms } from '../core/inbound.ts';
import { handleUssd } from '../core/ussd.ts';
import { normalizeMsisdn } from '../core/parser.ts';
import { json, type Ctx, type Router } from './util.ts';

/**
 * Webhooks shaped like Africa's Talking's inbound contracts so swapping the mock for
 * the real gateway is a configuration change, not a code change.
 *
 * SMS:   POST form { from, to, text|message, instanceId?, date? }
 * USSD:  POST form { text, sessionId, serviceCode, action?, msisdn?, channel? }
 * DLR:   POST json  { recipient | [ { recipient, status } ] }
 */
export function registerGatewayRoutes(router: Router): void {
  router.post('/gateway/sms', (ctx: Ctx) => {
    const from = ctx.body.from ?? ctx.body.sender ?? ctx.body.msisdn;
    const text = ctx.body.text ?? ctx.body.message ?? '';
    if (!from) {
      json(ctx.res, 400, { status: 'error', error: 'from is required' });
      return;
    }
    const result = handleInboundSms(String(from), String(text));
    markInboundProcessed(result.msisdn, String(text).trim());

    if (result.reply) sendSms(result.msisdn, result.reply);

    json(ctx.res, 200, {
      status: 'success',
      messageId: ctx.body.instanceId ?? ctx.body.messageId ?? null,
      result: { kind: result.kind, updateId: result.updateId ?? null },
      response: result.reply,
    });
  });

  router.post('/gateway/whatsapp', (ctx: Ctx) => {
    const from = ctx.body.from ?? ctx.body.sender ?? ctx.body.phoneNumber;
    const text = ctx.body.text ?? ctx.body.message ?? '';
    if (!from) {
      json(ctx.res, 400, { status: 'error', error: 'from is required' });
      return;
    }
    const result = handleInboundSms(String(from), String(text), 'WHATSAPP');
    markInboundProcessed(result.msisdn, String(text).trim(), 'WHATSAPP');
    if (result.reply) sendWhatsApp(result.msisdn, result.reply);
    json(ctx.res, 200, {
      status: 'success',
      result: { kind: result.kind, updateId: result.updateId ?? null },
      response: result.reply,
    });
  });

  router.post('/gateway/ussd', (ctx: Ctx) => {
    const sessionId = ctx.body.sessionId ?? `webhook-${Date.now()}`;
    const msisdn = normalizeMsisdn(
      ctx.body.phoneNumber ?? ctx.body.msisdn ?? '+256700000000',
    );
    const input = String(ctx.body.text ?? '').split('*').at(-1) ?? '';
    const reply = handleUssd({
      sessionId: String(sessionId),
      msisdn,
      text: input,
    });

    ctx.res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    ctx.res.end(`${reply.continues ? 'CON' : 'END'} ${reply.text}`);
  });

  router.post('/gateway/dlr', (ctx: Ctx) => {
    let reports: { id?: string; recipient?: string; phoneNumber?: string; status: string }[] = [];
    try {
      const raw = ctx.body.statuses ?? ctx.body.delivery;
      const parsed = raw ? JSON.parse(raw) : undefined;
      reports = Array.isArray(parsed)
        ? parsed
        : [{
            id: ctx.body.id,
            recipient: ctx.body.recipient,
            phoneNumber: ctx.body.phoneNumber,
            status: ctx.body.status ?? '',
          }];
    } catch {
      reports = [{ id: ctx.body.id, recipient: ctx.body.recipient, phoneNumber: ctx.body.phoneNumber, status: ctx.body.status ?? '' }];
    }

    let updated = 0;
    for (const report of reports) {
      const status = report.status.toUpperCase();
      const delivered = ['DELIVRD', 'DELIVERED', 'OK', 'SUCCESS'].includes(status);
      const failed = ['FAILED', 'EXPIRED', 'UNDELIV', 'REJECTED', 'ABSENTSUBSCRIBER'].includes(status);
      if (!delivered && !failed) continue;
      const recipient = report.phoneNumber ?? report.recipient;
      const message = report.id
        ? get<{ id: number }>(`SELECT id FROM messages WHERE provider_id = ? AND direction = 'OUT'`, report.id)
        : recipient
          ? get<{ id: number }>(
              `SELECT id FROM messages WHERE direction = 'OUT' AND msisdn = ? AND status IN ('SENT','QUEUED')
               ORDER BY id DESC LIMIT 1`,
              normalizeMsisdn(recipient),
            )
          : undefined;
      if (!message) continue;
      run(
        'UPDATE messages SET status = ?, updated_at = ?, delivered_at = ?, error = ? WHERE id = ?',
        delivered ? 'DELIVERED' : 'FAILED',
        nowIso(),
        delivered ? nowIso() : null,
        delivered ? null : `Gateway report: ${status}`,
        message.id,
      );
      updated += 1;
    }
    json(ctx.res, 200, { status: 'success', updated });
  });
}

function markInboundProcessed(msisdn: string, body: string, channel = 'SMS'): void {
  run(
    `UPDATE messages SET status = 'PROCESSED', updated_at = ?
     WHERE id = (
       SELECT id FROM messages WHERE direction = 'IN' AND msisdn = ? AND body = ? AND channel = ?
       ORDER BY id DESC LIMIT 1
     )`,
    nowIso(),
    msisdn,
    body,
    channel,
  );
}
