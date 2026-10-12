import {contextBridge,ipcRenderer} from 'electron';
import {CHANNELS} from '../shared/channels';
import type {DesktopApi} from '../shared/types';
const invoke=(name:keyof typeof CHANNELS,...args:unknown[])=>ipcRenderer.invoke(CHANNELS[name],...args);
const api:DesktopApi={
  snapshot:()=>invoke('snapshot'),addAccount:name=>invoke('addAccount',name),renameAccount:(id,name)=>invoke('renameAccount',id,name),removeAccount:id=>invoke('removeAccount',id),
  openAccount:id=>invoke('openAccount',id),checkAccount:id=>invoke('checkAccount',id),selectDirectory:()=>invoke('selectDirectory'),scan:config=>invoke('scan',config),prepare:config=>invoke('prepare',config),
  selectMaterials:(kind,mode)=>invoke('selectMaterials',kind,mode),
  createTask:id=>invoke('createTask',id),startTask:id=>invoke('startTask',id),pauseTask:id=>invoke('pauseTask',id),cancelTask:id=>invoke('cancelTask',id),retryTask:id=>invoke('retryTask',id),
  resolvePost:(taskId,postId,resolution)=>invoke('resolvePost',taskId,postId,resolution),rebindTask:(id,textDirectory,imageDirectory)=>invoke('rebindTask',id,textDirectory,imageDirectory),
  exportData:kind=>invoke('exportData',kind),importData:()=>invoke('importData'),revealDataDirectory:()=>invoke('revealDataDirectory'),
  mediaUrl:path=>'media://asset/?path='+encodeURIComponent(path),
  onChanged:listener=>{const wrapped=()=>listener();ipcRenderer.on(CHANNELS.changed,wrapped);return ()=>ipcRenderer.removeListener(CHANNELS.changed,wrapped);}
};
contextBridge.exposeInMainWorld('desktop',api);
