export type AccountStatus = 'unverified' | 'ready' | 'expired';
export interface Account {id:string; name:string; status:AccountStatus; platform:'douyin'; createdAt:string; platformUserId?:string}
export interface TaskConfig {
  name:string; accountId:string; textDirectory:string; imageDirectory:string;
  textFiles?:string[]; imageFiles?:string[];
  postCount:number; imagesPerPost:number; intervalMinutes:number;
  startAt:string; timezone:'Asia/Shanghai'; reuseImages:boolean;
  titleMode:'none'|'filename'; visibility:'public'|'private';
}
export type PostStatus = 'pending'|'uploading'|'submitting'|'submitted'|'failed'|'uncertain';
export type TaskStatus = 'draft'|'scheduled'|'running'|'paused'|'completed'|'needs_attention'|'cancelled';
export interface MediaFile {id:string; path:string; filename:string; sha256:string; width:number; height:number; mime:string}
export interface PreparedPost {
  id:string; textPath:string; textFilename:string; textHash:string; caption:string;
  title:string; images:MediaFile[]; status:PostStatus; scheduledAt:string;
  submittedAt?:string; platformPostId?:string; platformUrl?:string; error?:string;
}
export interface PreparedBatch {id:string; config:TaskConfig; posts:PreparedPost[]; createdAt:string; warnings:string[]}
export interface PublishTask extends PreparedBatch {status:TaskStatus; updatedAt:string; pauseReason?:string; needsRebind?:boolean}
export interface ScanResult {textCount:number; imageCount:number; invalidFiles:string[]; textFiles:string[]; imageFiles:string[]}
export interface MaterialSelection {directory:string; files?:string[]; count:number; invalidFiles:string[]}
export interface AppSnapshot {accounts:Account[]; tasks:PublishTask[]; dataDirectory:string; adapter:AdapterCapability}
export interface AdapterCapability {mode:'browser-protocol'; available:boolean; description:string}
export interface OperationResult {ok:boolean; message:string}
export interface ImportResult {accounts:number; tasks:number; needsRebind:number}
export interface PublishResult {kind:'submitted'|'failed'|'uncertain'; message?:string; postId?:string; url?:string}
export interface PublishAdapter {
  capability:AdapterCapability;
  probe?(account:Account):Promise<AdapterCapability>;
  publish(account:Account, post:PreparedPost, config:TaskConfig, onSubmitting:()=>void, signal?:AbortSignal):Promise<PublishResult>;
}
export interface AccountCheck {status:AccountStatus; message:string; platformUserId?:string}
export interface DesktopApi {
  snapshot():Promise<AppSnapshot>;
  addAccount(name:string):Promise<Account>;
  renameAccount(id:string,name:string):Promise<Account>;
  removeAccount(id:string):Promise<void>;
  openAccount(id:string):Promise<void>;
  checkAccount(id:string):Promise<AccountCheck>;
  selectDirectory():Promise<string|null>;
  selectMaterials(kind:'text'|'image',mode:'folder'|'files'):Promise<MaterialSelection|null>;
  scan(config:TaskConfig):Promise<ScanResult>;
  prepare(config:TaskConfig):Promise<PreparedBatch>;
  createTask(batchId:string):Promise<PublishTask>;
  startTask(id:string):Promise<OperationResult>;
  pauseTask(id:string):Promise<OperationResult>;
  cancelTask(id:string):Promise<OperationResult>;
  retryTask(id:string):Promise<OperationResult>;
  resolvePost(taskId:string,postId:string,resolution:'submitted'|'not_published'):Promise<OperationResult>;
  rebindTask(id:string,textDirectory:string,imageDirectory:string):Promise<OperationResult>;
  exportData(kind:'config'|'backup'):Promise<boolean>;
  importData():Promise<ImportResult|null>;
  revealDataDirectory():Promise<void>;
  mediaUrl(path:string):string;
  onChanged(listener:()=>void):()=>void;
}
