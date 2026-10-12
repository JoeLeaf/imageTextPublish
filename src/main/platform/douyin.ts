import {createHash} from 'node:crypto';
import {readMaterial} from '../core/materials';
import type {Account, AdapterCapability, MediaFile, PreparedPost, PublishAdapter, PublishResult, TaskConfig} from '../../shared/types';
import {CREATOR_ORIGIN, type AccountSessionManager, type RealmRequest, type RealmResponse} from './account-sessions';
import {CREATE_PATHS} from './submission-gate';

const BLOCKED = '抖音创作者中心发布签名 SDK 尚未完成当前账号验收，协议发布不可用。可登录、管理素材和预览任务；不会自动点击发布或伪造成功。';
export interface BridgeReadiness {
  available:boolean;
  /** Must be obtained from an authenticated server identity response, not local configuration. */
  platformUserId?:string;
  /** This requires evidence that the native site SDK signs the create endpoint. An STS grant alone is insufficient. */
  createSignatureVerified:boolean;
  description:string;
}
export interface PreparedSubmission {platformUserId:string; request:RealmRequest}
export interface VerifiedMedia {image:MediaFile;bytes:Buffer}

/** Extension point for an independently implemented, audited native site-SDK bridge.
 * The bridge must use this account's realm, obtain live upload grants, upload media,
 * and prepare the signed request WITHOUT issuing the final create request itself.
 * No guessed private signature, fingerprint spoofing or challenge solver belongs here.
 */
export interface CreatorProtocolBridge {
  probe(account:Account, manager:AccountSessionManager):Promise<BridgeReadiness>;
  prepare(account:Account,post:PreparedPost,config:TaskConfig,manager:AccountSessionManager,signal?:AbortSignal,media?:readonly VerifiedMedia[]):Promise<PreparedSubmission>;
}
export interface DouyinAdapter extends PublishAdapter {
  probe(account:Account):Promise<AdapterCapability>;
}

export function hasUploadGrant(body:unknown):boolean {
  if (!body || typeof body !== 'object') return false;
  const response = body as Record<string,unknown>;
  if (response.status_code !== undefined && response.status_code !== 0) return false;
  try {
    const grant = typeof response.auth === 'string' ? JSON.parse(response.auth) as Record<string,unknown> : undefined;
    return !!grant && ['AccessKeyID','SecretAccessKey','SessionToken'].every(key => typeof grant[key] === 'string' && (grant[key] as string).length > 0);
  } catch {return false;}
}

export function classifyCreateResponse(response:RealmResponse):PublishResult {
  if (!response.body || typeof response.body !== 'object') return {kind:'uncertain',message:'提交响应不是有效业务 JSON，发布结果未知。请在抖音核对后再处理，禁止自动重试。'};
  const body = response.body as Record<string,unknown>;
  // Legacy photo creation returns aweme.aweme_id; newer responses may use item_id.
  // Every populated ID must be lossless and agree before a submission is confirmed.
  const aweme = body.aweme && typeof body.aweme === 'object' ? body.aweme as Record<string,unknown> : undefined;
  const rawIds = [body.item_id,aweme?.aweme_id].filter(value => value !== undefined && value !== null);
  const ids = rawIds.map(raw => typeof raw === 'string' && /^[1-9]\d{0,29}$/.test(raw) ? raw : typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? String(raw) : undefined);
  const postId = ids.length && ids.every(id => id !== undefined && id === ids[0]) ? ids[0] : undefined;
  if(response.status>=200&&response.status<300&&body.status_code===5&&!rawIds.length)return {kind:'failed',message:'抖音明确拒绝提交（业务代码 5），请检查内容和账号后再决定是否重试。'};
  if (response.status >= 200 && response.status < 300 && body.status_code === 0 && postId) return {kind:'submitted',postId,url:`https://www.douyin.com/note/${postId}`,message:'平台已接收作品提交；展示和审核结果请以抖音为准。'};
  return {kind:'uncertain',message:'平台未返回可确认的作品标识，发布结果未知。请在抖音核对，禁止自动重试。'};
}

