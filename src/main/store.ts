import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname,posix,win32} from 'node:path';
import {z} from 'zod';
import type {Account, PublishTask, PreparedPost, ImportResult} from '../shared/types';

const date=z.string().refine(v=>Number.isFinite(Date.parse(v)),'无效日期');
const id=z.string().uuid();
const accountSchema=z.object({id,name:z.string().trim().min(1).max(80),status:z.enum(['unverified','ready','expired']),platform:z.literal('douyin'),createdAt:date,platformUserId:z.string().max(200).optional()}).strict();
// Backups can carry Windows or POSIX file paths; local readability is checked on rebinding.
const sourceFile=z.string().min(1).max(4096).refine(value=>!value.includes('\0')&&(win32.isAbsolute(value)||posix.isAbsolute(value)),'无效素材文件路径');
const sourceFiles=z.array(sourceFile).max(10000).optional();
const configSchema=z.object({name:z.string().min(1).max(120),accountId:id,textDirectory:z.string().min(1).max(4096),imageDirectory:z.string().min(1).max(4096),textFiles:sourceFiles,imageFiles:sourceFiles,postCount:z.number().int().min(1).max(1000),imagesPerPost:z.number().int().min(1).max(35),intervalMinutes:z.number().int().min(1).max(525600),startAt:date,timezone:z.literal('Asia/Shanghai'),reuseImages:z.boolean(),titleMode:z.enum(['none','filename']),visibility:z.enum(['public','private'])}).strict();
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const media=z.object({id,path:z.string().max(4096),filename:z.string().max(500),sha256:hash,width:z.number().int().positive(),height:z.number().int().positive(),mime:z.string().max(100)}).strict();
const postSchema=z.object({id,textPath:z.string().max(4096),textFilename:z.string().max(500),textHash:hash,caption:z.string().max(100000),title:z.string().max(500),images:z.array(media).min(1).max(35),status:z.enum(['pending','uploading','submitting','submitted','failed','uncertain']),scheduledAt:date,submittedAt:date.optional(),platformPostId:z.string().max(500).optional(),platformUrl:z.string().max(2000).optional(),error:z.string().max(5000).optional()}).strict();
const taskSchema=z.object({id,config:configSchema,posts:z.array(postSchema).min(1).max(1000),createdAt:date,warnings:z.array(z.string().max(5000)).max(1000),status:z.enum(['draft','scheduled','running','paused','completed','needs_attention','cancelled']),updatedAt:date,pauseReason:z.string().max(5000).optional(),needsRebind:z.boolean().optional()}).strict();
export const migrationSchema=z.object({format:z.literal('image-text-publish'),version:z.literal(1),kind:z.enum(['config','backup']),exportedAt:date,accounts:z.array(accountSchema).max(500),tasks:z.array(taskSchema).max(5000)}).strict();
export type MigrationData=z.infer<typeof migrationSchema>;

export interface TaskRepository {
  tasks():PublishTask[];
  getTask(id:string):PublishTask|undefined;
  saveTask(task:PublishTask):void;
  getAccount(id:string):Account|undefined;
}

