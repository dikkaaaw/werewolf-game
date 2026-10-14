import { describe, expect, it } from 'vitest';

import {
  actionFailedToast,
  nightActionToast,
  voteCastToast,
} from '@/lib/game/action-messages';

describe('Action messages — night actions', () => {
  it('titles each night action distinctly', () => {
    expect(nightActionToast('protect', 'TestBot 4').title).toBe('Protection submitted');
    expect(nightActionToast('investigate', 'TestBot 4').title).toBe('Investigation submitted');
    expect(nightActionToast('eliminate', 'TestBot 4').title).toBe('Elimination submitted');
  });

  it('names the actual target in the description', () => {
    for (const action of ['protect', 'investigate', 'eliminate'] as const) {
      const toast = nightActionToast(action, 'TestBot 4');
      expect(toast.description).toContain('Target: TestBot 4');
    }
  });

  it('does not leak an unfilled placeholder when the target is unknown', () => {
    const toast = nightActionToast('protect', 'target');
    expect(toast.description).toContain('Target: target');
    expect(toast.description).not.toContain('{target}');
  });

  it('tells the player they can change target before the deadline', () => {
    for (const action of ['protect', 'investigate', 'eliminate'] as const) {
      expect(nightActionToast(action, 'X').description).toMatch(/change your target/i);
      expect(nightActionToast(action, 'X').description).toMatch(/deadline/i);
    }
  });

  it('marks confirmed actions as success', () => {
    expect(nightActionToast('protect', 'X').kind).toBe('success');
    expect(nightActionToast('investigate', 'X').kind).toBe('success');
    expect(nightActionToast('eliminate', 'X').kind).toBe('success');
  });
});

describe('Action messages — voting', () => {
  it('names the voted player', () => {
    const toast = voteCastToast('TestBot 4');
    expect(toast.title).toBe('Vote submitted');
    expect(toast.description).toContain('Voted for TestBot 4');
  });

  it('notes that the vote can still be changed', () => {
    expect(voteCastToast('Bob').description).toMatch(/change your vote/i);
    expect(voteCastToast('Bob').description).toMatch(/deadline/i);
  });
});

describe('Action messages — failures', () => {
  it('describes a rejection as an error, not a success', () => {
    const toast = actionFailedToast('eliminate');
    expect(toast.kind).toBe('error');
    expect(toast.title).toBe('Action rejected');
    expect(toast.description).toContain('eliminate');
  });
});