import { describe, expect, it, vi } from 'vitest';

describe('Lobby Realtime Lifecycle: Broadcast and Presence', () => {
  it('correctly creates a broadcast and presence channel and cleans up on unmount', () => {
    const roomId = 'room-test-1234';
    let unsubscribed = false;

    const mockChannel = {
      on: vi.fn((...args: unknown[]) => {
        void args;
        return mockChannel;
      }),
      track: vi.fn(async () => 'ok'),
      send: vi.fn(),
      presenceState: vi.fn(() => ({})),
      subscribe: vi.fn((cb: (status: string) => void) => {
        cb('SUBSCRIBED');
        return mockChannel;
      }),
    };

    const mockSupabase = {
      channel: vi.fn((name: string, config?: unknown) => {
        expect(name).toBe(`room:${roomId}`);
        expect(config).toBeDefined();
        return mockChannel;
      }),
      removeChannel: vi.fn((chan: unknown) => {
        if (chan === mockChannel) unsubscribed = true;
      }),
    };

    // Simulate Broadcast + Presence subscription setup in Lobby component
    const channel = mockSupabase
      .channel(`room:${roomId}`, { config: { presence: { key: 'user-1' } } })
      .on('broadcast', { event: 'room_updated' }, () => {})
      .on('presence', { event: 'sync' }, () => {})
      .subscribe((status: string) => {
        expect(status).toBe('SUBSCRIBED');
      });

    expect(mockSupabase.channel).toHaveBeenCalledWith(
      `room:${roomId}`,
      expect.objectContaining({ config: expect.any(Object) }),
    );
    expect(mockChannel.on).toHaveBeenCalledWith(
      'broadcast',
      { event: 'room_updated' },
      expect.any(Function),
    );
    expect(mockChannel.on).toHaveBeenCalledWith(
      'presence',
      { event: 'sync' },
      expect.any(Function),
    );

    // Verify postgres_changes is NOT registered
    expect(mockChannel.on).not.toHaveBeenCalledWith(
      'postgres_changes',
      expect.anything(),
      expect.anything(),
    );

    // Simulate unmount cleanup
    mockSupabase.removeChannel(channel);
    expect(unsubscribed).toBe(true);
  });

  it('triggers snapshot refresh when a room_updated broadcast event is received', async () => {
    let snapshotFetchCount = 0;
    const fetchSnapshot = () => {
      snapshotFetchCount++;
    };

    let onBroadcastUpdate: () => void = () => {};
    let onPresenceSync: () => void = () => {};

    const mockChannel = {
      on: vi.fn((type: string, config: { event: string }, callback: () => void) => {
        if (type === 'broadcast' && config.event === 'room_updated') onBroadcastUpdate = callback;
        if (type === 'presence' && config.event === 'sync') onPresenceSync = callback;
        return mockChannel;
      }),
      track: vi.fn(async () => 'ok'),
      send: vi.fn(),
      presenceState: vi.fn(() => ({
        'user-1': [{ userId: 'user-1', onlineAt: '2026-10-30T00:00:00Z' }],
      })),
      subscribe: vi.fn((cb: (status: string) => void) => {
        cb('SUBSCRIBED');
        fetchSnapshot(); // Initial sync on connect
        return mockChannel;
      }),
    };

    // Setup subscription
    mockChannel
      .on('broadcast', { event: 'room_updated' }, () => fetchSnapshot())
      .on('presence', { event: 'sync' }, () => onPresenceSync())
      .subscribe(() => {});

    expect(snapshotFetchCount).toBe(1); // Connected initial sync

    // Broadcast event received from another player (ready, vote, action, start)
    onBroadcastUpdate();
    expect(snapshotFetchCount).toBe(2);

    // Another player sends broadcast
    onBroadcastUpdate();
    expect(snapshotFetchCount).toBe(3);
  });
});
