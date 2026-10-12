import {createHash,createHmac} from 'node:crypto';

export interface ImageXCredentials {accessKeyId:string; secretAccessKey:string; sessionToken:string; currentTime?:string|number; expiredTime?:string|number}
export interface GatewaySignInput {method:'GET'|'POST'; query:Record<string,string>; body?:Buffer; now?:Date; region?:string; service?:string}

const hash = (value:Buffer|string) => createHash('sha256').update(value).digest('hex');
const hmac = (key:Buffer|string,value:string) => createHmac('sha256',key).update(value).digest();
const encode = (value:string) => encodeURIComponent(value).replace(/[!'()*]/g,ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

/** Independent implementation of the documented AWS Signature V4 algorithm. */
export function signImageX(credentials:ImageXCredentials,input:GatewaySignInput):Record<string,string> {
  if (!credentials.accessKeyId || !credentials.secretAccessKey || !credentials.sessionToken) throw new Error('ImageX 临时上传授权不完整');
  const timestamp = (input.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g,'');
  const day = timestamp.slice(0,8);
  const region = input.region ?? 'cn-north-1';
  const service = input.service ?? 'imagex';
  const scope = `${day}/${region}/${service}/aws4_request`;
  const bodyHash = hash(input.body ?? Buffer.alloc(0));
  const headers:Record<string,string> = {'x-amz-date':timestamp,'x-amz-security-token':credentials.sessionToken};
  if (input.method === 'POST') headers['x-amz-content-sha256'] = bodyHash;
  const keys = Object.keys(headers).sort();
  const query = Object.entries(input.query).map(([k,v]) => [encode(k),encode(v)]).sort(([ak,av],[bk,bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0).map(([k,v]) => `${k}=${v}`).join('&');
  const canonicalHeaders = keys.map(key => `${key}:${headers[key].trim()}\n`).join('');
  const signedHeaders = keys.join(';');
  const canonical = [input.method,'/',query,canonicalHeaders,signedHeaders,bodyHash].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`,day),region),service),'aws4_request');
  const signature = createHmac('sha256',signingKey).update(['AWS4-HMAC-SHA256',timestamp,scope,hash(canonical)].join('\n')).digest('hex');
  return {...headers,authorization:`AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`};
}

export function crc32Hex(bytes:Buffer):string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit=0;bit<8;bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8,'0');
}

export interface ImageUploadGrant {host:string; storeUri:string; authorization:string; headers?:Record<string,string>; uploadId?:string}
export interface ImageXGrant {upload:ImageUploadGrant; sessionKey:string}
export interface ImageXUploadOptions {
  serviceId:string; appId:string; credentials:ImageXCredentials; userId?:string; fetch?:typeof fetch;
  signal?:AbortSignal; now?:()=>Date; serverCurrentTime?:string|number; expiredTime?:string|number;
}

function milliseconds(value:string|number|undefined):number|undefined {
  if(value===undefined)return;
  const time=typeof value==='number' ? (value<1e12 ? value*1000:value) : /^\d+(?:\.\d+)?$/.test(value) ? (Number(value)<1e12 ? Number(value)*1000:Number(value)) : Date.parse(value);
  if(!Number.isFinite(time)||time<=0)throw new Error('上传临时授权时间无效');
  return time;
}

/** Normalizes the two credential spellings supported by the official uploader. */
export function normalizeImageXCredentials(value:unknown):ImageXCredentials {
  if(!value||typeof value!=='object')throw new Error('图片上传临时授权格式无效');
  const data=value as Record<string,unknown>;
  const accessKeyId=data.AccessKeyID??data.AccessKeyId;
  if(typeof accessKeyId!=='string'||!accessKeyId||typeof data.SecretAccessKey!=='string'||!data.SecretAccessKey||typeof data.SessionToken!=='string'||!data.SessionToken)throw new Error('图片上传临时授权不完整');
  const currentTime=typeof data.CurrentTime==='string'||typeof data.CurrentTime==='number' ? data.CurrentTime:undefined;
  const expiredTime=typeof data.ExpiredTime==='string'||typeof data.ExpiredTime==='number' ? data.ExpiredTime:undefined;
  milliseconds(currentTime);milliseconds(expiredTime);
  return {accessKeyId,secretAccessKey:data.SecretAccessKey,sessionToken:data.SessionToken,currentTime,expiredTime};
}

/** Server-issued extension headers are restricted to storage semantics and cannot override credentials or transport. */
export function normalizeUploadHeaders(input:unknown):Record<string,string> {
  if(input===undefined||input===null)return {};
  const entries:Array<[unknown,unknown]>=Array.isArray(input)
    ? input.map(entry=>[entry?.Key,entry?.Value])
    : typeof input==='object' ? Object.entries(input):[];
  if(!Array.isArray(input)&&typeof input!=='object')throw new Error('上传节点扩展头格式无效');
  const headers:Record<string,string>={};
  for(const [rawKey,rawValue] of entries) {
    if(typeof rawKey!=='string'||!/^[a-zA-Z0-9-]+$/.test(rawKey))throw new Error('上传节点扩展头名称无效');
    const key=rawKey.toLowerCase();
    if(!/^x-(?:storage-|upload-|tos-|use-|large-|tt-|amz-)/.test(key)||key==='x-storage-u'||key.startsWith('x-amz-security-'))throw new Error('上传节点返回了未经允许的扩展头');
    if((typeof rawValue!=='string'&&typeof rawValue!=='number')||/[\r\n\0]/.test(String(rawValue)))throw new Error('上传节点扩展头值无效');
    const value=String(rawValue);
    if(value.length>8192||Object.hasOwn(headers,key))throw new Error('上传节点扩展头重复或过长');
    headers[key]=value;
  }
  return headers;
}

function uploadUrl(grant:ImageUploadGrant):string {
  const raw = /^https:\/\//.test(grant.host) ? grant.host : `https://${grant.host}`;
  const host = new URL(raw);
  // Upload destinations are server-issued, but must still be restricted to known storage domains.
  if (host.protocol !== 'https:' || host.username || host.password || (host.port && host.port !== '443') ||
      !['.bytedance.com','.byteimg.com','.bytedance.net','.bytedancevod.com','.volces.com','.volcengineapi.com','.douyinpic.com','.douyin.com','.pstatp.com'].some(suffix => host.hostname.endsWith(suffix))) throw new Error('上传授权返回了不可信的存储域名');
  if (!grant.storeUri || grant.storeUri.includes('..') || /[?#\\\s\0]/.test(grant.storeUri) || grant.storeUri.startsWith('/')) throw new Error('图片存储地址无效');
  return `${host.origin}/upload/v1/${grant.storeUri.split('/').map(encodeURIComponent).join('/')}`;
}

/** Used only after a complete site-SDK signing bridge passes readiness. No creator signature is guessed. */
export class ImageXUploader {
  private readonly http:typeof fetch;
  private readonly clock:()=>Date;
  private readonly serverOffset:number;
  private readonly expiration?:number;
  constructor(private readonly options:ImageXUploadOptions) {
    if (!options.serviceId || !options.appId) throw new Error('缺少已验收的 ImageX 服务配置');
    this.http = options.fetch ?? fetch;
    this.clock=options.now??(()=>new Date());
    const current=milliseconds(options.serverCurrentTime??options.credentials.currentTime);
    this.serverOffset=current===undefined ? 0:current-this.clock().getTime();
    this.expiration=milliseconds(options.expiredTime??options.credentials.expiredTime);
  }
  private currentTime():Date {
    this.options.signal?.throwIfAborted();
    const date=new Date(this.clock().getTime()+this.serverOffset);
    if(!Number.isFinite(date.getTime()))throw new Error('系统时间无效');
    if(this.expiration!==undefined&&date.getTime()+5_000>=this.expiration)throw new Error('图片临时上传授权已过期，请重新取得授权');
    return date;
  }
  private abortSignal(timeout:number):AbortSignal {
    this.options.signal?.throwIfAborted();
    const timeoutSignal=AbortSignal.timeout(timeout);
    return this.options.signal ? AbortSignal.any([this.options.signal,timeoutSignal]):timeoutSignal;
  }
  private async gateway(method:'GET'|'POST',query:Record<string,string>,body?:Buffer):Promise<Record<string,unknown>> {
    const headers = signImageX(this.options.credentials,{method,query,body,now:this.currentTime()});
    const response = await this.http(`https://imagex.bytedanceapi.com/?${new URLSearchParams(query)}`,{method,headers:{...headers,...(body ? {'content-type':'application/json'} : {})},body:body ? new Uint8Array(body) : undefined,redirect:'error',signal:this.abortSignal(60_000)});
    if (!response.ok) throw new Error(`ImageX 上传授权请求被拒绝（HTTP ${response.status}）`);
    const value = await response.json() as Record<string,unknown>;
    if (value.ResponseMetadata && (value.ResponseMetadata as Record<string,unknown>).Error) throw new Error('ImageX 上传接口返回业务错误');
    if (!value.Result || typeof value.Result !== 'object') throw new Error('ImageX 上传接口未返回有效结果');
    return value.Result as Record<string,unknown>;
  }
  async apply():Promise<ImageXGrant> {
    const result = await this.gateway('GET',{Action:'ApplyImageUpload',Version:'2018-08-01',ServiceId:this.options.serviceId,app_id:this.options.appId,user_id:this.options.userId ?? '',s:Math.random().toString(36).slice(2)});
    const address = result.UploadAddress as Record<string,unknown> | undefined;
    const stores = address?.StoreInfos as Array<Record<string,unknown>> | undefined;
    const hosts = address?.UploadHosts as string[] | undefined;
    const store = stores?.[0];
    const sessionKey = address?.SessionKey;
    if (!store || typeof hosts?.[0]!=='string' || typeof sessionKey !== 'string'||!sessionKey || typeof store.StoreUri !== 'string' || typeof store.Auth !== 'string'||!store.Auth) throw new Error('ImageX 返回的上传节点不完整');
    const upload = {host:hosts[0],storeUri:store.StoreUri,authorization:store.Auth,headers:normalizeUploadHeaders(address?.UploadHeader),uploadId:typeof store.UploadID==='string' ? store.UploadID:undefined};
    uploadUrl(upload);
    return {upload,sessionKey};
  }
  async transfer(grant:ImageXGrant,bytes:Buffer,filename?:string):Promise<void> {
    if (!bytes.length) throw new Error('图片文件为空');
    this.currentTime();
    if(bytes.length>50*1024*1024)throw new Error('抖音图文图片不能超过 50 MB');
    if(filename!==undefined&&(!filename||/[\r\n\0]/.test(filename)))throw new Error('图片上传文件名无效');
    const disposition=encodeURI(filename??'undefined').replace(/["\\]/g,char=>encodeURIComponent(char));
    const response = await this.http(uploadUrl(grant.upload),{method:'POST',headers:{...normalizeUploadHeaders(grant.upload.headers),authorization:grant.upload.authorization,'content-type':'application/octet-stream','content-crc32':crc32Hex(bytes),'x-storage-u':encodeURIComponent(this.options.userId??''),'content-disposition':`attachment; filename="${disposition}"`},body:new Uint8Array(bytes),redirect:'error',signal:this.abortSignal(120_000)});
    if (!response.ok) throw new Error(`图片上传失败（HTTP ${response.status}）`);
    const value = await response.json() as {code?:number};
    if (value.code !== 2000) throw new Error('图片上传节点未明确确认成功');
  }
  async commit(grant:ImageXGrant):Promise<{uri:string;width:number;height:number}> {
    const body = Buffer.from(JSON.stringify({SessionKey:grant.sessionKey}));
    const result = await this.gateway('POST',{Action:'CommitImageUpload',Version:'2018-08-01',ServiceId:this.options.serviceId,app_id:this.options.appId,user_id:this.options.userId ?? ''},body);
    const base=(result.Results as Array<Record<string,unknown>>|undefined)?.[0];
    const plugin=(result.PluginResult as Array<Record<string,unknown>>|undefined)?.[0];
    const value={...base,...plugin};
    const uri=value.ImageUri??value.Uri;
    if(typeof uri!=='string'||!uri||!Number.isSafeInteger(value.ImageWidth)||!Number.isSafeInteger(value.ImageHeight)||Number(value.ImageWidth)<=0||Number(value.ImageHeight)<=0)throw new Error('图片提交未返回有效图片标识或尺寸');
    if(typeof value.Uri==='string'&&typeof value.ImageUri==='string'&&value.Uri!==value.ImageUri)throw new Error('图片提交返回的资源标识不一致');
    return {uri,width:Number(value.ImageWidth),height:Number(value.ImageHeight)};
  }
}
