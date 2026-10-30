// ============ Material Web component library (local vendor, zero external deps) ============
// Note: this bundle fully inlines lit with no bare module references, so browsers can load it directly.
const MW_OK = await import('/auth/vendor/mw-v2.js').then(()=>true).catch(e=>{
  console.error('[MW] 组件库加载失败:', e); return false;
});

// ============ Feature detection: Form Association / dialog are hard dependencies of Material Web form components ============
(function detectCompat(){
  const miss=[];
  if(!('attachInternals' in HTMLElement.prototype)) miss.push('Element Internals');
  else if(typeof ElementInternals!=='undefined' && !('setFormValue' in ElementInternals.prototype)) miss.push('Form Association');
  if(!('showModal' in HTMLDialogElement.prototype)) miss.push('<dialog>');
  if(!customElements.get('md-filled-button')) miss.push('组件库未加载');
  if(miss.length){
    const b=document.getElementById('compatBar');
    b.textContent='⚠ 当前浏览器缺少 '+miss.join(' / ')+'，按钮/选择框/输入框可能失效。请用 Chrome 90+ / Edge 90+ / Safari 16.4+ / Firefox 143+ 打开。';
    b.classList.add('show');
  }
})();

// ============ Tools ============
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const escAttr = s => esc(s).replace(/\s/g,' ');
const fmtNum = n => n?.toLocaleString?.() ?? '-';
const fmtDur = s => { if(!s||s<0)return '-'; const h=Math.floor(s/3600),m=Math.floor(s%3600/60); return h?`${h}h${m}m`:`${m}m`; };
//// abbreviated Base URL: strip the scheme and trailing /v1 to fit ~40% more useful info at the same width; the full value goes in title
const fmtHost = u => String(u||'-')
  .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  .replace(/\/+$/, '')
  .replace(/\/v1\d*$/i, '');

function snack(msg, isErr=false){
  const el=$('#snackbar'); el.textContent=msg;
  el.classList.toggle('err', !!isErr); el.classList.add('show');
  clearTimeout(el._t);
  el._t=setTimeout(()=>el.classList.remove('show'), isErr?4000:2000);
}

// ============ Data adapter layer (contract identical to the hand-written version) ============
class BaseAdapter{
  async _fetch(url, opts={}, signal){
    if(!Store.online) throw new Error('网络已断开');
    let res;
    try{ res = await fetch(url, {...opts, signal}); }
    catch(e){ if(e.name==='AbortError') throw e;
      throw new Error('无法连接到 ' + url.split('/admin/api/')[0] + ' (实例可能未运行或正在重启中)'); }
if(res.status===401) openKeyDialog(); // missing/wrong password: open the input dialog
    if(!res.ok){
// Best-effort parse {error:{message}} / {error:"..."} into readable text (balance failures must show why)
      let msg='';
      try{
        const t=await res.text();
        try{ const j=JSON.parse(t); msg=(j&&j.error&&(j.error.message||j.error))||(j&&j.message)||t; }catch(_){ msg=t; }
      }catch(_){}
      throw new Error(msg || `HTTP ${res.status}`);
    }
    const ct = res.headers.get('content-type')||'';
    return ct.includes('json') ? res.json() : res.text();
  }
}
class MockAdapter extends BaseAdapter{
  constructor(){ super();
    this._insts=[
      {name:'default',port:16384,running:true,tlsOn:false,chCount:3},
      {name:'free-deepseek',port:16388,running:true,tlsOn:true,chCount:5},
      {name:'nvidia',port:16386,running:false,tlsOn:false,chCount:1},
    ];
    this._chs={ default:[
        {name:'deepseek-official',type:'openai',baseUrl:'https://api.deepseek.com/v1',proxy:'-',models:['deepseek-chat','deepseek-reasoner'],default:true,apiKey:'sk-mock-xxxx',hasKey:true},
        {name:'local-minicpm',type:'openai',baseUrl:'http://127.0.0.1:8080/v1',proxy:'-',models:['minicpm5-1b'],apiKey:'',hasKey:false},
      ], 'free-deepseek':[
        {name:'pool-a',type:'openai',baseUrl:'https://api.example-provider-a.com/v1',proxy:'clash',models:['deepseek-chat'],default:true,delayMs:800,hasKey:true},
        {name:'pool-b',type:'claude',baseUrl:'https://api.anthropic.com/v1',proxy:'clash',models:['claude-sonnet-4-5'],hasKey:true},
        {name:'pool-c',type:'gemini',baseUrl:'https://generativelanguage.googleapis.com/v1beta',proxy:'-',models:['gemini-2.5-pro'],hasKey:true},
      ], nvidia:[
        {name:'nvidia-k3-a',type:'openai',baseUrl:'https://integrate.api.nvidia.com',proxy:'-',models:['kimi-k3'],hasKey:true},
      ]};
    this._stats={ default:{requests:1287,errors:14,uptime:3600*5.2,byChannel:{'deepseek-official':{requests:1102,inputTokens:845210,outputTokens:233100},'local-minicpm':{requests:185,inputTokens:42100,outputTokens:18900}}},
      'free-deepseek':{requests:4412,errors:88,uptime:3600*11.4,byChannel:{'pool-a':{requests:2001,inputTokens:1234567,outputTokens:345678},'pool-b':{requests:1400,inputTokens:998877,outputTokens:221100},'pool-c':{requests:1011,inputTokens:554433,outputTokens:120011}}},
      nvidia:{requests:0,errors:0,uptime:0,byChannel:{}} };
    this._pxs={};
  }
  async getInstances(){ return {instances:this._insts.map(i=>({...i})), current:'default'}; }
  async getConfig(name){ return {name, port:this._insts.find(i=>i.name===name)?.port||16384,
    gatewayKey:'', webToken:'(已设)', channels:(this._chs[name]||[]).map(c=>({...c})),
    proxies:this._pxs[name]||{},
    record:(this._rec&&this._rec[name])||{enable:false,server:''},
    routing:{maxRetry:3,timeoutSec:60,cooldownSec:30}}; }
  async saveConfig(name,patch){ if(patch&&patch.proxies) this._pxs[name]=patch.proxies; if(patch&&patch.record){ this._rec=this._rec||{}; this._rec[name]=patch.record; } return {ok:true,patch}; }
  async getRecordBody(name,id){ return {ok:true,record:{id,time:'2026-08-29 09:41:22',model:'deepseek-chat',channel:'pool-a',status:200,duration:1840,inputTokens:128,outputTokens:64,request:{model:'deepseek-chat',messages:[{role:'user',content:'你好'}]},response:'data: {"choices":[{"delta":{"content":"你好!"}}]}\n\ndata: [DONE]\n'}}; }
  async createInstance(name,body){ this._insts.push({name,port:body.port,running:false,chCount:0,tlsOn:!!(body.tls&&body.tls.enable)}); return {ok:true}; }
  async saveChannel(inst,ch){ const a=this._chs[inst]||(this._chs[inst]=[]);
    const i=a.findIndex(c=>c.name===ch.name); if(i>=0)a[i]=ch; else a.push(ch); return {ok:true}; }
  async deleteChannel(inst,chName){ this._chs[inst]=(this._chs[inst]||[]).filter(c=>c.name!==chName); return {ok:true}; }
  async deleteInstance(name){ this._insts=this._insts.filter(x=>x.name!==name); return {ok:true}; }
  async renameInstance(name,newName){ const i=this._insts.find(x=>x.name===name); if(i)i.name=newName; return {ok:true,hotReload:true,name:newName}; }
  async fetchModels(inst,body){ return {models:['mock-model-alpha','mock-model-beta','mock-model-gamma']}; }
  async syncModels(inst){ return {ok:true,instance:inst,channels:0,added:0,fails:0}; }
  async getStats(name){ return this._stats[name]||{requests:0,errors:0,uptime:0,byChannel:{}}; }
  async getLogs(name,lines){ return Array.from({length:Math.min(lines||50,50)},(_,i)=>
    `[0${i%9}:${10+i}:22] ai-gateway v1.0.0 就绪 (配置: .../config.${name}.json)`).join('\n'); }
  async getRequests(name){ return [
    {id:'req_mock01',time:'09:41:22',model:'deepseek-chat',channel:'pool-a',status:200,duration:1840},
    {id:'req_mock02',time:'09:41:19',model:'kimi-k3',channel:'nvidia-k3-a',status:429,duration:310},
    {id:'req_mock03',time:'09:40:58',model:'claude-sonnet-4-5',channel:'pool-b',status:200,duration:7190}]; }
  async action(name,a){ const i=this._insts.find(x=>x.name===name); if(i&&a==='start')i.running=true; if(i&&a==='stop')i.running=false; return {ok:true}; }
  async getKeys(inst){ return {keys:this._keys||(this._keys=[{key:'sk-mock1234567890abcdef',name:'演示卡',enable:true,quotaTokens:100000,usedTokens:35210,models:[],channels:[],expiresAt:'',note:'',createdAt:'2026-09-01T00:00:00Z'}]),gatewayKeySet:true}; }
  async createKey(inst,body){ const k={key:'sk-mock'+Math.random().toString(36).slice(2,20),name:body.name||'',enable:true,quotaTokens:body.quotaTokens||0,usedTokens:0,models:body.models||[],channels:[],expiresAt:body.expiresAt||'',note:body.note||'',createdAt:new Date().toISOString()}; (this._keys=this._keys||[]).push(k); return {ok:true,key:k}; }
  async updateKey(inst,body){ const k=(this._keys||[]).find(x=>x.key===body.key); if(k){ if(body.enable!==undefined)k.enable=body.enable; if(body.resetUsage)k.usedTokens=0; if(body.addQuota)k.quotaTokens+=body.addQuota; } return {ok:true}; }
  async deleteKey(inst,key){ this._keys=(this._keys||[]).filter(x=>x.key!==key); return {ok:true}; }
  async getAdminAuth(inst){ return {hasAdminKey:true,secondKeySet:false,totpEnabled:false}; }
  async setAdminAuth(inst,body){ return {ok:true,secondKeySet:!!body.secondKey,totpEnabled:body.totpAction==='enable',totpSecret:body.totpAction==='enable'?'JBSWY3DPEHPK3PXP':null,otpauthUrl:'otpauth://totp/ai-gateway-demo?secret=JBSWY3DPEHPK3PXP&issuer=ai-gateway'}; }
  async getTunnel(){ return this._tunnel||{running:false,url:'',log:[]}; }
  async tunnelAction(action){ this._tunnel = action==='start' ? {running:true,url:'https://demo-abc-xyz.trycloudflare.com',log:[]} : {running:false,url:'',log:[]}; return {ok:true,...this._tunnel}; }
  async getBalance(inst,ch){ return {ok:true,channel:ch,balance:'42.00',unit:'CNY'}; }
  async probeNow(inst){ return {ok:true,probe:{}}; }
  async shutdownAll(){ return {ok:true}; }
  async getWebSessions(){ const now=Date.now(); return {ok:true, now, sessions:[{sid:'demoSIDaaaaaaaaaaaaaaaa1',exp:now+6*864e5},{sid:'demoSIDbbbbbbbbbbbbbbbb2',exp:now+2*864e5}], pending:[{sid:'pendSIDcccccccccccccccc3',exp:now+9e5}], adminExpireAt:0}; }
  async revokeWebSession(sid){ return {ok:true, sid:sid||null}; }
  async setAdminExpire(at){ return {ok:true, at:Number(at)||0}; }
  async getMdu(){ return {ok:true, tokens:{primary:'#4C6B3C'}, source:'mock'}; }
  async chat(body){ return { json:()=>Promise.resolve({choices:[{message:{content:'(Mock 回复) 收到: '+body.messages.at(-1).content}}]}) }; }
}
class HttpAdapter extends BaseAdapter{
  constructor(base){
    super();
    const pm=location.pathname.match(/^\/([A-Za-z0-9_-]{1,32})\/auth(?:\/|$)/);
    const prefix=pm?'/'+pm[1]:'';
    this.base=(base||(location.origin+prefix)).replace(/\/$/,'');
  }
  _hdr(){ const h={'Content-Type':'application/json'}; const k=localStorage.getItem('agw-admin-key'); if(k)h['x-agw-token']=k; return h; }
  async getInstances(signal){ return this._fetch(`${this.base}/admin/api/instances`,{headers:this._hdr()},signal); }
  async getConfig(name,signal){ return this._fetch(`${this.base}/admin/api/config/${encodeURIComponent(name)}?reveal=1`,{headers:this._hdr()},signal); }
  async saveConfig(name,patch,signal){
    const r=await this._fetch(`${this.base}/admin/api/config/${encodeURIComponent(name)}`,{method:'POST',headers:this._hdr(),body:JSON.stringify(patch)},signal);
    if(r&&r.restarting){ snack('已保存, 实例 '+name+' 重启中…'); await this._waitUp(name); snack('实例 '+name+' 已重启'); }
    return r;
  }
  // wait for the instance to finish restarting (poll the instance list until running)
  async _waitUp(name,timeoutMs=40000){
    const t0=Date.now();
await new Promise(r=>setTimeout(r,3500)); // let the old process exit and the new one start first (the self-restart script takes ~2-3s)
    while(Date.now()-t0<timeoutMs){
      try{ const d=await this.getInstances(); const i=(d.instances||[]).find(x=>x.name===name); if(i&&i.running) return true; }catch(_){}
      await new Promise(r=>setTimeout(r,1000));
    }
    return false;
  }
  async getRecordBody(name,id,signal){ return this._fetch(`${this.base}/admin/api/record-body/${encodeURIComponent(name)}?id=${encodeURIComponent(id)}`,{headers:this._hdr()},signal); }
  async createInstance(name,body,signal){ return this._fetch(`${this.base}/admin/api/instance-create/${encodeURIComponent(name)}`,{method:'POST',headers:this._hdr(),body:JSON.stringify(body)},signal); }
  async saveChannel(inst,ch,signal){ const r=await this._fetch(`${this.base}/admin/api/channel/${encodeURIComponent(inst)}`,{method:'POST',headers:this._hdr(),body:JSON.stringify(ch)},signal);
    if(r&&r.restarting){ snack('已保存, 实例 '+inst+' 重启中…'); await this._waitUp(inst); snack('实例 '+inst+' 已重启'); } return r; }
  async deleteChannel(inst,chName,signal){ const r=await this._fetch(`${this.base}/admin/api/channel/${encodeURIComponent(inst)}/${encodeURIComponent(chName)}`,{method:'DELETE',headers:this._hdr()},signal);
    if(r&&r.restarting){ snack('已删除, 实例 '+inst+' 重启中…'); await this._waitUp(inst); snack('实例 '+inst+' 已重启'); } return r; }
  async deleteInstance(name,signal){ return this._fetch(`${this.base}/admin/api/instance/${encodeURIComponent(name)}`,{method:'DELETE',headers:this._hdr()},signal); }
  async renameInstance(name,newName,signal){ return this._fetch(`${this.base}/admin/api/instance-rename/${encodeURIComponent(name)}`,{method:'POST',headers:this._hdr(),body:JSON.stringify({newName})},signal); }
  async fetchModels(inst,body,signal){ return this._fetch(`${this.base}/admin/api/channel-models/${encodeURIComponent(inst)}`,{method:'POST',headers:this._hdr(),body:JSON.stringify(body)},signal); }
  async syncModels(inst,signal){ return this._fetch(`${this.base}/admin/api/sync-models`,{method:'POST',headers:this._hdr()},signal); }
  async getWebSessions(signal){ return this._fetch(`${this.base}/admin/api/web-sessions`,{headers:this._hdr()},signal); }
  async revokeWebSession(sid,signal){ return this._fetch(`${this.base}/admin/api/web-expired`,{method:'POST',headers:this._hdr(),body:JSON.stringify(sid?{sid}:{})},signal); }
  async setAdminExpire(at,signal){ return this._fetch(`${this.base}/admin/api/admin-expire`,{method:'POST',headers:this._hdr(),body:JSON.stringify({at:Number(at)||0})},signal); }
  async getMdu(signal){ return this._fetch(`${this.base}/admin/api/mdu`,{headers:this._hdr()},signal); }
  async getStats(name,signal){ return this._fetch(`${this.base}/admin/api/stats?instance=${encodeURIComponent(name)}`,{headers:this._hdr()},signal); }
  async getLogs(name,lines,signal){ const r=await fetch(`${this.base}/admin/api/logs/${encodeURIComponent(name)}?lines=${lines}`,{headers:this._hdr(),signal}); if(!r.ok) throw new Error(await r.text().catch(()=>'')); return r.text(); }
  async getRequests(name,signal){ return this._fetch(`${this.base}/admin/api/requests/${encodeURIComponent(name)}`,{headers:this._hdr()},signal); }
  async action(name,cmd,signal){ return this._fetch(`${this.base}/admin/api/action/${encodeURIComponent(name)}/${cmd}`,{method:'POST',headers:this._hdr()},signal); }
  async getKeys(inst,signal){ return this._fetch(`${this.base}/admin/api/keys/${encodeURIComponent(inst)}`,{headers:this._hdr()},signal); }
  async createKey(inst,body,signal){ return this._fetch(`${this.base}/admin/api/keys/${encodeURIComponent(inst)}`,{method:'POST',headers:this._hdr(),body:JSON.stringify(body)},signal); }
  async updateKey(inst,body,signal){ return this._fetch(`${this.base}/admin/api/keys-update/${encodeURIComponent(inst)}`,{method:'POST',headers:this._hdr(),body:JSON.stringify(body)},signal); }
  async deleteKey(inst,key,signal){ return this._fetch(`${this.base}/admin/api/keys/${encodeURIComponent(inst)}/${encodeURIComponent(key)}`,{method:'DELETE',headers:this._hdr()},signal); }
  async getAdminAuth(inst,signal){ return this._fetch(`${this.base}/admin/api/admin-auth/${encodeURIComponent(inst)}`,{headers:this._hdr()},signal); }
  async setAdminAuth(inst,body,signal){ return this._fetch(`${this.base}/admin/api/admin-auth/${encodeURIComponent(inst)}`,{method:'POST',headers:this._hdr(),body:JSON.stringify(body)},signal); }
  async getTunnel(signal){ return this._fetch(`${this.base}/admin/api/tunnel`,{headers:this._hdr()},signal); }
  async tunnelAction(action,signal){ return this._fetch(`${this.base}/admin/api/tunnel`,{method:'POST',headers:this._hdr(),body:JSON.stringify({action})},signal); }
  async getBalance(inst,ch,signal){ return this._fetch(`${this.base}/admin/api/balance/${encodeURIComponent(inst)}/${encodeURIComponent(ch)}`,{headers:this._hdr()},signal); }
  async probeNow(inst,signal){ return this._fetch(`${this.base}/admin/api/probe/${encodeURIComponent(inst)}`,{method:'POST',headers:this._hdr()},signal); }
  async shutdownAll(signal){ return this._fetch(`${this.base}/admin/api/shutdown-all`,{method:'POST',headers:this._hdr()},signal); }
  async chat(body,signal){ const r=await fetch(`${this.base}/admin/api/chat`,{method:'POST',headers:{...this._hdr(),'Content-Type':'application/json'},body:JSON.stringify(body),signal});
    if(!r.ok) throw new Error(await r.text().catch(()=>'聊天请求失败')); return r; }
}

