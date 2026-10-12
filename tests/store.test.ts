import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/main/store';
import { Scheduler } from '../src/main/scheduler';
import type { Account, PostStatus, PublishAdapter, PublishTask } from '../src/shared/types';

const now = Date.parse('2026-10-12T12:00:00Z');
const stamp = new Date(now).toISOString();
let directory: string;
let stores: Set<Store>;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'publish-store-')); stores = new Set(); });
afterEach(async () => { for (const store of stores) store.close(); await rm(directory, { recursive: true, force: true }); });

function openStore(name: string) { const store = new Store(path.join(directory, `${name}.sqlite`)); stores.add(store); return store; }
function closeStore(store: Store) { store.close(); stores.delete(store); }
function readyAccount(store: Store): Account {
  const account = { ...store.addAccount('测试账号'), status: 'ready' as const, platformUserId: 'douyin-user' };
  store.saveAccount(account); return account;
}
function taskFor(account: Account, statuses: PostStatus[] = ['pending']): PublishTask {
  return {
    id: randomUUID(), status: 'paused', createdAt: stamp, updatedAt: stamp, warnings: [],
    config: { name: '冻结批次', accountId: account.id, textDirectory: 'C:\\material\\texts', imageDirectory: 'C:\\material\\images', postCount: statuses.length, imagesPerPost: 1, intervalMinutes: 10, startAt: stamp, timezone: 'Asia/Shanghai', reuseImages: true, titleMode: 'none', visibility: 'public' },
    posts: statuses.map((status, index) => ({ id: randomUUID(), textPath: `C:\\material\\texts\\${index}.txt`, textFilename: `${index}.txt`, textHash: (index + 1).toString(16).repeat(64), caption: `冻结正文 ${index}`, title: '', status, scheduledAt: stamp, images: [{ id: randomUUID(), path: `C:\\material\\images\\${index}.png`, filename: `${index}.png`, sha256: 'f'.repeat(64), width: 2, height: 2, mime: 'image/png' }] })),
  };
}

