import {describe,expect,it,vi} from 'vitest';
import {ImageXUploader,normalizeImageXCredentials,normalizeUploadHeaders} from '../src/main/platform/imagex';

const credentials={accessKeyId:'fixture-access',secretAccessKey:'fixture-secret',sessionToken:'fixture-token'};
function fixture(responses:unknown[],extras:Partial<ConstructorParameters<typeof ImageXUploader>[0]>={}) {
  const calls:Array<{url:string;init?:RequestInit}>=[];
  const http=vi.fn(async(input:URL|RequestInfo,init?:RequestInit)=>{
    calls.push({url:String(input),init});
    return new Response(JSON.stringify(responses.shift()),{status:200});
  });
  const uploader=new ImageXUploader({serviceId:'jm8ajry58r',appId:'2906',credentials,userId:'12345678901',fetch:http as typeof fetch,...extras});
  return {uploader,calls,http};
}
const applyBody=(headers:unknown={})=>({Result:{UploadAddress:{StoreInfos:[{StoreUri:'tos-cn-i-image/filename',Auth:'node-token',UploadID:'upload-id'}],UploadHosts:['image-uploader.example.byteimg.com'],SessionKey:'session-key',UploadHeader:headers}}});

describe('official uploader response normalization',()=>{
  it('accepts AccessKeyId and preserves server timing without leaking credentials',()=>{
    expect(normalizeImageXCredentials({AccessKeyId:'a',SecretAccessKey:'b',SessionToken:'c',CurrentTime:'2026-10-12T00:00:00Z',ExpiredTime:'2026-10-12T00:30:00Z'})).toEqual({accessKeyId:'a',secretAccessKey:'b',sessionToken:'c',currentTime:'2026-10-12T00:00:00Z',expiredTime:'2026-10-12T00:30:00Z'});
    expect(()=>normalizeImageXCredentials({AccessKeyID:'a'})).toThrow('不完整');
  });
  it('normalizes array and object UploadHeader formats while rejecting credential and transport overrides',()=>{
    expect(normalizeUploadHeaders([{Key:'X-Storage-Mode',Value:'gateway'},{Key:'X-Tos-Tag',Value:'image'}])).toEqual({'x-storage-mode':'gateway','x-tos-tag':'image'});
    expect(normalizeUploadHeaders({'X-Upload-Storage-Mode':'gateway','X-Use-Option-Cache':1})).toEqual({'x-upload-storage-mode':'gateway','x-use-option-cache':'1'});
    for(const key of ['Cookie','Host','Authorization','Origin','Content-Length','X-Storage-U','X-Amz-Security-Token'])expect(()=>normalizeUploadHeaders({[key]:'injected'})).toThrow();
    expect(()=>normalizeUploadHeaders({'X-Tos-Tag':'value\r\nCookie: secret'})).toThrow();
  });
  it('uses upload/v1, actual user ID and server-issued headers for byte transfer',async()=>{
    const {uploader,calls}=fixture([applyBody([{Key:'X-Storage-Mode',Value:'gateway'}]),{code:2000}]);
    const grant=await uploader.apply();
    expect(grant.upload.uploadId).toBe('upload-id');
    await uploader.transfer(grant,Buffer.from('123456789'),'作品.png');
    const query=new URL(calls[0].url).searchParams;
    expect(query.get('user_id')).toBe('12345678901');
    expect(query.get('ServiceId')).toBe('jm8ajry58r');
    expect(query.get('app_id')).toBe('2906');
    expect(calls[1].url).toContain('/upload/v1/tos-cn-i-image/filename');
    expect(calls[1].url).not.toContain('/store/v1/');
    expect(calls[1].init?.headers).toMatchObject({'x-storage-u':'12345678901','x-storage-mode':'gateway','content-crc32':'cbf43926',authorization:'node-token','content-disposition':'attachment; filename="%E4%BD%9C%E5%93%81.png"'});
  });
  it('accepts the storage domain issued by the real authenticated ImageX gateway without accepting lookalikes',async()=>{
    const grant={upload:{host:'image-upload.bytedancevod.com',storeUri:'tos/image',authorization:'test'},sessionKey:'s'};
    const valid=fixture([{code:2000}]);
    await valid.uploader.transfer(grant,Buffer.from('test'));
    expect(valid.calls[0].url).toBe('https://image-upload.bytedancevod.com/upload/v1/tos/image');
    const invalid=fixture([]);
    await expect(invalid.uploader.transfer({...grant,upload:{...grant.upload,host:'image-upload.bytedancevod.com.evil.test'}},Buffer.from('test'))).rejects.toThrow('不可信');
    expect(invalid.http).not.toHaveBeenCalled();
  });
  it('merges Results with PluginResult and retains only validated image metadata',async()=>{
    const {uploader,calls}=fixture([{Result:{Results:[{Uri:'tos-id',ImageWidth:100}],PluginResult:[{ImageUri:'tos-id',ImageHeight:200}]}}]);
    expect(await uploader.commit({upload:{host:'uploader.byteimg.com',storeUri:'uri',authorization:'a'},sessionKey:'s'})).toEqual({uri:'tos-id',width:100,height:200});
    expect(JSON.parse(Buffer.from(calls[0].init?.body as Uint8Array).toString())).toEqual({SessionKey:'s'});
  });
  it('rejects inconsistent resource identifiers and business errors',async()=>{
    const grant={upload:{host:'uploader.byteimg.com',storeUri:'uri',authorization:'a'},sessionKey:'s'};
    const mismatch=fixture([{Result:{Results:[{Uri:'old'}],PluginResult:[{ImageUri:'new',ImageWidth:10,ImageHeight:20}]}}]);
    await expect(mismatch.uploader.commit(grant)).rejects.toThrow('不一致');
    const error=fixture([{ResponseMetadata:{Error:{Code:'AccessDenied'}},Result:{}}]);
    await expect(error.uploader.apply()).rejects.toThrow('业务错误');
  });
});