// ============ State ============
const VIEWS = [
// icons use Material Symbols word forms (local font ligatures; see @font-face)
  {id:'overview', label:'总览',   icon:'home'},
  {id:'providers',label:'提供商', icon:'business'},
  {id:'routing',  label:'路由',   icon:'sync'},
  {id:'keys',     label:'密钥',   icon:'key'},
  {id:'cards',    label:'卡密',   icon:'confirmation_number'},
  {id:'ports',    label:'端口',   icon:'power'},
  {id:'session',  label:'会话',   icon:'devices'},
  {id:'replace',  label:'替换',   icon:'find_replace'},
  {id:'stats',    label:'统计',   icon:'bar_chart'},
  {id:'requests', label:'请求',   icon:'monitoring'},
  {id:'logs',     label:'日志',   icon:'description'},
  {id:'chat',     label:'聊天',   icon:'chat'},
];
const TITLES = {overview:'总览',providers:'AI 提供商',routing:'路由与重试',keys:'API 密钥',cards:'卡密管理',ports:'服务端口',session:'面板会话',replace:'文本替换',stats:'统计信息',requests:'请求记录',logs:'日志',chat:'聊天测试'};

const Store = {
  page:'overview', instances:[], configs:new Map(), aborts:new Map(), timer:null,
  online:navigator.onLine, currentName:'', adapter:'http',
  inst:'default',
  chat:{ messages:[], inst:'', streaming:false },
  charts:null,
  abort(key){ const c=this.aborts.get(key); if(c){ try{c.abort();}catch(e){} }
    const n=new AbortController(); this.aborts.set(key,n); return n.signal; },
  armTimeout(key,ms,onFire){ const c=this.aborts.get(key); if(!c) return ()=>{};
    const t=setTimeout(()=>{ try{ if(onFire) onFire(); c.abort(); }catch(_){} },ms);
    return ()=>clearTimeout(t); },
  clearRefresh(){ if(this.timer){ clearInterval(this.timer); this.timer=null; } },
  startRefresh(fn,ms){ this.clearRefresh(); this.timer=setInterval(fn,ms); },
};
let adapter = new HttpAdapter();

// ============ Navigation ============
function buildNav(){
// Sidebar items use custom buttons: MW md-list-item line-height/spacing misbehaves on some screens (rows too tall, active pill too big)
  $('#railList').innerHTML = VIEWS.map(v=>
    `<button type="button" class="rail-item" data-page="${v.id}" ${v.id===Store.page?'active':''}>
       <span class="msym" aria-hidden="true">${v.icon}</span><span>${v.label}</span>
     </button>`).join('');
// md-navigation-tab's slots are inactive-icon / active-icon (there is no icon slot),
// Writing slot="icon" is dropped outright -> bottom-bar icons disappear. Both slots must be provided.
  $('#navbar').innerHTML = NAV_TABS.map(v=>
    `<md-navigation-tab data-page="${v.id}" label="${v.label}" ${navActive(v.id)?'active':''}>
       <md-icon slot="inactive-icon" aria-hidden="true">${v.icon}</md-icon>
       <md-icon slot="active-icon" aria-hidden="true">${v.icon}</md-icon>
     </md-navigation-tab>`).join('');
}
function syncNav(){
  $$('#railList .rail-item').forEach(el=>el.toggleAttribute('active', el.dataset.page===Store.page));
  const tabs=$$('#navbar md-navigation-tab');
  const activePage=NAV_ACTIVE_PAGE();
  const idx=tabs.findIndex(t=>t.dataset.page===activePage);
  const bar=$('#navbar');
  if(idx>=0 && bar.activeIndex!==idx) bar.activeIndex=idx;
  tabs.forEach(t=>t.toggleAttribute('active', t.dataset.page===activePage));
}
//// The bottom bar holds 5 common pages; the rest fold into "More": all 12 pages remain reachable on phones
const NAV_TABS = ['overview','providers','routing','keys','stats']
  .map(id=>VIEWS.find(v=>v.id===id)).filter(Boolean)
  .concat([{id:'__more', label:'更多', icon:'more_horiz'}]);
const NAV_ACTIVE_PAGE = () => NAV_TABS.some(t=>t.id===Store.page) ? Store.page : '__more';
function navActive(id){ return id===NAV_ACTIVE_PAGE(); }
function openViewSheet(){
  const cur=Store.page;
  openDialog('全部页面', '<div class="vs-grid">'+VIEWS.map(v=>
    `<button type="button" class="ov-nav-btn" data-page="${v.id}" ${v.id===cur?'style="border-color:var(--md-sys-color-primary)"':''}>
       <span class="msym" aria-hidden="true">${v.icon}</span><span>${v.label}</span></button>`).join('')+'</div>',
    {okText:'关闭', cancel:false});
}
async function go(page){
  if(!VIEWS.some(v=>v.id===page)) return;
  // slide direction from nav order: target after current = enters from the right, before = from the left
// Same page (go triggered twice, e.g. bottom-bar click + nav event) skips animation so the second go does not override the slide with a fade
  const oldIdx=VIEWS.findIndex(v=>v.id===Store.page), newIdx=VIEWS.findIndex(v=>v.id===page);
  const anim=newIdx>oldIdx?'anim-slide-r':newIdx<oldIdx?'anim-slide-l':'';
  Store.page=page;
  $$('.page').forEach(p=>{ const on=p.id===`page-${page}`; p.classList.toggle('hidden',!on); p.hidden=!on;
    if(on && anim){ p.classList.remove('anim-in','anim-slide-r','anim-slide-l'); void p.offsetWidth; p.classList.add(anim); } });
  $('#pageTitle').textContent = TITLES[page]||page;
  syncNav();
  Store.clearRefresh();
  if(page==='overview') Store.startRefresh(()=>{ if(Store.page==='overview' && !Store._ovBusy) renderOverview(); },5000);
  else if(page==='stats') Store.startRefresh(()=>{ if(Store.page==='stats' && !Store._stBusy) renderStats(); },5000);
  const R={overview:renderOverview,providers:renderProviders,routing:renderRouting,
    keys:renderKeys,cards:renderCards,ports:renderPorts,session:renderSession,replace:renderReplace,
    stats:renderStats,requests:renderRequests,logs:renderLogs,chat:renderChat};
  await R[page]?.();
}

// ============ Render: text replacement ============
let rpLists={out:[],inc:[]};
function rpCompileCli(rules){
  const out=[];
  for(const r of (rules||[])){ if(!r||!r.re) continue; try{ out.push({re:new RegExp(r.re,(r.ci?'i':'')+'g'),to:String(r.to==null?'':r.to)}); }catch(_){}}
  return out;
}
function rpApplyCli(s,rules){ for(const r of rules) s=s.replace(r.re,r.to); return s; }
function rpRenderChips(dir){
  const box=$('#rp-'+dir+'-chips'); if(!box) return;
  const list=rpLists[dir];
  box.innerHTML=list.length?list.map((r,i)=>
    '<span class="mm-chip" data-i="'+i+'"><span class="nm">'+esc(r.re)+'</span><span class="arrow">→</span><span class="nm">'+esc(r.to||'(删除匹配)')+'</span>'
    +(r.ci?'<span class="tag default" style="margin-left:2px">Aa</span>':'')
    +'<button class="mm-x" data-i="'+i+'" aria-label="删除">✕</button></span>').join('')
    :'<span style="font-size:12px;color:var(--md-sys-color-on-surface-variant)">暂无规则 — 填上方两框后点 + 添加 (点 ✕ 删除)</span>';
}
async function rpSave(){
  try{
    await adapter.saveConfig(Store.inst,{replace:{out:rpLists.out,inc:rpLists.inc}});
    snack('已保存');
  }catch(e){ snack(e.message,true); }
}
function rpAdd(dir){
  const f=$('#rp-'+dir+'-find'), t=$('#rp-'+dir+'-to'), ci=$('#rp-'+dir+'-ci');
  const re=(f.value||'').trim(), to=(t.value==null?'':t.value);
  if(!re){ snack('先填查找(正则)',true); return; }
  try{ new RegExp(re, ci&&ci.selected?'i':''); }catch(e){ snack('正则无效: '+e.message,true); return; }
  if(rpLists[dir].some(x=>x.re===re&&x.to===to&&!!x.ci===!!(ci&&ci.selected))){ snack('规则已存在',true); return; }
  rpLists[dir].push({re,to,ci:!!(ci&&ci.selected)});
  f.value=''; if(t) t.value='';
  rpRenderChips(dir); rpSave(dir);
}
function rpDel(dir,i){ rpLists[dir].splice(i,1); rpRenderChips(dir); rpSave(dir); }
function rpBindSwipe(dir){
  const box=$('#rp-'+dir+'-chips'); let sx=0,sy=0,chip=null,idx=-1,dx=0;
  box.addEventListener('touchstart',e=>{
    const t=e.target.closest('.mm-chip'); if(!t) return;
    chip=t; idx=+t.dataset.i; sx=e.touches[0].clientX; sy=e.touches[0].clientY; dx=0;
    t.style.transition='none';
  },{passive:true});
  box.addEventListener('touchmove',e=>{
    if(!chip) return;
    dx=e.touches[0].clientX-sx;
    const dy=e.touches[0].clientY-sy;
    if(Math.abs(dx)>6&&Math.abs(dx)>Math.abs(dy)) chip.style.transform='translateX('+Math.max(-140,Math.min(140,dx))+'px)';
  },{passive:true});
  box.addEventListener('touchend',()=>{
    if(!chip) return;
    if(Math.abs(dx)>64){ chip.style.transition='transform .18s,opacity .18s'; chip.style.transform='translateX('+(dx>0?160:-160)+'px)'; chip.style.opacity='0'; const i=idx; setTimeout(()=>rpDel(dir,i),180); }
    else { chip.style.transition='transform .18s'; chip.style.transform=''; }
    chip=null; idx=-1; dx=0;
  });
}
async function renderReplace(){
  const signal=Store.abort('replace');
  const cur = await fillInstSelect($('#topInst'), Store.inst, signal); Store.inst=cur;
  try{
    const cfg=await adapter.getConfig(cur,signal);
    const rp=cfg.replace||{};
    rpLists.out=Array.isArray(rp.out)?rp.out.map(r=>({re:String(r.re||''),to:String(r.to==null?'':r.to),ci:!!r.ci})):[];
    rpLists.inc=Array.isArray(rp.inc)?rp.inc.map(r=>({re:String(r.re||''),to:String(r.to==null?'':r.to),ci:!!r.ci})):[];
    rpRenderChips('out'); rpRenderChips('inc');
  }catch(e){ if(e.name!=='AbortError') snack(e.message,true); }
}

// ============ Instance dropdown (md-select needs options attached before value is set, otherwise it is ignored) ============
async function fillInstSelect(sel, current, signal){
  if(!sel) return;
  try{
    const {instances}=await adapter.getInstances(signal);
    Store.instances=instances;
    if(!current || !instances.some(i=>i.name===current)) current = instances[0]?.name || '';
    sel.innerHTML = instances.map(i=>`<md-select-option value="${escAttr(i.name)}" ${i.name===current?'selected':''}>${esc(i.name)}</md-select-option>`).join('');
    await sel.updateComplete;
    await Promise.all([...sel.querySelectorAll('md-select-option')].map(o=>o.updateComplete||Promise.resolve()));
    sel.value = current;
    await sel.updateComplete;
    return current;
  }catch(e){ if(e.name!=='AbortError') console.error(e); }
  return current;
}
async function fillChatModels(sel, inst){
  try{
    const cfg=await adapter.getConfig(inst);
    Store.configs.set(inst,cfg);
    const models=new Set();
    for(const ch of cfg.channels||[]){
      (ch.models||[]).forEach(m=>models.add(m));
      if(ch.modelMap) Object.keys(ch.modelMap).forEach(m=>models.add(m));
    }
    const arr=[...models];
    sel.innerHTML = arr.length? arr.map((m,i)=>`<md-select-option value="${escAttr(m)}" ${i===0?'selected':''}>${esc(m)}</md-select-option>`).join('')
                              : '<md-select-option value="">(无模型)</md-select-option>';
    await sel.updateComplete;
    await Promise.all([...sel.querySelectorAll('md-select-option')].map(o=>o.updateComplete||Promise.resolve()));
    if(arr.length) sel.value=arr[0];
  }catch(e){ sel.innerHTML='<md-select-option value="">(加载失败)</md-select-option>'; }
}

// ============ List item builders: md-list-item supports only slots (no headline attribute in v2.5) ============
function listItem({icon='', headline='', sub='', over='', endHtml='', active=false, data=''}){
  return `<md-list-item ${data} tabindex="0" role="button">
    ${icon?`<span slot="start" aria-hidden="true">${icon}</span>`:''}
    ${over?`<span slot="overline">${over}</span>`:''}
    <span slot="headline" title="${escAttr(headline)}">${headline}</span>
    ${sub?`<span slot="supporting-text" title="${escAttr(sub.replace(/<[^>]+>/g,''))}">${sub}</span>`:''}
    ${endHtml?`<span slot="end">${endHtml}</span>`:''}
  </md-list-item>`;
}

