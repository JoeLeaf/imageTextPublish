import {describe,it,expect} from 'vitest';
import {SubmissionGate,CREATE_PATH,PROBE_PARAM,SUBMIT_PARAM} from '../src/main/platform/submission-gate';
const target=(key:string,id:string,signed=true)=>`https://creator.douyin.com${CREATE_PATH}?${key}=${id}${signed?'&msToken=token&a_bogus=signature':''}`;
describe('pre-network submission gate',()=>{
  it('cancels every probe including retries while recording native signing evidence',()=>{
    const gate=new SubmissionGate();const id=gate.issue('probe');
    expect(gate.inspect(target(PROBE_PARAM,id,false),'POST')).toBe(true);
    expect(gate.inspect(target(PROBE_PARAM,id),'POST')).toBe(true);
    expect(gate.inspect(target(PROBE_PARAM,id),'POST')).toBe(true);
    expect(gate.finish(id)).toMatchObject({signed:true,sent:0,attempts:3});
  });
  it('allows one signed dispatch and blocks the site fetch wrapper retry',()=>{
    const gate=new SubmissionGate();const id=gate.issue('submit');
    expect(gate.inspect(target(SUBMIT_PARAM,id),'POST')).toBe(false);
    expect(gate.inspect(target(SUBMIT_PARAM,id),'POST')).toBe(true);
    expect(gate.finish(id)).toMatchObject({sent:1,attempts:2});
    expect(gate.inspect(target(SUBMIT_PARAM,id),'POST')).toBe(true);
  });
  it('rejects unsigned, mixed, reset or incorrect-method tickets',()=>{
    const gate=new SubmissionGate();const id=gate.issue('submit');
    expect(gate.inspect(target(SUBMIT_PARAM,id,false),'POST')).toBe(true);
    expect(gate.inspect(target(SUBMIT_PARAM,id),'GET')).toBe(true);
    expect(gate.inspect(target(SUBMIT_PARAM,id)+'&'+PROBE_PARAM+'='+id,'POST')).toBe(true);
    gate.clear();expect(gate.inspect(target(SUBMIT_PARAM,id),'POST')).toBe(true);
  });
  it('blocks unmarked create retries but leaves unrelated read-only requests untouched',()=>{
    expect(new SubmissionGate().inspect(`https://creator.douyin.com${CREATE_PATH}`,'POST')).toBe(true);
    expect(new SubmissionGate().inspect('https://creator.douyin.com/web/api/media/user/info/','GET')).toBe(false);
  });
});