export class Store implements TaskRepository {
  private db:Database.Database;
  constructor(path:string) {
    mkdirSync(dirname(path),{recursive:true});
    this.db=new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    this.db.prepare('INSERT OR IGNORE INTO meta (key,value) VALUES (?,?)').run('schemaVersion','1');
  }
  accounts():Account[] {return (this.db.prepare('SELECT data FROM accounts ORDER BY rowid').all() as {data:string}[]).map(r=>accountSchema.parse(JSON.parse(r.data)));}
  tasks():PublishTask[] {return (this.db.prepare('SELECT data FROM tasks ORDER BY rowid DESC').all() as {data:string}[]).map(r=>taskSchema.parse(JSON.parse(r.data)));}
  getAccount(accountId:string):Account|undefined {const row=this.db.prepare('SELECT data FROM accounts WHERE id=?').get(accountId) as {data:string}|undefined;return row?accountSchema.parse(JSON.parse(row.data)):undefined;}
  getTask(taskId:string):PublishTask|undefined {const row=this.db.prepare('SELECT data FROM tasks WHERE id=?').get(taskId) as {data:string}|undefined;return row?taskSchema.parse(JSON.parse(row.data)):undefined;}
  saveAccount(account:Account):void {const valid=accountSchema.parse(account);this.db.prepare('INSERT INTO accounts(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(valid.id,JSON.stringify(valid));}
  addAccount(name:string):Account {const account:Account={id:randomUUID(),name:name.trim(),platform:'douyin',status:'unverified',createdAt:new Date().toISOString()};this.saveAccount(account);return account;}
  removeAccount(accountId:string):void {
    if(this.tasks().some(t=>t.config.accountId===accountId)) throw new Error('该账号已有任务或发布历史，为保留迁移和核对记录暂不能删除；可以改名或添加新账号。');
    this.db.prepare('DELETE FROM accounts WHERE id=?').run(accountId);
  }
  saveTask(task:PublishTask):void {const valid=taskSchema.parse(task);this.db.prepare('INSERT INTO tasks(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(valid.id,JSON.stringify(valid));}
  reservedHashes(accountId:string,excludeTaskId?:string):Set<string> {
    const hashes=new Set<string>();
    for(const task of this.tasks()) if(task.config.accountId===accountId && task.id!==excludeTaskId) for(const post of task.posts) {
      if(post.status==='submitted'||post.status==='uncertain'||task.status!=='cancelled') hashes.add(post.textHash);
    }
    return hashes;
  }
  recover(now:number):void {
    for(const task of this.tasks()) {
      let changed=false;
      for(const post of task.posts) if(post.status==='submitting'||post.status==='uploading') {
        post.status=post.status==='submitting'?'uncertain':'failed';
        post.error=post.status==='uncertain'?'程序在最终提交过程中中断，请先核对抖音作品记录。':'程序在上传阶段中断，内容已保留。';changed=true;
      }
      if(task.status==='running'||(task.status==='scheduled'&&task.posts.some(p=>p.status==='pending'&&Date.parse(p.scheduledAt)<=now))) {
        task.status=task.posts.some(p=>p.status==='uncertain')?'needs_attention':'paused';task.pauseReason='程序已重启；请检查剩余内容后继续，系统不会追发错过的任务。';changed=true;
      }
      if(changed) {task.updatedAt=new Date(now).toISOString();this.saveTask(task);}
    }
  }
  exportData(kind:'config'|'backup'):MigrationData {
    const tasks=this.tasks().map(task=>kind==='backup'?task:{...task,status:'cancelled' as const,pauseReason:'导入的任务模板，请复制为新任务并重新选择素材目录。',posts:task.posts.map(post=>({...post,status:'pending' as const,submittedAt:undefined,platformPostId:undefined,platformUrl:undefined,error:undefined}))});
    return {format:'image-text-publish',version:1,kind,exportedAt:new Date().toISOString(),accounts:this.accounts().map(a=>({...a,status:'unverified' as const})),tasks};
  }
  importData(input:unknown,options?:{replace?:boolean}):ImportResult {
    const data=migrationSchema.parse(input);
    if(new Set(data.accounts.map(a=>a.id)).size!==data.accounts.length||new Set(data.tasks.map(t=>t.id)).size!==data.tasks.length) throw new Error('导入文件包含重复标识。');
    const ids=new Set(data.accounts.map(a=>a.id));
    if(data.tasks.some(t=>!ids.has(t.config.accountId))) throw new Error('导入文件有任务缺少对应账号。');
    const existing=this.tasks();
    if(existing.some(t=>['scheduled','running'].includes(t.status))) throw new Error('请先暂停正在执行或等待执行的任务，再导入数据。');
    if(!options?.replace&&(data.accounts.some(a=>this.getAccount(a.id))||data.tasks.some(t=>this.getTask(t.id)))) throw new Error('该数据已经存在。为避免覆盖发布记录，请导入到空数据目录或使用新的任务配置。');
    this.db.transaction(()=>{
      if(options?.replace) {
        // Replace only workspace data; preserve the database schema and its version marker.
        this.db.exec('DELETE FROM tasks; DELETE FROM accounts; DELETE FROM meta;');
        this.db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run('schemaVersion','1');
      }
      for(const account of data.accounts) this.saveAccount({...account,status:'unverified'});
      for(const original of data.tasks) {
        const task:PublishTask=structuredClone(original);
        for(const post of task.posts) {
          if(post.status==='submitting') {post.status='uncertain';post.error='迁移前提交结果不确定，请核对后处理。';}
          if(post.status==='uploading') {post.status='failed';post.error='迁移前上传已中断。';}
        }
        // Imported paths are hints only; even on the same OS a rebind is required.
        if(!['completed','cancelled'].includes(task.status)) {
          task.status=task.posts.some(p=>p.status==='uncertain')?'needs_attention':'paused';
          task.pauseReason=data.kind==='config'?'配置模板已导入，请重新绑定目录并复制为新任务。':'数据已导入，请重新绑定目录和登录，确认后继续。';
        }
        task.needsRebind=true;task.updatedAt=new Date().toISOString();
        this.saveTask(task);
      }
    })();
    return {accounts:data.accounts.length,tasks:data.tasks.length,needsRebind:data.tasks.filter(t=>!['completed','cancelled'].includes(t.status)).length};
  }
  close():void {this.db.close();}
}

export function mutatePost(task:PublishTask,postId:string,update:Partial<PreparedPost>):void {
  const post=task.posts.find(p=>p.id===postId);if(!post) throw new Error('未找到图文。');Object.assign(post,update);
}
