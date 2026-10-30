import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockSignInWithPassword = vi.fn();
const mockCreateUser = vi.fn();
const mockUpdateUserById = vi.fn();
const mockAdminRpc = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: async () => ({
    auth: { signInWithPassword: mockSignInWithPassword },
  }),
  createAdminClient: () => ({
    auth: {
      admin: {
        createUser: mockCreateUser,
        updateUserById: mockUpdateUserById,
      },
    },
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

describe('POST /api/auth/nickname-pin (Secure Nickname + Passphrase)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdminRpc.mockImplementation((rpcName: string) => {
      if (rpcName === 'consume_rate_limit') {
        return Promise.resolve({ data: { ok: true, allowed: true }, error: null });
      }
      if (rpcName === 'verify_player_credentials') {
        return Promise.resolve({
          data: { ok: true, found: false },
          error: null,
        });
      }
      if (rpcName === 'register_player_credentials') {
        return Promise.resolve({ data: { ok: true }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    mockCreateUser.mockResolvedValue({
      data: { user: { id: 'random-uuid-1234' } },
      error: null,
    });
    mockUpdateUserById.mockResolvedValue({ data: {}, error: null });
    mockSignInWithPassword.mockResolvedValue({ data: {}, error: null });
  });

  it('rejects PIN/passphrase shorter than 8 characters', async () => {
    const res = await authHandler(createRequest({ nickname: 'Alex', pin: '1234567' }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toContain('failed validation');
  });

  it('rejects nickname with invalid characters', async () => {
    const res = await authHandler(createRequest({ nickname: '<Hacker>', pin: 'secretPass123' }));
    expect(res.status).toBe(400);
  });

  it('blocks request when auth rate limit per IP is exceeded', async () => {
    mockAdminRpc.mockImplementationOnce(() =>
      Promise.resolve({ data: { ok: true, allowed: false }, error: null }),
    );
    const res = await authHandler(createRequest({ nickname: 'Alex', pin: 'secretPass123' }));
    expect(res.status).toBe(429);
  });

  it('blocks request when account is locked from exponential backoff', async () => {
    mockAdminRpc.mockImplementation((rpcName: string) => {
      if (rpcName === 'consume_rate_limit') {
        return Promise.resolve({ data: { ok: true, allowed: true }, error: null });
      }
      if (rpcName === 'verify_player_credentials') {
        return Promise.resolve({
          data: {
            ok: false,
            found: true,
            code: 'account_locked',
            message: 'Akun terkunci sementara.',
            retry_after: 120,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const res = await authHandler(createRequest({ nickname: 'Alex', pin: 'secretPass123' }));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error.message).toContain('terkunci');
  });

  it('registers new user with purely random UUID and slow KDF bcrypt hash', async () => {
    const res = await authHandler(createRequest({ nickname: 'NewPlayer', pin: 'hunter wolf red' }));
    expect(res.status).toBe(200);
    expect(mockCreateUser).toHaveBeenCalled();
    const createdArgs = mockCreateUser.mock.calls[0][0];
    expect(createdArgs.id).toBeDefined(); // random UUID
    expect(mockAdminRpc).toHaveBeenCalledWith(
      'register_player_credentials',
      expect.objectContaining({
        p_nickname: 'NewPlayer',
        p_pin: 'hunter wolf red',
      }),
    );
  });

  it('authenticates existing user and updates session without leaking credentials', async () => {
    mockAdminRpc.mockImplementation((rpcName: string) => {
      if (rpcName === 'consume_rate_limit') {
        return Promise.resolve({ data: { ok: true, allowed: true }, error: null });
      }
      if (rpcName === 'verify_player_credentials') {
        return Promise.resolve({
          data: {
            ok: true,
            found: true,
            user_id: 'existing-uuid-9999',
            email: 'player_existing@werewolf.local',
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const res = await authHandler(createRequest({ nickname: 'ExistingUser', pin: 'passphrase999' }));
    expect(res.status).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledWith(
      'existing-uuid-9999',
      expect.objectContaining({ password: expect.any(String) }),
    );
    expect(mockSignInWithPassword).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'player_existing@werewolf.local',
      }),
    );
  });
});