describe('SQLite Store persistence and migrations', () => {
  it('persists explicit source files, migrates them without scanning and accepts old folder-only tasks', () => {
    const source = openStore('explicit-source'); const account = readyAccount(source);
    const selected = taskFor(account);
    selected.config.textFiles = [selected.posts[0].textPath];
    selected.config.imageFiles = [selected.posts[0].images[0].path];
    source.saveTask(selected);
    const folderOnly = taskFor(account); source.saveTask(folderOnly);
    closeStore(source);
    const reopened = openStore('explicit-source');
    expect(reopened.getTask(selected.id)!.config).toEqual(selected.config);
    expect(reopened.getTask(folderOnly.id)!.config.textFiles).toBeUndefined();
    for (const kind of ['backup','config'] as const) {
      const destination = openStore(`explicit-${kind}`);
      destination.importData(JSON.parse(JSON.stringify(reopened.exportData(kind))));
      const imported = destination.getTask(selected.id)!;
      expect(imported.config.textFiles).toEqual(selected.config.textFiles);
      expect(imported.config.imageFiles).toEqual(selected.config.imageFiles);
      expect(imported.needsRebind).toBe(true);
      expect(destination.getTask(folderOnly.id)!.config.imageFiles).toBeUndefined();
    }
  });

  it('rejects malformed explicit file lists on save and import without changing stored tasks', () => {
    const store = openStore('explicit-invalid'); const account = readyAccount(store);
    const task = taskFor(account); store.saveTask(task);
    for (const textFiles of [['relative.txt'],['C:\\material\\bad\0.txt'],['a'.repeat(4097)]]) {
      expect(() => store.saveTask({...task,config:{...task.config,textFiles}})).toThrow();
      const backup = store.exportData('backup');
      expect(() => store.importData({...backup,tasks:[{...task,config:{...task.config,textFiles}}]},{replace:true})).toThrow();
      expect(store.getTask(task.id)).toEqual(task);
    }
  });

  it('recovers reopened final submissions as uncertain and interrupted uploads as failed', () => {
    const store = openStore('recovery'); const account = readyAccount(store);
    const task = taskFor(account, ['submitting', 'uploading', 'pending']); task.status = 'running';
    const missed = taskFor(account); missed.status = 'scheduled';
    const future = taskFor(account); future.status = 'scheduled'; future.posts[0].scheduledAt = new Date(now + 60_000).toISOString();
    store.saveTask(task); store.saveTask(missed); store.saveTask(future); closeStore(store);
    const reopened = openStore('recovery'); reopened.recover(now);
    const recovered = reopened.getTask(task.id)!;
    expect(recovered.status).toBe('needs_attention');
    expect(recovered.posts.map(post => post.status)).toEqual(['uncertain', 'failed', 'pending']);
    expect(recovered.posts.map(post => ({ caption: post.caption, images: post.images }))).toEqual(task.posts.map(post => ({ caption: post.caption, images: post.images })));
    expect(reopened.getTask(missed.id)!.status).toBe('paused');
    expect(reopened.getTask(future.id)!.status).toBe('scheduled');
    closeStore(reopened);
    expect(openStore('recovery').getTask(task.id)!.posts[0].status).toBe('uncertain');
  });

  it('releases cancelled unpublished texts while retaining submitted and uncertain reservations per account', () => {
    const store = openStore('reservations'); const account = readyAccount(store); const other = readyAccount(store);
    const cancelled = taskFor(account, ['pending', 'failed', 'submitted', 'uncertain']); cancelled.status = 'cancelled'; store.saveTask(cancelled);
    expect([...store.reservedHashes(account.id)].sort()).toEqual([cancelled.posts[2].textHash, cancelled.posts[3].textHash].sort());
    expect(store.reservedHashes(other.id).size).toBe(0);
    const paused = taskFor(account); paused.posts[0].textHash = 'a'.repeat(64); store.saveTask(paused);
    expect(store.reservedHashes(account.id).has(paused.posts[0].textHash)).toBe(true);
    expect(store.reservedHashes(account.id, paused.id).has(paused.posts[0].textHash)).toBe(false);
  });

  it('imports a backup with frozen payload and paths but requires rebinding and re-login without auto dispatch', async () => {
    const source = openStore('source'); const account = readyAccount(source);
    const task = taskFor(account, ['pending', 'submitted']); task.status = 'scheduled';
    task.posts[1].submittedAt = stamp; task.posts[1].platformPostId = 'existing-post'; source.saveTask(task);
    const backup = JSON.parse(JSON.stringify(source.exportData('backup')));
    const destination = openStore('destination');
    expect(destination.importData(backup)).toEqual({ accounts: 1, tasks: 1, needsRebind: 1 });
    const imported = destination.getTask(task.id)!;
    expect(imported.status).toBe('paused'); expect(imported.needsRebind).toBe(true);
    expect(imported.posts).toEqual(task.posts);
    expect(imported.config.textDirectory).toBe(task.config.textDirectory);
    expect(destination.getAccount(account.id)!.status).toBe('unverified');
    const publish = vi.fn<PublishAdapter['publish']>();
    const adapter: PublishAdapter = { capability: { available: true, mode: 'browser-protocol', description: 'test' }, publish };
    const scheduler = new Scheduler(destination, adapter, () => {}, async () => ({ ok: true, invalidFiles: [] }), () => now);
    await scheduler.tick(); expect(publish).not.toHaveBeenCalled();
    expect((await scheduler.start(task.id)).ok).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    expect(destination.reservedHashes(account.id).has(task.posts[1].textHash)).toBe(true);
  });

  it('turns migrated interrupted operations into uncertain/failed without changing selected materials', () => {
    const source = openStore('interrupted-source'); const account = readyAccount(source);
    const task = taskFor(account, ['submitting', 'uploading']); task.status = 'running'; source.saveTask(task);
    const destination = openStore('interrupted-destination'); destination.importData(source.exportData('backup'));
    const imported = destination.getTask(task.id)!;
    expect(imported.status).toBe('needs_attention');
    expect(imported.posts.map(post => post.status)).toEqual(['uncertain', 'failed']);
    expect(imported.posts.map(post => post.images)).toEqual(task.posts.map(post => post.images));
  });

  it('rejects duplicate and malformed imports atomically without partially adding new records', () => {
    const source = openStore('atomic-source'); const account = readyAccount(source); source.saveTask(taskFor(account));
    const backup = source.exportData('backup'); const destination = openStore('atomic-destination'); destination.importData(backup);
    const beforeAccounts = destination.accounts(); const beforeTasks = destination.tasks();
    const extraAccount = { ...account, id: randomUUID(), name: '不得部分导入' };
    const extraTask = taskFor(extraAccount);
    const overlapping = { ...backup, accounts: [extraAccount, ...backup.accounts], tasks: [extraTask, ...backup.tasks] };
    expect(() => destination.importData(overlapping)).toThrow('已经存在');
    expect(destination.accounts()).toEqual(beforeAccounts); expect(destination.tasks()).toEqual(beforeTasks);
    expect(() => destination.importData(backup)).toThrow('已经存在');
    const empty = openStore('invalid-destination');
    expect(() => empty.importData({ ...backup, accounts: [account, account] })).toThrow('重复标识');
    expect(empty.accounts()).toEqual([]); expect(empty.tasks()).toEqual([]);
    expect(() => empty.importData({ ...backup, tasks: [{ ...backup.tasks[0], config: { ...backup.tasks[0].config, accountId: randomUUID() } }] })).toThrow('缺少对应账号');
    expect(empty.accounts()).toEqual([]); expect(empty.tasks()).toEqual([]);
  });

  it('exports a configuration copy as a cancelled template that frees reservations and preserves source history', () => {
    const source = openStore('config-source'); const account = readyAccount(source);
    const task = taskFor(account, ['submitted', 'uncertain']); task.status = 'needs_attention';
    task.posts[0].submittedAt = stamp; task.posts[0].platformPostId = 'published'; task.posts[0].platformUrl = 'https://www.douyin.com/video/example'; source.saveTask(task);
    const exported = source.exportData('config');
    expect(exported.tasks[0].status).toBe('cancelled');
    expect(exported.tasks[0].posts.every(post => post.status === 'pending' && post.submittedAt === undefined && post.platformPostId === undefined && post.platformUrl === undefined)).toBe(true);
    expect(source.getTask(task.id)).toEqual(task);
    expect(source.reservedHashes(account.id).size).toBe(2);
    const destination = openStore('config-destination'); destination.importData(JSON.parse(JSON.stringify(exported)));
    expect(destination.getTask(task.id)!.status).toBe('cancelled');
    expect(destination.getTask(task.id)!.needsRebind).toBe(true);
    expect(destination.reservedHashes(account.id).size).toBe(0);
    expect(destination.getAccount(account.id)!.status).toBe('unverified');
  });

  it('replaces the entire workspace, including colliding IDs, and persists only imported items safely', () => {
    const destination = openStore('replace-destination'); const oldAccount = readyAccount(destination);
    const oldTask = taskFor(oldAccount); destination.saveTask(oldTask);
    const source = openStore('replace-source');
    const changedAccount = { ...oldAccount, name: '迁移后的账号' }; source.saveAccount(changedAccount);
    const changedTask = { ...oldTask, config: { ...oldTask.config, name: '更新的配置' } }; source.saveTask(changedTask);
    const extraOldAccount = readyAccount(destination); const extraOldTask = taskFor(extraOldAccount); destination.saveTask(extraOldTask);
    const newAccount = readyAccount(source); const newTask = taskFor(newAccount); source.saveTask(newTask);
    const result = destination.importData(source.exportData('backup'), { replace: true });
    expect(result).toEqual({ accounts: 2, tasks: 2, needsRebind: 2 });
    expect(destination.getAccount(oldAccount.id)!.name).toBe('迁移后的账号');
    expect(destination.getTask(oldTask.id)!.config.name).toBe('更新的配置');
    expect(destination.getAccount(extraOldAccount.id)).toBeUndefined(); expect(destination.getTask(extraOldTask.id)).toBeUndefined();
    expect(destination.accounts().every(value => value.status === 'unverified')).toBe(true);
    expect(destination.tasks().every(value => value.needsRebind && value.status === 'paused')).toBe(true);
    closeStore(destination);
    const reopened = openStore('replace-destination');
    expect(reopened.accounts()).toHaveLength(2); expect(reopened.tasks()).toHaveLength(2);
    expect(reopened.getTask(newTask.id)!.needsRebind).toBe(true);
  });

  it('validates replacement data before deletion and rolls back a write failure atomically', () => {
    const destination = openStore('rollback-destination'); const account = readyAccount(destination); destination.saveTask(taskFor(account));
    const beforeAccounts = destination.accounts(); const beforeTasks = destination.tasks();
    const source = openStore('rollback-source'); const incoming = readyAccount(source); source.saveTask(taskFor(incoming));
    const backup = source.exportData('backup');
    expect(() => destination.importData({ ...backup, tasks: [{ ...backup.tasks[0], config: { ...backup.tasks[0].config, postCount: 0 } }] }, { replace: true })).toThrow();
    expect(destination.accounts()).toEqual(beforeAccounts); expect(destination.tasks()).toEqual(beforeTasks);
    expect(() => destination.importData({ ...backup, accounts: [] }, { replace: true })).toThrow('缺少对应账号');
    expect(destination.accounts()).toEqual(beforeAccounts); expect(destination.tasks()).toEqual(beforeTasks);
    const failure = vi.spyOn(destination, 'saveTask').mockImplementationOnce(() => { throw new Error('模拟磁盘写入失败'); });
    try { expect(() => destination.importData(backup, { replace: true })).toThrow('模拟磁盘写入失败'); }
    finally { failure.mockRestore(); }
    expect(destination.accounts()).toEqual(beforeAccounts); expect(destination.tasks()).toEqual(beforeTasks);
    closeStore(destination);
    const reopened = openStore('rollback-destination');
    expect(reopened.accounts()).toEqual(beforeAccounts); expect(reopened.tasks()).toEqual(beforeTasks);
  });

  it('refuses replacement while scheduled or running tasks are active and preserves all old records', () => {
    const source = openStore('active-source'); const incoming = readyAccount(source); source.saveTask(taskFor(incoming));
    for (const status of ['scheduled', 'running'] as const) {
      const destination = openStore(`active-${status}`); const account = readyAccount(destination);
      const task = taskFor(account); task.status = status; destination.saveTask(task);
      expect(() => destination.importData(source.exportData('backup'), { replace: true })).toThrow('请先暂停');
      expect(destination.accounts()).toEqual([account]); expect(destination.tasks()).toEqual([task]);
    }
  });
});
