import { describe, expect, it } from 'vitest';
import { nextDue, recoverTaskState } from '../src/main/core';

describe('schedule and restart semantics', () => {
  it('waits from confirmed submission time instead of the original planned slot', () => {
    expect(nextDue('2026-10-12T20:02:00+08:00', 10)).toBe('2026-10-12T12:12:00.000Z');
    expect(() => nextDue('bad', 10)).toThrow();
    expect(() => nextDue('2026-10-12T20:02:00+08:00', 0)).toThrow();
  });

  it('never replays uncertain submissions and restores unfinished uploads as paused', () => {
    const now = new Date('2026-10-12T12:00:00Z');
    expect(recoverTaskState('running', [{ status: 'submitting' }], '2026-10-12T11:00:00Z', now)).toMatchObject({ status: 'needs_attention', postStatuses: ['uncertain'] });
    expect(recoverTaskState('running', [{ status: 'uploading' }], '2026-10-12T11:00:00Z', now)).toMatchObject({ status: 'paused', postStatuses: ['pending'] });
    expect(recoverTaskState('scheduled', [{ status: 'pending' }], '2026-10-12T11:00:00Z', now).status).toBe('paused');
    expect(recoverTaskState('scheduled', [{ status: 'pending' }], '2026-10-12T13:00:00Z', now).status).toBe('scheduled');
    expect(recoverTaskState('running', [{ status: 'submitted' }], '2026-10-12T11:00:00Z', now).status).toBe('completed');
  });
});