// ============ Render: overview ============
async function renderOverview(){
  if(Store._ovBusy) return;
  Store._ovBusy=true;
  let ovDisarm=()=>{};
  let ovTimedOut=false;
  try{
    const signal=Store.abort('overview');
    ovDisarm=Store.armTimeout('overview',20000,()=>{ ovTimedOut=true; });
    const {instances,current}=await adapter.getInstances(signal);
    Store.instances=instances; if(current) Store.currentName=current;
    $('#ov-instances').textContent=instances.length;
    $('#ov-running').textContent=instances.filter(i=>i.running).length;
    $('#ov-channels').textContent=instances.reduce((a,i)=>a+(i.chCount||0),0);
// Fetch per-instance stats/config in parallel: with dozens of instances the old sequential
// loop took longer than the 5s refresh interval, so every tick aborted the previous render
// and the overview stayed on "加载中…" forever.
    const stats=await Promise.all(instances.map(i=>adapter.getStats(i.name,signal).catch(e=>{ if(e.name==='AbortError') ovTimedOut=true; return {}; })));
    if(ovTimedOut){ $('#ov-inst-list').innerHTML='<div class="empty">实例数据读取超时，正在重试…</div>'; $('#ov-ch-list').innerHTML='<div class="empty">读取超时，正在重试…</div>'; return; }
    let totalReq=0,maxUp=0;
    for(const s of stats){ totalReq+=s.requests||0; if(s.uptime>maxUp)maxUp=s.uptime; }
    $('#ov-requests').textContent=fmtNum(totalReq);
    $('#ov-uptime').textContent=fmtDur(maxUp);
    $('#ov-inst-list').innerHTML='<md-list>'+instances.map(i=>listItem({
      icon:`<span class="msym ${i.running?'ok':'err'}">circle</span>`,
      headline:esc(i.name)+(i.tlsOn?' <span class="tag default">TLS</span>':''),
      sub:`端口 ${i.port} · ${i.chCount} 渠道 · ${i.running?'运行中':'已停止'}`,
      endHtml:'<span class="muted">›</span>',
      data:`data-goto="ports"`,
    })).join('')+'</md-list>';
    const cfgs=await Promise.all(instances.map(i=>adapter.getConfig(i.name,signal).catch(e=>{ if(e.name==='AbortError') ovTimedOut=true; return null; })));
    if(ovTimedOut){ $('#ov-ch-list').innerHTML='<div class="empty">读取超时，正在重试…</div>'; return; }
    const chRows=[];
    instances.forEach((inst,idx)=>{
      const cfg=cfgs[idx]; if(!cfg) return;
      for(const ch of (cfg.channels||[]).slice(0,3))
        chRows.push(`<tr><td class="mono truncate" title="${escAttr(ch.name)}">${esc(ch.name)}</td><td><span class="tag ${esc(ch.type)}">${esc(ch.type)}</span></td><td class="mono truncate" title="${escAttr(ch.baseUrl)}">${esc(fmtHost(ch.baseUrl))}</td><td class="truncate" title="${escAttr(inst.name)}">${esc(inst.name)}</td></tr>`);
    });
    $('#ov-ch-list').innerHTML = chRows.length
      ? `<div class="tbl-wrap"><table class="tbl" id="ov-ch-table" aria-label="渠道概览"><thead><tr><th style="width:24%">名称</th><th style="width:14%">类型</th><th style="width:46%">地址</th><th style="width:16%">实例</th></tr></thead><tbody>${chRows.join('')}</tbody></table></div>`
      : '<div class="empty">无渠道</div>';
  }catch(e){ if(e.name!=='AbortError'){ console.error(e); snack(e.message,true); } }
  finally{ ovDisarm(); Store._ovBusy=false; }
}

