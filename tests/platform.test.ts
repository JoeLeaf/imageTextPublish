import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
vi.mock('electron',() => ({BrowserWindow:vi.fn(),session:{fromPartition:vi.fn()}}));
import {accountPartition,parseAccountIdentity,type AccountSessionManager} from '../src/main/platform/account-sessions';
import {classifyCreateResponse,createDouyinAdapter,hasUploadGrant,type CreatorProtocolBridge} from '../src/main/platform/douyin';
import {crc32Hex,ImageXUploader,signImageX} from '../src/main/platform/imagex';
import type {Account,PreparedPost,TaskConfig} from '../src/shared/types';

const account:Account = {id:'account-a',name:'A',status:'ready',platform:'douyin',createdAt:'2026-10-12',platformUserId:'12345'};
const config:TaskConfig = {name:'Test',accountId:account.id,textDirectory:'',imageDirectory:'',postCount:1,imagesPerPost:1,intervalMinutes:10,startAt:'',timezone:'Asia/Shanghai',reuseImages:false,titleMode:'none',visibility:'private'};
let directory:string;
let post:PreparedPost;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(),'platform-test-'));
  const bytes = Buffer.from('planned-image');
  const path = join(directory,'image.png');
  await writeFile(path,bytes);
  post = {id:'post-a',textPath:'',textFilename:'caption.txt',textHash:'',caption:'文本',title:'',status:'pending',scheduledAt:'',images:[{id:'image-a',path,filename:'image.png',sha256:createHash('sha256').update(bytes).digest('hex'),width:10,height:10,mime:'image/png'}]};
});
afterAll(async () => {await rm(directory,{recursive:true,force:true});});

function harness(options:{response?:unknown;fail?:boolean;identityChange?:boolean} = {}) {
  let checks=0;
  const events:string[]=[];
  const manager = {
    check:vi.fn(async () => ({status:'ready',platformUserId:options.identityChange && ++checks > 1 ? '99999' : '12345',message:'checked'})),
    request:vi.fn(async () => {events.push('create');if (options.fail) throw new Error('timeout');return options.response ?? {status:200,body:{status_code:0,item_id:'9876543210123456789'}};}),
  } as unknown as AccountSessionManager;
  const bridge:CreatorProtocolBridge = {
    probe:vi.fn(async () => ({available:true,createSignatureVerified:true,platformUserId:'12345',description:'test bridge'})),
    prepare:vi.fn(async () => {events.push('prepare');return {platformUserId:'12345',request:{path:'/web/api/media/aweme/create_v2/',method:'POST' as const,body:'{}'}};}),
  };
  return {manager,bridge,events};
}

describe('persistent account isolation',() => {
  it('keeps partition stable, isolates accounts, and prevents partition-name injection',() => {
    expect(accountPartition('a')).toBe(accountPartition('a'));
    expect(accountPartition('a')).not.toBe(accountPartition('b'));
    expect(accountPartition('../other')).toMatch(/^persist:douyin-[a-f0-9]{64}$/);
  });
  it('requires server success and an exact user ID rather than cookies or unsafe JS numbers',() => {
    expect(parseAccountIdentity({status_code:0,user_info:{uid:'9876543210123456789'}})).toBe('9876543210123456789');
    expect(parseAccountIdentity({status_code:1,user_info:{uid:'123'}})).toBeUndefined();
    expect(parseAccountIdentity({status_code:0,user_info:{uid:9876543210123456789}})).toBeUndefined();
    expect(parseAccountIdentity({sessionid:'looks-logged-in'})).toBeUndefined();
  });
});

