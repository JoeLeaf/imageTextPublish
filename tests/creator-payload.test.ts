import {describe,expect,it} from 'vitest';
import {buildCreatorPayload} from '../src/main/platform/creator-payload';
import type {PreparedPost,TaskConfig} from '../src/shared/types';

const config:TaskConfig={name:'payload测试',accountId:'account',textDirectory:'',imageDirectory:'',postCount:1,imagesPerPost:1,intervalMinutes:10,startAt:'2026-10-12T12:00:00Z',timezone:'Asia/Shanghai',reuseImages:true,titleMode:'none',visibility:'public'};
const post:PreparedPost={id:'post',textPath:'',textFilename:'文案.txt',textHash:'',caption:'  正文\n第二段  ',title:'不使用的文件名标题',images:[{id:'image',path:'',filename:'image.png',sha256:'',width:100,height:200,mime:'image/png'}],status:'pending',scheduledAt:'2026-10-12T12:00:00Z'};
const uploaded=[{uri:'tos-cn-i-test/example',width:100,height:200}];

describe('legacy creator photo payload',()=>{
  it('serializes pure caption and upload resources as flat form fields without a phantom title',()=>{
    const body=buildCreatorPayload(post,config,uploaded,'creation-1');
    expect(body.text).toBe('正文\n第二段');expect(body.text_extra).toBe('[]');
    expect(body.images).toBe(JSON.stringify(uploaded));expect(body.poster).toBe(uploaded[0].uri);
    expect(body.visibility_type).toBe(0);expect(body.timing).toBe(-1);expect(body.hashtag_source).toBe('""');
    expect(body).not.toHaveProperty('item');expect(body).not.toHaveProperty('item_title');expect(body).not.toHaveProperty('image_post_info');
    const encoded=new URLSearchParams(Object.entries(body).map(([key,value])=>[key,String(value)]));
    expect(JSON.parse(encoded.get('images')!)).toEqual(uploaded);
  });
  it('uses UTF-16 title ranges and a separate divider only when required',()=>{
    const body=buildCreatorPayload({...post,title:'标题😀'},{...config,titleMode:'filename',visibility:'private'},uploaded,'creation-2');
    expect(body.text).toBe('标题😀。正文\n第二段');expect(body.visibility_type).toBe(1);
    expect(JSON.parse(body.text_extra as string)).toEqual([{start:0,end:4,hashtag_id:0,hashtag_name:'',type:7},{start:4,end:5,hashtag_id:0,hashtag_name:'',type:8}]);
    const withPeriod=buildCreatorPayload({...post,title:'标题。'},{...config,titleMode:'filename'},uploaded,'creation-3');
    expect(withPeriod.text).toBe('标题。正文\n第二段');expect(JSON.parse(withPeriod.text_extra as string)).toHaveLength(1);
  });
  it('accepts exact limits and rejects oversize or mismatched content before any request',()=>{
    expect(()=>buildCreatorPayload({...post,caption:'文'.repeat(1000),title:'题'.repeat(20)},{...config,titleMode:'filename'},uploaded,'creation')).not.toThrow();
    expect(()=>buildCreatorPayload({...post,caption:'文'.repeat(1001)},config,uploaded,'creation')).toThrow('1000');
    expect(()=>buildCreatorPayload({...post,title:'题'.repeat(21)},{...config,titleMode:'filename'},uploaded,'creation')).toThrow('20');
    expect(()=>buildCreatorPayload(post,config,[],'creation')).toThrow('数量');
    expect(()=>buildCreatorPayload(post,config,[{...uploaded[0],width:101}],'creation')).toThrow('不一致');
    expect(()=>buildCreatorPayload(post,config,uploaded,'')).toThrow('创作标识');
  });
});
