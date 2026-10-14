import 'server-only';

import { NextResponse } from 'next/server';
import { ZodError, type ZodType } from 'zod';

import { SETTINGS } from '@/lib/game/settings';

/**
 * API response helpers.
 *
 * Every endpoint returns the same envelope, and error bodies never contain a
 * stack trace, a credential, a role, or raw database text (PRD §7).
 */

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** Field-level detail for 400s only. */
    details?: unknown;
  };
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, { status: 200, ...init });
}

export function created<T>(data: T): NextResponse {
  return NextResponse.json(data, { status: 201 });
}

export function apiError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): NextResponse<ApiErrorBody> {
  const body: ApiErrorBody = {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
  return NextResponse.json(body, { status });
}

export const badRequest = (message: string, details?: unknown) =>
  apiError(400, 'invalid_request', message, details);
export const unauthorized = (message = 'Authentication required.') =>
  apiError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to this resource.') =>
  apiError(403, 'forbidden', message);
export const notFound = (message = 'Not found.') => apiError(404, 'not_found', message);
export const conflict = (message: string, code = 'conflict') =>
  apiError(409, code, message);
export const tooManyRequests = (message: string, retryAfterSeconds?: number) =>
  NextResponse.json<ApiErrorBody>(
    { error: { code: 'rate_limited', message } },
    {
      status: 429,
      ...(retryAfterSeconds ? { headers: { 'Retry-After': String(retryAfterSeconds) } } : {}),
    },
  );
export const internalError = () =>
  apiError(500, 'internal_error', 'Something went wrong. Please try again.');

/**
 * Parse and validate a JSON body, enforcing the size cap first.
 *
 * The cap is checked from the Content-Length header before reading the stream
 * so an oversized body never reaches the JSON parser (PRD §18.F).
 */
export async function parseJsonBody<T>(
  request: Request,
  schema: ZodType<T>,
  maxBytes: number = SETTINGS.maxRequestBodyBytes,
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse<ApiErrorBody> }> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return {
      ok: false,
      response: apiError(
        413,
        'payload_too_large',
        `Request body must be under ${maxBytes} bytes.`,
      ),
    };
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: badRequest('Request body must be valid JSON.') };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: badRequest('Request body failed validation.', formatZodError(parsed.error)),
    };
  }

  return { ok: true, data: parsed.data };
}

/** Only ever returns field paths and messages — never the offending values. */
function formatZodError(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Translate an engine/DB error code into an HTTP response.
 *
 * The database RPCs return `{ ok: false, error: { code, message } }`; this maps
 * those codes onto the PRD §7 status table so no handler has to.
 */
export function mapEngineError(
  code: string,
  message: string,
): NextResponse<ApiErrorBody> {
  switch (code) {
    case 'not_a_member':
    case 'forbidden':
      return forbidden(message);
    case 'room_not_found':
    case 'target_not_in_room':
      return notFound(message);
    case 'target_is_self':
    // Voting analogue of `target_is_self`. Without this it fell through to the
    // default arm and returned 409 "conflict", which misreports a client
    // validation error as a state conflict and disagrees with its own
    // night-action twin above.
    case 'vote_for_self':
    case 'target_dead':
    case 'target_is_werewolf':
    case 'target_is_doctor':
    case 'same_role_target_forbidden':
    case 'repeat_target_forbidden':
    case 'action_not_supported_by_role':
    case 'player_not_alive':
      return apiError(400, code, message);
    case 'room_not_in_progress':
    case 'not_night_phase':
    case 'not_voting_phase':
    case 'phase_expired':
    case 'game_already_started':
    case 'already_joined':
    case 'claim_failed':
    case 'claim_lost':
      return conflict(message, code);
    case 'room_full':
    case 'room_expired':
    case 'room_in_progress':
      return conflict(message, code);
    default:
      return conflict(message, code);
  }
}
