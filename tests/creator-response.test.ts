import {describe,expect,it,vi} from 'vitest';
vi.mock('electron',() => ({BrowserWindow:vi.fn(),session:{fromPartition:vi.fn()}}));
import {classifyCreateResponse} from '../src/main/platform/douyin';

describe('creator submission response classification',() => {
  it.each([
    {item_id:'9876543210123456789'},
    {aweme:{aweme_id:'9876543210123456789'}},
    {item_id:'9876543210123456789',aweme:{aweme_id:'9876543210123456789'}},
  ])('preserves a lossless large platform ID from either response shape',ids => {
    expect(classifyCreateResponse({status:200,body:{status_code:0,...ids}})).toMatchObject({
      kind:'submitted',postId:'9876543210123456789',url:'https://www.douyin.com/note/9876543210123456789',
    });
  });

  it.each([
    {item_id:12345},
    {aweme:{aweme_id:12345}},
    {item_id:'12345',aweme:{aweme_id:12345}},
  ])('accepts safe positive numeric IDs and agreeing string/number IDs',ids => {
    expect(classifyCreateResponse({status:201,body:{status_code:0,...ids}})).toMatchObject({kind:'submitted',postId:'12345'});
  });

  it.each([
    {item_id:'12345',aweme:{aweme_id:'67890'}},
    {item_id:'12345',aweme:{aweme_id:9876543210123456789}},
    {item_id:9876543210123456789,aweme:{aweme_id:'12345'}},
    {item_id:'12345',aweme:{aweme_id:''}},
    {item_id:{id:'12345'},aweme:{aweme_id:'12345'}},
  ])('keeps contradictory or malformed populated IDs uncertain',ids => {
    expect(classifyCreateResponse({status:200,body:{status_code:0,...ids}}).kind).toBe('uncertain');
  });

  it.each([9876543210123456789,0,-1,1.5,'','0','-1','1.5','123x',' 123','1'.repeat(31)])('rejects an invalid or lossy ID %s in both shapes',id => {
    for(const ids of [{item_id:id},{aweme:{aweme_id:id}}]) {
      expect(classifyCreateResponse({status:200,body:{status_code:0,...ids}}).kind).toBe('uncertain');
    }
  });

  it.each([
    {status:500,body:{status_code:0,aweme:{aweme_id:'12345'}}},
    {status:200,body:{aweme:{aweme_id:'12345'}}},
    {status:200,body:{status_code:'0',aweme:{aweme_id:'12345'}}},
    {status:200,body:{status_code:5,aweme:{aweme_id:'12345'}}},
    {status:200,body:{status_code:9,item_id:'12345'}},
    {status:200,body:{status_code:0,aweme:{}}},
    {status:200,body:null},
  ])('requires both HTTP and explicit business success',response => {
    expect(classifyCreateResponse(response).kind).toBe('uncertain');
  });

  it('only classifies a known code 5 rejection without IDs as failed',() => {
    expect(classifyCreateResponse({status:200,body:{status_code:5}}).kind).toBe('failed');
    expect(classifyCreateResponse({status:200,body:{status_code:5,aweme:{aweme_id:null}}}).kind).toBe('failed');
    expect(classifyCreateResponse({status:503,body:{status_code:5}}).kind).toBe('uncertain');
    expect(classifyCreateResponse({status:200,body:{status_code:5,item_id:''}}).kind).toBe('uncertain');
    expect(classifyCreateResponse({status:200,body:{status_code:987654321}}).kind).toBe('uncertain');
  });
});