describe('upload authorization time and cancellation',()=>{
  it('signs with server time and advances that clock across Apply and Commit',async()=>{
    let time=Date.parse('2026-10-12T02:00:00Z');
    const {uploader,calls}=fixture([applyBody(),{Result:{PluginResult:[{ImageUri:'i',ImageWidth:10,ImageHeight:20}]}}],{now:()=>new Date(time),serverCurrentTime:'2026-10-12T00:00:00Z',expiredTime:'2026-10-12T00:30:00Z'});
    const grant=await uploader.apply();
    time+=10_000;
    await uploader.commit(grant);
    expect(calls[0].init?.headers).toMatchObject({'x-amz-date':'20261012T000000Z'});
    expect(calls[1].init?.headers).toMatchObject({'x-amz-date':'20261012T000010Z'});
  });
  it('blocks expired credentials before any request',async()=>{
    const {uploader,http}=fixture([],{now:()=>new Date('2026-10-12T02:00:00Z'),serverCurrentTime:'2026-10-12T00:00:00Z',expiredTime:'2026-10-11T23:59:00Z'});
    await expect(uploader.apply()).rejects.toThrow('过期');
    expect(http).not.toHaveBeenCalled();
  });
  it('honors pre-request and in-flight abort signals without retrying',async()=>{
    const aborted=new AbortController();aborted.abort();
    const first=fixture([],{signal:aborted.signal});
    await expect(first.uploader.apply()).rejects.toThrow();
    expect(first.http).not.toHaveBeenCalled();
    const active=new AbortController();
    const http=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
      init?.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true});
      active.abort();
    }));
    const uploader=new ImageXUploader({serviceId:'s',appId:'a',credentials,signal:active.signal,fetch:http as typeof fetch});
    await expect(uploader.apply()).rejects.toThrow();
    expect(http).toHaveBeenCalledTimes(1);
  });
});
