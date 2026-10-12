import {createHash} from 'node:crypto';
import {BrowserWindow, session, type Session} from 'electron';
import type {Account, AccountCheck} from '../../shared/types';
import {SubmissionGate,CREATE_PATH,CREATE_PATHS,PROBE_PARAM,SUBMIT_PARAM} from './submission-gate';

export const CREATOR_ORIGIN = 'https://creator.douyin.com';

// Populate protocol metadata from the account's actual Chromium environment.
// This describes the current browser; no platform fingerprint is substituted.
const creatorQuerySource=`
  let hevc=false;
  try {hevc=['hev1.1.6.L153.B0','hev1.2.4.L153.B0'].every(codec=>globalThis.MediaSource?.isTypeSupported('video/mp4; codecs="'+codec+'"'));} catch {}
  const metadata={cookie_enabled:navigator.cookieEnabled,screen_width:screen.width,screen_height:screen.height,browser_language:navigator.language,browser_platform:navigator.platform,browser_name:navigator.appCodeName,browser_version:navigator.appVersion,browser_online:navigator.onLine,timezone_name:Intl.DateTimeFormat().resolvedOptions().timeZone,aid:1128,support_h265:hevc?1:0};
  for(const [key,value] of Object.entries(metadata))target.searchParams.set(key,String(value));
`;

export function accountPartition(accountId:string):string {
  if (!accountId || accountId.length > 200) throw new Error('账号标识无效');
  return `persist:douyin-${createHash('sha256').update(accountId).digest('hex')}`;
}

/** Only a server response with an explicit success code and a stable ID is identity evidence. */
export function parseAccountIdentity(body:unknown):string | undefined {
  if (!body || typeof body !== 'object') return;
  const value = body as Record<string, unknown>;
  if (value.status_code !== 0) return;
  const data = value.data && typeof value.data === 'object' ? value.data as Record<string,unknown> : {};
  const user = (value.user ?? value.user_info ?? data.user_info) as Record<string, unknown> | undefined;
  if (!user || typeof user !== 'object') return;
  const uid = user.uid ?? user.user_id;
  if (typeof uid === 'string' && /^\d{1,30}$/.test(uid)) return uid;
  if (typeof uid === 'number' && Number.isSafeInteger(uid) && uid > 0) return String(uid);
  return;
}

export interface RealmResponse {status:number; body:unknown}
export interface RealmRequest {path:string; method:'GET'|'POST'; body?:string; headers?:Record<string,string>; timeoutMs?:number}

export class AccountSessionManager {
  private readonly windows = new Map<string,BrowserWindow>();
  private readonly loading = new Map<string,Promise<void>>();
  private readonly accounts = new Map<string,Account>();
  private readonly checks = new Map<string,Promise<AccountCheck>>();
  private readonly timers = new Map<string,ReturnType<typeof setTimeout>>();
  private readonly watchingUntil = new Map<string,number>();
  private readonly closeAfterLogin = new Set<string>();
  private readonly generations = new Map<string,number>();
  private onAccountCheck?: (account:Account,result:AccountCheck)=>void;
  private readonly submissionGates=new Map<string,SubmissionGate>();
  private readonly signatureChecks=new Map<string,Promise<boolean>>();

  setOnAccountCheck(callback:(account:Account,result:AccountCheck)=>void):void {this.onAccountCheck=callback;}

  private remember(account:Account):Account {
    const current=this.accounts.get(account.id);
    const remembered={...account,platformUserId:account.platformUserId??current?.platformUserId};
    this.accounts.set(account.id,remembered);
    return remembered;
  }

  private stopWatching(accountId:string):void {
    const timer=this.timers.get(accountId);
    if(timer)clearTimeout(timer);
    this.timers.delete(accountId);
    this.watchingUntil.delete(accountId);
  }

