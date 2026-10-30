import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/components/game/RoomChatPanel';

function mergeChatMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const map = new Map<string, ChatMessage>();
  for (const m of existing) map.set(m.id, m);
  for (const m of incoming) map.set(m.id, m);
  return Array.from(map.values()).sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
}

describe('Chat Catch-Up & Deduplication Engine', () => {
  const m1: ChatMessage = {
    id: 'msg-1',
    round_number: 1,
    author_player_id: 'p1',
    author_name: 'Alice',
    message: 'Hello village',
    created_at: '2026-10-30T10:00:00.000Z',
  };

  const m2: ChatMessage = {
    id: 'msg-2',
    round_number: 1,
    author_player_id: 'p2',
    author_name: 'Bob',
    message: 'Who is the wolf?',
    created_at: '2026-10-30T10:00:05.000Z',
  };

  const m3: ChatMessage = {
    id: 'msg-3',
    round_number: 1,
    author_player_id: 'p1',
    author_name: 'Alice',
    message: 'I suspect seat 3',
    created_at: '2026-10-30T10:00:10.000Z',
  };

  const m4: ChatMessage = {
    id: 'msg-4',
    round_number: 1,
    author_player_id: 'p3',
    author_name: 'Charlie',
    message: 'Not me!',
    created_at: '2026-10-30T10:00:15.000Z',
  };

  it('merges broadcast message with existing list without duplicates', () => {
    const existing = [m1, m2];
    // Player receives m2 again via broadcast and m3
    const merged = mergeChatMessages(existing, [m2, m3]);
    expect(merged.length).toBe(3);
    expect(merged.map((m) => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
  });

  it('catches up missed offline messages when reconnecting without gaps', () => {
    // Player was offline after m1, missed m2, m3, m4
    const offlinePlayerMessages = [m1];
    const incomingCatchUp = [m2, m3, m4];

    const merged = mergeChatMessages(offlinePlayerMessages, incomingCatchUp);
    expect(merged.length).toBe(4);
    expect(merged.map((m) => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4']);
  });

  it('maintains strict chronological order even if network delivers out of order', () => {
    const outOfOrder = [m4, m2, m1, m3];
    const merged = mergeChatMessages([], outOfOrder);
    expect(merged.map((m) => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4']);
  });
});