export function createDouyinAdapter(manager:AccountSessionManager, bridge?:CreatorProtocolBridge):DouyinAdapter {
  const busy = new Set<string>();
  const adapter:DouyinAdapter = {
    capability:{mode:'browser-protocol',available:!!bridge,description:bridge?'图文协议已接通；开始任务时会实时检查该账号、上传授权和网页签名。实际提交仍需在界面启动任务。':BLOCKED},
    async probe(account) {
      const identity = await manager.check(account);
      let description = identity.message;
      let available = false;
      if (identity.status === 'ready' && identity.platformUserId) {
        if (bridge) {
          try {
            const result = await bridge.probe(account,manager);
            available = result.available && result.createSignatureVerified && result.platformUserId === identity.platformUserId && account.platformUserId === identity.platformUserId;
            description = available ? result.description : `协议验收未通过：${result.description}`;
          } catch {description = '协议验收失败，发布不可用。请检查登录窗口和网络。';}
        } else {
          // Read-only authorization probe. A grant proves upload access, never publication signing.
          try {
            const response = await manager.request(account,{path:'/web/api/media/upload/auth/v5/',method:'GET'});
            description = response.status === 200 && hasUploadGrant(response.body)
              ? `已核实账号身份和临时上传授权；${BLOCKED}`
              : `已核实账号身份，上传授权接口尚未通过；${BLOCKED}`;
          } catch {description = `已核实账号身份，上传授权探测未完成；${BLOCKED}`;}
        }
      }
      return {mode:'browser-protocol',available,description};
    },
    async publish(account,post,config,onSubmitting,signal) {
      if (busy.has(account.id)) return {kind:'failed',message:'该账号已有发布操作正在处理，请等待完成。'};
      busy.add(account.id);
      let submitted = false;
      try {
        signal?.throwIfAborted();
        if (config.accountId !== account.id) return {kind:'failed',message:'任务账号与发布会话不一致，已阻止发布。'};
        if (!account.platformUserId) return {kind:'failed',message:'账号尚未绑定可核实的抖音用户 ID，请先检查登录身份。'};
        const readiness = await adapter.probe(account);
        signal?.throwIfAborted();
        if (!readiness.available || !bridge) return {kind:'failed',message:readiness.description};
        if (!post.images.length) return {kind:'failed',message:'图文任务至少需要一张图片。'};
        // Revalidate the immutable planned files before the bridge can upload them.
        const media:VerifiedMedia[]=[];
        for (const image of post.images) {
          signal?.throwIfAborted();
          const bytes = await readMaterial(image.path,'image');
          if (createHash('sha256').update(bytes).digest('hex') !== image.sha256) return {kind:'failed',message:`图片已发生变化，已停止发布：${image.filename}`};
          media.push({image,bytes});
        }
        const preparation = await bridge.prepare(account,post,config,manager,signal,media);
        signal?.throwIfAborted();
        const current = await manager.check(account);
        signal?.throwIfAborted();
        if (current.status !== 'ready' || current.platformUserId !== account.platformUserId || preparation.platformUserId !== account.platformUserId) return {kind:'failed',message:'提交前账号身份发生变化，已阻止发布。'};
        const destination = new URL(preparation.request.path,CREATOR_ORIGIN);
        if (destination.origin !== CREATOR_ORIGIN || !CREATE_PATHS.includes(destination.pathname) || preparation.request.method !== 'POST' || !preparation.request.body) return {kind:'failed',message:'签名桥返回了无效的提交请求，已阻止发布。'};
        // Persist the uncertainty boundary before the first and only final request.
        onSubmitting();
        submitted = true;
        const response = await manager.request(account,{...preparation.request,timeoutMs:60_000},signal);
        return classifyCreateResponse(response);
      } catch (error) {
        return submitted
          ? {kind:'uncertain',message:'最终提交超时或连接中断，作品可能已提交。请先在抖音核对，禁止自动重试。'}
          : {kind:'failed',message:signal?.aborted?'准备发布已中断，尚未发送最终提交请求。':`准备发布失败：${error instanceof Error?error.message.slice(0,300):'请检查素材、登录和协议适配器'}。尚未发送最终提交请求。`};
      } finally {busy.delete(account.id);}
    },
  };
  return adapter;
}
