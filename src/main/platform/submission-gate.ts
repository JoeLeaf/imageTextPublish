import {randomUUID} from 'node:crypto';

export const CREATE_PATH='/web/api/media/aweme/create/';
export const CREATE_PATHS=[CREATE_PATH,'/web/api/media/aweme/create_v2/'];
export const PROBE_PARAM='_itp_probe';
export const SUBMIT_PARAM='_itp_submit';
type Ticket={kind:'probe'|'submit';attempts:number;sent:number;signed:boolean};

/** The site's fetch wrapper can retry failed requests. Permit one final dispatch only. */
export class SubmissionGate {
  private readonly tickets=new Map<string,Ticket>();
  issue(kind:Ticket['kind']):string {const id=randomUUID();this.tickets.set(id,{kind,attempts:0,sent:0,signed:false});return id;}
  inspect(url:string,method:string):boolean {
    const parsed=new URL(url);
    if(parsed.origin!=='https://creator.douyin.com'||!CREATE_PATHS.includes(parsed.pathname))return false;
    const probe=parsed.searchParams.get(PROBE_PARAM),submit=parsed.searchParams.get(SUBMIT_PARAM);
    if(!probe&&!submit)return true;
    const ticket=this.tickets.get(probe??submit!);
    if(!ticket||probe&&submit||method!=='POST'||ticket.kind!==(probe?'probe':'submit'))return true;
    ticket.attempts++;
    const signed=!!parsed.searchParams.get('a_bogus')&&!!parsed.searchParams.get('msToken');
    ticket.signed ||= signed;
    if(ticket.kind==='probe'||!signed||ticket.sent>0)return true;
    ticket.sent++;
    return false;
  }
  finish(id:string):Readonly<Ticket>|undefined {const ticket=this.tickets.get(id);this.tickets.delete(id);return ticket?{...ticket}:undefined;}
  clear():void {this.tickets.clear();}
}
