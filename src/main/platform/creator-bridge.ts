import {randomInt,createHash} from 'node:crypto';
import type {CreatorProtocolBridge,VerifiedMedia} from './douyin';
import {ImageXUploader,normalizeImageXCredentials,type ImageXCredentials} from './imagex';
import {buildCreatorPayload,type CreatorUploadedImage} from './creator-payload';
import {CREATE_PATH} from './submission-gate';
import type {AccountSessionManager,RealmResponse} from './account-sessions';
import type {Account,PreparedPost,TaskConfig} from '../../shared/types';

function credentials(response:RealmResponse):ImageXCredentials {
  const body=response.body as {status_code?:unknown;auth?:unknown}|null;
  if(response.status!==200||body?.status_code!==0||typeof body.auth!=='string')throw new Error('抖音未返回有效的图片上传授权，请检查登录和网络');
  try{return normalizeImageXCredentials(JSON.parse(body.auth));}
  catch{throw new Error('图片上传授权格式发生变化，请更新协议适配器');}
}

export interface CreatorBridgeOptions {fetch?:typeof fetch; creationId?:()=>string}

/** HTTP upload + native creator-page signing. No DOM clicks are used for publishing. */
export function createCreatorBridge(options:CreatorBridgeOptions={}):CreatorProtocolBridge {
  const obtain=async(account:Account,manager:AccountSessionManager,signal?:AbortSignal)=>credentials(await manager.request(account,{path:'/web/api/media/upload/auth/v5/',method:'GET'},signal));
  return {
    async probe(account,manager) {
      if(!account.platformUserId)return {available:false,createSignatureVerified:false,description:'请先核实该账号登录身份'};
      await obtain(account,manager);
      const signed=await manager.probeCreateSignature(account);
      return {available:signed,createSignatureVerified:signed,platformUserId:account.platformUserId,description:signed?'已检查账号上传授权与网页签名注入；准备就绪，真实作品接收结果以首次提交回执为准。':'网页尚未为图文请求生成签名，请打开账号窗口等待页面加载后重新检查。'};
    },
    async prepare(account:Account,post:PreparedPost,config:TaskConfig,manager:AccountSessionManager,signal?:AbortSignal,media?:readonly VerifiedMedia[]) {
      signal?.throwIfAborted();
      if(!account.platformUserId||config.accountId!==account.id)throw new Error('图文任务账号不一致');
      if(!media||media.length!==post.images.length)throw new Error('缺少已核对的图片内容');
      const creationId=(options.creationId??(()=>randomInt(36**8).toString(36).padStart(8,'0')+Date.now()))();
      // Validate every platform field BEFORE uploading any image bytes.
      buildCreatorPayload(post,config,post.images.map(i=>({uri:'validation-only',width:i.width,height:i.height})),creationId);
      for(let i=0;i<media.length;i++) {
        if(media[i].image.sha256!==post.images[i].sha256||media[i].bytes.length>50*1024*1024||createHash('sha256').update(media[i].bytes).digest('hex')!==post.images[i].sha256)throw new Error('图片内容与冻结预览不一致');
      }
      const uploaded:CreatorUploadedImage[]=[];
      for(const item of media) {
        signal?.throwIfAborted();
        const grantCredentials=await obtain(account,manager,signal);
        signal?.throwIfAborted();
        const uploader=new ImageXUploader({serviceId:'jm8ajry58r',appId:'2906',userId:account.platformUserId,credentials:grantCredentials,signal,fetch:options.fetch});
        const grant=await uploader.apply();signal?.throwIfAborted();
        await uploader.transfer(grant,item.bytes,item.image.filename);signal?.throwIfAborted();
        uploaded.push(await uploader.commit(grant));signal?.throwIfAborted();
      }
      const payload=buildCreatorPayload(post,config,uploaded,creationId);
      return {platformUserId:account.platformUserId,request:{path:`${CREATE_PATH}?read_aid=2906`,method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(Object.entries(payload).map(([key,value])=>[key,String(value)])).toString()}};
    },
  };
}
