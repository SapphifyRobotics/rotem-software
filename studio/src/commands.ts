export class Commands {
 private pending: {match:(s:string)=>boolean;resolve:(s:string)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}|null=null;
 constructor(private send:(s:string)=>Promise<void>){}
 accept(line:string){const p=this.pending;if(!p)return;if(line.startsWith('ERR ')||p.match(line)){clearTimeout(p.timer);this.pending=null;line.startsWith('ERR ')?p.reject(new Error(line)):p.resolve(line)}}
 cancel(){if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(new Error('Device disconnected'));this.pending=null}}
 async request(command:string,match:(s:string)=>boolean,timeout=2500):Promise<string>{
  if(this.pending)throw new Error('Another command is waiting for a reply');
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending=null;reject(new Error('No acknowledgement from the board'))},timeout);this.pending={resolve,reject,match,timer};this.send(command).catch(e=>{clearTimeout(timer);this.pending=null;reject(e)})});
 }
}
