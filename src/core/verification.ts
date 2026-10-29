import { all, get, run, nowIso, audit } from '../db.ts';
import { sendSms, sendWhatsApp } from '../gateway.ts';
import type { State, StatusUpdate } from '../types.ts';
import { stateLabel } from './language.ts';

export interface SupervisorCommand {
  updateId: number;
  decision: 'VERIFIED' | 'REJECTED';
  reason?: string;
}

/**
 * Supervisor replies are deliberately terser than reports: "OK 12" or "NO 12 staff on leave".
 */
export function parseSupervisorCommand(text: string): SupervisorCommand | undefined {
  const match = /^\s*(OK|YES|CONFIRM|NO|REJECT)\s*#?(\d+)\b\s*(.*)$/i.exec(text);
  if (!match) return undefined;
  const positive = ['OK', 'YES', 'CONFIRM'].includes(match[1].toUpperCase());
  return {
    updateId: Number(match[2]),
    decision: positive ? 'VERIFIED' : 'REJECTED',
    reason: match[3]?.trim().slice(0, 120) || undefined,
  };
}

export interface VerificationRequest {
  updateId: number;
  facilityCode: string;
  serviceName: string;
  state: State;
  sourceMsisdn: string;
}

export function notifySupervisors(
  request: VerificationRequest,
  options: { reminder?: boolean } = {},
): number {
  const supervisors = all<{ msisdn: string }>(
    `SELECT msisdn FROM app_users WHERE role = 'SUPERVISOR' AND active = 1`,
  );
  const label = stateLabel(request.state, 'en');
  const body =
    `${options.reminder ? 'REMINDER ' : ''}VERIFY #${request.updateId}: ` +
    `${request.facilityCode} ${request.serviceName}=${label} ` +
    `by ${request.sourceMsisdn}. Reply OK ${request.updateId} or NO ${request.updateId} <reason>`;
  for (const supervisor of supervisors) sendSms(supervisor.msisdn, body, { relatedUpdateId: request.updateId });
  run(`UPDATE status_updates SET notified_at = ? WHERE id = ?`, nowIso(), request.updateId);
  return supervisors.length;
}

export function applyDecision(
  command: SupervisorCommand,
  supervisorMsisdn: string,
): { ok: boolean; message: string; update?: StatusUpdate } {
  const update = get<StatusUpdate>(
    `SELECT * FROM status_updates WHERE id = ?`,
    command.updateId,
  );
  if (!update) return { ok: false, message: `Update #${command.updateId} not found` };
  const facility = get<{ code: string; name: string; active: number }>(
    'SELECT code, name, active FROM facilities WHERE id = ?',
    update.facility_id,
  );
  if (!facility || facility.active !== 1) {
    return { ok: false, message: `Update #${command.updateId} belongs to an inactive facility` };
  }
  if (update.verification !== 'PENDING') {
    return { ok: false, message: `Update #${command.updateId} is already ${update.verification}` };
  }

  const timestamp = nowIso();
  run(
    `UPDATE status_updates
       SET verification = ?, verified_by = ?, verified_at = ?, reject_reason = ?
     WHERE id = ?`,
    command.decision,
    supervisorMsisdn,
    timestamp,
    command.decision === 'REJECTED' ? (command.reason ?? 'Not specified') : null,
    update.id,
  );

  const outcome = command.decision === 'VERIFIED' ? 'CONFIRMED' : 'NOT CONFIRMED';
  audit(supervisorMsisdn, command.decision, `update:${update.id}`, command.reason ?? '');
  const confirmation =
    `${outcome}: ${facility?.code ?? ''} ${update.service_code}=${update.state} (#${update.id})` +
    (command.reason ? ` Reason: ${command.reason}` : '');
  if (update.channel === 'WHATSAPP') sendWhatsApp(update.source_msisdn, confirmation, update.id);
  else sendSms(update.source_msisdn, confirmation, { relatedUpdateId: update.id });

  return {
    ok: true,
    message: `Update #${update.id} ${command.decision.toLowerCase()}`,
    update: {
      ...update,
      verification: command.decision,
      verified_by: supervisorMsisdn,
      verified_at: timestamp,
      reject_reason: command.decision === 'REJECTED' ? (command.reason ?? 'Not specified') : null,
    },
  };
}

/** Reports left pending too long are chased again so critical items cannot be dropped. */
export function overdueVerifications(olderThanMinutes: number): StatusUpdate[] {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60000).toISOString();
  return all<StatusUpdate>(
    `SELECT u.* FROM status_updates u
      JOIN facilities f ON f.id = u.facility_id
      WHERE f.active = 1 AND u.verification = 'PENDING' AND u.created_at < ?
        AND (u.notified_at IS NULL OR u.notified_at < ?)`,
    cutoff,
    cutoff,
  );
}
