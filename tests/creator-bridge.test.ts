import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Account, PreparedPost, TaskConfig } from '../src/shared/types';
import type { AccountSessionManager, RealmResponse } from '../src/main/platform/account-sessions';
import { createCreatorBridge } from '../src/main/platform/creator-bridge';
import { buildCreatorPayload } from '../src/main/platform/creator-payload';

const bytes = Buffer.from('the exact verified image bytes');
const account: Account = { id: 'account-a', name: 'A', platform: 'douyin', status: 'ready', platformUserId: '12345', createdAt: '2026-10-12T12:00:00Z' };
const config: TaskConfig = { name: 'test', accountId: account.id, textDirectory: '/text', imageDirectory: '/image', postCount: 1, imagesPerPost: 1, intervalMinutes: 10, startAt: '2026-10-12T12:00:00Z', timezone: 'Asia/Shanghai', reuseImages: false, titleMode: 'none', visibility: 'private' };
function planned(): PreparedPost { return { id: 'post-a', textPath: '/missing-do-not-read.txt', textFilename: 'caption.txt', textHash: 'a'.repeat(64), caption: '独立的图集文案\n第二行', title: '', status: 'pending', scheduledAt: config.startAt, images: [{ id: 'image-a', path: '/missing-do-not-read.png', filename: '已冻结.png', sha256: createHash('sha256').update(bytes).digest('hex'), width: 10, height: 20, mime: 'image/png' }] }; }
function setup(options: { signature?: boolean; grant?: RealmResponse; uploadFailure?: boolean; controller?: AbortController; abortAfterApply?: boolean } = {}) {
  const request = vi.fn<AccountSessionManager['request']>(async () => options.grant ?? { status: 200, body: { status_code: 0, auth: JSON.stringify({ AccessKeyID: 'key', SecretAccessKey: 'secret', SessionToken: 'token' }) } });
  const check = vi.fn<AccountSessionManager['check']>(async () => ({ status: 'ready', platformUserId: account.platformUserId, message: 'ready' }));
  const probeCreateSignature = vi.fn<AccountSessionManager['probeCreateSignature']>(async () => options.signature ?? true);
  const manager = { request, check, probeCreateSignature } as unknown as AccountSessionManager;
  const http = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.searchParams.get('Action') === 'ApplyImageUpload') {
      if (options.abortAfterApply) options.controller?.abort();
      return new Response(JSON.stringify({ Result: { UploadAddress: { StoreInfos: [{ StoreUri: 'image/frozen', Auth: 'upload-ticket' }], UploadHosts: ['node.example.byteimg.com'], SessionKey: 'session' } } }), { status: 200 });
    }
    if (url.pathname.startsWith('/upload/v1/')) return new Response(JSON.stringify({ code: options.uploadFailure ? 5000 : 2000 }), { status: 200 });
    if (url.searchParams.get('Action') === 'CommitImageUpload') return new Response(JSON.stringify({ Result: { PluginResult: [{ ImageUri: 'tos-image-resource', ImageWidth: 10, ImageHeight: 20 }] } }), { status: 200 });
    throw new Error(`Unexpected network destination: ${input}`);
  });
  const bridge = createCreatorBridge({ fetch: http, creationId: () => 'frozen-creation-id' });
  return { manager, request, check, probeCreateSignature, http, bridge };
}

