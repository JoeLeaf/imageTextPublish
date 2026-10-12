import { describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../src/main/scheduler';
import { Store, type TaskRepository } from '../src/main/store';
import type { Account, PublishAdapter, PublishResult, PublishTask } from '../src/shared/types';

const initialTime = Date.parse('2026-10-12T12:00:00Z');
const account: Account = { id: '08d3d3b0-dbbf-41fa-81cb-8a5334a3d92a', name: '测试账号', status: 'ready', platform: 'douyin', createdAt: new Date(initialTime).toISOString() };

function sampleTask(): PublishTask {
  return {
    id: 'dcf8aef5-ef04-457c-af52-ff2609b26039', status: 'draft', createdAt: new Date(initialTime).toISOString(), updatedAt: new Date(initialTime).toISOString(), warnings: [],
    config: { name: '测试批次', accountId: account.id, textDirectory: '/texts', imageDirectory: '/images', postCount: 2, imagesPerPost: 1, intervalMinutes: 10, startAt: new Date(initialTime).toISOString(), timezone: 'Asia/Shanghai', reuseImages: true, titleMode: 'none', visibility: 'public' },
    posts: [0, 1].map(index => ({ id: `post-${index}`, textPath: `/texts/${index}.txt`, textFilename: `${index}.txt`, textHash: `${index}`.repeat(64), caption: `冻结正文${index}`, title: '', status: 'pending', scheduledAt: new Date(initialTime + index * 600_000).toISOString(), images: [{ id: `image-${index}`, path: `/images/${index}.png`, filename: `${index}.png`, sha256: `${index + 2}`.repeat(64), width: 2, height: 3, mime: 'image/png' }] })),
  };
}

class MemoryRepository implements TaskRepository {
  private readonly taskMap = new Map<string, PublishTask>();
  private readonly accountMap = new Map<string, Account>([[account.id, account]]);
  constructor(private task: PublishTask) { this.saveTask(task); }
  tasks() { return [...this.taskMap.values()].map(value => structuredClone(value)); }
  getTask(id: string) { const task = this.taskMap.get(id); return task ? structuredClone(task) : undefined; }
  getAccount(id: string) { const value = this.accountMap.get(id); return value ? structuredClone(value) : undefined; }
  saveAccount(value: Account) { this.accountMap.set(value.id, structuredClone(value)); }
  saveTask(task: PublishTask) { this.taskMap.set(task.id, structuredClone(task)); }
  read(id = this.task.id) { return this.getTask(id)!; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(task = sampleTask()) {
  let time = initialTime;
  const repository = new MemoryRepository(task);
  const publish = vi.fn<PublishAdapter['publish']>(async (_account, _post, _config, onSubmitting) => { onSubmitting(); return { kind: 'submitted' }; });
  const adapter: PublishAdapter = { capability: { mode: 'browser-protocol', available: true, description: '测试适配器' }, publish };
  const changed = vi.fn();
  const validate = vi.fn<(task: PublishTask) => Promise<{ ok: boolean; invalidFiles: string[] }>>(async () => ({ ok: true, invalidFiles: [] }));
  const scheduler = new Scheduler(repository, adapter, changed, validate, () => time);
  // Keep ticks within the wakeup-detection threshold to represent a normally running app.
  async function advance(milliseconds: number) {
    while (milliseconds > 0) { const step = Math.min(30_000, milliseconds); time += step; milliseconds -= step; await scheduler.tick(); }
  }
  return { repository, publish, adapter, changed, validate, scheduler, advance, now: () => time, setTime: (value: number) => { time = value; } };
}

describe('Scheduler', () => {
  it('starts the next upload only after the previous confirmed submission plus the interval', async () => {
    const h = harness(); const started = deferred<void>(); const result = deferred<PublishResult>();
    h.publish.mockImplementationOnce(async (_account, _post, _config, onSubmitting) => { onSubmitting(); started.resolve(); return result.promise; });
    expect((await h.scheduler.start(h.repository.read().id)).ok).toBe(true);
    const firstTick = h.scheduler.tick(); await started.promise;
    await h.advance(120_000); // The first upload/submission takes two minutes.
    expect(h.publish).toHaveBeenCalledTimes(1);
    result.resolve({ kind: 'submitted', postId: 'douyin-post-1' }); await firstTick;
    const completedAt = h.now();
    expect(h.repository.read().posts[0].submittedAt).toBe(new Date(completedAt).toISOString());
    expect(h.repository.read().posts[1].scheduledAt).toBe(new Date(completedAt + 600_000).toISOString());
    await h.advance(599_999); expect(h.publish).toHaveBeenCalledTimes(1);
    await h.advance(1); expect(h.publish).toHaveBeenCalledTimes(2);
    expect(h.repository.read().status).toBe('completed');
  });

  it('a pause during submission waits for its result and blocks start/retry until it completes', async () => {
    const h = harness(); const started = deferred<void>(); const result = deferred<PublishResult>();
    h.publish.mockImplementationOnce(async (_account, _post, _config, onSubmitting) => { onSubmitting(); started.resolve(); return result.promise; });
    const id = h.repository.read().id; await h.scheduler.start(id);
    const tick = h.scheduler.tick(); await started.promise;
    expect(h.scheduler.pause(id).ok).toBe(true);
    expect((await h.scheduler.start(id)).ok).toBe(false);
    expect((await h.scheduler.retry(id)).ok).toBe(false);
    expect(h.scheduler.isBusy()).toBe(true);
    result.resolve({ kind: 'submitted' }); await tick;
    expect(h.repository.read().status).toBe('paused');
    expect(h.repository.read().posts[0].status).toBe('submitted');
    await h.advance(600_000); expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('resume still respects the interval from the previous successful submission', async () => {
    const h = harness(); const id = h.repository.read().id;
    await h.scheduler.start(id); await h.scheduler.tick();
    h.scheduler.pause(id);
    expect((await h.scheduler.start(id)).ok).toBe(true);
    await h.scheduler.tick();
    expect(h.publish).toHaveBeenCalledTimes(1);
    await h.advance(599_999); expect(h.publish).toHaveBeenCalledTimes(1);
    await h.advance(1); expect(h.publish).toHaveBeenCalledTimes(2);
  });

  it('a throw after final submission becomes uncertain and cannot be retried automatically', async () => {
    const h = harness(); const id = h.repository.read().id;
    h.publish.mockImplementationOnce(async (_account, _post, _config, onSubmitting) => { onSubmitting(); throw new Error('提交后连接中断'); });
    const frozen = h.repository.read().posts.map(post => ({ caption: post.caption, images: post.images }));
    await h.scheduler.start(id); await h.scheduler.tick();
    expect(h.repository.read().status).toBe('needs_attention');
    expect(h.repository.read().posts[0].status).toBe('uncertain');
    expect((await h.scheduler.retry(id)).ok).toBe(false);
    expect((await h.scheduler.start(id)).ok).toBe(false);
    await h.advance(600_000); expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.repository.read().posts.map(post => ({ caption: post.caption, images: post.images }))).toEqual(frozen);
  });

  it('an upload failure can be retried with the exact original caption and images', async () => {
    const h = harness(); const id = h.repository.read().id;
    h.publish.mockRejectedValueOnce(new Error('上传失败'));
    await h.scheduler.start(id); await h.scheduler.tick();
    expect(h.repository.read().posts[0].status).toBe('failed');
    expect((await h.scheduler.retry(id)).ok).toBe(true);
    await h.scheduler.tick();
    expect(h.publish).toHaveBeenCalledTimes(2);
    const first = h.publish.mock.calls[0][1], retry = h.publish.mock.calls[1][1];
    expect({ caption: retry.caption, images: retry.images }).toEqual({ caption: first.caption, images: first.images });
  });

  it('does not begin when the adapter is unavailable or material validation fails', async () => {
    const h = harness(); const id = h.repository.read().id;
    h.adapter.capability.available = false;
    expect((await h.scheduler.start(id)).ok).toBe(false);
    expect(h.validate).not.toHaveBeenCalled();
    const task = h.repository.read(); task.status = 'scheduled'; h.repository.saveTask(task);
    await h.scheduler.tick(); expect(h.publish).not.toHaveBeenCalled();
    h.adapter.capability.available = true;
    h.validate.mockResolvedValueOnce({ ok: false, invalidFiles: ['图片已修改'] });
    await h.scheduler.tick();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.repository.read().posts[0].status).toBe('failed');
  });

  it('explicit suspend and a long missed tick pause tasks without catching up', async () => {
    const h = harness(); const id = h.repository.read().id;
    await h.scheduler.start(id); h.scheduler.suspend(); await h.scheduler.tick();
    expect(h.repository.read().status).toBe('paused'); expect(h.publish).not.toHaveBeenCalled();
    const future = sampleTask(); future.config.startAt = new Date(initialTime + 3_600_000).toISOString();
    const sleeping = harness(future); await sleeping.scheduler.start(future.id); await sleeping.scheduler.tick();
    sleeping.setTime(initialTime + 4_000_000); await sleeping.scheduler.tick();
    expect(sleeping.repository.read().status).toBe('paused'); expect(sleeping.publish).not.toHaveBeenCalled();
  });

  it('actual repository restart recovery makes interrupted final submission uncertain and blocks dispatch', async () => {
    const task = sampleTask(); task.status = 'running'; task.posts[0].status = 'submitting';
    const h = harness(task);
    // Run the production recovery logic against detached in-memory persistence; no native SQLite instance is needed.
    Store.prototype.recover.call(h.repository as unknown as Store, initialTime);
    expect(h.repository.read().status).toBe('needs_attention');
    expect(h.repository.read().posts[0].status).toBe('uncertain');
    expect((await h.scheduler.retry(task.id)).ok).toBe(false);
    await h.scheduler.tick(); expect(h.publish).not.toHaveBeenCalled();
    const missed = sampleTask(); missed.status = 'scheduled';
    const restarted = harness(missed); Store.prototype.recover.call(restarted.repository as unknown as Store, initialTime);
    expect(restarted.repository.read().status).toBe('paused');
    await restarted.scheduler.tick(); expect(restarted.publish).not.toHaveBeenCalled();
  });

  it('probes the selected account in start rather than trusting another account global capability', async () => {
    const h = harness(); h.adapter.capability.available = false;
    const probe = vi.fn<NonNullable<PublishAdapter['probe']>>(async () => ({ mode: 'browser-protocol', available: true, description: '目标账号可用' }));
    h.adapter.probe = probe;
    expect((await h.scheduler.start(h.repository.read().id)).ok).toBe(true);
    expect(probe).toHaveBeenCalledWith(account);
    await h.scheduler.tick(); expect(h.publish).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1); // publish owns its own fresh identity/ability checks.
    const denied = harness(); denied.adapter.probe = vi.fn<NonNullable<PublishAdapter['probe']>>(async () => ({ mode: 'browser-protocol', available: false, description: '该账号尚不可用' }));
    expect(await denied.scheduler.start(denied.repository.read().id)).toEqual({ ok: false, message: '该账号尚不可用' });
    expect(denied.validate).not.toHaveBeenCalled();
  });

  it('blocks another batch of the same account on uncertainty, but permits a different account', async () => {
    const h = harness(); const first = h.repository.read(); first.posts[0].status = 'uncertain'; first.status = 'needs_attention'; h.repository.saveTask(first);
    const second = sampleTask(); second.id = 'other-task'; h.repository.saveTask(second);
    expect((await h.scheduler.start(second.id)).ok).toBe(false);
    expect((await h.scheduler.retry(second.id)).ok).toBe(false);
    second.status = 'scheduled'; h.repository.saveTask(second);
    await h.scheduler.tick(); expect(h.publish).not.toHaveBeenCalled();
    expect(h.repository.read(second.id).status).toBe('needs_attention');
    const otherAccount = { ...account, id: 'other-account' }; h.repository.saveAccount(otherAccount);
    const third = sampleTask(); third.id = 'third-task'; third.config.accountId = otherAccount.id; h.repository.saveTask(third);
    expect((await h.scheduler.start(third.id)).ok).toBe(true);
    await h.scheduler.tick(); expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish.mock.calls[0][0].id).toBe(otherAccount.id);
  });

  it('applies the last submitted batch interval to all queued batches of that account', async () => {
    const task = sampleTask(); task.posts = [task.posts[0]]; task.config.postCount = 1; task.config.intervalMinutes = 20;
    const h = harness(task);
    const second = sampleTask(); second.id = 'second-batch'; second.posts = [second.posts[0]]; second.config.postCount = 1; second.config.intervalMinutes = 1; h.repository.saveTask(second);
    await h.scheduler.start(task.id); await h.scheduler.start(second.id);
    await h.scheduler.tick(); expect(h.publish).toHaveBeenCalledTimes(1);
    await h.advance(1_199_999); expect(h.publish).toHaveBeenCalledTimes(1);
    await h.advance(1); expect(h.publish).toHaveBeenCalledTimes(2);
    const third = sampleTask(); third.id = 'third-batch'; h.repository.saveTask(third);
    await h.scheduler.start(third.id);
    expect(h.repository.read(third.id).posts[0].scheduledAt).toBe(new Date(h.now() + 60_000).toISOString());
  });

  it('never overwrites pause/cancel/suspend during asynchronous start even when the clock is unchanged', async () => {
    for (const action of ['pause', 'cancel', 'suspend'] as const) {
      const h = harness(); const id = h.repository.read().id; const gate = deferred<{ ok: boolean; invalidFiles: string[] }>();
      h.validate.mockReturnValueOnce(gate.promise);
      const start = h.scheduler.start(id);
      if (action === 'suspend') h.scheduler.suspend(); else h.scheduler[action](id);
      gate.resolve({ ok: true, invalidFiles: [] });
      expect((await start).ok).toBe(false);
      expect(h.repository.read().status).toBe(action === 'cancel' ? 'cancelled' : action === 'pause' ? 'paused' : 'draft');
      await h.scheduler.tick(); expect(h.publish).not.toHaveBeenCalled();
    }
  });

  it('detects configuration or updatedAt changes made outside the scheduler during start', async () => {
    for (const change of ['config', 'updatedAt'] as const) {
      const h = harness(); const id = h.repository.read().id; const gate = deferred<{ ok: boolean; invalidFiles: string[] }>();
      h.validate.mockReturnValueOnce(gate.promise); const start = h.scheduler.start(id);
      const changed = h.repository.read();
      if (change === 'config') changed.config.intervalMinutes = 99; else changed.updatedAt = '2026-10-12T12:00:00.001Z';
      h.repository.saveTask(changed); gate.resolve({ ok: true, invalidFiles: [] });
      expect((await start).ok).toBe(false);
      expect(h.repository.read().status).toBe('draft');
    }
  });

  it('invalidates an outstanding probe when the user pauses and only validates pending material', async () => {
    const h = harness(); const id = h.repository.read().id;
    const gate = deferred<{ mode: 'browser-protocol'; available: boolean; description: string }>();
    h.adapter.probe = vi.fn(() => gate.promise);
    const start = h.scheduler.start(id); h.scheduler.pause(id);
    gate.resolve({ mode: 'browser-protocol', available: true, description: 'ready' });
    expect((await start).ok).toBe(false); expect(h.repository.read().status).toBe('paused');
    const resumed = harness(); const old = resumed.repository.read(); old.posts[0].status = 'submitted'; old.posts[0].submittedAt = new Date(initialTime - 600_000).toISOString(); resumed.repository.saveTask(old);
    await resumed.scheduler.start(old.id);
    expect(resumed.validate.mock.calls[0][0].posts.map(post => post.id)).toEqual([old.posts[1].id]);
  });

  it('suspend aborts preparation and the final-submission callback prevents dispatch after resume', async () => {
    const h = harness(); const ready = deferred<void>(); const gate = deferred<void>(); const sent = vi.fn();
    h.publish.mockImplementationOnce(async (_account, _post, _config, onSubmitting, signal) => {
      expect(signal?.aborted).toBe(false); ready.resolve(); await gate.promise;
      expect(signal?.aborted).toBe(true); onSubmitting(); sent(); return { kind: 'submitted' };
    });
    const id = h.repository.read().id; await h.scheduler.start(id); const tick = h.scheduler.tick(); await ready.promise;
    h.scheduler.suspend(); gate.resolve(); await tick;
    expect(sent).not.toHaveBeenCalled();
    expect(h.repository.read().status).toBe('paused'); expect(h.repository.read().posts[0].status).toBe('pending');
    expect(h.scheduler.isBusy()).toBe(false);
  });

  it('an interrupted final request stays uncertain and cannot silently become a retryable pending post', async () => {
    const h = harness(); const submitted = deferred<void>(); const gate = deferred<void>();
    h.publish.mockImplementationOnce(async (_account, _post, _config, onSubmitting, signal) => {
      onSubmitting(); submitted.resolve(); await gate.promise; expect(signal?.aborted).toBe(true); throw new Error('请求中断');
    });
    const id = h.repository.read().id; await h.scheduler.start(id); const tick = h.scheduler.tick(); await submitted.promise;
    h.scheduler.suspend(); gate.resolve(); await tick;
    expect(h.repository.read().status).toBe('needs_attention'); expect(h.repository.read().posts[0].status).toBe('uncertain');
    expect((await h.scheduler.retry(id)).ok).toBe(false);
  });

  it('stops the timer on persistence failure without an unhandled rejection or subsequent dispatch', async () => {
    vi.useFakeTimers();
    const h = harness(); const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reads = vi.spyOn(h.repository, 'tasks').mockImplementation(() => { throw new Error('database unavailable'); });
    try {
      h.scheduler.run(); await vi.advanceTimersByTimeAsync(1000);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('调度'), 'database unavailable');
      const called = reads.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(reads).toHaveBeenCalledTimes(called); expect(h.publish).not.toHaveBeenCalled();
    } finally { h.scheduler.stop(); error.mockRestore(); reads.mockRestore(); vi.useRealTimers(); }
  });
});