// ============ Render: providers ============
async function renderProviders(){
  const signal=Store.abort('providers');
  const cur = await fillInstSelect($('#topInst'), Store.inst, signal); Store.inst=cur;
  try{
    const cfg=await adapter.getConfig(cur,signal); Store.configs.set(cur,cfg);
    const tb=$('#pv-table tbody');
    tb.innerHTML=(cfg.channels||[]).map(ch=>{
      const mm=(ch.modelMap?Object.entries(ch.modelMap).filter(([k,v])=>k!==v):[]);
      const cell=[(ch.models||[]).join(', ')].concat(mm.length?['改名: '+mm.map(([k,v])=>k+'→'+v).join(', ')]:[]).filter(Boolean).join(' ｜ ');
      return `<tr>
      <td class="mono truncate pv-setdef" data-action="setDefaultProvider" data-name="${escAttr(ch.name)}" title="点击设为默认渠道">${esc(ch.name)}${ch.default?' <span class="tag default">default</span>':''}${ch.useResponses?' <span class="tag default" title="上游走 Responses API">⚡Responses</span>':''}${ch.delayMs?` <span class="tag default" title="请求延迟">⏱${esc(String(ch.delayMs))}ms</span>`:''}${ch.balanceUrl?` <span class="tag default" title="自定义余额接口: ${escAttr(ch.balanceUrl)}">💰</span>`:''}</td>
      <td><span class="tag ${esc(ch.type)}">${esc(ch.type)}</span></td>
      <td class="mono truncate" title="${escAttr(ch.baseUrl)}">${esc(fmtHost(ch.baseUrl))}</td>
      <td class="mono truncate" title="${escAttr(ch.proxy||'-')}">${esc(ch.proxy||'-')}</td>
      <td class="mono truncate" title="${escAttr(cell)}">${esc(cell)}</td>
      <td><div class="row-acts">
        <button type="button" class="icon-act ${ch.default?'on':''}" data-action="setDefaultProvider" data-name="${escAttr(ch.name)}" ${ch.default?'disabled':''} title="${ch.default?'当前默认渠道':'设为默认渠道'}"><span class="msym">${ch.default?'star':'star_outline'}</span></button>
        <button type="button" class="icon-act" data-action="chBalance" data-name="${escAttr(ch.name)}" title="查余额"><span class="msym">account_balance_wallet</span></button>
        <button type="button" class="icon-act" data-action="editProvider" data-name="${escAttr(ch.name)}" title="编辑"><span class="msym">edit</span></button>
        <button type="button" class="icon-act err" data-action="deleteProvider" data-name="${escAttr(ch.name)}" title="删除"><span class="msym">delete</span></button>
      </div></td></tr>`;}).join('')
      || '<tr><td colspan="6" class="empty">该实例暂无渠道，点右上「添加渠道」</td></tr>';
    const px=Object.entries(cfg.proxies||{});
    $('#px-table tbody').innerHTML=px.map(([n,p])=>`<tr>
      <td class="mono truncate" title="${escAttr(n)}">${esc(n)}</td>
      <td><span class="tag">${esc(p.type||'socks5')}</span></td>
      <td class="mono truncate" title="${escAttr(p.host+':'+p.port)}">${esc(p.host+':'+p.port)}${p.username?' <span class="msym" style="font-size:12px;vertical-align:-2px;color:var(--md-sys-color-primary)">key</span>':''}</td>
      <td><div class="row-acts">
        <button type="button" class="icon-act" data-action="editProxy" data-name="${escAttr(n)}" title="编辑"><span class="msym">edit</span></button>
        <button type="button" class="icon-act err" data-action="delProxy" data-name="${escAttr(n)}" title="删除"><span class="msym">delete</span></button>
      </div></td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">暂无代理，渠道可留空直连</td></tr>';
  }catch(e){ if(e.name!=='AbortError') snack(e.message,true); }
}

//// clicking a channel name/star -> set as default (other channels lose the marker; the instance auto-restarts after saving)
async function setDefaultChannel(n){
  try{
    const cfg=await adapter.getConfig(Store.inst);
    const chs=(cfg.channels||[]).map(c=>{ const{hasKey,...rest}=c; rest.default=c.name===n; return rest; });
    if(!chs.some(c=>c.name===n)) return;
    await adapter.saveConfig(Store.inst,{channels:chs});
    snack('已将 '+n+' 设为默认渠道');
    await renderProviders();
  }catch(e){ snack(e.message,true); }
}

// ============ Render: routing ============
async function renderRouting(){
  const signal=Store.abort('routing');
  const cur = await fillInstSelect($('#topInst'), Store.inst, signal); Store.inst=cur;
  try{
    const cfg=await adapter.getConfig(cur,signal); Store.configs.set(cur,cfg);
    const r=cfg.routing||{};
    $('#rt-maxRetry').value=String(r.maxRetry??3); $('#rt-timeout').value=String(r.timeoutSec??60); $('#rt-cooldown').value=String(r.cooldownSec??30);
    $('#rt-redact').selected=!((cfg.redact||{}).enable===false);
    $('#rt-redactRes').selected=!!((cfg.redact||{}).response);
    $('#rt-redactExtra').value=((cfg.redact||{}).extra||[]).join('\n');
    $('#rt-modelSync').selected=!((cfg.modelSync||{}).enable===false);
    $('#rt-syncInterval').value=String((cfg.modelSync||{}).intervalHours??24);
    $('#rt-channels').innerHTML='<md-list>'+(cfg.channels||[]).map(ch=>listItem({
      icon:`<span class="msym">${ch.type==='openai'?'bolt':'diamond'}</span>`,
      headline:esc(ch.name)+(ch.default?' <span class="tag default">default</span>':'')+(ch.useResponses?' <span class="tag default" title="该 OpenAI 渠道上游走 Responses API">⚡Responses</span>':''),
      sub:esc((ch.models||[]).join(', '))||'未配置模型',
      endHtml:`<span class="muted small mono" title="${escAttr(ch.baseUrl)}">${esc(fmtHost(ch.baseUrl))}</span>`,
    })).join('')+'</md-list>' || '<div class="empty">无渠道</div>';
  }catch(e){ if(e.name!=='AbortError') snack(e.message,true); }
}

// ============ Render: keys ============
async function renderKeys(){
  const signal=Store.abort('keys');
  const cur = await fillInstSelect($('#topInst'), Store.inst, signal); Store.inst=cur;
  try{
    const cfg=await adapter.getConfig(cur,signal);
    $('#ky-gatewayKey').value = cfg.gatewayKey && cfg.gatewayKey!=='(已设)' ? cfg.gatewayKey : '';
    $('#ky-gatewayKey').placeholder = cfg.gatewayKey==='(已设)' ? '(已设, 留空不改)' : '留空=不校验';
    $('#ky-webToken').value = cfg.webToken && cfg.webToken!=='(已设)' ? cfg.webToken : '';
    $('#ky-webToken').placeholder = cfg.webToken==='(已设)' ? '(已设, 留空不改)' : '留空=不启用 API 令牌';
    $('#ky-channels').innerHTML=(cfg.channels||[]).map(ch=>
      `<md-outlined-text-field data-keyfor="${escAttr(ch.name)}" label="${esc(ch.name)} (${esc(ch.type)})" type="password" value="${esc(ch.apiKey||'')}" placeholder="${ch.hasKey?'(已设)':'API Key'}"></md-outlined-text-field>`
    ).join('');
    $('#rg-keyLength').value=cfg.keyLength||24;
  }catch(e){ if(e.name!=='AbortError') snack(e.message,true); }
  loadAdminAuth(cur);
}

// ---- Admin second factor ----
async function loadAdminAuth(inst){
  try{
    const d=await adapter.getAdminAuth(inst);
    $('#ka-status').innerHTML = '管理密码: '+(d.hasAdminKey?'<b style="color:var(--md-sys-color-primary)">已设</b>':'<b style="color:var(--md-sys-color-error)">未设(危险)</b>')
      +' · 第二密码: '+(d.secondKeySet?'<b style="color:var(--md-sys-color-primary)">已启用</b>':'未启用')
      +' · TOTP: '+(d.totpEnabled?'<b style="color:var(--md-sys-color-primary)">已启用</b>':'未启用');
    $('#ka-totp-info').style.display = d.totpEnabled ? '' : 'none';
    // the secret itself is only returned once, right after enable (POST /admin-api/admin-auth)
    const pf=d.profile||{};
    $('#ka-profile-name').textContent = pf.name || '(未设置名称)';
    $('#ka-profile-text').textContent = pf.profile || '';
    $('#ka-profile-other').textContent = pf.other || '';
    const av=$('#ka-profile-avatar');
    if(pf.avatar){ av.src=pf.avatar; av.style.display=''; } else { av.removeAttribute('src'); av.style.display='none'; }
    $('#ka-profile-expire').textContent = d.expireAt ? ('面板会话将于 '+new Date(d.expireAt).toLocaleString()+' 到期') : '';
  }catch(e){ $('#ka-status').textContent='加载失败: '+e.message; }
}

// ---- Card settings save ----
async function saveCardSettings(){
  try{
    await adapter.saveConfig(Store.inst,{ keyLength:Number($('#rg-keyLength').value)||24 });
    snack('卡密设置已保存');
  }catch(e){ snack(e.message,true); }
}

// ============ Render: ports ============
async function renderPorts(){
  const signal=Store.abort('ports');
  try{
    const data=await adapter.getInstances(signal);
    const instances=data.instances; if(data.current) Store.currentName=data.current;
    Store.multi=!!data.multi; Store.mainPort=data.mainPort||0;
    $('#pt-list').innerHTML='<md-list>'+instances.map(i=>{
      const isSelf=i.name===Store.currentName;
      let acts;
      if(!i.running) acts=`<md-filled-button data-cmd="start" data-name="${escAttr(i.name)}">启动</md-filled-button>`;
      else if(Store.multi&&i.name==='default') acts=`<md-text-button disabled title="单进程模式: default 承载主端口, 不能停止">停止 <span class="msym">lock</span></md-text-button>`;
      else acts=`<md-text-button data-cmd="stop" data-name="${escAttr(i.name)}" style="color:var(--md-sys-color-error)">停止</md-text-button>`;
      const prefix=Store.multi?(i.name==='default'?'无前缀':('/'+i.name)):null;
      return listItem({
        icon:`<span class="msym ${i.running?'ok':'err'}">circle</span>`,
        headline:esc(i.name)+(isSelf?' <span class="tag default"><span class="msym">home</span>面板</span>':'')+(i.tlsOn?' <span class="tag default">TLS</span>':''),
        sub:`端口 ${i.port} · ${i.chCount} 渠道 · ${i.running?'运行中':'已停止'}${prefix?(' · 主端口路径 '+prefix+'/v1'):''}`,
        endHtml:`<div class="row-acts"><md-outlined-button data-action="openPortDialog" data-name="${escAttr(i.name)}">编辑</md-outlined-button><md-text-button data-cmd="restart" data-name="${escAttr(i.name)}" title="热重载配置">重载</md-text-button>${acts}</div>`,
      });
    }).join('')+'</md-list>';
  }catch(e){ if(e.name!=='AbortError') snack(e.message,true); }
  loadTunnel();
}

// ---- cloudflared tunnel ----
let tnTimer=null;
async function loadTunnel(){
  try{
    const d=await adapter.getTunnel();
    renderTunnel(d);
    if(d.running && !d.url){ clearTimeout(tnTimer); tnTimer=setTimeout(loadTunnel,2000); }
  }catch(e){ $('#tn-status').textContent='查询失败: '+e.message; }
}
function renderTunnel(d){
  $('#tn-toggle').textContent = d.running ? '停止隧道' : '启动隧道';
  if(d.running && d.url){
    $('#tn-status').innerHTML='<b style="color:var(--md-sys-color-primary)">运行中</b>';
    $('#tn-url-row').style.display='flex';
    $('#tn-url').textContent=d.url;
  } else if(d.running){
    $('#tn-status').textContent='启动中, 等待域名分配…';
    $('#tn-url-row').style.display='none';
  } else {
    $('#tn-status').textContent='未启动';
    $('#tn-url-row').style.display='none';
  }
}

// ============ Render: key card management ============
function fmtTok(n){ n=Number(n)||0; if(n>=1e8)return (n/1e8).toFixed(2)+'亿'; if(n>=1e4)return (n/1e4).toFixed(1)+'万'; return String(n); }
async function renderCards(){
  const signal=Store.abort('cards');
  try{
    const data=await adapter.getKeys(Store.inst,signal);
    const keys=data.keys||[];
    if(!keys.length){ $('#cd-list').innerHTML='<div class="empty" style="padding:32px;text-align:center;color:var(--md-sys-color-on-surface-variant)">暂无卡密 · 点右上角「发卡」给朋友发一个</div>'; return; }
    $('#cd-list').innerHTML='<md-list>'+keys.map(k=>{
      const quota=k.quotaTokens||0, used=k.usedTokens||0;
      const pct=quota>0?Math.min(100,Math.round(used/quota*100)):0;
      let state,stateColor;
      if(!k.enable){ state='已禁用'; stateColor='var(--md-sys-color-error)'; }
      else if(k.expiresAt && new Date(k.expiresAt).getTime()<Date.now()){ state='已过期'; stateColor='var(--md-sys-color-error)'; }
      else if(quota>0&&used>=quota){ state='已用尽'; stateColor='var(--md-sys-color-error)'; }
      else { state='启用中'; stateColor='var(--md-sys-color-primary)'; }
      const limits=[k.models&&k.models.length?`限模型 ${k.models.join('/')}`:null, k.expiresAt?`${String(k.expiresAt).slice(0,10)}到期`:null].filter(Boolean).join(' · ');
      return listItem({
        icon:'<span class="msym">confirmation_number</span>',
        headline:esc(k.name||'(无名卡)')+` <span class="tag" style="color:${stateColor}">${state}</span>`,
        sub:`${esc(k.key.slice(0,10))}… · 用量 ${fmtTok(used)}${quota>0?' / '+fmtTok(quota)+' ('+pct+'%)':'(不限额)'}${limits?' · '+esc(limits):''}${k.note?' · '+esc(k.note):''}`,
        endHtml:`<div class="row-acts">
          <button type="button" class="icon-act" data-action="copyKey" data-key="${escAttr(k.key)}" title="复制完整Key"><span class="msym">content_copy</span></button>
          <button type="button" class="icon-act" data-action="toggleKey" data-key="${escAttr(k.key)}" data-on="${k.enable?1:0}" title="${k.enable?'禁用':'启用'}"><span class="msym">${k.enable?'pause_circle':'play_circle'}</span></button>
          <button type="button" class="icon-act" data-action="rechargeKey" data-key="${escAttr(k.key)}" data-name="${escAttr(k.name||'')}" title="充值额度/重置用量"><span class="msym">add_card</span></button>
          <button type="button" class="icon-act err" data-action="delKey" data-key="${escAttr(k.key)}" data-name="${escAttr(k.name||'')}" title="删除"><span class="msym">delete</span></button>
        </div>`,
      });
    }).join('')+'</md-list>';
  }catch(e){ if(e.name!=='AbortError') snack(e.message,true); }
}
// ---- Key-issuing dialog ----
async function openCardDialog(){
  openDialog('发新卡 (实例 '+Store.inst+')', `
    <div style="display:flex;flex-direction:column;gap:14px;padding-top:8px">
      <md-outlined-text-field data-f="name" label="名称(给谁用的)" required></md-outlined-text-field>
      <md-outlined-text-field data-f="quotaWan" label="额度(万 tokens)" type="number" value="100" helper="0 或留空=不限量; 100 = 100万tokens"></md-outlined-text-field>
      <md-outlined-text-field data-f="models" label="限定模型(逗号分隔, 留空=全部可用)" helper="例如 deepseek-chat, gpt-4o-mini"></md-outlined-text-field>
      <md-outlined-text-field data-f="expiresAt" label="有效期(留空=永久)" placeholder="2026-12-31" helper="到期自动拒绝; 支持 YYYY-MM-DD"></md-outlined-text-field>
      <md-outlined-text-field data-f="note" label="备注(可选)"></md-outlined-text-field>
    </div>`, {onOk:async ()=>{
      const v=dlgValue();
      if(!String(v.name||'').trim()){ snack('名称必填',true); return false; }
      const quotaWan=Number(v.quotaWan)||0;
      const body={ name:String(v.name).trim(), quotaTokens:Math.round(quotaWan*10000),
        models:String(v.models||'').split(',').map(s=>s.trim()).filter(Boolean),
        expiresAt:String(v.expiresAt||'').trim(), note:String(v.note||'').trim() };
      try{
        const r=await adapter.createKey(Store.inst,body);
        const k=r.key||{};
        openDialog('发卡成功', `<div style="display:flex;flex-direction:column;gap:12px;padding-top:8px">
          <div style="font-size:13px;color:var(--md-sys-color-on-surface-variant)">完整 Key (配置里可查, 也可随时回来复制):</div>
          <div class="mono" style="word-break:break-all;background:var(--md-sys-color-surface-container);padding:12px;border-radius:12px;user-select:all">${esc(k.key||'')}</div>
          <div style="font-size:13px">客户端用法: base_url 填 <span class="mono">http://&lt;网关地址&gt;:${Store.mainPort||'主端口'}/${esc(Store.inst==='default'?'':Store.inst+'/')}v1</span>, API Key 填上面的 Key</div>
          <md-filled-button id="cd-copy-new">复制 Key</md-filled-button>
        </div>`, {hideCancel:true});
        setTimeout(()=>{ const b=$('#cd-copy-new'); if(b) b.onclick=()=>{ navigator.clipboard&&navigator.clipboard.writeText(k.key||''); snack('已复制'); }; },50);
        renderCards();
      }catch(e){ snack(e.message,true); return false; }
      return true;
    }});
}
// ---- Key card operations ----
async function cardAction(action,key,name,on){
  try{
    if(action==='copyKey'){ await navigator.clipboard.writeText(key); snack('已复制完整 Key'); return; }
    if(action==='toggleKey'){ await adapter.updateKey(Store.inst,{key,enable:!on}); snack(on?'已禁用':'已启用'); renderCards(); return; }
    if(action==='delKey'){
      if(!confirm('删除卡密「'+(name||key.slice(0,10))+'」? 该Key立即失效。')) return;
      await adapter.deleteKey(Store.inst,key); snack('已删除'); renderCards(); return;
    }
    if(action==='rechargeKey'){
      openDialog('充值/重置 「'+esc(name||'')+'」', `
        <div style="display:flex;flex-direction:column;gap:14px;padding-top:8px">
          <md-outlined-text-field data-f="addWan" label="追加额度(万 tokens)" type="number" value="0" helper="在现有额度上追加; 0=不变"></md-outlined-text-field>
          <label style="display:flex;align-items:center;gap:8px;font-size:14px"><md-checkbox data-f="reset"></md-checkbox>重置已用量为 0</label>
        </div>`, {onOk:async ()=>{
          const v=dlgValue();
          const body={key};
          const addWan=Number(v.addWan)||0;
          if(addWan>0) body.addQuota=Math.round(addWan*10000);
          if(v.reset) body.resetUsage=true;
          try{ await adapter.updateKey(Store.inst,body); snack('已更新'); renderCards(); }catch(e){ snack(e.message,true); return false; }
          return true;
        }});
      return;
    }
  }catch(e){ snack(e.message,true); }
}

// ---- Channel balances ----
async function chBalanceAction(chName){
  snack('查询 '+chName+' 余额…');
  try{
    const r=await adapter.getBalance(Store.inst,chName);
    openDialog('渠道余额 · '+esc(chName), `<div style="padding:8px 0;text-align:center">
      <div style="font-size:32px;font-weight:600;color:var(--md-sys-color-primary)">${esc(String(r.balance))} <span style="font-size:14px">${esc(r.unit||'')}</span></div>
      <div class="muted small" style="margin-top:6px">${esc(r.url||'')}</div></div>`, {hideCancel:true});
  }catch(e){ snack(e.message,true); }
}

// ============ Render: statistics ============
async function renderStats(){
  if(Store._stBusy) return;
  Store._stBusy=true;
  let stDisarm=()=>{};
  let stTimedOut=false;
  try{
    const signal=Store.abort('stats');
    stDisarm=Store.armTimeout('stats',20000,()=>{ stTimedOut=true; });
    const cur = await fillInstSelect($('#topInst'), Store.inst, signal); Store.inst=cur;
    const s=await adapter.getStats(cur,signal);
    const chs=Object.entries(s.byChannel||{});
    const sumIn=chs.reduce((t,[,d])=>t+(d.inputTokens||0),0);
    const sumOut=chs.reduce((t,[,d])=>t+(d.outputTokens||0),0);
    const models=Object.entries(s.byModel||{});
    const sumCached=models.reduce((t,[,d])=>t+(d.cached||0),0);
    $('#st-requests').textContent=fmtNum(s.requests);
    $('#st-errors').textContent=fmtNum(s.errors);
    $('#st-intok').textContent=fmtNum(sumIn);
    $('#st-outtok').textContent=fmtNum(sumOut);
    $('#st-cached').textContent=fmtNum(sumCached);
    $('#st-hitrate').textContent=sumIn?((sumCached/sumIn)*100).toFixed(1)+'%':'-';
    $('#st-uptime').textContent=fmtDur(s.uptime);
    $('#st-rps').textContent=((s.requests||0)/(s.uptime||1)).toFixed(2);
// Token distribution (aggregated across all days)
    const D={tools:0,system:0,history:0,user:0,reasoning:0,text:0,tool:0};
    for(const v of Object.values(s.daily||{})){ for(const k of Object.keys(D)) D[k]+=(v.dist&&v.dist[k])||0; }
    const dTot=Object.values(D).reduce((a,b)=>a+b,0);
    const DN={tools:'工具定义',system:'系统提示',history:'对话历史',user:'用户输入',reasoning:'思考内容',text:'正文',tool:'ToolCall'};
    const bar=(pct,label,val)=>`<div style="margin:6px 0"><div style="display:flex;justify-content:space-between;font-size:12px"><span>${esc(label)}</span><span class="mono" style="opacity:.8">${fmtNum(val)} · ${pct.toFixed(1)}%</span></div><div style="height:6px;border-radius:3px;background:var(--md-sys-color-surface-container-highest,#333);overflow:hidden"><div style="height:100%;width:${Math.max(pct,0.5)}%;background:var(--md-sys-color-primary)"></div></div></div>`;
    $('#st-dist').innerHTML=dTot?Object.keys(DN).map(k=>bar(D[k]/dTot*100,DN[k],D[k])).join(''):'<div class="empty" style="padding:8px 0">暂无分布数据(需有请求流过)</div>';
    // by model
    const mRows=models.map(([m,d])=>({m,...d,sum:(d.inputTokens||0)+(d.outputTokens||0)})).sort((a,b)=>b.sum-a.sum);
    const mTot=mRows.reduce((t,r)=>t+r.sum,0)||1;
    $('#st-model').innerHTML=mRows.length?mRows.slice(0,12).map(r=>bar(r.sum/mTot*100,r.m,r.sum)).join(''):'<div class="empty" style="padding:8px 0">暂无数据</div>';
    // daily usage
    const days=Object.entries(s.daily||{}).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,14);
    $('#st-daily tbody').innerHTML=days.length?days.map(([d,v])=>
      `<tr><td class="mono">${esc(d)}</td><td>${fmtNum(v.requests)}</td><td>${fmtNum(v.inputTokens)}</td><td>${fmtNum(v.outputTokens)}</td><td>${fmtNum(v.cached)}</td></tr>`).join('')
      :'<tr><td colspan="5" class="empty">暂无数据</td></tr>';
    $('#st-table tbody').innerHTML=chs.length?chs.map(([n,d])=>
      `<tr><td class="mono truncate" title="${escAttr(n)}">${esc(n)}</td><td>${fmtNum(d.requests)}</td><td>${fmtNum(d.inputTokens)}</td><td>${fmtNum(d.outputTokens)}</td></tr>`).join('')
      :'<tr><td colspan="4" class="empty">暂无数据</td></tr>';
// Charts (plain canvas, no third-party libs)
    const daily=Object.entries(s.daily||{}).sort((x,y)=>x[0].localeCompare(y[0])).slice(-14)
      .map(([d,v])=>({label:String(d).slice(5),in:v.inputTokens||0,out:v.outputTokens||0}));
    Store.charts={daily, models:mRows.map(r=>({name:r.m,sum:r.sum}))};
    drawDailyChart(daily); drawModelChart(Store.charts.models);
  }catch(e){
    if(e.name==='AbortError'){ if(stTimedOut) $('#st-table tbody').innerHTML='<tr><td colspan="4" class="empty">读取超时，正在重试…</td></tr>'; }
    else snack(e.message,true);
  }
  finally{ stDisarm(); Store._stBusy=false; }
}

// ============ Render: request log ============
async function renderRequests(){
  const signal=Store.abort('requests');
  const cur = await fillInstSelect($('#topInst'), Store.inst, signal); Store.inst=cur;
  try{
    const [reqs,cfg]=await Promise.all([adapter.getRequests(cur,signal), adapter.getConfig(cur,signal)]);
    const rec=cfg.record||{};
    $('#rq-rec-enable').selected=!!rec.enable;
    $('#rq-rec-server').value=rec.server||'';
    $('#rq-table tbody').innerHTML=(reqs||[]).map(r=>{
      const tp=String(r.time||'').split(' ');
      return `<tr>
      <td class="mono"><span class="rq-date">${esc(tp[0]||'')} </span>${esc(tp[1]||tp[0]||'')}</td>
      <td class="mono truncate" title="${escAttr(r.model)}">${esc(r.model)}</td>
      <td class="mono truncate" title="${escAttr(r.channel)}">${esc(r.channel)}</td>
      <td title="HTTP ${r.status}">${r.status===200?'<span style="color:#4CAF50">✓</span>':'<span style="color:var(--md-sys-color-error)">✗</span>'}<span class="mono" style="font-size:11px">${r.status}</span></td>
      <td class="mono" style="font-size:11px">${r.duration}ms</td>
      <td>${r.id?`<button type="button" class="icon-act" data-action="viewBody" data-id="${escAttr(r.id)}" title="查看正文"><span class="msym">article</span></button>`:''}</td></tr>`;}).join('') || '<tr><td colspan="6" class="empty">暂无记录</td></tr>';
  }catch(e){ if(e.name!=='AbortError') snack(e.message,true); }
}
// Save recording settings (switch/server address)
async function saveRecCfg(){
  try{
    await adapter.saveConfig(Store.inst,{record:{enable:!!$('#rq-rec-enable').selected, server:($('#rq-rec-server').value||'').trim()}});
    snack('记录设置已保存');
  }catch(e){ snack(e.message,true); }
}
// Fetch a request/response body by id from the record file and show it in a dialog
async function viewRecordBody(id){
  openDialog('请求正文', '<div style="padding:8px">加载中…</div>', {okText:'关闭', cancel:false});
  try{
    const d=await adapter.getRecordBody(Store.inst,id);
    const r=d.record||{};
    const fmt=v=>typeof v==='string'?v:JSON.stringify(v,null,2);
    $('#dlgBody').innerHTML='<div class="rec-meta mono">'+esc(r.time||'')+' · '+esc(r.model||'')+' · 渠道 '+esc(r.channel||'-')+' · 状态 '+(r.status??'')+' · '+(r.duration||0)+'ms · tokens '+(r.inputTokens||0)+'/'+(r.outputTokens||0)+'</div>'
      +'<div style="font-size:13px;font-weight:600">请求</div><pre class="rec-pre mono">'+esc(fmt(r.request??'(无)'))+'</pre>'
      +'<div style="font-size:13px;font-weight:600">响应</div><pre class="rec-pre mono">'+esc(fmt(r.response??'(无)'))+'</pre>';
  }catch(e){ $('#dlgBody').innerHTML='<div style="padding:8px;color:var(--md-sys-color-error)">'+esc(e.message)+'</div>'; }
}

// ============ Render: logs ============
async function renderLogs(){
  const signal=Store.abort('logs');
  const cur = await fillInstSelect($('#topInst'), Store.inst, signal); Store.inst=cur;
  const box=$('#lg-box'); box.textContent='加载中…';
  try{
    const lines=+($('#lg-lines').value||100);
    const txt=await adapter.getLogs(cur,lines,signal);
    box.textContent=txt||'(空)';
    box.scrollTop=box.scrollHeight;
  }catch(e){ if(e.name!=='AbortError'){ box.textContent='读取失败: '+e.message; } }
}

// ============ Render: chat ============
let chatStick=true;
const chatNow=()=>new Date().toTimeString().slice(0,5);
const chatAtBottom=()=>{ const b=$('#ch-messages'); return b?(b.scrollHeight-b.scrollTop-b.clientHeight<80):true; };
function chatUpdateJump(){ const j=$('#ch-jump'); if(j) j.classList.toggle('hidden', !( !chatStick && Store.chat.messages.length>0 )); }
function renderChatMessages(force){
  const box=$('#ch-messages'); if(!box) return;
  chatStick = force ? true : chatAtBottom();
  const msgs=Store.chat.messages;
  if(!msgs.length){ box.innerHTML='<div class="empty" style="margin:auto">选择模型，输入消息后回车发送</div>'; chatUpdateJump(); return; }
  box.innerHTML=msgs.map((m,i)=>{
    const isUser=m.role==='user';
    const cur=(!isUser&&Store.chat.streaming&&i===msgs.length-1)?' chat-cursor':'';
    return `<div class="chat-msg ${isUser?'user':'ai'}">
      <div class="chat-ava" aria-hidden="true">${isUser?'<span class="msym">person</span>':'<span class="msym">smart_toy</span>'}</div>
      <div class="chat-body">
        <div class="chat-meta"><span class="who">${isUser?'你':'助手'}</span>${m.t?`<span>${esc(m.t)}</span>`:''}
          <button class="chat-copy" type="button" data-copy="${i}" aria-label="复制第 ${i+1} 条消息">复制</button></div>
        <div class="chat-bubble${cur}">${esc(m.content)||'<span style="opacity:.5">…</span>'}</div>
      </div></div>`;
  }).join('');
  if(chatStick) box.scrollTop=box.scrollHeight;
  chatUpdateJump();
}
async function renderChat(){
  const signal=Store.abort('chat');
  const cur = await fillInstSelect($('#topInst'), Store.chat.inst||Store.inst, signal);
  Store.chat.inst=cur; Store.inst=cur;
  await fillChatModels($('#ch-model'), cur);
  renderChatMessages(true);
}
async function copyText(t){
  try{ if(navigator.clipboard&&window.isSecureContext){ await navigator.clipboard.writeText(t); snack('已复制'); return; } throw 0; }
  catch(e){ const ta=document.createElement('textarea'); ta.value=t; ta.setAttribute('readonly','');
    ta.style.cssText='position:fixed;top:0;left:0;opacity:0'; document.body.appendChild(ta); ta.select();
    let ok=false; try{ ok=document.execCommand('copy'); }catch(_){}
    document.body.removeChild(ta); ok?snack('已复制'):snack('复制失败（需 HTTPS 或手动长按选择）',true); }
}
async function sendChat(){
  const inp=$('#ch-input'), text=String(inp.value||'').trim();
  if(!text) return;
  const model=$('#ch-model').value;
  if(!model){ snack('请先选择模型',true); return; }
  const stream=$('#ch-stream').selected;
  inp.value='';
  Store.chat.messages.push({role:'user',content:text,t:chatNow()});
  renderChatMessages(true);
  const btn=$('#ch-send'); btn.disabled=true; btn.textContent='…';
  try{
    const res=await adapter.chat({model,messages:Store.chat.messages.slice(),stream,instance:Store.chat.inst});
    if(stream){
      Store.chat.streaming=true;
      Store.chat.messages.push({role:'assistant',content:'',t:chatNow()});
      renderChatMessages(true);
      const reader=res.body.getReader(), dec=new TextDecoder();
      let buf='',ai='';
      while(true){ const {done,value}=await reader.read(); if(done)break;
        buf+=dec.decode(value,{stream:true}); const ls=buf.split('\n'); buf=ls.pop();
        for(const line of ls){
          const d=line.startsWith('data: ')?line.slice(6):(line.startsWith('data:')?line.slice(5):null);
          if(!d||d.trim()==='[DONE]')continue;
          try{ const j=JSON.parse(d); const delta=j.choices?.[0]?.delta?.content||j.choices?.[0]?.message?.content;
            if(delta){ ai+=delta; Store.chat.messages.at(-1).content=ai; renderChatMessages(); } }catch(_){}
        } }
      if(!ai) Store.chat.messages.at(-1).content='(空响应)';
    }else{
      const data=await res.json();
      Store.chat.messages.push({role:'assistant',content:data.choices?.[0]?.message?.content||'(空响应)',t:chatNow()});
    }
  }catch(e){ snack('聊天失败: '+e.message,true); Store.chat.messages.push({role:'assistant',content:'⚠️ '+e.message,t:chatNow()}); }
  finally{ Store.chat.streaming=false; btn.disabled=false; btn.textContent='发送'; renderChatMessages(); try{inp.focus();}catch(_){} }
}

// ============ Dialogs ============
// md-dialog's OK/Cancel buttons live in the actions slot; a <form method=dialog> cannot bind across slots,
// hence explicit click binding: on validation/save failure the dialog stays open (no more show() reopening).
// Add an eye toggle to password fields
function upgradePwFields(root){
  if(!root || !root.querySelectorAll) return;
  root.querySelectorAll('md-outlined-text-field[type="password"]').forEach(f=>{
    if(f.querySelector('.pw-eye')) return;
    const b=document.createElement('md-outlined-icon-button');
    b.className='pw-eye'; b.setAttribute('slot','trailing-icon'); b.title='显示/隐藏';
    b.innerHTML='<md-icon>visibility</md-icon>';
    f.appendChild(b);
  });
}
document.body.addEventListener('click', e=>{
  const eye=e.target.closest('.pw-eye'); if(!eye) return;
  const f=eye.closest('md-outlined-text-field'); if(!f) return;
  const show = f.type==='password';
  f.type = show?'text':'password';
  const ic=eye.querySelector('md-icon'); if(ic) ic.textContent = show?'visibility_off':'visibility';
});

let dlgOnOk = null;
let mmList=[]; // the channel dialog's model rename map [[public name, real name],...]
let portDlgOrigKey; // the original admin password before dialog backfill (undefined = backfill not done)
function openDialog(title, bodyHtml, {okText='确定', cancel=true, onOk=null}={}){
  dlgOnOk = onOk;
  $('#dlgTitle').textContent=title;
  $('#dlgBody').innerHTML=bodyHtml;
  upgradePwFields($('#dlgBody'));
  $('#dlgOk').textContent=okText;
  $('#dlgCancel').hidden=!cancel;
  $('#dlgFetch').hidden=true;
  $('#dlgOverlay').hidden=false;
// Auto-focus the first input; a failed focus must not break the dialog
  setTimeout(()=>{ try{ $('#dlgBody').querySelector('md-outlined-text-field,md-outlined-select')?.focus?.(); }catch(_){} },120);
}
const dlgValue = () => { const o={}; $$('#dlgBody [data-f]').forEach(el=>o[el.dataset.f]=el.value); return o; };
// ---- Theme switching (light/dark + Material You primary color) ----
const SWATCHES=['#6750A4','#005AC1','#006C7C','#006E1C','#9A1E78','#9C4146','#8E4D00','#3B5BA5'];
let themeState={mode:'dark',seed:'#6750A4'};
function hexToHSL(hex){hex=hex.replace('#','');const r=parseInt(hex.substr(0,2),16)/255,g=parseInt(hex.substr(2,2),16)/255,b=parseInt(hex.substr(4,2),16)/255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b);let h,s,l=(mx+mn)/2;if(mx===mn){h=s=0;}else{const d=mx-mn;s=l>0.5?d/(2-mx-mn):d/(mx+mn);switch(mx){case r:h=(g-b)/d+(g<b?6:0);break;case g:h=(b-r)/d+2;break;case b:h=(r-g)/d+4;break;}h/=6;}return{h:Math.round(h*360),s:Math.round(s*100),l:Math.round(l*100)};}
function hslToHex(h,s,l){s/=100;l/=100;const a=s*Math.min(l,1-l);const f=n=>{const k=(n+h/30)%12;const c=l-a*Math.max(-1,Math.min(k-3,9-k,1));return Math.round(255*c).toString(16).padStart(2,'0');};return'#'+f(0)+f(8)+f(4);}
//// derive the full primary/secondary/tertiary roles from the seed color, otherwise the bottom-bar indicator (secondary-container) and some buttons (filled-tonal = secondary-container) never follow the change
function applyTheme(t){
  themeState={mode:t.mode||'dark',seed:t.seed||'#6750A4'};
  const el=document.documentElement; el.dataset.theme=themeState.mode; el.style.colorScheme=themeState.mode;
  const hsl=hexToHSL(themeState.seed), isDark=themeState.mode!=='light';
  const set=(k,v)=>el.style.setProperty(k,v);
// A role palette: primary / on-primary / primary-container / on-primary-container
  const role=(h,s,cL,onCL)=>{
    const pL=isDark?80:40;
    set('--md-sys-color-'+cL,hslToHex(h,s,pL));
    set('--md-sys-color-on-'+cL,pL>55?'#1A1A1A':'#FFFFFF');
    set('--md-sys-color-'+cL+'-container',hslToHex(h,s,isDark?onCL[0]:onCL[1]));
    set('--md-sys-color-on-'+cL+'-container',hslToHex(h,s,isDark?onCL[2]:onCL[3]));
  };
  role(hsl.h, Math.min(100,hsl.s+10), 'primary', [25,90,90,25]);
  role(hsl.h, Math.max(8,Math.round(hsl.s*0.35)), 'secondary', [30,90,90,20]);
  role((hsl.h+60)%360, Math.max(10,Math.round(hsl.s*0.55)), 'tertiary', [30,90,90,20]);
  set('--md-sys-color-surface-tint', hslToHex(hsl.h, Math.min(100,hsl.s+10), isDark?80:40));
}
function loadTheme(){try{const t=JSON.parse(localStorage.getItem('agw-theme')||'{}');if(t.mode)applyTheme(t);else applyTheme({mode:'dark',seed:'#6750A4'});}catch(_){applyTheme({mode:'dark',seed:'#6750A4'});}}
function saveTheme(){localStorage.setItem('agw-theme',JSON.stringify(themeState));}
function openThemeDialog(){
  openDialog('主题',`<div style="display:flex;flex-direction:column;gap:16px;padding-top:8px">
    <label style="display:flex;align-items:center;gap:10px"><md-switch id="th-dark" ${themeState.mode==='dark'?'selected':''}></md-switch><span style="font-size:14px">深色主题</span></label>
    <div><div style="font-size:13px;color:var(--md-sys-color-on-surface-variant);margin-bottom:8px">主色 (Material You)</div>
    <div id="th-swatches" style="display:flex;gap:8px;flex-wrap:wrap"></div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:10px"><button type="button" class="btn sm outline" id="th-mdu">从手机取色</button><span style="font-size:13px;color:var(--md-sys-color-on-surface-variant)">Material You 壁纸色</span><input type="color" id="th-custom" value="${themeState.seed}" style="width:40px;height:36px;border:none;border-radius:8px;cursor:pointer;background:none"><span style="font-size:13px;color:var(--md-sys-color-on-surface-variant)">自定义颜色</span></div></div>
  </div>`,{okText:'完成',cancel:false});
  const sw=$('#th-swatches');if(sw)sw.innerHTML=SWATCHES.map(c=>`<button type="button" class="th-swatch" data-c="${c}" style="width:36px;height:36px;border-radius:50%;border:2px solid ${c===themeState.seed?'var(--md-sys-color-on-surface)':'transparent'};background:${c};cursor:pointer;padding:0"></button>`).join('');
  const dk=$('#th-dark');if(dk)dk.addEventListener('click',()=>setTimeout(()=>{applyTheme({mode:dk.selected?'dark':'light',seed:themeState.seed});saveTheme();},0));
  if(sw)sw.addEventListener('click',e=>{const b=e.target.closest('.th-swatch');if(b){applyTheme({mode:themeState.mode,seed:b.dataset.c});saveTheme();sw.querySelectorAll('.th-swatch').forEach(s=>s.style.borderColor=s.dataset.c===themeState.seed?'var(--md-sys-color-on-surface)':'transparent');}});
  const cu=$('#th-custom');if(cu)cu.addEventListener('input',e=>{applyTheme({mode:themeState.mode,seed:e.target.value});saveTheme();});
  const mduBtn=$('#th-mdu');
  if(mduBtn) mduBtn.addEventListener('click',async()=>{
    const old=mduBtn.textContent;
    mduBtn.disabled=true; mduBtn.textContent='取色中…';
    try{
      const r=await adapter.getMdu();
      const hex=String((r&&r.tokens&&r.tokens.primary)||'').replace('#','');
      if(!r || !r.ok || !/^[0-9a-f]{6}$/i.test(hex)) throw new Error((r&&r.error)||'桥未返回颜色');
      applySeed('#'+hex);
      mduBtn.textContent='已应用 #'+hex;
    }catch(e){
      snack('取色桥不可用 ('+e.message+'), 改为选一张壁纸取色', true);
      mduBtn.textContent=old;
      pickWallpaperColor(mduBtn);
    }
    mduBtn.disabled=false;
  });
}
// Apply the theme seed color (kept in sync across the custom swatch / palette / custom input)
function applySeed(hex){
  applyTheme({mode:themeState.mode, seed:hex}); saveTheme();
  const cu=$('#th-custom'); if(cu) cu.value=hex;
  const sw=$('#th-swatches'); if(sw) sw.querySelectorAll('.th-swatch').forEach(s=>s.style.borderColor='transparent');
}
// Pick a wallpaper from the gallery -> extract the primary color with in-browser canvas; no system API / backend endpoint
function pickWallpaperColor(btn){
  const inp=document.createElement('input');
  inp.type='file'; inp.accept='image/*';
  inp.addEventListener('change', async ()=>{
    const f=inp.files && inp.files[0]; if(!f) return;
    const old=btn.textContent; btn.disabled=true; btn.textContent='取色中…';
    try{
      const hex=await dominantColor(f);
      applySeed(hex);
      btn.textContent='已应用 '+hex;
    }catch(e){ snack('取色失败: '+(e.message||e),true); btn.textContent=old; }
    btn.disabled=false;
  });
  inp.click();
}
// Primary extraction: downscale to 32x32 -> bucket by 30-degree hue -> average the bucket scoring best on pixels x saturation x centered lightness
async function dominantColor(file){
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>rej(new Error('图片无法解码')); i.src=url; });
    const S=32, cv=document.createElement('canvas'); cv.width=cv.height=S;
    const cx=cv.getContext('2d',{willReadFrequently:true}); cx.drawImage(img,0,0,S,S);
    const d=cx.getImageData(0,0,S,S).data, buckets=new Map();
    for(let i=0;i<d.length;i+=4){
      if(d[i+3]<128) continue;
      const c=rgbToHsl(d[i],d[i+1],d[i+2]);
if(c.s<12 || c.l<12 || c.l>92) continue;   // skip near-gray / too dark / too bright
      const k=Math.round(c.h/12);
      const b=buckets.get(k)||{n:0,h:0,s:0,l:0};
      b.n++; b.h+=c.h; b.s+=c.s; b.l+=c.l; buckets.set(k,b);
    }
    let best=null;
    for(const b of buckets.values()){
      const w=b.n*(b.s/b.n)*(1-Math.abs(b.l/b.n-55)/55);
      if(!best||w>best.w) best={w,b};
    }
    if(!best) return '#6750A4';                  // 全灰/全黑图: 退回默认紫
    const b=best.b, h=Math.round(b.h/b.n);
    const s=Math.min(100,Math.round(b.s/b.n*1.15));
    const l=Math.round(b.l/b.n);
    // Seed colors are clamped to mid lightness: too pale/dark and the whole role palette loses contrast
    return hslToHex(h, Math.max(28,s), l>70?58:(l<35?45:l));
  } finally { URL.revokeObjectURL(url); }
}
function rgbToHsl(r,g,b){
  r/=255; g/=255; b/=255;
  const mx=Math.max(r,g,b), mn=Math.min(r,g,b), l=(mx+mn)/2; let h=0, s=0;
  if(mx!==mn){
    const dd=mx-mn;
    s=l>0.5?dd/(2-mx-mn):dd/(mx+mn);
    switch(mx){ case r: h=(g-b)/dd+(g<b?6:0); break; case g: h=(b-r)/dd+2; break; default: h=(r-g)/dd+4; }
    h*=60;
  }
  return {h,s:s*100,l:l*100};
}

// ---- Optional admin API token input: top-bar key button, auto-opens on API 401 ----
function keyDlgVisible(){ return !$('#dlgOverlay').hidden && $('#dlgTitle').textContent==='管理令牌'; }
function openKeyDialog(){
  if(keyDlgVisible()) return;
  openDialog('管理令牌', `
    <div style="display:flex;flex-direction:column;gap:14px;padding-top:8px">
      <md-outlined-text-field data-f="key" label="管理 API 令牌(可选)" type="password" value="${escAttr(localStorage.getItem('agw-admin-key')||'')}"
        helper="面板登录请用 agw web login 的一次性链接; 这里只用于脚本/API 的 webToken"></md-outlined-text-field>
    </div>`, {okText:'保存', onOk:saveKey});
}
async function saveKey(){
  const k=String(dlgValue().key||'').trim();
  if(k) localStorage.setItem('agw-admin-key',k); else localStorage.removeItem('agw-admin-key');
  snack(k?'令牌已记住, 正在刷新…':'已清除记住的令牌, 正在刷新…');
  setTimeout(()=>location.reload(),600);
  return true;
}
// ---- Model rename tag editor (inside the channel dialog) ----
function renderMmChips(){
  const box=$('#mmChips'); if(!box) return;
  box.innerHTML=mmList.length?mmList.map(([k,v],i)=>
    '<span class="mm-chip" data-i="'+i+'"><span class="nm">'+esc(k)+'</span>'
    +(k===v?'':'<span class="arrow">→</span><span class="nm">'+esc(v)+'</span>')
    +'<button class="mm-x" data-i="'+i+'" aria-label="删除">✕</button></span>').join('')
    :'<span style="font-size:12px;color:var(--md-sys-color-on-surface-variant)">暂无映射 — 填上方两框后点 + 添加 (左滑标签或点 ✕ 删除)</span>';
}
function mmAdd(){
  const a=($('#mm-alias').value||'').trim(), r=($('#mm-real').value||'').trim();
  if(!a){ snack('先填左框(对外名)',true); return; }
  if(!/^[A-Za-z0-9_.\/:@+~-]+$/.test(a)){ snack('对外名建议只用字母/数字/._/:@+~-',true); return; }
  if(mmList.some(([k])=>k===a)){ snack('覆盖名 '+a+' 已存在',true); return; }
  mmList.push([a,r||a]);
  $('#mm-alias').value=''; $('#mm-real').value='';
  renderMmChips();
}
function mmDel(i){ mmList.splice(i,1); renderMmChips(); }
function mmBindSwipe(){
  const box=$('#mmChips'); let sx=0,sy=0,chip=null,idx=-1,dx=0;
  box.addEventListener('touchstart',e=>{
    const t=e.target.closest('.mm-chip'); if(!t) return;
    chip=t; idx=+t.dataset.i; sx=e.touches[0].clientX; sy=e.touches[0].clientY; dx=0;
    t.style.transition='none';
  },{passive:true});
  box.addEventListener('touchmove',e=>{
    if(!chip) return;
    dx=e.touches[0].clientX-sx;
    const dy=e.touches[0].clientY-sy;
    if(Math.abs(dx)>6&&Math.abs(dx)>Math.abs(dy)) chip.style.transform='translateX('+Math.max(-140,Math.min(140,dx))+'px)';
  },{passive:true});
  box.addEventListener('touchend',()=>{
    if(!chip) return;
if(Math.abs(dx)>64){ // swipe past the threshold -> delete
      chip.style.transition='transform .18s,opacity .18s';
      chip.style.transform='translateX('+(dx>0?160:-160)+'px)'; chip.style.opacity='0';
      const i=idx; setTimeout(()=>mmDel(i),180);
    } else { chip.style.transition='transform .18s'; chip.style.transform=''; }
    chip=null; idx=-1; dx=0;
  });
}
// Checkbox panel for a fetched model list (inserted at the top of the dialog; checking fills the Models field)
function mmShowModelPicker(list){
  const oldBox=$('#mmSelBox'); if(oldBox) oldBox.remove();
  const box=document.createElement('div');
  box.id='mmSelBox';
  box.style.cssText='border:1px solid var(--md-sys-color-outline-variant);border-radius:12px;padding:10px;max-height:230px;overflow-y:auto';
  const head=document.createElement('div');
  head.style.cssText='display:flex;align-items:center;gap:8px;margin-bottom:6px';
  head.innerHTML='<span style="font-size:12px;color:var(--md-sys-color-on-surface-variant)">已获取 '+list.length+' 个, 勾选后填入</span>'
    +'<button type="button" class="pbtn pbtn-text" id="mmSelAll" style="height:26px;padding:0 10px;margin-left:auto">全选</button>'
    +'<button type="button" class="pbtn pbtn-text" id="mmSelNone" style="height:26px;padding:0 10px">清空</button>'
    +'<button type="button" class="pbtn pbtn-filled" id="mmSelOk" style="height:26px;padding:0 12px">填入</button>'
    +'<button type="button" class="pbtn pbtn-text" id="mmSelX" style="height:26px;padding:0 8px" aria-label="关闭">✕</button>';
  box.appendChild(head);
  list.forEach(m=>{
    const lab=document.createElement('label');
    lab.style.cssText='display:flex;align-items:center;gap:6px;font-size:13px;padding:2px 0;cursor:pointer';
    const cb=document.createElement('input'); cb.type='checkbox'; cb.className='mm-sel'; cb.value=m; cb.checked=true;
    const sp=document.createElement('span'); sp.className='mono'; sp.textContent=m; sp.style.cssText='word-break:break-all';
    lab.appendChild(cb); lab.appendChild(sp); box.appendChild(lab);
  });
  box.addEventListener('click',e=>{
    const t=e.target.id;
    if(t==='mmSelAll') box.querySelectorAll('.mm-sel').forEach(c=>c.checked=true);
    else if(t==='mmSelNone') box.querySelectorAll('.mm-sel').forEach(c=>c.checked=false);
    else if(t==='mmSelOk'){
      const sel=[...box.querySelectorAll('.mm-sel')].filter(c=>c.checked).map(c=>c.value);
      if(!sel.length){ snack('至少勾选一个模型',true); return; }
      const f=$('#dlgBody [data-f=models]'); if(f) f.value=sel.join(', ');
      box.remove(); snack('已填入 '+sel.length+' 个模型');
    }
    else if(t==='mmSelX') box.remove();
  });
  // insert right above the Models field (not the dialog top) and scroll it into view
  const mf=$('#dlgBody [data-f=models]');
  if(mf && mf.parentNode) mf.parentNode.insertBefore(box, mf);
  else $('#dlgBody').prepend(box);
  try{ box.scrollIntoView({behavior:'smooth', block:'center'}); }
  catch(_){ try{ $('#dlgBody').scrollTop = box.offsetTop - 8; }catch(_2){} }
}
let providerDlgOrigName='';        // 打开渠道弹窗时的原渠道名(用于改名)
let providerDlgOrigUseResponses;   // the original useResponses (undefined = unset/auto passthrough; submitted only when the user flips it)
function openProviderDialog(ch){
  const c=ch||{name:'',type:'openai',baseUrl:'',proxy:'-',models:[],apiKey:'',default:false};
  providerDlgOrigName=ch?ch.name:'';
  providerDlgOrigUseResponses=ch?ch.useResponses:undefined;
  mmList=(c.modelMap?Object.entries(c.modelMap):[]);
  const pxs=Object.keys((Store.configs.get(Store.inst)||{}).proxies||{});
  const pOpts=['-'].concat(pxs); if(c.proxy&&!pOpts.includes(c.proxy)) pOpts.push(c.proxy);
  const curP=c.proxy||'-';
  openDialog(ch?'编辑渠道':'添加渠道', `
    <div style="display:flex;flex-direction:column;gap:14px;padding-top:8px">
      <md-outlined-text-field data-f="name" label="名称" value="${escAttr(c.name)}" required></md-outlined-text-field>
      <md-outlined-select data-f="type" label="类型" style="width:100%">
        ${['openai','claude','gemini'].map(t=>`<md-select-option value="${t}" ${t===c.type?'selected':''}>${t}</md-select-option>`).join('')}
      </md-outlined-select>
      <md-outlined-text-field data-f="baseUrl" label="Base URL" value="${escAttr(c.baseUrl)}" placeholder="https://…/v1"></md-outlined-text-field>
      <md-outlined-text-field data-f="path" label="固定路径 (可选)" value="${escAttr(c.path||'')}" placeholder="/v1/chat/completions" helper="填了则所有请求都发往 baseUrl+path, 忽略客户端路径与查询; 留空=自动"></md-outlined-text-field>
      <md-outlined-select data-f="proxy" label="代理(-为直连)" style="width:100%">
        ${pOpts.map(o=>`<md-select-option value="${escAttr(o)}" ${o===curP?'selected':''}>${o==='-'?'- 直连':esc(o)}</md-select-option>`).join('')}
      </md-outlined-select>
      <md-outlined-text-field data-f="models" label="模型(逗号分隔)" value="${escAttr((c.models||[]).join(', '))}"></md-outlined-text-field>
      <md-outlined-text-field data-f="delayMs" label="请求延迟(毫秒, 0=关闭)" type="number" value="${escAttr(String(c.delayMs||0))}" helper="每个请求发出前等待这么久; 同渠道并发请求按此间隔排队发出, 可缓解 429 限流"></md-outlined-text-field>
      <div>
        <div style="font-size:12px;color:var(--md-sys-color-on-surface-variant);margin-bottom:4px">模型改名 (对外名 → 真实名; 右框留空=按原名提供; 手机上左滑标签可删除; 对外名会出现在 /v1/models; 重启实例后生效)</div>
        <div class="mm-row">
          <md-outlined-text-field id="mm-alias" label="覆盖名(对外)"></md-outlined-text-field>
          <md-outlined-text-field id="mm-real" label="原始名(可空)"></md-outlined-text-field>
          <button type="button" class="mm-add-btn" id="mm-add" aria-label="添加"><span class="msym">add</span></button>
        </div>
        <div class="mm-chips" id="mmChips"></div>
      </div>
      <md-outlined-text-field data-f="apiKey" label="API Key" type="password" value="${escAttr(c.apiKey||'')}" placeholder="${c.hasKey?'(已设, 留空不改)':'API Key'}"></md-outlined-text-field>
      <label style="display:flex;align-items:center;gap:8px;font-size:14px"><md-checkbox data-f="useResponses" ${c.useResponses?'selected':''}></md-checkbox>上游用 Responses API <span class="muted small">(仅 openai 类型; 不勾=自动: Responses 客户端直通 /v1/responses, Chat 客户端直通 chat)</span></label>
      <label style="display:flex;align-items:center;gap:8px;font-size:14px"><md-checkbox data-f="probe" ${c.probe?'selected':''}></md-checkbox>参与成功率探测 <span class="muted small">(需实例开启 probe; 用户端可见成功率)</span></label>
      <div class="muted small" style="margin-top:4px">上游余额 (列表里 💰 按钮查; 三项留空 = 用内置预设)</div>
      <md-outlined-text-field data-f="balanceUrl" label="余额接口 URL (可相对 Base URL)" value="${escAttr(c.balanceUrl||'')}" placeholder="/v1/user/info"></md-outlined-text-field>
      <md-outlined-text-field data-f="balancePath" label="取值路径 (点路径)" value="${escAttr(c.balancePath||'')}" placeholder="data.balance"></md-outlined-text-field>
      <md-outlined-text-field data-f="balanceUnit" label="单位 (可选)" value="${escAttr(c.balanceUnit||'')}" placeholder="CNY"></md-outlined-text-field>
      <label style="display:flex;align-items:center;gap:8px;font-size:14px"><md-checkbox data-f="default" ${c.default?'selected':''}></md-checkbox>设为默认渠道</label>
    </div>`, {onOk:saveProvider});
  const s=$('#dlgBody [data-f=type]');
  s.updateComplete.then(()=>Promise.all([...s.querySelectorAll('md-select-option')].map(o=>o.updateComplete||0))).then(()=>s.value=c.type);
  const sp=$('#dlgBody [data-f=proxy]');
  if(sp) sp.updateComplete.then(()=>Promise.all([...sp.querySelectorAll('md-select-option')].map(o=>o.updateComplete||0))).then(()=>sp.value=curP).catch(()=>{});
  const cb=$('#dlgBody [data-f=default]'); if(c.default) cb.selected=true;
  const ur=$('#dlgBody [data-f=useResponses]'); if(c.useResponses) ur.selected=true;
  const pr=$('#dlgBody [data-f=probe]'); if(c.probe) pr.selected=true;
  const ma=$('#mm-alias');
  if(ma){
    $('#mm-add').addEventListener('click',mmAdd);
    [ma,$('#mm-real')].forEach(el=>el.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); mmAdd(); } }));
    $('#mmChips').addEventListener('click',e=>{ const x=e.target.closest('.mm-x'); if(x) mmDel(+x.dataset.i); });
    mmBindSwipe();
    renderMmChips();
  }
  const fb=$('#dlgFetch');
  if(fb){
    fb.hidden=false;
    fb.onclick=async ()=>{
      if(fb.disabled) return;
      const v=dlgValue();
      fb.disabled=true; fb.textContent='获取中…';
      try{
        const r=await adapter.fetchModels(Store.inst,{ name:String(v.name||'').trim(), type:v.type||'openai',
          baseUrl:String(v.baseUrl||'').trim(), apiKey:String(v.apiKey||'').trim(), proxy:v.proxy||'-' });
        const list=r.models||[];
        if(!list.length) snack('上游未返回任何模型',true);
        else mmShowModelPicker(list);
      }catch(e){ snack(e.message,true); }
      fb.disabled=false; fb.textContent='获取模型列表';
    };
  }
}
function openPortDialog(name){
  const i=Store.instances.find(x=>x.name===name)||{};
  openDialog(name?'编辑实例 '+name:'新建实例', `
    <div style="display:flex;flex-direction:column;gap:14px;padding-top:8px">
      <md-outlined-text-field data-f="name" label="实例名" value="${escAttr(i.name||'')}" ${(name==='default')?'disabled':''} required helper="${name?(name==='default'?'主实例不能改名':'改名会同步改配置文件名, 热生效'):'只能含字母/数字/中划线/下划线'}"></md-outlined-text-field>
      <md-outlined-text-field data-f="port" label="端口" type="number" value="${i.port||16390}" helper="${(i.tlsOn||(name&&name!=='default'))?'开 HTTPS 的实例只经主端口访问, 此端口仅作标识':'监听端口(开 HTTPS 后只提供 https)'}"></md-outlined-text-field>
      <md-outlined-text-field data-f="webToken" label="访问令牌" type="password" value="" helper="留空保存=清除访问令牌"></md-outlined-text-field>
      <label style="display:flex;align-items:center;gap:8px;font-size:14px"><md-switch data-f="tls" ${i.tlsOn?'selected':''}></md-switch>启用 HTTPS</label>
      ${(name&&name!=='default'&&name!==Store.currentName)?`<md-text-button data-action="delInstance" data-name="${escAttr(name)}" style="color:var(--md-sys-color-error);align-self:flex-start;margin-top:2px">删除实例</md-text-button>`:''}
    </div>`, {onOk:()=>savePortSettings(name)});
if(name){ // edit mode: fetch the real config to backfill port/TLS/admin password (revealed in plaintext, WYSIWYG)
    portDlgOrigKey=undefined;
    adapter.getConfig(name).then(c=>{
      const q=f=>$('#dlgBody [data-f='+f+']');
      if(q('port')) q('port').value=(c.port!=null?c.port:16384);
      const sw=q('tls'); if(sw) sw.selected=!!(c.tls&&c.tls.enable);
      portDlgOrigKey=c.webToken||'';
      if(q('webToken')) q('webToken').value=portDlgOrigKey;
    }).catch(()=>{});
  }
}

// ============ Save actions ============
//// create/edit an instance (the ports page dialog's OK). editName present = edit, otherwise create.
async function savePortSettings(editName){
  const v=dlgValue();
  const name=String(editName||v.name||'').trim();
  const port=Number(v.port);
  const adminKey=String(v.webToken||'').trim();
  const tlsOn=!!($('#dlgBody [data-f=tls]')&&$('#dlgBody [data-f=tls]').selected);
  if(!/^[A-Za-z0-9_-]{1,32}$/.test(name)){ snack('实例名只能含字母/数字/中划线/下划线(最长32字符)',true); return false; }
  if(!port||port<1024||port>65535){ snack('HTTP 端口范围 1024-65535',true); return false; }
  try{
if(editName){ // ---- edit an existing instance ----
      let effName=editName;
if(name!==editName){ // ---- rename: call the rename API first (hot), later saves use the new name ----
        await adapter.renameInstance(editName,name);
        effName=name;
        snack('实例已改名: '+editName+' → '+name);
      }
      const cur=await adapter.getConfig(effName);
      const patch={ port, host:(cur&&cur.host)||'0.0.0.0',
        tls:Object.assign({},(cur&&cur.tls)||{},{ enable:tlsOn }) };
      delete patch.tls.port;
      // admin password: submit only when different from the backfilled value (empty = remove it); untouched when backfill failed (unknown)
      if(portDlgOrigKey!==undefined && adminKey!==portDlgOrigKey) patch.webToken=adminKey;
      await adapter.saveConfig(effName,patch);
      snack('已保存实例 '+effName);
      if(editName===Store.currentName&&cur&&cur.port&&Number(cur.port)!==port)
        snack('面板实例端口已改为 '+port+', 稍后请用新地址访问面板',true);
      let running=false;
      try{ const d=await adapter.getInstances(); running=!!(d.instances||[]).find(x=>x.name===effName&&x.running); }catch(_){}
      if(running) doInstanceAction(effName,'restart'); else renderPorts();
}else{ // ---- create a new instance ----
      const tls={ enable:tlsOn };
if(tlsOn){ // reuse an existing instance's certificate (certs can be shared across instances); none available -> fall back to pure HTTP
        try{
          const d=await adapter.getInstances();
          const names=(d.instances||[]).map(x=>x.name);
          for(const n of names){
            try{
              const c=await adapter.getConfig(n);
              if(c&&c.tls&&c.tls.cert&&c.tls.key){ tls.cert=c.tls.cert; tls.key=c.tls.key; break; }
            }catch(_){}
          }
          if(!tls.cert){ tls.enable=false; snack('没有找到可用证书, 已按纯 HTTP 创建',true); }
        }catch(_){ tls.enable=false; }
      }
      await adapter.createInstance(name,{ port, host:'0.0.0.0', tls, webToken:adminKey });
      snack('实例 '+name+' 已创建, 正在启动…');
      try{ await adapter.action(name,'start'); }catch(_){}
      renderPorts();
    }
  }catch(e){ snack(e.message,true); return false; }
  return true;
}
// ---- Proxy server management (add/edit/remove; whole-array replace via saveConfig's proxies) ----
function openProxyDialog(name){
  const cur=Store.configs.get(Store.inst);
  const p=(cur&&cur.proxies&&cur.proxies[name])||{};
  openDialog(name?'编辑代理 '+name:'添加代理', `
    <div style="display:flex;flex-direction:column;gap:14px;padding-top:8px">
      <md-outlined-text-field data-f="name" label="名称" value="${escAttr(name||'')}" ${name?'disabled':''} required helper="渠道里用这个名字引用"></md-outlined-text-field>
      <md-outlined-select data-f="type" label="类型" style="width:100%">
        ${['socks5','http'].map(t=>`<md-select-option value="${t}" ${t===(p.type||'socks5')?'selected':''}>${t}</md-select-option>`).join('')}
      </md-outlined-select>
      <md-outlined-text-field data-f="host" label="服务器地址" value="${escAttr(p.host||'127.0.0.1')}" required></md-outlined-text-field>
      <md-outlined-text-field data-f="port" label="端口" type="number" value="${p.port||7890}"></md-outlined-text-field>
      <md-outlined-text-field data-f="username" label="用户名(可选)" value="${escAttr(p.username||'')}"></md-outlined-text-field>
      <md-outlined-text-field data-f="password" label="密码(可选)" type="password" value="${escAttr(p.password||'')}"></md-outlined-text-field>
    </div>`, {onOk:()=>saveProxy(name)});
  const s=$('#dlgBody [data-f=type]');
  if(s) s.updateComplete.then(()=>Promise.all([...s.querySelectorAll('md-select-option')].map(o=>o.updateComplete||0))).then(()=>s.value=p.type||'socks5').catch(()=>{});
}
async function saveProxy(origName){
  const v=dlgValue();
  const name=String(origName||v.name||'').trim();
  const host=String(v.host||'').trim();
  const port=Number(v.port);
  if(!name){ snack('名称必填',true); return false; }
  if(!/^[A-Za-z0-9_-]{1,32}$/.test(name)){ snack('代理名只能含字母/数字/中划线/下划线',true); return false; }
  if(!host){ snack('服务器地址必填',true); return false; }
  if(!port||port<1||port>65535){ snack('端口范围 1-65535',true); return false; }
  try{
    const cur=await adapter.getConfig(Store.inst);
    const proxies=Object.assign({},(cur&&cur.proxies)||{});
    if(!origName&&proxies[name]){ snack('代理 '+name+' 已存在',true); return false; }
    const entry={ type:v.type||'socks5', host, port };
    const un=String(v.username||'').trim(), pw=String(v.password||'');
    if(un) entry.username=un;
else if(origName&&(cur.proxies[origName]||{}).username) entry.username=cur.proxies[origName].username; // empty = keep the old value
    if(pw) entry.password=pw;
    else if(origName&&(cur.proxies[origName]||{}).password) entry.password=cur.proxies[origName].password;
    proxies[name]=entry;
    await adapter.saveConfig(Store.inst,{proxies});
    snack(origName?('代理 '+name+' 已保存'):'代理 '+name+' 已添加');
    await renderProviders();
  }catch(e){ snack(e.message,true); return false; }
  return true;
}
async function delProxy(name){
  if(!name) return;
  try{
    const cur=await adapter.getConfig(Store.inst);
    const used=(cur.channels||[]).filter(c=>c.proxy===name).map(c=>c.name);
    const msg=used.length
      ? `确定删除代理 ${name}? 渠道 ${used.join(', ')} 正在引用它, 删除后这些渠道的代理会失效!`
      : `确定删除代理 ${name}?`;
    if(!confirm(msg)) return;
    const proxies=Object.assign({},(cur&&cur.proxies)||{});
    delete proxies[name];
    await adapter.saveConfig(Store.inst,{proxies});
    snack('代理 '+name+' 已删除');
    await renderProviders();
  }catch(e){ snack(e.message,true); }
}
async function saveProvider(){
  const v=dlgValue();
  if(!v.name||!v.baseUrl){ snack('名称与 Base URL 必填',true); return false; }
  // the model rename map comes from the tag editor (mmList); public -> real name; identical = served under the original name
  const modelMap={};
  for(const [k,r] of mmList) modelMap[k]=r;
  const ch={ name:v.name, type:v.type||'openai', baseUrl:v.baseUrl, path:String(v.path||'').trim(), proxy:v.proxy||'-',
    models:String(v.models||'').split(',').map(s=>s.trim()).filter(Boolean),
    apiKey:v.apiKey||'', default:!!v.default,
// Upstream balance passthrough: always send (empty string = clear); the backend inherits only on omission -- otherwise one channel edit wipes the balance config
// Upstream passthrough-to-Responses is three-state: unset (undefined) = auto passthrough /v1/responses; the field is submitted only when the user explicitly changes the checkbox,
// otherwise omit (avoids an edit baking undefined into false and silently killing Responses passthrough)
    balanceUrl:String(v.balanceUrl||'').trim(), balancePath:String(v.balancePath||'').trim(), balanceUnit:String(v.balanceUnit||'').trim(),
    probe:!!($('#dlgBody [data-f=probe]')&&$('#dlgBody [data-f=probe]').selected) };
// useResponses stays three-state: the field is submitted only when the user explicitly flipped the checkbox; otherwise omitted (undefined = auto passthrough /v1/responses)
  const urEl=$('#dlgBody [data-f=useResponses]');
  const urNow=!!(urEl&&urEl.selected);
  if(!!providerDlgOrigUseResponses!==urNow) ch.useResponses=urNow;
  const delayMs=Math.max(0,Math.min(120000,+v.delayMs||0));
if(delayMs) ch.delayMs=delayMs; // 0 = omit, clearing the old value
if(providerDlgOrigName && providerDlgOrigName!==ch.name) ch.oldName=providerDlgOrigName; // rename
if(Object.keys(modelMap).length) ch.modelMap=modelMap; // never send an arrow-less empty map, so an existing one is not wiped
  try{ await adapter.saveChannel(Store.inst,ch);
    snack('已保存渠道 '+ch.name+(Object.keys(modelMap).length?' (改名映射重启实例后生效)':''));
    await renderProviders(); }
  catch(e){ snack(e.message,true); return false; }
  return true;
}
async function saveKeys(){
  try{
    const patch={gatewayKey:$('#ky-gatewayKey').value, webToken:$('#ky-webToken').value, channels:{}};
    $$('#ky-channels [data-keyfor]').forEach(el=>{ patch.channels[el.dataset.keyfor]=el.value; });
    await adapter.saveConfig(Store.inst,patch); snack('密钥已保存'); await renderKeys();
  }catch(e){ snack(e.message,true); }
}
async function saveRouting(){
  try{
    await adapter.saveConfig(Store.inst,{routing:{
      maxRetry:+$('#rt-maxRetry').value||0, timeoutSec:+$('#rt-timeout').value||0, cooldownSec:+$('#rt-cooldown').value||0 },
      redact:{enable:!!$('#rt-redact').selected, response:!!$('#rt-redactRes').selected,
        extra:$('#rt-redactExtra').value.split('\n').map(x=>x.trim()).filter(Boolean)},
      modelSync:{enable:!!$('#rt-modelSync').selected, intervalHours:+$('#rt-syncInterval').value||24}});
    snack('已保存 (热重载生效)'); await renderRouting();
  }catch(e){ snack(e.message,true); }
}
async function doInstanceAction(name,cmd){
  if(cmd==='stop'&&name===Store.currentName){ snack('不能停止承载面板的实例',true); return; }
  try{
    await adapter.action(name,cmd); snack(`${name} ${cmd} 指令已发送`);
    if(cmd==='restart'){ let n=0; const ping=setInterval(async()=>{ n++;
      try{ await adapter.getInstances(); clearInterval(ping); snack(`${name} 已恢复`); renderPorts(); }
      catch(_){ if(n>20){ clearInterval(ping); snack(`${name} 未在 20 秒内恢复，请检查日志`,true); } } },1000); }
    else setTimeout(renderPorts,800);
  }catch(e){ snack(e.message,true); }
}

// Delete instance (button in the edit dialog): after confirmation, stops + removes config; irreversible
async function delInstance(name){
  if(!name||name==='default'||name===Store.currentName) return;
  if(!confirm('确定删除实例 '+name+' ? 将停止它并删除其配置文件, 不可恢复!')) return;
  try{
    await adapter.deleteInstance(name);
    $('#dlgOverlay').hidden=true;
    snack('实例 '+name+' 已删除');
    renderPorts();
  }catch(e){ snack(e.message,true); }
}

// ============ Render: panel sessions ============
function fmtDateTime(ms){ try{ return new Date(ms).toLocaleString('zh-CN',{hour12:false}); }catch(_){ return String(ms); } }
function fmtLeft(ms){
  const d=Math.round((ms-Date.now())/1000);
  if(d<=0) return '已过期';
  if(d<3600) return Math.ceil(d/60)+' 分钟后';
  if(d<86400) return Math.ceil(d/3600)+' 小时后';
  return Math.ceil(d/86400)+' 天后';
}
function ssRows(list, kind){
  if(!list.length) return '<tr><td colspan="3" class="empty">'+(kind==='pend'?'登录链接不保存在面板中':'没有有效会话')+'</td></tr>';
  return list.map(s=>`<tr>
    <td class="mono truncate" title="${escAttr(s.sid)}">${esc(String(s.sid).slice(0,10))}…</td>
    <td class="small">${esc(fmtDateTime(s.exp))}<span class="muted"> · ${esc(fmtLeft(s.exp))}</span></td>
    <td><div class="row-acts"><button type="button" class="icon-act err" data-action="revokeSession" data-sid="${escAttr(s.sid)}" title="注销该会话"><span class="msym">logout</span></button></div></td></tr>`).join('');
}
async function renderSession(){
  const signal=Store.abort('session');
  try{
    const d=await adapter.getWebSessions(signal);
    $('#ss-table tbody').innerHTML=ssRows(d.sessions||[], 'sess');
    $('#ss-pend tbody').innerHTML=ssRows(d.pending||[], 'pend');
    const at=Number(d.adminExpireAt)||0;
    $('#ss-expire-state').textContent=at?('已设定: '+fmtDateTime(at)+' ('+fmtLeft(at)+')'):'未设定';
    const inp=$('#ss-expire-at');
    if(inp) inp.value=at?new Date(at-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16):'';
  }catch(e){ if(e.name!=='AbortError') snack(e.message,true); }
}
async function revokeSession(sid){
  const msg=sid?'确定注销这个会话? 对应浏览器需要重新用登录链接进入。':'确定注销全部会话? 包括当前这个浏览器, 之后要重新 agw web login。';
  if(!confirm(msg)) return;
  try{
    await adapter.revokeWebSession(sid);
    snack('已注销');
    if(sid) renderSession();
    else setTimeout(()=>location.reload(),600);
  }catch(e){ snack(e.message,true); }
}
async function setAdminExpire(){
  const v=$('#ss-expire-at')?.value;
  if(!v){ snack('先选一个时间',true); return; }
  const at=new Date(v).getTime();
  if(!(at>0)){ snack('时间无效',true); return; }
  try{ await adapter.setAdminExpire(at); snack('已设定定时注销: '+fmtDateTime(at)); renderSession(); }
  catch(e){ snack(e.message,true); }
}
async function clearAdminExpire(){
  try{ await adapter.setAdminExpire(0); snack('已取消定时注销'); renderSession(); }
  catch(e){ snack(e.message,true); }
}

// ============ Statistics charts (plain canvas) ============
function cvCtx(id, h){
  const cv=$('#'+id); if(!cv) return null;
  const dpr=window.devicePixelRatio||1;
  const w=Math.max(160, Math.floor(cv.clientWidth||cv.parentElement?.clientWidth||320));
  cv.width=Math.round(w*dpr); cv.height=Math.round(h*dpr); cv.style.height=h+'px';
  const cx=cv.getContext('2d'); cx.setTransform(dpr,0,0,dpr,0,0); cx.clearRect(0,0,w,h);
  cx.font='11px system-ui,-apple-system,"Noto Sans SC",sans-serif'; cx.textBaseline='middle';
  return {cx,w,h};
}
function cssVar(n, fb){ const v=getComputedStyle(document.documentElement).getPropertyValue(n).trim(); return v||fb; }
function shortNum(n){ n=Number(n)||0;
  if(n>=1e9) return (n/1e9).toFixed(1)+'B';
  if(n>=1e6) return (n/1e6).toFixed(1)+'M';
  if(n>=1e3) return (n/1e3).toFixed(n>=1e4?0:1)+'K';
  return String(Math.round(n));
}
function drawDailyChart(days){
  const H=200, g=cvCtx('st-chart-daily',H); if(!g) return;
  const {cx,w,h}=g;
  const onSurf=cssVar('--md-sys-color-on-surface-variant','#9a9a9a');
  const prim=cssVar('--md-sys-color-primary','#D0BCFF'), tert=cssVar('--md-sys-color-tertiary','#EFB8C8');
  const padL=42, padR=10, padT=20, padB=24, iw=w-padL-padR, ih=h-padT-padB;
  if(!days.length){ cx.fillStyle=onSurf; cx.fillText('暂无数据 (需有请求流过)', padL, h/2); return; }
  const max=Math.max(1, ...days.map(d=>Math.max(d.in,d.out)));
  cx.strokeStyle=cssVar('--md-sys-color-outline-variant','#444'); cx.lineWidth=1;
  for(let i=0;i<=3;i++){
    const y=Math.round(padT+ih*i/3)+.5;
    cx.beginPath(); cx.moveTo(padL,y); cx.lineTo(w-padR,y); cx.stroke();
    cx.fillStyle=onSurf; cx.fillText(shortNum(max*(1-i/3)), 6, y);
  }
  const slot=iw/days.length, bw=Math.max(2, Math.min(9, slot/3.2));
  days.forEach((d,i)=>{
    const x=padL+slot*i;
    [[d.in,prim],[d.out,tert]].forEach(([v,c],k)=>{
      if(!(v>0)) return;
      const bh=Math.max(2, ih*v/max);
      cx.fillStyle=c;
      cx.fillRect(x+(slot-(bw*2+2))/2+k*(bw+2), padT+ih-bh, bw, bh);
    });
    if(days.length<=8 || i%Math.ceil(days.length/6)===0){
      cx.fillStyle=onSurf; cx.textAlign='center';
      cx.fillText(d.label, x+slot/2, padT+ih+12);
      cx.textAlign='left';
    }
  });
  cx.fillStyle=prim; cx.fillRect(w-padR-116, 3, 8, 8);
  cx.fillStyle=onSurf; cx.fillText('输入', w-padR-104, 7);
  cx.fillStyle=tert; cx.fillRect(w-padR-64, 3, 8, 8);
  cx.fillStyle=onSurf; cx.fillText('输出', w-padR-52, 7);
}
function drawModelChart(rows){
  const H=200, g=cvCtx('st-chart-model',H); if(!g) return;
  const {cx,w,h}=g;
  const onSurf=cssVar('--md-sys-color-on-surface-variant','#9a9a9a');
  const prim=cssVar('--md-sys-color-primary','#D0BCFF');
  const track=cssVar('--md-sys-color-surface-container-highest','#2a2a2a');
  const top=(rows||[]).slice(0,8);
  if(!top.length){ cx.fillStyle=onSurf; cx.fillText('暂无数据', 12, h/2); return; }
  const max=Math.max(1, ...top.map(r=>r.sum));
  const padL=Math.min(132, Math.max(64, w*0.32)), padR=56, padT=6, padB=6;
  const ih=h-padT-padB, rowH=ih/top.length, barH=Math.min(16, rowH*0.55);
  top.forEach((r,i)=>{
    const cy=padT+rowH*i+rowH/2;
    const bw=Math.max(2, (w-padL-padR)*r.sum/max);
    cx.fillStyle=track; cx.fillRect(padL, cy-barH/2, w-padL-padR, barH);
    cx.fillStyle=prim;  cx.fillRect(padL, cy-barH/2, bw, barH);
    // model names right-aligned + truncated
    let nm=String(r.name||'');
    const maxW=padL-8;
    while(nm.length>3 && cx.measureText(nm).width>maxW) nm=nm.slice(0,-2);
    cx.fillStyle=onSurf; cx.textAlign='right'; cx.fillText(nm, padL-6, cy); cx.textAlign='left';
    cx.fillStyle=onSurf; cx.fillText(shortNum(r.sum), Math.min(w-padR+4, padL+bw+6), cy);
  });
}

// ============ Events (centralized delegation) ============
document.body.addEventListener('click', e=>{
  const nav=e.target.closest('[data-page]');
  if(nav?.dataset.page){
    if(nav.closest('#dlgBody')) $('#dlgOverlay').hidden=true;
    go(nav.dataset.page); return;
  }
  const jump=e.target.closest('[data-goto]');
  if(jump?.dataset.goto){ go(jump.dataset.goto); return; }
  const act=e.target.closest('[data-action]');
  if(act){
    const a=act.dataset.action, n=act.dataset.name;
    if(a==='editProvider'){ const cfg=Store.configs.get(Store.inst); openProviderDialog(cfg?.channels?.find(c=>c.name===n)); }
    else if(a==='setDefaultProvider'){ setDefaultChannel(n); }
    else if(a==='deleteProvider'){ if(confirm(`删除渠道 ${n}?`)) adapter.deleteChannel(Store.inst,n).then(renderProviders).catch(x=>snack(x.message,true)); }
    else if(a==='openPortDialog') openPortDialog(n);
    else if(a==='delInstance') delInstance(n);
    else if(a==='copyKey'||a==='toggleKey'||a==='delKey'||a==='rechargeKey') cardAction(a,act.dataset.key,act.dataset.name,act.dataset.on==='1');
    else if(a==='chBalance') chBalanceAction(act.dataset.name);
    else if(a==='editProxy') openProxyDialog(n);
    else if(a==='delProxy') delProxy(n);
    else if(a==='viewBody') viewRecordBody(act.dataset.id);
    else if(a==='cwDel') cwDel(+act.dataset.i);
    else if(a==='revokeSession') revokeSession(act.dataset.sid||'');
    return;
  }
  const cmdBtn=e.target.closest('[data-cmd]');
  if(cmdBtn?.dataset.cmd) doInstanceAction(cmdBtn.dataset.name, cmdBtn.dataset.cmd);
});
$('#navbar').addEventListener('navigation-bar-activated', e=>{
  const t=e.detail?.tab, page=t?.dataset?.page;
  if(!page) return;
  if(page==='__more'){ openViewSheet(); syncNav(); return; }
  go(page);
});
$('#dlgOk').addEventListener('click', async ()=>{
  const btn=$('#dlgOk'); btn.disabled=true;
  try{
    const ok = dlgOnOk ? await dlgOnOk() : true;
    if(ok!==false) $('#dlgOverlay').hidden=true;
  } finally { btn.disabled=false; }
});
$('#dlgCancel').addEventListener('click', ()=>$('#dlgOverlay').hidden=true);
$('#dlgX').addEventListener('click', ()=>$('#dlgOverlay').hidden=true);
$('#dlgOverlay').addEventListener('click', e=>{ if(e.target===e.currentTarget) $('#dlgOverlay').hidden=true; });
$('#pv-add').addEventListener('click',()=>openProviderDialog());
$('#px-add').addEventListener('click',()=>openProxyDialog());
['out','inc'].forEach(dir=>{
  const add=$('#rp-'+dir+'-add');
  if(!add) return;
  add.addEventListener('click',()=>rpAdd(dir));
  [$('#rp-'+dir+'-find'),$('#rp-'+dir+'-to')].forEach(el=>el&&el.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); rpAdd(dir); } }));
  rpBindSwipe(dir);
  $('#rp-'+dir+'-chips').addEventListener('click',e=>{ const x=e.target.closest('.mm-x'); if(x) rpDel(dir,+x.dataset.i); });
});
const rpTestOut=$('#rp-test-out-btn'), rpTestInc=$('#rp-test-inc-btn');
if(rpTestOut) rpTestOut.addEventListener('click',()=>{ const rules=rpCompileCli(rpLists.out); const r=rpApplyCli($('#rp-test-in')?$('#rp-test-in').value:'',rules); $('#rp-test-result').textContent = r===''?'(空)':r; });
if(rpTestInc) rpTestInc.addEventListener('click',()=>{ const rules=rpCompileCli(rpLists.inc); const r=rpApplyCli($('#rp-test-in')?$('#rp-test-in').value:'',rules); $('#rp-test-result').textContent = r===''?'(空)':r; });
  $('#pt-new').addEventListener('click',()=>openPortDialog());
  $('#cd-new').addEventListener('click',()=>openCardDialog());
  // second factor
  $('#ka-save-second').addEventListener('click',async()=>{ try{ await adapter.setAdminAuth(Store.inst,{secondKey:$('#ka-secondKey').value}); snack('第二密码已保存'); loadAdminAuth(Store.inst); }catch(e){ snack(e.message,true); } });
  $('#ka-totp-enable').addEventListener('click',async()=>{ try{ const r=await adapter.setAdminAuth(Store.inst,{totpAction:'enable'}); if(r.totpSecret){ $('#ka-totp-info').style.display=''; $('#ka-totp-secret').textContent=r.totpSecret; $('#ka-totp-url').textContent=r.otpauthUrl||''; } snack('TOTP 已启用, 请立即扫码保存密钥!'); loadAdminAuth(Store.inst); }catch(e){ snack(e.message,true); } });
  $('#ka-totp-disable').addEventListener('click',async()=>{ try{ await adapter.setAdminAuth(Store.inst,{totpAction:'disable'}); snack('TOTP 已停用'); loadAdminAuth(Store.inst); }catch(e){ snack(e.message,true); } });
  $('#rg-save').addEventListener('click',saveCardSettings);
// Tunnel
  $('#tn-toggle').addEventListener('click',async()=>{ try{ const d=await adapter.getTunnel(); await adapter.tunnelAction(d.running?'stop':'start'); snack(d.running?'隧道已停止':'隧道启动中…'); setTimeout(loadTunnel,1500); }catch(e){ snack(e.message,true); } });
  $('#tn-copy').addEventListener('click',()=>{ const t=$('#tn-url').textContent; if(t){ navigator.clipboard&&navigator.clipboard.writeText(t); snack('已复制'); } });
$('#rt-save').addEventListener('click',saveRouting);
$('#rt-reset').addEventListener('click',renderRouting);
$('#rt-syncNow').addEventListener('click', async ()=>{
  const btn=$('#rt-syncNow'); btn.disabled=true; const old='立即同步'; btn.textContent='同步中…';
  try{ const r=await adapter.syncModels(Store.inst);
    snack('已同步: '+r.added+' 个新模型'+(r.fails?', '+r.fails+' 失败':''));
    await renderRouting();
  }catch(e){ snack(e.message,true); }
  btn.disabled=false; btn.textContent=old;
});
$('#ky-save').addEventListener('click',saveKeys);
$('#ss-revoke-all').addEventListener('click',()=>revokeSession(''));
$('#ss-expire-set').addEventListener('click',setAdminExpire);
$('#ss-expire-clear').addEventListener('click',clearAdminExpire);
$('#rq-refresh').addEventListener('click',renderRequests);
$('#rq-rec-save').addEventListener('click',saveRecCfg);
$('#rq-rec-enable').addEventListener('change',saveRecCfg);
$('#lg-refresh').addEventListener('click',renderLogs);
$('#refreshBtn').addEventListener('click',()=>{ go(Store.page); });
$('#refreshBtn').addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ go(Store.page); } });
$('#modeChip').addEventListener('click',()=>{
  Store.adapter = Store.adapter==='mock'?'http':'mock';
  adapter = Store.adapter==='mock' ? new MockAdapter() : new HttpAdapter();
  $('#modeChip').label = Store.adapter==='mock'?'Mock':'HTTP';
  $('#modeChipIc').textContent = Store.adapter==='mock'?'inventory_2':'public';
  localStorage.setItem('agw-mode',Store.adapter);
  go(Store.page);
});
$('#topInst').addEventListener('change', e=>{ Store.inst=e.target.value; go(Store.page); });
$('#ch-send').addEventListener('click',sendChat);
$('#ch-input').addEventListener('keydown', e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendChat(); } });
$('#ch-clear').addEventListener('click',()=>{
  const n=Store.chat.messages.length;
  if(!n){ snack('没有可清空的消息'); return; }
  if(!confirm(`确定清空全部 ${n} 条消息? 此操作不可撤销。`)) return;
  Store.chat.messages=[]; Store.chat.streaming=false; renderChatMessages(true); snack('已清空');
});
$('#ch-jump').addEventListener('click',()=>{ const b=$('#ch-messages'); if(b){ chatStick=true; b.scrollTop=b.scrollHeight; chatUpdateJump(); } });
$('#ch-messages')?.addEventListener('scroll',()=>{ chatStick=chatAtBottom(); chatUpdateJump(); });
$('#ch-messages')?.addEventListener('click', e=>{
  const b=e.target.closest('.chat-copy'); if(!b) return;
  const m=Store.chat.messages[+b.dataset.copy]; if(m) copyText(m.content);
});
$('#ch-model').addEventListener('change', e=>{ Store.chat.model=e.target.value; });
window.addEventListener('online',()=>{ Store.online=true; });
window.addEventListener('offline',()=>{ Store.online=false; snack('网络已断开',true); });

// ============ Boot ============
if(!MW_OK){
  $('#compatBar').textContent='⚠ Material Web 组件库 (/auth/vendor/mw-v2.js) 加载失败，页面将只有无样式内容。请确认文件已部署。';
  $('#compatBar').classList.add('show');
}
$('#keyBtn').addEventListener('click',openKeyDialog);
$('#thBtn').addEventListener('click',openThemeDialog);
// ?key=<webToken> one-click token access: store in localStorage and scrub from the address bar
try{
  const u=new URL(location.href);
  const k=u.searchParams.has('key')?u.searchParams.get('key'):'';
  if(k!=null){
    if(k) localStorage.setItem('agw-admin-key',k); else localStorage.removeItem('agw-admin-key');
    u.searchParams.delete('key'); history.replaceState(null,'',u);
  }
}catch(_){}
upgradePwFields(document.body);
// ---- Custom brand name (edit via the brand area top-left; stored in localStorage, per device) ----
let brandState={name:'AI Gateway',ver:'Material Web v2.11'};
function applyBrand(b){
  brandState={name:(b&&b.name)||'AI Gateway', ver:b&&b.ver!=null?b.ver:'Material Web v2.11'};
  const n=$('.rail-brand .name'), v=$('.rail-brand .ver');
  if(n) n.textContent=brandState.name;
  if(v){ v.textContent=brandState.ver; v.style.display=brandState.ver?'':'none'; }
  document.title=brandState.name+(brandState.ver?' · '+brandState.ver:'');
}
function loadBrand(){ try{ applyBrand(JSON.parse(localStorage.getItem('agw-brand')||'null')); }catch(_){ applyBrand(null); } }
function openBrandDialog(){
  openDialog('修改页面名称', `<div style="display:flex;flex-direction:column;gap:14px;padding-top:8px">
    <md-outlined-text-field data-f="bname" label="名称" value="${escAttr(brandState.name)}"></md-outlined-text-field>
    <md-outlined-text-field data-f="bver" label="副标题(留空隐藏)" value="${escAttr(brandState.ver)}"></md-outlined-text-field>
  </div>`, {onOk:()=>{
    const v=dlgValue();
    const name=String(v.bname||'').trim()||'AI Gateway', ver=String(v.bver||'').trim();
    applyBrand({name,ver});
    try{ localStorage.setItem('agw-brand',JSON.stringify({name,ver})); }catch(_){}
    snack('页面名称已更新');
    return true;
  }});
}
loadBrand();
$('#railBrand').addEventListener('click', openBrandDialog);
loadTheme();
buildNav();
if(localStorage.getItem('agw-mode')==='mock'){
  Store.adapter='mock'; adapter=new MockAdapter(); $('#modeChip').label='Mock'; $('#modeChipIc').textContent='inventory_2';
}
// Never let a slow/hung first /admin/api/instances call block the whole boot:
// render the default page after at most 6s; the per-page render has its own 20s abort guard.
await Promise.race([
  fillInstSelect($('#topInst'), Store.inst).catch(()=>{}),
  new Promise(r=>setTimeout(r,6000)),
]);
go(Store.page);
let chartResizeT=0;
window.addEventListener('resize',()=>{
  clearTimeout(chartResizeT);
  chartResizeT=setTimeout(()=>{
    const c=Store.charts;
    if(c && Store.page==='stats'){ drawDailyChart(c.daily); drawModelChart(c.models); }
  },150);
});
console.log('[AI Gateway] Material Web 面板已初始化 · 组件库', MW_OK?'就绪':'缺失');