describe('creator bridge upload preparation', () => {
  it('uses the exact verified bytes through real ImageX apply/transfer/commit without reading paths or submitting a post', async () => {
    const h = setup(); const post = planned(); const controller = new AbortController();
    const result = await h.bridge.prepare(account, post, config, h.manager, controller.signal, [{ image: post.images[0], bytes }]);
    expect(h.http).toHaveBeenCalledTimes(3);
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.request.mock.calls[0][1]).toMatchObject({ method: 'GET', path: '/web/api/media/upload/auth/v5/' });
    expect(h.request.mock.calls[0][2]).toBe(controller.signal);
    const transfer = h.http.mock.calls.find(([url]) => String(url).includes('/upload/v1/'))!;
    expect(Buffer.from(transfer[1]!.body as Uint8Array)).toEqual(bytes);
    expect(transfer[1]!.headers).toMatchObject({ 'content-crc32': expect.any(String) });
    expect(result.platformUserId).toBe(account.platformUserId);
    expect(result.request.path).toBe('/web/api/media/aweme/create/?read_aid=2906');
    expect(result.request.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    const body = new URLSearchParams(result.request.body);
    expect(body.get('text')).toBe(post.caption);
    expect(body.get('creation_id')).toBe('frozen-creation-id'); expect(body.get('visibility_type')).toBe('1');
    expect(JSON.parse(body.get('images')!)).toEqual([{ uri: 'tos-image-resource', width: 10, height: 20 }]);
    expect(h.request.mock.calls.some(([, req]) => req.method === 'POST')).toBe(false);
    expect(h.http.mock.calls.every(([url]) => !String(url).includes('aweme/create'))).toBe(true);
  });

  it('only probes upload authorization and blocked signing capability, never uploading or publishing', async () => {
    const h = setup({ signature: false });
    const result = await h.bridge.probe(account, h.manager);
    expect(result.available).toBe(false); expect(result.createSignatureVerified).toBe(false);
    expect(h.probeCreateSignature).toHaveBeenCalledWith(account);
    expect(h.request.mock.calls.every(([, request]) => request.method === 'GET')).toBe(true);
    expect(h.http).not.toHaveBeenCalled();
    const signed = setup(); expect((await signed.bridge.probe(account, signed.manager)).available).toBe(true);
    expect(signed.http).not.toHaveBeenCalled();
    const missing = setup(); expect((await missing.bridge.probe({ ...account, platformUserId: undefined }, missing.manager)).available).toBe(false);
    expect(missing.request).not.toHaveBeenCalled(); expect(missing.probeCreateSignature).not.toHaveBeenCalled();
  });

  it('rejects overlong caption and title, missing media, hash mismatch and account mismatch before any uploads', async () => {
    const cases = [
      { post: { ...planned(), caption: '文'.repeat(1001) }, config },
      { post: { ...planned(), title: '题'.repeat(21) }, config: { ...config, titleMode: 'filename' as const } },
      { post: planned(), config: { ...config, accountId: 'different-account' } },
    ];
    for (const value of cases) {
      const h = setup(); await expect(h.bridge.prepare(account, value.post, value.config, h.manager, undefined, [{ image: value.post.images[0], bytes }])).rejects.toThrow();
      expect(h.http).not.toHaveBeenCalled(); expect(h.request).not.toHaveBeenCalled();
    }
    for (const media of [undefined, [], [{ image: planned().images[0], bytes: Buffer.from('changed') }]]) {
      const h = setup(); await expect(h.bridge.prepare(account, planned(), config, h.manager, undefined, media)).rejects.toThrow();
      expect(h.http).not.toHaveBeenCalled(); expect(h.request).not.toHaveBeenCalled();
    }
  });

  it('stops on rejected or malformed temporary credentials before sending verified image bytes', async () => {
    for (const grant of [{ status: 403, body: { status_code: 0, auth: '{}' } }, { status: 200, body: { status_code: 0, auth: 'not-json' } }, { status: 200, body: { status_code: 0, auth: '{}' } }]) {
      const h = setup({ grant }); const post = planned();
      await expect(h.bridge.prepare(account, post, config, h.manager, undefined, [{ image: post.images[0], bytes }])).rejects.toThrow();
      expect(h.http).not.toHaveBeenCalled();
    }
  });

  it('never commits or prepares create after upload failure', async () => {
    const h = setup({ uploadFailure: true }); const post = planned();
    await expect(h.bridge.prepare(account, post, config, h.manager, undefined, [{ image: post.images[0], bytes }])).rejects.toThrow('未明确确认成功');
    expect(h.http).toHaveBeenCalledTimes(2);
    expect(h.request.mock.calls.every(([, request]) => request.method === 'GET')).toBe(true);
  });

  it('respects cancellation before grants and between apply and byte transfer', async () => {
    const aborted = new AbortController(); aborted.abort(); const early = setup(); const post = planned();
    await expect(early.bridge.prepare(account, post, config, early.manager, aborted.signal, [{ image: post.images[0], bytes }])).rejects.toThrow();
    expect(early.request).not.toHaveBeenCalled(); expect(early.http).not.toHaveBeenCalled();
    const controller = new AbortController(); const mid = setup({ controller, abortAfterApply: true });
    await expect(mid.bridge.prepare(account, post, config, mid.manager, controller.signal, [{ image: post.images[0], bytes }])).rejects.toThrow();
    expect(mid.http).toHaveBeenCalledTimes(1);
  });
});

describe('creator payload contracts', () => {
  it('keeps text and image list separate and rejects mismatching upload dimensions or URI', () => {
    const post = planned(); const uploaded = [{ uri: 'tos-resource', width: 10, height: 20 }];
    const payload = buildCreatorPayload(post, config, uploaded, 'creation-id');
    expect(payload.text).toBe(post.caption); expect(JSON.parse(String(payload.images))).toEqual(uploaded);
    for (const bad of [{ uri: 'space uri', width: 10, height: 20 }, { uri: 'tos-resource', width: 11, height: 20 }, { uri: 'tos-resource', width: 10, height: 0 }]) {
      expect(() => buildCreatorPayload(post, config, [bad], 'creation-id')).toThrow();
    }
    expect(() => buildCreatorPayload(post, config, [], 'creation-id')).toThrow();
    expect(() => buildCreatorPayload(post, config, uploaded, '\n')).toThrow();
  });
});