  private scheduleCheck(accountId:string,delay=350):void {
    if(!this.watchingUntil.has(accountId))return;
    const timer=this.timers.get(accountId);
    if(timer)clearTimeout(timer);
    this.timers.set(accountId,setTimeout(()=>{
      this.timers.delete(accountId);
      void this.autoCheck(accountId);
    },delay));
  }

  private async autoCheck(accountId:string):Promise<void> {
    const account=this.accounts.get(accountId);
    const generation=this.generations.get(accountId)??0;
    if(!account||!this.watchingUntil.has(accountId))return;
    const result=await this.check(account);
    if((this.generations.get(accountId)??0)!==generation||!this.watchingUntil.has(accountId))return;
    const current=this.accounts.get(accountId);
    if(!current)return;
    if(result.status==='ready'&&result.platformUserId) {
      const checked=current.platformUserId&&current.platformUserId!==result.platformUserId
        ? {status:'expired' as const,message:'当前抖音身份与已绑定账号不一致，已阻止绑定与发布。'}
        : result;
      if(checked.status==='ready')this.remember({...current,status:'ready',platformUserId:result.platformUserId});
      try {this.onAccountCheck?.(current,checked);}
      catch {this.stopWatching(accountId);return;}
      this.stopWatching(accountId);
      if(checked.status==='ready'&&this.closeAfterLogin.delete(accountId))this.windows.get(accountId)?.hide();
      return;
    }
    if(result.status==='expired') {
      try {this.onAccountCheck?.(current,result);} catch { /* persistence owns its own errors */ }
      this.stopWatching(accountId);
      return;
    }
    if(Date.now()<(this.watchingUntil.get(accountId)??0))this.scheduleCheck(accountId,4_000);
    else this.stopWatching(accountId);
  }

  getSession(account:Account | string):Session {
    return session.fromPartition(accountPartition(typeof account === 'string' ? account : account.id));
  }

  async open(account:Account):Promise<void> {
    this.remember(account);
    if(account.status==='ready')this.closeAfterLogin.delete(account.id);
    else this.closeAfterLogin.add(account.id);
    this.watchingUntil.set(account.id,Date.now()+10*60_000);
    const current = this.windows.get(account.id);
    if (current && !current.isDestroyed()) {current.show(); current.focus();this.scheduleCheck(account.id); return;}
    await this.createWindow(account,true);
    this.scheduleCheck(account.id);
  }

