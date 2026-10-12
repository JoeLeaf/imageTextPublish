import type {PreparedPost,TaskConfig} from '../../shared/types';

export interface CreatorUploadedImage {uri:string; width:number; height:number}
export type CreatorPayload = Record<string,string|number>;

/** Flat, form-encoded photo schema observed on /publish-media/image-text.
 * This targets legacy /web/api/media/aweme/create/, never the nested create_v2 API.
 * Construction has no network side effects. Upload URIs must come from the live uploader.
 */
export function buildCreatorPayload(post:PreparedPost,config:TaskConfig,uploaded:readonly CreatorUploadedImage[],creationId:string):CreatorPayload {
  if(!post.caption.trim())throw new Error('图文正文不能为空。');
  const caption=post.caption.trim();
  if(caption.length>1000)throw new Error('抖音图文正文最多 1000 个字符，请调整文案后重新预览。');
  const title=config.titleMode==='none'?'':post.title;
  if(title.length>20)throw new Error('抖音图文标题最多 20 个字符，请调整文件名后重新预览。');
  if(!uploaded.length||uploaded.length>35||uploaded.length!==post.images.length)throw new Error('上传图片必须与预览一致，且数量为 1 至 35 张。');
  if(config.visibility!=='public'&&config.visibility!=='private')throw new Error('图文可见范围无效。');
  if(typeof creationId!=='string'||!creationId.trim()||creationId.length>200||/[\u0000-\u001f]/.test(creationId))throw new Error('创作标识无效。');
  const images=uploaded.map((image,index)=>{
    if(typeof image.uri!=='string'||!image.uri||image.uri.length>4096||/[\u0000-\u0020]/.test(image.uri))throw new Error('上传图片资源 URI 无效。');
    if(!Number.isSafeInteger(image.width)||image.width<1||!Number.isSafeInteger(image.height)||image.height<1)throw new Error('上传图片尺寸无效。');
    if(image.width!==post.images[index].width||image.height!==post.images[index].height)throw new Error('上传图片尺寸与预览不一致。');
    return {uri:image.uri,width:image.width,height:image.height};
  });
  const textExtra:{start:number;end:number;hashtag_id:number;hashtag_name:string;type:number}[]=[];
  let prefix='';
  if(title) {
    textExtra.push({start:0,end:title.length,hashtag_id:0,hashtag_name:'',type:7});
    prefix=title;
    if(!title.endsWith('。')) {
      textExtra.push({start:title.length,end:title.length+1,hashtag_id:0,hashtag_name:'',type:8});
      prefix+='。';
    }
  }
  return {
    text:prefix+caption,
    text_extra:JSON.stringify(textExtra),
    activity:'[]',challenges:'[]',hashtag_source:JSON.stringify(''),mentions:'[]',
    hot_sentence:'',visibility_type:config.visibility==='private'?1:0,download:1,
    poster:images[0].uri,timing:-1,
    images:JSON.stringify(images),creation_id:creationId,
  };
}
