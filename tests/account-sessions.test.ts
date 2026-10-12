import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Account} from '../src/shared/types';

const fake=vi.hoisted(()=>{
  const windows:Array<any>=[];
  const fromPartition=vi.fn(()=>({clearStorageData:vi.fn(async()=>{}),clearCache:vi.fn(async()=>{})}));
  class Events {
    listeners=new Map<string,Array<(...args:any[])=>void>>();
    on(name:string,callback:(...args:any[])=>void){this.listeners.set(name,[...(this.listeners.get(name)??[]),callback]);}
    emit(name:string,...args:any[]){for(const callback of this.listeners.get(name)??[])callback(...args);}
  }
  class Window extends Events {
    destroyed=false;
    visible:boolean;
    url='';
    hide=vi.fn(()=>{this.visible=false;});
    show=vi.fn(()=>{this.visible=true;});
    focus=vi.fn();
    webContents=Object.assign(new Events(),{
      setWindowOpenHandler:vi.fn(),
      session:{setPermissionRequestHandler:vi.fn(),setPermissionCheckHandler:vi.fn(),webRequest:{onBeforeRequest:vi.fn()}},
      getURL:()=>this.url,
      executeJavaScript:vi.fn(async()=>({status:200,body:{status_code:0,user:{uid:'12345678901'}}})),
    });
    constructor(readonly options:any){super();this.visible=options.show;windows.push(this);}
    isDestroyed(){return this.destroyed;}
    async loadURL(url:string){this.url=url;this.webContents.emit('did-finish-load');}
    close(){const event={preventDefault:vi.fn()};this.emit('close',event);if(!event.preventDefault.mock.calls.length)this.destroy();}
    destroy(){this.destroyed=true;this.emit('closed');}
  }
  return {windows,Window,fromPartition};
});
vi.mock('electron',()=>({BrowserWindow:fake.Window,session:{fromPartition:fake.fromPartition}}));
import {AccountSessionManager,parseAccountIdentity} from '../src/main/platform/account-sessions';
const account:Account={id:'a',name:'Original',status:'unverified',platform:'douyin',createdAt:'2026-10-12'};
let manager:AccountSessionManager;
beforeEach(()=>{vi.useFakeTimers();fake.windows.length=0;manager=new AccountSessionManager();});
afterEach(()=>{manager.closeAll();vi.useRealTimers();});

describe('creator identity schema verified from the live authenticated endpoint',()=>{
  it('accepts exact uid at top-level user only with explicit server success',()=>{
    expect(parseAccountIdentity({status_code:0,user:{uid:'12345678901',sec_uid:'ignored'}})).toBe('12345678901');
    expect(parseAccountIdentity({status_code:1,user:{uid:'12345678901'}})).toBeUndefined();
    expect(parseAccountIdentity({status_code:0,user:{sec_uid:'not-an-exact-uid'}})).toBeUndefined();
  });
});

describe('login-window lifecycle',()=>{
  it('automatically verifies real HTTP identity, reports it and hides the login window',async()=>{
    const callback=vi.fn();manager.setOnAccountCheck(callback);
    await manager.open(account);
    await vi.advanceTimersByTimeAsync(400);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][1]).toMatchObject({status:'ready',platformUserId:'12345678901'});
    expect(fake.windows[0].webContents.executeJavaScript.mock.calls[0][0]).toContain('/web/api/media/user/info/');
    expect(fake.windows[0].visible).toBe(false);
    expect(fake.windows[0].destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it('closing the visible window preserves a hidden realm for manual checks',async()=>{
    await manager.open(account);fake.windows[0].close();
    expect(fake.windows[0].visible).toBe(false);
    expect(fake.windows[0].destroyed).toBe(false);
    expect((await manager.check(account)).status).toBe('ready');
    expect(fake.windows).toHaveLength(1);
  });
  it('checks an already-ready account while keeping its opened creator window visible',async()=>{
    const callback=vi.fn();manager.setOnAccountCheck(callback);
    await manager.open({...account,status:'ready',platformUserId:'12345678901'});
    await vi.advanceTimersByTimeAsync(400);
    expect(callback.mock.calls[0][1].status).toBe('ready');
    expect(fake.windows[0].visible).toBe(true);
    expect(fake.windows[0].hide).not.toHaveBeenCalled();
  });
  it('restores the saved partition in a hidden window when checked after application restart',async()=>{
    expect((await manager.check(account)).status).toBe('ready');
    expect(fake.windows[0].options.show).toBe(false);
    expect(fake.windows[0].options.webPreferences.partition).toMatch(/^persist:douyin-/);
  });
  it('coalesces simultaneous checks for an account without overlapping HTTP requests',async()=>{
    await manager.open(account);
    const results=await Promise.all([manager.check(account),manager.check(account)]);
    expect(results.map(result=>result.status)).toEqual(['ready','ready']);
    expect(fake.windows[0].webContents.executeJavaScript).toHaveBeenCalledTimes(1);
  });
  it('keeps bound identity and a visible window when the user logs in to a different account',async()=>{
    const callback=vi.fn();manager.setOnAccountCheck(callback);
    await manager.open({...account,platformUserId:'99999999999'});
    await vi.advanceTimersByTimeAsync(400);
    expect(callback.mock.calls[0][1].status).toBe('expired');
    expect(fake.windows[0].visible).toBe(true);
  });
  it('does not bind or hide based on cookies or an unsuccessful endpoint response',async()=>{
    const callback=vi.fn();manager.setOnAccountCheck(callback);
    await manager.open(account);
    fake.windows[0].webContents.executeJavaScript.mockResolvedValue({status:200,body:{status_code:1,user:{uid:'12345678901'}}});
    await vi.advanceTimersByTimeAsync(400);
    expect(callback).not.toHaveBeenCalled();
    expect(fake.windows[0].visible).toBe(true);
  });
  it('suppresses an in-flight automatic result after account removal',async()=>{
    const callback=vi.fn();manager.setOnAccountCheck(callback);
    await manager.open(account);
    let resolve:(value:unknown)=>void=()=>{};
    fake.windows[0].webContents.executeJavaScript.mockImplementation(()=>new Promise(result=>{resolve=result;}));
    await vi.advanceTimersByTimeAsync(400);
    await manager.remove(account.id);
    resolve({status:200,body:{status_code:0,user:{uid:'12345678901'}}});
    await vi.advanceTimersByTimeAsync(1);
    expect(callback).not.toHaveBeenCalled();
    expect(fake.windows[0].destroyed).toBe(true);
  });
  it('destroys all hidden windows and cancels watchers on application shutdown',async()=>{
    const callback=vi.fn();manager.setOnAccountCheck(callback);
    await manager.open(account);manager.closeAll();
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.windows[0].destroyed).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });
});
