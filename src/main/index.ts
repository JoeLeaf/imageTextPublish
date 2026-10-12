import {app,BrowserWindow,dialog,ipcMain,Menu,net,powerMonitor,protocol,shell} from 'electron';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFile,writeFile,rename,stat,mkdir} from 'node:fs/promises';
import {z} from 'zod';
import {CHANNELS} from '../shared/channels';
import type {AccountCheck,PreparedBatch,PublishTask,TaskConfig} from '../shared/types';
import {prepareBatch,scanDirectories,scanMaterialSource,validateBatchFiles,rebindPreparedPosts,relocateMaterialPath,validateConfig} from './core';
import {AccountSessionManager,createDouyinAdapter,createCreatorBridge} from './platform';
import {Store,migrationSchema} from './store';
import {Scheduler} from './scheduler';

// Isolate development/verification workspaces, including browser partitions and the instance lock.
if(process.env.ITP_DATA_DIR)app.setPath('userData',resolve(process.env.ITP_DATA_DIR));
protocol.registerSchemesAsPrivileged([{scheme:'media',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const currentDir=dirname(fileURLToPath(import.meta.url));
const drafts=new Map<string,PreparedBatch>();
const selectedDirectories=new Set<string>();
const selectedFiles=new Set<string>();
const allowedMedia=new Set<string>();
let window:BrowserWindow|undefined;
let store:Store;
let sessions:AccountSessionManager;
let scheduler:Scheduler;
let quitConfirmed=false;
let dataDirectory:string;
const uuid=z.string().uuid();
const nameSchema=z.string().trim().min(1,'请输入名称。').max(80,'名称最多 80 个字符。');

function changed():void {if(window&&!window.isDestroyed())window.webContents.send(CHANNELS.changed);}
function grantMedia(posts:PreparedBatch['posts']):void {for(const post of posts)for(const image of post.images)allowedMedia.add(resolve(image.path));}
function rebuildGrants():void {
  allowedMedia.clear();
  for(const task of store.tasks())if(!task.needsRebind) {
    for(const [directory,files] of [[task.config.textDirectory,task.config.textFiles],[task.config.imageDirectory,task.config.imageFiles]] as const) {
      if(files)for(const file of files)selectedFiles.add(resolve(file));
      else selectedDirectories.add(resolve(directory));
    }
    grantMedia(task.posts);
  }
  for(const draft of drafts.values())grantMedia(draft.posts);
}
function checkDirectories(config:TaskConfig):void {
  for(const [directory,files] of [[config.textDirectory,config.textFiles],[config.imageDirectory,config.imageFiles]] as const) {
    if(files) {
      if(files.some(file=>!selectedFiles.has(resolve(file))))throw new Error('请通过“选择文件”重新选择本机素材。');
    } else if(!selectedDirectories.has(resolve(directory)))throw new Error('请通过“选择文件夹”重新绑定本机目录。');
  }
}
function commonDirectory(files:string[]):string {
  let root=dirname(files[0]);
  for(const file of files) {
    while(true) {
      const subpath=relative(root,file);
      if(subpath&&!isAbsolute(subpath)&&subpath!=='..'&&!subpath.startsWith('..\\')&&!subpath.startsWith('../'))break;
      const parent=dirname(root);if(parent===root)throw new Error('请选择同一磁盘中的素材文件。');root=parent;
    }
  }
  return root;
}
function requireAccount(id:string) {const account=store.getAccount(uuid.parse(id));if(!account)throw new Error('账号不存在。');return account;}
function saveAccountCheck(id:string,result:AccountCheck):AccountCheck {
  const latest=store.getAccount(id);
  if(!latest)return {status:'unverified',message:'账号已移除，本次检查结果已忽略。'};
  const mismatch=latest.platformUserId && result.platformUserId && latest.platformUserId!==result.platformUserId;
  const checked:AccountCheck=mismatch
    ? {status:'expired',message:'检测到当前登录账号与已绑定账号不一致。请切回原账号，或添加新的账号配置。'}
    : result;
  const platformUserId=latest.platformUserId??(checked.status==='ready'?checked.platformUserId:undefined);
  if(latest.status!==checked.status||latest.platformUserId!==platformUserId) {
    store.saveAccount({...latest,status:checked.status,platformUserId});changed();
  }
  return checked;
}
function handler(key:keyof typeof CHANNELS,action:(...args:any[])=>unknown):void {
  ipcMain.handle(CHANNELS[key],async(event,...args)=>{
    if(!window || event.sender!==window.webContents || event.senderFrame!==window.webContents.mainFrame)throw new Error('不允许此窗口调用本地功能。');
    try{return await action(...args);}
    catch(error) {
      if(error instanceof z.ZodError)throw new Error(error.issues.slice(0,8).map(issue=>issue.message).join('；'));
      throw new Error(error instanceof Error?error.message:'操作未完成，请重试。');
    }
  });
}

function createWindow():void {
  window=new BrowserWindow({width:1320,height:900,minWidth:900,minHeight:640,title:'图文发布助手',backgroundColor:'#f5f7fa',show:false,
    icon:resolve(app.getAppPath(),'assets/brand/app-icon.png'),
    titleBarStyle:process.platform==='darwin'?'hiddenInset':'hidden',
    ...(process.platform==='darwin'?{trafficLightPosition:{x:16,y:15}}:{titleBarOverlay:{color:'#f9fbff',symbolColor:'#556076',height:44}}),
    webPreferences:{preload:resolve(currentDir,'../preload/index.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.once('ready-to-show',()=>window?.show());
  window.on('close',event=>{if(!quitConfirmed){event.preventDefault();app.quit();}});
  window.on('closed',()=>{window=undefined;});
  if(process.env.ELECTRON_RENDERER_URL)void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(resolve(currentDir,'../../dist/index.html'));
}

async function initialize():Promise<void> {
  dataDirectory=process.env.ITP_DATA_DIR?resolve(process.env.ITP_DATA_DIR):app.getPath('userData');
  await mkdir(dataDirectory,{recursive:true});
  store=new Store(resolve(dataDirectory,'workspace.db'));
  store.recover(Date.now());
  sessions=new AccountSessionManager();
  sessions.setOnAccountCheck((account,result)=>{saveAccountCheck(account.id,result);});
  const adapter=createDouyinAdapter(sessions,createCreatorBridge());
  scheduler=new Scheduler(store,adapter,changed,async task=>validateBatchFiles(task));
  rebuildGrants();
  protocol.handle('media',async request=>{
    try {
      const url=new URL(request.url);const location=url.searchParams.get('path');
      if(url.hostname!=='asset'||!location||!allowedMedia.has(resolve(location)))return new Response('Not allowed',{status:403});
      return await net.fetch(pathToFileURL(resolve(location)).href);
    } catch {return new Response('Missing image',{status:404});}
  });
  handler('snapshot',()=>({accounts:store.accounts(),tasks:store.tasks(),dataDirectory,adapter:{...adapter.capability}}));
  handler('addAccount',(name:string)=>{const account=store.addAccount(nameSchema.parse(name));changed();return account;});
  handler('renameAccount',(id:string,name:string)=>{const account=requireAccount(id);account.name=nameSchema.parse(name);store.saveAccount(account);changed();return account;});
  handler('removeAccount',async(id:string)=>{const account=requireAccount(id);store.removeAccount(account.id);await sessions.remove(account.id);changed();});
  handler('openAccount',async(id:string)=>{await sessions.open(requireAccount(id));});
  handler('checkAccount',async(id:string)=>{
    const account=requireAccount(id);const result=saveAccountCheck(account.id,await sessions.check(account));
    const updated=store.getAccount(account.id);
    const capability=updated?await adapter.probe(updated):undefined;
    changed();return result.status==='ready'&&capability?{...result,message:`登录身份已核实。${capability.description}`} : result;
  });
  handler('selectDirectory',async()=>{
    const result=await dialog.showOpenDialog(window!,{title:'选择本机素材文件夹',properties:['openDirectory']});
    if(result.canceled||!result.filePaths[0])return null;
    const directory=resolve(result.filePaths[0]);selectedDirectories.add(directory);return directory;
  });
  handler('selectMaterials',async(kind:unknown,mode:unknown)=>{
    const materialKind=z.enum(['text','image']).parse(kind),selectionMode=z.enum(['folder','files']).parse(mode);
    const result=await dialog.showOpenDialog(window!,{
      title:`选择${materialKind==='text'?'文案':'图片'}${selectionMode==='folder'?'文件夹':'文件（可多选）'}`,
      properties:selectionMode==='folder'?['openDirectory']:['openFile','multiSelections'],
      ...(selectionMode==='files'?{filters:[{name:materialKind==='text'?'文案文件':'图片文件',extensions:materialKind==='text'?['txt','md','text']:['jpg','jpeg','png','webp']}]}:{}),
    });
    if(result.canceled||!result.filePaths.length)return null;
    const files=selectionMode==='files'?[...new Set(result.filePaths.map(file=>resolve(file)))]:undefined;
    const directory=files?commonDirectory(files):resolve(result.filePaths[0]);
    const scanned=await scanMaterialSource(materialKind,directory,files);
    if(files)for(const file of files)selectedFiles.add(file);
    else selectedDirectories.add(directory);
    return {directory,files,...scanned};
  });
  handler('scan',async(input:unknown)=>{const config=validateConfig(input);requireAccount(config.accountId);checkDirectories(config);return scanDirectories(config);});
  handler('prepare',async(input:unknown)=>{
    const config=validateConfig(input);requireAccount(config.accountId);checkDirectories(config);
    const prepared=await prepareBatch(config);
    drafts.set(prepared.id,prepared);while(drafts.size>20)drafts.delete(drafts.keys().next().value!);rebuildGrants();return prepared;
  });
  handler('createTask',async(id:string)=>{
    const prepared=drafts.get(uuid.parse(id));if(!prepared)throw new Error('预览已过期，请重新生成。');
    requireAccount(prepared.config.accountId);
    const valid=await validateBatchFiles(prepared);if(!valid.ok)throw new Error('预览后素材已变化：'+valid.invalidFiles.join('；'));
    const task:PublishTask={...prepared,status:'draft',updatedAt:new Date().toISOString()};store.saveTask(task);drafts.delete(id);rebuildGrants();changed();return task;
  });
  handler('startTask',(id:string)=>scheduler.start(uuid.parse(id)));
  handler('pauseTask',(id:string)=>scheduler.pause(uuid.parse(id)));
  handler('cancelTask',(id:string)=>scheduler.cancel(uuid.parse(id)));
  handler('retryTask',(id:string)=>scheduler.retry(uuid.parse(id)));
  handler('resolvePost',(taskId:string,postId:string,resolution:unknown)=>scheduler.resolve(uuid.parse(taskId),uuid.parse(postId),z.enum(['submitted','not_published']).parse(resolution)));
  handler('rebindTask',async(id:string,textDirectory:string,imageDirectory:string)=>{
    const task=store.getTask(uuid.parse(id));if(!task)throw new Error('任务不存在。');
    if(scheduler.isBusy()||['scheduled','running'].includes(task.status))throw new Error('请暂停并等待当前发布结束后再绑定目录。');
    if(!selectedDirectories.has(resolve(textDirectory))||!selectedDirectories.has(resolve(imageDirectory)))throw new Error('请通过“选择文件夹”绑定本机目录。');
    const config={...task.config,textDirectory,imageDirectory,
      textFiles:task.config.textFiles?.map(file=>relocateMaterialPath(file,task.config.textDirectory,textDirectory)),
      imageFiles:task.config.imageFiles?.map(file=>relocateMaterialPath(file,task.config.imageDirectory,imageDirectory))};
    validateConfig(config);
    const posts=await rebindPreparedPosts(task.posts,task.config.textDirectory,task.config.imageDirectory,textDirectory,imageDirectory);
    const latest=store.getTask(id)!;if(['scheduled','running'].includes(latest.status))throw new Error('任务已开始，请先暂停。');
    latest.posts=posts;latest.config=config;latest.needsRebind=false;latest.updatedAt=new Date().toISOString();latest.pauseReason='本机目录已核对绑定，请登录账号并检查后继续。';store.saveTask(latest);rebuildGrants();changed();return {ok:true,message:'目录已绑定，文案和图片与原预览一致。'};
  });
  handler('exportData',async(kind:unknown)=>{
    const selected=z.enum(['config','backup']).parse(kind);
    const result=await dialog.showSaveDialog(window!,{title:selected==='config'?'导出任务配置':'备份任务和发布记录',defaultPath:`图文助手-${selected}-${new Date().toISOString().slice(0,10)}.json`,filters:[{name:'图文助手数据',extensions:['json']}]});
    if(result.canceled||!result.filePath)return false;
    const temp=result.filePath+'.writing';await writeFile(temp,JSON.stringify(store.exportData(selected),null,2),'utf8');await rename(temp,result.filePath);return true;
  });
  handler('importData',async()=>{
    if(scheduler.isBusy())throw new Error('请等待当前发布结束后再导入。');
    const result=await dialog.showOpenDialog(window!,{title:'导入配置或任务备份',properties:['openFile'],filters:[{name:'图文助手数据',extensions:['json']}]});
    if(result.canceled||!result.filePaths[0])return null;
    const path=result.filePaths[0];if((await stat(path)).size>32*1024*1024)throw new Error('导入文件超过 32 MB，请拆分任务备份。');
    let data:unknown;try{data=JSON.parse(await readFile(path,'utf8'));}catch{throw new Error('文件不是有效的 JSON 配置或备份。');}
    const validated=migrationSchema.parse(data);
    const currentAccounts=store.accounts(),currentTasks=store.tasks();
    const collision=validated.accounts.some(a=>store.getAccount(a.id))||validated.tasks.some(t=>store.getTask(t.id));
    let replace=false;
    if(collision) {
      if(currentTasks.some(t=>['scheduled','running'].includes(t.status)))throw new Error('请先暂停所有排期和执行中的任务，再迁移工作空间。');
      const confirmation=await dialog.showMessageBox(window!,{type:'warning',title:'切换到导入的工作空间？',message:`导入文件与当前账号或任务有重复标识。`,detail:`将用文件中的 ${validated.accounts.length} 个账号、${validated.tasks.length} 个任务替换当前的 ${currentAccounts.length} 个账号、${currentTasks.length} 个任务。替换前会自动备份当前工作空间；素材文件和本机登录环境保留。导入后需要重新绑定目录，任务不会自动开始。`,buttons:['取消','备份并替换'],defaultId:0,cancelId:0});
      if(confirmation.response!==1)return null;
      if(scheduler.isBusy()||store.tasks().some(t=>['scheduled','running'].includes(t.status)))throw new Error('任务状态已变化，请先暂停再导入。');
      const backupDirectory=resolve(dataDirectory,'migration-backups');await mkdir(backupDirectory,{recursive:true});
      await writeFile(resolve(backupDirectory,`before-import-${Date.now()}.json`),JSON.stringify(store.exportData('backup'),null,2),{encoding:'utf8',flag:'wx'});
      replace=true;
    }
    const imported=store.importData(validated,{replace});
    if(replace)sessions.closeAll();
    drafts.clear();selectedDirectories.clear();selectedFiles.clear();rebuildGrants();changed();return imported;
  });
  handler('revealDataDirectory',async()=>{const error=await shell.openPath(dataDirectory);if(error)throw new Error(error);});
  app.on('activate',()=>{if(!window)createWindow();else window.show();});
  powerMonitor.on('suspend',()=>scheduler.suspend());
  powerMonitor.on('resume',()=>scheduler.suspend());
  // macOS keeps its system-level Edit roles for standard keyboard shortcuts.
  // Windows/Linux have no application menu row or production reload/devtools entries.
  Menu.setApplicationMenu(process.platform==='darwin'?Menu.buildFromTemplate([
    {label:app.name,submenu:[{role:'about'},{type:'separator'},{role:'quit'}]},
    {label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
  ]):null);
  createWindow();scheduler.run();
}

if(!app.requestSingleInstanceLock())app.quit();
else {
  app.on('second-instance',()=>{window?.show();window?.focus();});
  void app.whenReady().then(initialize).catch(error=>{dialog.showErrorBox('启动未完成',error instanceof Error?error.message:String(error));app.quit();});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{
    if(quitConfirmed||!store)return;
    if(scheduler?.isBusy()||store.tasks().some(t=>['scheduled','running'].includes(t.status))) {
      const choice=dialog.showMessageBoxSync({type:'warning',title:'退出图文发布助手？',message:'退出后定时任务不会执行。',detail:scheduler?.isBusy()?'当前图文仍在处理，退出可能需要核对提交结果。':'任务记录会保留，重新打开后请检查错过的任务。',buttons:['继续运行','退出'],defaultId:0,cancelId:0});
      if(choice===0){event.preventDefault();return;}
    }
    quitConfirmed=true;scheduler?.stop();sessions?.closeAll();
  });
  app.on('will-quit',()=>store?.close());
}
