import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockSignInWithPassword = vi.fn();
const mockCreateUser = vi.fn();
const mockAdminRpc = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: async () => ({
    auth: { signInWithPassword: mockSignInWithPassword },
  }),
  createAdminClient: () => ({
    auth: { admin: { createUser: mockCreateUser } },
    rpc: mockAdminRpc,
  }),
}));

import { POST as authHandler } from '@/app/api/auth/nickname-pin/route';

function createRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/auth/nickname-pin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/nickname-pin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdminRpc.mockResolvedValue({ data: { ok: true, allowed: true }, error: null });
    mockSignInWithPassword.mockResolvedValue({
      data: { user: { id: 'uuid-player-1', email: 'test@game.local' } },
      error: null,
    });
  });

  it('rejects PIN shorter than 6 digits', async () => {
    const res = await authHandler(createRequest({ nickname: 'Alex', pin: '12345' }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toContain('failed validation');
  });

  it('rejects nickname with invalid characters', async () => {
    const res = await authHandler(createRequest({ nickname: '<Hacker>', pin: '123456' }));
    expect(res.status).toBe(400);
  });

  it('blocks request when auth rate limit is exceeded', async () => {
    mockAdminRpc.mockResolvedValue({ data: { ok: true, allowed: false }, error: null });
    const res = await authHandler(createRequest({ nickname: 'Alex', pin: '123456' }));
    expect(res.status).toBe(429);
  });

  it('signs in existing user with correct credentials', async () => {
    const res = await authHandler(createRequest({ nickname: 'Alex', pin: '123456' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.userId).toBe('uuid-player-1');
  });

  it('creates new user when credentials are not found and signs in', async () => {
    mockSignInWithPassword
      .mockResolvedValueOnce({ data: { user: null }, error: { message: 'Invalid login credentials' } })
      .mockResolvedValueOnce({ data: { user: { id: 'uuid-new-player' } }, error: null });
    mockCreateUser.mockResolvedValueOnce({ data: {}, error: null });

    const res = await authHandler(createRequest({ nickname: 'Bob', pin: '987654' }));
    expect(res.status).toBe(200);
    expect(mockCreateUser).toHaveBeenCalled();
  });
});
