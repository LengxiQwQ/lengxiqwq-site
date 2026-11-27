import { writeMusicTrace } from './trace-output.mjs';
import { randomUUID } from 'node:crypto';

const commands = new Set(['music:enqueue', 'music:skip', 'music:vote_skip', 'music:play_queued',
  'music:play_rotation', 'music:confirm_rotation', 'music:report_error']);

export function traceMusicCommand(packet, room) {
  if (!commands.has(packet.type)) return undefined;
  const requestId = typeof packet.requestId === 'string' && /^[\w-]{1,80}$/.test(packet.requestId)
    ? packet.requestId : randomUUID();
  const started = performance.now();
  const trace = (stage, fields = {}) => writeMusicTrace('[MusicCommand]', {
    at: new Date().toISOString(), room, requestId, action: packet.type, stage,
    elapsedMs: Math.round(performance.now() - started), ...fields
  });
  trace('received', { playUid: String(packet.playUid || '').slice(0, 100),
    target: String(packet.uid || packet.entryId || packet.track?.id || '').slice(0, 120),
    title: String(packet.track?.title || '').slice(0, 160) });
  return trace;
}

export function traceCommandResult(trace, result, active) {
  if (!trace) return;
  // Manager errors can include upstream URLs. Record the local reason, never a signed link.
  const reason = String(result?.error || '').replace(/https?:\/\/\S+/gi, '[url]').slice(0, 200);
  trace('decision', { active, ok: result?.ok, code: result?.code, reason,
    skipped: result?.skipped, votes: result?.votes, threshold: result?.threshold,
    unvoted: result?.unvoted, playImmediately: result?.playImmediately, position: result?.position });
}
