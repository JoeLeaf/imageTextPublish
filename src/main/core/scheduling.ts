import type { PostStatus, TaskStatus } from '../../shared/types';

/** The next upload begins no earlier than the previous confirmed submission plus the gap. */
export function nextDue(previousSubmittedAt: string, intervalMinutes: number): string {
  const timestamp = Date.parse(previousSubmittedAt);
  if (!Number.isFinite(timestamp) || !Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1) {
    throw new Error('提交时间或发布间隔无效');
  }
  const due = timestamp + intervalMinutes * 60_000;
  if (!Number.isFinite(due) || Math.abs(due) > 8.64e15) throw new Error('下一次发布时间超出范围');
  return new Date(due).toISOString();
}

export interface RecoveryDecision { status: TaskStatus; postStatuses: PostStatus[]; reason?: string }

/** Restart never replays a final submission or catches up missed schedules automatically. */
export function recoverTaskState(status: TaskStatus, posts: readonly { status: PostStatus }[], startAt: string, now = new Date()): RecoveryDecision {
  const postStatuses = posts.map(post => post.status === 'submitting' ? 'uncertain' as const : post.status === 'uploading' ? 'pending' as const : post.status);
  if (status === 'cancelled' || status === 'completed' || status === 'draft') return { status, postStatuses };
  if (postStatuses.includes('uncertain')) return { status: 'needs_attention', postStatuses, reason: '上次提交结果待确认，请核对抖音后继续' };
  if (postStatuses.length > 0 && postStatuses.every(value => value === 'submitted')) return { status: 'completed', postStatuses };
  if (status === 'running') return { status: 'paused', postStatuses, reason: '程序已重新启动，请确认剩余任务后继续' };
  if (status === 'scheduled' && Date.parse(startAt) <= now.getTime()) return { status: 'paused', postStatuses, reason: '已错过开始时间，请点击继续重新安排剩余任务' };
  return { status, postStatuses };
}