  private async createWindow(account:Account,visible:boolean):Promise<void> {
    const current=this.windows.get(account.id);
    if(current&&!current.isDestroyed())return this.loading.get(account.id);
    const window = new BrowserWindow({
      width:1180, height:850, show:visible,title:`抖音账号 · ${account.name}`,
      webPreferences:{partition:accountPartition(account.id), nodeIntegration:false, contextIsolation:true, sandbox:true, webSecurity:true,backgroundThrottling:false},
    });
    this.windows.set(account.id, window);
    if(!this.submissionGates.has(account.id)) {
      const gate=new SubmissionGate();this.submissionGates.set(account.id,gate);
      window.webContents.session.webRequest.onBeforeRequest({urls:CREATE_PATHS.map(path=>`${CREATOR_ORIGIN}${path}*`)},(details,callback)=>{
        try {callback({cancel:gate.inspect(details.url,details.method)});} catch {callback({cancel:true});}
      });
    }
    const trusted = (raw:string) => {
      try {const url = new URL(raw); return url.protocol === 'https:' && (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'));}
      catch {return false;}
    };
    window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    window.webContents.on('will-navigate', (event,url) => {if (!trusted(url)) event.preventDefault();});
    window.webContents.on('will-redirect', (event,url) => {if (!trusted(url)) event.preventDefault();});
    window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    // Closing the login UI hides it; its realm and persistent partition remain available.
    window.on('close',(event)=>{event.preventDefault();window.hide();});
    window.webContents.on('did-finish-load',()=>this.scheduleCheck(account.id));
    window.webContents.on('did-navigate-in-page',()=>this.scheduleCheck(account.id));
    window.on('closed', () => {
      if (this.windows.get(account.id) === window) {
        this.windows.delete(account.id);
        this.stopWatching(account.id);
      }
    });
    const load=window.loadURL(`${CREATOR_ORIGIN}/creator-micro/content/manage`).catch(()=>{
      if(visible&&!window.isDestroyed())window.show();
      throw new Error('无法打开抖音创作者中心，请检查网络后重试');
    }).finally(()=>{if(this.loading.get(account.id)===load)this.loading.delete(account.id);});
    this.loading.set(account.id,load);
    await load;
  }

  private creatorWindow(account:Account):BrowserWindow {
    const window = this.windows.get(account.id);
    if (!window || window.isDestroyed()) throw new Error('请先打开该账号登录窗口，并保持窗口开启');
    let url:URL;
    try {url = new URL(window.webContents.getURL());} catch {throw new Error('账号窗口尚未加载完成');}
    if (url.origin !== CREATOR_ORIGIN) throw new Error('请完成登录并进入抖音创作者中心后再检查');
    return window;
  }

  /** Run same-origin HTTP in the account's own Chromium realm; never click Publish. */
  async request(account:Account, request:RealmRequest, signal?:AbortSignal):Promise<RealmResponse> {
    signal?.throwIfAborted();
    const url = new URL(request.path, CREATOR_ORIGIN);
    if (url.origin !== CREATOR_ORIGIN || !url.pathname.startsWith('/web/api/')) throw new Error('仅允许创作者中心同源协议接口');
    const headers = request.headers ?? {};
    for (const key of Object.keys(headers)) {
      if (/^(cookie|authorization|host|origin|referer|user-agent|sec-)/i.test(key)) throw new Error('会话头必须由当前账号浏览器提供');
    }
    this.remember(account);
    await this.createWindow(account,false);
    await this.loading.get(account.id);
    const gate=this.submissionGates.get(account.id)!;
    let ticket:string|undefined;
    if(CREATE_PATHS.includes(url.pathname)) {
      if(url.searchParams.has(PROBE_PARAM)||url.searchParams.has(SUBMIT_PARAM)||request.method!=='POST')throw new Error('无效的最终提交请求。');
      ticket=gate.issue('submit');url.searchParams.set(SUBMIT_PARAM,ticket);
    }
    const input = JSON.stringify({url:url.href,creatorQuery:CREATE_PATHS.includes(url.pathname),method:request.method,body:request.body,headers,timeoutMs:Math.min(request.timeoutMs ?? 30_000,120_000)});
    const source = `(async () => {
      if (location.origin !== ${JSON.stringify(CREATOR_ORIGIN)}) throw new Error('账号窗口已离开创作者中心');
      const input = ${input};
      const target=new URL(input.url);
      if(input.creatorQuery){${creatorQuerySource}}
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs);
      try {
        const response = await fetch(target.href, {method:input.method, headers:input.headers, body:input.body, credentials:'include', redirect:'error', signal:controller.signal});
        const text = await response.text();
        let body; try {
          body = JSON.parse(text, (key,value,context) => {
            if (['uid','user_id','item_id','aweme_id'].includes(key) && typeof value === 'number' && !Number.isSafeInteger(value) && context && /^\\d{1,30}$/.test(context.source)) return context.source;
            return value;
          });
        } catch {body = null;}
        return {status:response.status,body};
      } finally {clearTimeout(timer);}
    })()`;
    try {
      signal?.throwIfAborted();
      const result=await this.creatorWindow(account).webContents.executeJavaScript(source,false) as RealmResponse;
      if(ticket&&gate.finish(ticket)?.sent!==1)throw new Error('最终提交被拦截：网页签名尚未就绪。');
      return result;
    } finally {if(ticket)gate.finish(ticket);}
  }

  /** Prove signing through Chromium's pre-network hook. Every probe attempt is canceled. */
  async probeCreateSignature(account:Account):Promise<boolean> {
    const existing=this.signatureChecks.get(account.id);if(existing)return existing;
    const pending=this.inspectSignature(account).finally(()=>{if(this.signatureChecks.get(account.id)===pending)this.signatureChecks.delete(account.id);});
    this.signatureChecks.set(account.id,pending);return pending;
  }
  private async inspectSignature(account:Account):Promise<boolean> {
    await this.createWindow(account,false);await this.loading.get(account.id);
    const gate=this.submissionGates.get(account.id)!;const ticket=gate.issue('probe');
    const target=`${CREATOR_ORIGIN}${CREATE_PATH}?read_aid=2906&${PROBE_PARAM}=${ticket}`;
    try {
      await this.creatorWindow(account).webContents.executeJavaScript(`(async()=>{const target=new URL(${JSON.stringify(target)});${creatorQuerySource}const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12000);try{await fetch(target.href,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'text=probe&images=%5B%5D',credentials:'include',redirect:'error',signal:controller.signal});}catch{}finally{clearTimeout(timer);}})()`,false);
      const result=gate.finish(ticket);return !!result?.signed&&result.sent===0;
    } finally {gate.finish(ticket);}
  }

  async check(account:Account):Promise<AccountCheck> {
    this.remember(account);
    let pending=this.checks.get(account.id);
    if(!pending) {
      const generation=this.generations.get(account.id)??0;
      pending=this.inspect(account,generation).finally(()=>{if(this.checks.get(account.id)===pending)this.checks.delete(account.id);});
      this.checks.set(account.id,pending);
    }
    const result=await pending;
    const bound=this.accounts.get(account.id)?.platformUserId??account.platformUserId;
    if(result.status==='ready'&&bound&&bound!==result.platformUserId)return {status:'expired',message:'该窗口当前登录的抖音账号与已绑定账号不一致，已阻止发布。请切回原账号，或新建账号配置。'};
    if(result.status==='ready'&&result.platformUserId)this.remember({...this.accounts.get(account.id)??account,status:'ready',platformUserId:result.platformUserId});
    return result;
  }

  private async inspect(account:Account,generation:number):Promise<AccountCheck> {
    try {
      const response = await this.request(account,{path:'/web/api/media/user/info/',method:'GET'});
      if((this.generations.get(account.id)??0)!==generation)return {status:'unverified',message:'账号会话已重置，请重新检测。'};
      const platformUserId = response.status === 200 ? parseAccountIdentity(response.body) : undefined;
      if (!platformUserId) return {status:'unverified',message:'无法从创作者中心响应核实账号身份；请完成登录。接口变化时需更新账号检查适配器。'};
      if (account.platformUserId && account.platformUserId !== platformUserId) return {status:'expired',message:'该窗口当前登录的抖音账号与已绑定账号不一致，已阻止发布。请切回原账号，或新建账号配置。'};
      return {status:'ready',platformUserId,message:'已核实登录身份；协议发布能力需独立验收。'};
    } catch (error) {return {status:'unverified',message:error instanceof Error ? error.message : '账号身份检查失败'};}
  }

  close(accountId:string):void {this.windows.get(accountId)?.hide();}
  private destroy(accountId:string):void {
    this.stopWatching(accountId);
    this.closeAfterLogin.delete(accountId);
    this.generations.set(accountId,(this.generations.get(accountId)??0)+1);
    this.checks.delete(accountId);
    this.accounts.delete(accountId);
    this.loading.delete(accountId);
    this.signatureChecks.delete(accountId);
    this.submissionGates.get(accountId)?.clear();
    const window=this.windows.get(accountId);
    this.windows.delete(accountId);
    if(window&&!window.isDestroyed())window.destroy();
  }
  closeAll():void {for (const accountId of new Set([...this.windows.keys(),...this.accounts.keys()]))this.destroy(accountId);}
  async remove(accountId:string):Promise<void> {
    this.destroy(accountId);
    await this.getSession(accountId).clearStorageData();
    await this.getSession(accountId).clearCache();
  }
}