describe('submission safety boundary',() => {
  it('does not equate HTTP 200 or a missing ID with successful submission',() => {
    expect(classifyCreateResponse({status:200,body:{status_code:0}}).kind).toBe('uncertain');
    expect(classifyCreateResponse({status:200,body:null}).kind).toBe('uncertain');
    expect(classifyCreateResponse({status:200,body:{status_code:5,status_msg:'rejected'}}).kind).toBe('failed');
    expect(classifyCreateResponse({status:200,body:{status_code:0,item_id:'9876543210123456789'}}).postId).toBe('9876543210123456789');
  });
  it('stays unavailable without a verified signing bridge, even if the read-only probe succeeds',async () => {
    const {manager}=harness({response:{status:200,body:{status_code:0}}});
    const adapter=createDouyinAdapter(manager);
    const submitting=vi.fn();
    expect((await adapter.probe(account)).available).toBe(false);
    expect((await adapter.publish(account,post,config,submitting)).kind).toBe('failed');
    expect(submitting).not.toHaveBeenCalled();
    expect(vi.mocked(manager.request).mock.calls.every(([,request]) => request.method === 'GET')).toBe(true);
  });
  it('persists submitting before sending the final request exactly once',async () => {
    const {manager,bridge,events}=harness();
    const result=await createDouyinAdapter(manager,bridge).publish(account,post,config,() => events.push('submitting'));
    expect(result.kind).toBe('submitted');
    expect(events).toEqual(['prepare','submitting','create']);
    expect(manager.request).toHaveBeenCalledTimes(1);
  });
  it('reports final-request timeouts as uncertain and never retries',async () => {
    const {manager,bridge}=harness({fail:true});
    const result=await createDouyinAdapter(manager,bridge).publish(account,post,config,vi.fn());
    expect(result.kind).toBe('uncertain');
    expect(manager.request).toHaveBeenCalledTimes(1);
  });
  it('stops if the browser account changes after media preparation',async () => {
    const {manager,bridge}=harness({identityChange:true});
    const submitting=vi.fn();
    expect((await createDouyinAdapter(manager,bridge).publish(account,post,config,submitting)).kind).toBe('failed');
    expect(submitting).not.toHaveBeenCalled();
    expect(manager.request).not.toHaveBeenCalled();
  });
  it('stops before upload when a planned image has changed',async () => {
    const {manager,bridge}=harness();
    const changed={...post,images:post.images.map(image => ({...image,sha256:'0'.repeat(64)}))};
    expect((await createDouyinAdapter(manager,bridge).publish(account,changed,config,vi.fn())).kind).toBe('failed');
    expect(bridge.prepare).not.toHaveBeenCalled();
  });
  it('does not submit if durable submitting-state persistence fails',async () => {
    const {manager,bridge}=harness();
    expect((await createDouyinAdapter(manager,bridge).publish(account,post,config,() => {throw new Error('disk full');})).kind).toBe('failed');
    expect(manager.request).not.toHaveBeenCalled();
  });
  it('does not make a retryable failure out of unknown business codes or exceptional HTTP responses',() => {
    for(const response of [
      {status:503,body:{status_code:5,status_msg:'upstream error'}},
      {status:200,body:{status_code:987654321,status_msg:'new unknown code'}},
      {status:500,body:{status_code:0,item_id:'12345'}},
      {status:200,body:{status_code:'0',item_id:'12345'}},
      {status:200,body:{status_code:0,item_id:9876543210123456789}},
      {status:200,body:{status_code:0,item_id:''}},
    ])expect(classifyCreateResponse(response).kind).toBe('uncertain');
  });
  it('pre-aborted preparation never probes, uploads, persists submitting or dispatches create',async () => {
    const {manager,bridge}=harness();const controller=new AbortController();controller.abort();const submitting=vi.fn();
    const result=await createDouyinAdapter(manager,bridge).publish(account,post,config,submitting,controller.signal);
    expect(result.kind).toBe('failed');
    expect(manager.check).not.toHaveBeenCalled();expect(bridge.probe).not.toHaveBeenCalled();expect(bridge.prepare).not.toHaveBeenCalled();
    expect(submitting).not.toHaveBeenCalled();expect(manager.request).not.toHaveBeenCalled();
  });
  it('an abort after media preparation is still stopped before the final request',async () => {
    const {manager,bridge}=harness();const controller=new AbortController();const submitting=vi.fn();
    vi.mocked(bridge.prepare).mockImplementationOnce(async()=>{
      controller.abort();return {platformUserId:account.platformUserId!,request:{path:'/web/api/media/aweme/create_v2/',method:'POST',body:'{}'}};
    });
    const result=await createDouyinAdapter(manager,bridge).publish(account,post,config,submitting,controller.signal);
    expect(result.kind).toBe('failed');expect(submitting).not.toHaveBeenCalled();expect(manager.request).not.toHaveBeenCalled();
  });
  it('passes cancellation through the final request and keeps a connection interruption uncertain',async () => {
    const {manager,bridge}=harness();const controller=new AbortController();
    vi.mocked(manager.request).mockImplementationOnce(async(_account,_request,signal)=>{
      expect(signal).toBe(controller.signal);controller.abort();throw new Error('connection interrupted');
    });
    const submitting=vi.fn();const result=await createDouyinAdapter(manager,bridge).publish(account,post,config,submitting,controller.signal);
    expect(submitting).toHaveBeenCalledTimes(1);expect(manager.request).toHaveBeenCalledTimes(1);expect(result.kind).toBe('uncertain');
    expect(vi.mocked(manager.request).mock.calls[0][2]).toBe(controller.signal);
  });
  it('hands the bridge the same verified bytes, so later disk edits cannot change the upload payload',async()=>{
    const {manager,bridge}=harness();
    vi.mocked(bridge.prepare).mockImplementationOnce(async(_account,_post,_config,_manager,_signal,media)=>{
      expect(media).toHaveLength(1);expect(media![0].bytes.toString()).toBe('planned-image');
      expect(media![0].image.sha256).toBe(post.images[0].sha256);
      await writeFile(post.images[0].path,'modified-after-validation');
      expect(createHash('sha256').update(media![0].bytes).digest('hex')).toBe(post.images[0].sha256);
      return {platformUserId:account.platformUserId!,request:{path:'/web/api/media/aweme/create_v2/',method:'POST',body:'{}'}};
    });
    try {
      expect((await createDouyinAdapter(manager,bridge).publish(account,post,config,vi.fn())).kind).toBe('submitted');
      expect(manager.request).toHaveBeenCalledTimes(1);
    } finally {await writeFile(post.images[0].path,'planned-image');}
  });
});

