import type { PublishAdapter, PublishTask, OperationResult } from '../shared/types';
import type { TaskRepository } from './store';

const ACCOUNT_UNCERTAIN = '该账号有提交结果待确认的图文，请先核对后再继续其他任务。';

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private activeTaskId: string | undefined;
  private activeController: AbortController | undefined;
  private lastTick = 0;
  private readonly revisions = new Map<string, number>();
  constructor(private store: TaskRepository, private adapter: PublishAdapter, private changed: () => void, private validate: (task: PublishTask) => Promise<{ ok: boolean; invalidFiles: string[] }>, private now = () => Date.now()) {}
  run(): void {
    this.stop(); this.lastTick = this.now();
    this.timer = setInterval(() => { void this.tick().catch(error => this.handleTimerFailure(error)); }, 1000);
    this.timer.unref();
  }
  private handleTimerFailure(error: unknown): void {
    // Storage or renderer notification failures must stop automation, never spin/replay.
    this.stop();
    this.activeController?.abort(new Error('调度器已停止'));
    try { this.suspend(); } catch { /* A failed database cannot persist recovery state; startup recovery owns it. */ }
    console.error('发布调度已因内部异常停止，请重新打开程序并检查任务。', error instanceof Error ? error.message : '未知错误');
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  isBusy(): boolean { return this.busy; }
  private revision(id: string): number { return this.revisions.get(id) ?? 0; }
  private invalidate(id: string): number { const revision = this.revision(id) + 1; this.revisions.set(id, revision); return revision; }
  private save(task: PublishTask): void { task.updatedAt = new Date(this.now()).toISOString(); this.store.saveTask(task); this.changed(); }
  private accountUncertain(accountId: string): boolean { return this.store.tasks().some(task => task.config.accountId === accountId && task.posts.some(post => post.status === 'uncertain')); }

  /** The latest actual submission establishes the gap across all batches of this account. */
  private accountDue(accountId: string): number {
    let latest = -Infinity, due = 0;
    for (const task of this.store.tasks()) if (task.config.accountId === accountId) {
      for (const post of task.posts) if (post.status === 'submitted' && post.submittedAt) {
        const submitted = Date.parse(post.submittedAt);
        if (!Number.isFinite(submitted)) continue;
        if (submitted > latest) { latest = submitted; due = submitted + task.config.intervalMinutes * 60_000; }
        else if (submitted === latest) due = Math.max(due, submitted + task.config.intervalMinutes * 60_000);
      }
    }
    return due;
  }

  async start(id: string): Promise<OperationResult> {
    const task = this.store.getTask(id); if (!task) throw new Error('任务不存在。');
    if (['scheduled', 'running'].includes(task.status)) return { ok: false, message: '任务已在排期或执行中，不需要重复开始。' };
    if (this.activeTaskId === id) return { ok: false, message: '该任务正在提交，请等待当前图文结束。' };
    if (['completed', 'cancelled'].includes(task.status)) return { ok: false, message: '已结束的任务不能继续，请复制为新任务。' };
    if (this.accountUncertain(task.config.accountId)) return { ok: false, message: ACCOUNT_UNCERTAIN };
    if (task.posts.some(post => post.status === 'failed')) return { ok: false, message: '任务有失败稿件，请使用“重试未完成图文”。' };
    if (task.needsRebind || !task.config.textDirectory || !task.config.imageDirectory) return { ok: false, message: '请先重新绑定本机素材目录。' };
    const account = this.store.getAccount(task.config.accountId);
    if (!account || account.status !== 'ready') return { ok: false, message: '请先打开账号登录窗口并检查登录状态。' };
    const remaining = task.posts.filter(post => post.status === 'pending');
    if (!remaining.length) return { ok: false, message: '没有可继续的图文。' };
    const revision = this.invalidate(id), snapshot = JSON.stringify(task);
    const capability = this.adapter.probe ? await this.adapter.probe(account) : this.adapter.capability;
    if (!capability.available) return { ok: false, message: capability.description };
    const valid = await this.validate({ ...task, posts: remaining });
    if (!valid.ok) return { ok: false, message: '素材已变化或缺失，请检查：' + valid.invalidFiles.join('、') };
    const current = this.store.getTask(id);
    if (!current || this.revision(id) !== revision || JSON.stringify(current) !== snapshot) return { ok: false, message: '任务状态或配置已变化，请重新确认后开始。' };
    const currentAccount = this.store.getAccount(task.config.accountId);
    if (!currentAccount || currentAccount.status !== 'ready' || currentAccount.platformUserId !== account.platformUserId) return { ok: false, message: '账号状态已变化，请检查登录后再开始。' };
    if (this.accountUncertain(task.config.accountId)) return { ok: false, message: ACCOUNT_UNCERTAIN };
    const base = Math.max(Date.parse(current.config.startAt), this.now(), this.accountDue(current.config.accountId));
    current.posts.filter(post => post.status === 'pending').forEach((post, index) => { post.scheduledAt = new Date(base + index * current.config.intervalMinutes * 60_000).toISOString(); });
    current.status = 'scheduled'; current.pauseReason = undefined; this.save(current);
    return { ok: true, message: '任务已安排，程序将按时间自动执行。' };
  }

  pause(id: string): OperationResult {
    const task = this.store.getTask(id); if (!task) throw new Error('任务不存在。');
    if (['completed', 'cancelled'].includes(task.status)) return { ok: false, message: '任务已经结束。' };
    this.invalidate(id); task.status = 'paused'; task.pauseReason = this.activeTaskId === id ? '暂停已请求，当前提交结束后不再启动下一条。' : '任务已暂停。'; this.save(task);
    return { ok: true, message: task.pauseReason };
  }
  cancel(id: string): OperationResult {
    const task = this.store.getTask(id); if (!task) throw new Error('任务不存在。');
    if (this.activeTaskId === id) return { ok: false, message: '请先暂停并等待当前图文结束，再取消任务。' };
    if (task.posts.some(post => post.status === 'uncertain')) return { ok: false, message: '有提交结果待确认的图文，请先核对，避免遗漏发布记录。' };
    this.invalidate(id); task.status = 'cancelled'; task.pauseReason = '任务已取消，原始素材保留。'; this.save(task); return { ok: true, message: task.pauseReason };
  }
  async retry(id: string): Promise<OperationResult> {
    const task = this.store.getTask(id); if (!task) throw new Error('任务不存在。');
    if (this.activeTaskId === id) return { ok: false, message: '请等待当前图文结束。' };
    if (['cancelled', 'completed', 'scheduled', 'running'].includes(task.status)) return { ok: false, message: '任务已经结束或已在排期执行中。' };
    if (this.accountUncertain(task.config.accountId)) return { ok: false, message: ACCOUNT_UNCERTAIN };
    this.invalidate(id);
    for (const post of task.posts) if (post.status === 'failed') { post.status = 'pending'; post.error = undefined; }
    task.status = 'paused'; this.save(task); return this.start(id);
  }
  resolve(taskId: string, postId: string, resolution: 'submitted' | 'not_published'): OperationResult {
    const task = this.store.getTask(taskId); if (!task) throw new Error('任务不存在。');
    const post = task.posts.find(value => value.id === postId); if (!post || post.status !== 'uncertain') throw new Error('只能处理结果待确认的图文。');
    this.invalidate(taskId);
    if (resolution === 'submitted') { post.status = 'submitted'; post.submittedAt = new Date(this.now()).toISOString(); post.error = '用户核对平台作品后手动确认已提交。'; }
    else { post.status = 'pending'; post.error = undefined; }
    task.status = task.posts.every(value => value.status === 'submitted') ? 'completed' : task.posts.some(value => value.status === 'uncertain') ? 'needs_attention' : 'paused';
    task.pauseReason = '核对结果已保存。'; this.save(task); return { ok: true, message: '已记录核对结果，系统不会自动重新提交。' };
  }
  suspend(): void {
    this.activeController?.abort(new Error('电脑休眠或执行中断'));
    for (const task of this.store.tasks()) {
      this.invalidate(task.id); // Cancel pending start/probe operations even on draft or paused tasks.
      if (['scheduled', 'running'].includes(task.status)) { task.status = 'paused'; task.pauseReason = '电脑休眠或执行中断，检查后继续；不会追发。'; this.save(task); }
    }
  }

  async tick(): Promise<void> {
    const currentTime = this.now();
    if (this.lastTick && currentTime - this.lastTick > 60_000) this.suspend();
    this.lastTick = currentTime;
    if (this.busy || (!this.adapter.probe && !this.adapter.capability.available)) return;
    const candidates = [];
    for (const task of this.store.tasks().filter(value => value.status === 'scheduled')) {
      if (this.accountUncertain(task.config.accountId)) { task.status = 'needs_attention'; task.pauseReason = ACCOUNT_UNCERTAIN; this.save(task); continue; }
      const post = task.posts.find(value => value.status === 'pending'); if (!post) continue;
      const due = Math.max(Date.parse(post.scheduledAt), this.accountDue(task.config.accountId));
      if (due <= currentTime) candidates.push({ task, post, due });
    }
    candidates.sort((a, b) => a.due - b.due);
    const candidate = candidates[0]; if (!candidate) return;
    const { task, post } = candidate;
    const account = this.store.getAccount(task.config.accountId);
    if (!account || account.status !== 'ready') { task.status = 'needs_attention'; task.pauseReason = '账号未登录或会话已失效，请检查账号。'; this.save(task); return; }
    this.busy = true; this.activeTaskId = task.id;
    const controller = new AbortController(); this.activeController = controller;
    const revision = this.revision(task.id), snapshot = JSON.stringify(task);
    let submitting = false;
    try {
      const valid = await this.validate({ ...task, posts: [post] });
      const refreshed = this.store.getTask(task.id);
      if (controller.signal.aborted || !refreshed || this.revision(task.id) !== revision || JSON.stringify(refreshed) !== snapshot) return;
      if (!valid.ok) throw new Error('素材变化或缺失：' + valid.invalidFiles.join('、'));
      if (this.accountUncertain(task.config.accountId)) { refreshed.status = 'needs_attention'; refreshed.pauseReason = ACCOUNT_UNCERTAIN; this.save(refreshed); return; }
      post.status = 'uploading'; task.status = 'running'; this.save(task);
      const result = await this.adapter.publish(account, post, task.config, () => {
        if (controller.signal.aborted) throw new Error('执行已中断，尚未发送最终提交。');
        const latest = this.store.getTask(task.id); const current = latest?.posts.find(value => value.id === post.id);
        if (!latest || !current || current.status !== 'uploading') throw new Error('当前提交状态已变化，已阻止发送。');
        current.status = 'submitting'; this.save(latest); submitting = true;
      }, controller.signal);
      const latest = this.store.getTask(task.id)!; const current = latest.posts.find(value => value.id === post.id)!;
      if (result.kind === 'submitted') {
        current.status = 'submitted'; current.submittedAt = new Date(this.now()).toISOString(); current.platformPostId = result.postId; current.platformUrl = result.url; current.error = undefined;
        let time = this.now() + latest.config.intervalMinutes * 60_000;
        for (const pending of latest.posts.filter(value => value.status === 'pending')) { pending.scheduledAt = new Date(time).toISOString(); time += latest.config.intervalMinutes * 60_000; }
        if (latest.posts.every(value => value.status === 'submitted')) latest.status = 'completed'; else if (latest.status !== 'paused') latest.status = 'scheduled';
      } else if (controller.signal.aborted && !submitting) {
        current.status = 'pending'; current.error = '执行已中断，最终提交尚未发送。'; latest.status = 'paused'; latest.pauseReason = current.error;
      } else {
        current.status = result.kind === 'uncertain' ? 'uncertain' : 'failed'; current.error = result.message || '发布未完成。'; latest.status = 'needs_attention'; latest.pauseReason = current.error;
      }
      this.save(latest);
    } catch (error) {
      const latest = this.store.getTask(task.id);
      if (latest) {
        const current = latest.posts.find(value => value.id === post.id)!;
        current.status = submitting ? 'uncertain' : controller.signal.aborted ? 'pending' : 'failed'; current.error = error instanceof Error ? error.message : '发布发生未知错误。';
        latest.status = controller.signal.aborted && !submitting ? 'paused' : 'needs_attention'; latest.pauseReason = current.error; this.save(latest);
      }
    } finally { this.busy = false; this.activeTaskId = undefined; this.activeController = undefined; }
  }
}
