import 'server-only';

/**
 * Lightweight structured logger (PRD Observability).
 * Outputs single-line JSON with prefixes [phase], [broadcast], [rls].
 * Never prints raw PINs, raw user_ids, secret roles, or chat messages.
 */

export function logPhase(data: {
  roomId: string;
  fromPhase?: string;
  toPhase?: string;
  roundNumber?: number;
  durationMs?: number;
  advanced: boolean;
  reason?: string;
}) {
  console.log(`[phase] ${JSON.stringify(data)}`);
}

export function logBroadcast(data: {
  roomId: string;
  event: string;
  status: 'ok' | 'fail';
  latencyMs?: number;
  reason?: string;
}) {
  console.log(`[broadcast] ${JSON.stringify(data)}`);
}

export function logRls(data: {
  table: string;
  operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'RPC';
  roomId?: string;
  reason: string;
}) {
  console.warn(`[rls] ${JSON.stringify(data)}`);
}
