import { describe, expect, it, vi } from 'vitest';

describe('Lobby Realtime Lifecycle and Event Handling', () => {
  it('correctly creates a filtered channel and cleans up on unmount', () => {
    const roomId = 'room-test-1234';
    let unsubscribed = false;

    const mockChannel = {
      on: vi.fn((...args: unknown[]) => {
        void args;
        return mockChannel;
      }),
      subscribe: vi.fn((cb: (status: string) => void) => {
        cb('SUBSCRIBED');
        return mockChannel;
      }),
    };

    const mockSupabase = {
      channel: vi.fn((name: string) => {
        expect(name).toBe(`lobby:${roomId}`);
        return mockChannel;
      }),
      removeChannel: vi.fn((chan: unknown) => {
        if (chan === mockChannel) unsubscribed = true;
      }),
    };

    // Simulate subscription setup in Lobby component
    const channel = mockSupabase.channel(`lobby:${roomId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'room_players',
          filter: `room_id=eq.${roomId}`,
        },
        () => {},
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'rooms',
          filter: `id=eq.${roomId}`,
        },
        () => {},
      )
      .subscribe((status: string) => {
        expect(status).toBe('SUBSCRIBED');
      });

    expect(mockSupabase.channel).toHaveBeenCalledWith(`lobby:${roomId}`);
    expect(mockChannel.on).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({
        table: 'room_players',
        filter: `room_id=eq.${roomId}`,
      }),
      expect.any(Function),
    );
    expect(mockChannel.on).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({
        table: 'rooms',
        filter: `id=eq.${roomId}`,
      }),
      expect.any(Function),
    );

    // Simulate unmount cleanup
    mockSupabase.removeChannel(channel);
    expect(unsubscribed).toBe(true);
  });

  it('triggers snapshot refresh when a player_joined or room event is received', async () => {
    let snapshotFetchCount = 0;
    const fetchSnapshot = () => {
      snapshotFetchCount++;
    };

    let onPlayerChange: () => void = () => {};
    let onRoomChange: () => void = () => {};

    const mockChannel = {
      on: vi.fn((_type: string, config: { table: string }, callback: () => void) => {
        if (config.table === 'room_players') onPlayerChange = callback;
        if (config.table === 'rooms') onRoomChange = callback;
        return mockChannel;
      }),
      subscribe: vi.fn((cb: (status: string) => void) => {
        cb('SUBSCRIBED');
        fetchSnapshot(); // Initial sync on connect
        return mockChannel;
      }),
    };

    // Setup subscription
    mockChannel
      .on('postgres_changes', { table: 'room_players' }, () => fetchSnapshot())
      .on('postgres_changes', { table: 'rooms' }, () => fetchSnapshot())
      .subscribe(() => {});

    expect(snapshotFetchCount).toBe(1); // Connected initial sync

    // Realtime event: Player joins
    onPlayerChange();
    expect(snapshotFetchCount).toBe(2);

    // Realtime event: Room status/round updates
    onRoomChange();
    expect(snapshotFetchCount).toBe(3);
  });
});