describe('independent ImageX upload primitives',() => {
  it('requires actual temporary credential fields rather than an HTTP or status-code success',() => {
    expect(hasUploadGrant({status_code:0})).toBe(false);
    expect(hasUploadGrant({status_code:0,auth:'invalid'})).toBe(false);
    expect(hasUploadGrant({status_code:0,auth:JSON.stringify({AccessKeyID:'a',SecretAccessKey:'b',SessionToken:'c'})})).toBe(true);
  });
  it('matches the standard CRC32 check vector',() => {
    expect(crc32Hex(Buffer.from('123456789'))).toBe('cbf43926');
    expect(crc32Hex(Buffer.alloc(0))).toBe('00000000');
  });
  it('canonicalizes query order and signs body bytes',() => {
    const credentials={accessKeyId:'example',secretAccessKey:'secret',sessionToken:'token'};
    const now=new Date('2026-10-12T01:02:03.000Z');
    const a=signImageX(credentials,{method:'POST',query:{z:'a b',a:'x/y'},body:Buffer.from('{}'),now});
    const b=signImageX(credentials,{method:'POST',query:{a:'x/y',z:'a b'},body:Buffer.from('{}'),now});
    const c=signImageX(credentials,{method:'POST',query:{a:'x/y',z:'a b'},body:Buffer.from('{"x":1}'),now});
    expect(a.authorization).toBe(b.authorization);
    expect(a.authorization).not.toBe(c.authorization);
    expect(a['x-amz-date']).toBe('20261012T010203Z');
    expect(a['x-amz-content-sha256']).toBe(createHash('sha256').update('{}').digest('hex'));
  });
  it('rejects unexpected upload hosts before media bytes are sent',async () => {
    const http=vi.fn(async () => new Response(JSON.stringify({Result:{UploadAddress:{StoreInfos:[{StoreUri:'image/x',Auth:'ticket'}],UploadHosts:['127.0.0.1'],SessionKey:'session'}}}),{status:200}));
    const uploader=new ImageXUploader({serviceId:'example',appId:'1',credentials:{accessKeyId:'a',secretAccessKey:'b',sessionToken:'c'},fetch:http as unknown as typeof fetch});
    await expect(uploader.apply()).rejects.toThrow('不可信');
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('validates upload and commit business receipts through the complete three-step flow',async () => {
    const responses=[{Result:{UploadAddress:{StoreInfos:[{StoreUri:'image/x',Auth:'ticket'}],UploadHosts:['upload.example.byteimg.com'],SessionKey:'session'}}},{code:2000},{Result:{PluginResult:[{ImageUri:'tos-image-id',ImageWidth:100,ImageHeight:200}]}}];
    const http=vi.fn(async () => new Response(JSON.stringify(responses.shift()),{status:200}));
    const uploader=new ImageXUploader({serviceId:'example',appId:'1',credentials:{accessKeyId:'a',secretAccessKey:'b',sessionToken:'c'},fetch:http as unknown as typeof fetch});
    const grant=await uploader.apply();
    await uploader.transfer(grant,Buffer.from('123456789'));
    expect(await uploader.commit(grant)).toEqual({uri:'tos-image-id',width:100,height:200});
    expect(http).toHaveBeenCalledTimes(3);
  });
});
