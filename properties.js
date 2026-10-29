(function (root, factory) {
  'use strict';
  const api = factory(() => root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RegalProperties = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (getRoot) {
  'use strict';
  const KEY = 'regal-properties-v1', TZID = 'America/New_York';
  const text = (v, max = 500) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  function validDate(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const [y,m,d] = v.split('-').map(Number), x = new Date(Date.UTC(y,m-1,d));
    return x.getUTCFullYear()===y && x.getUTCMonth()===m-1 && x.getUTCDate()===d;
  }
  function businessDate(now = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:TZID,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  function addMonths(date, months) {
    if (!validDate(date) || !Number.isInteger(Number(months)) || Number(months)<1 || Number(months)>120) throw new RangeError('Choose a valid service date and interval from 1 to 120 months.');
    const [y,m,d]=date.split('-').map(Number), target= new Date(Date.UTC(y,m-1+Number(months),1));
    const day=Math.min(d,new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate());
    return `${target.getUTCFullYear()}-${String(target.getUTCMonth()+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }
  function normalize(value, prior = {}) {
    const v=value&&typeof value==='object'?value:{};
    const p={id:text(v.id||prior.id||makeId(),100),name:text(v.name,160),phone:text(v.phone,60),email:text(v.email,254),address:text(v.address,240),rooms:text(v.rooms,1000),notes:text(v.notes,2000),accessInstructions:text(v.accessInstructions,1000),pets:text(v.pets,500),parking:text(v.parking,500),lastServiceDate:v.lastServiceDate||'',nextDueDate:v.nextDueDate||'',intervalMonths:v.intervalMonths===''||v.intervalMonths==null?null:Number(v.intervalMonths),archived:v.archived===true,createdAt:prior.createdAt||v.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
    if(!p.name) throw new Error('Enter a customer name.');
    if(p.lastServiceDate&&!validDate(p.lastServiceDate)) throw new Error('Choose a real last service date.');
    if(p.nextDueDate&&!validDate(p.nextDueDate)) throw new Error('Choose a real next due date.');
    if(p.intervalMonths!==null&&(!Number.isInteger(p.intervalMonths)||p.intervalMonths<1||p.intervalMonths>120)) throw new Error('Repeat interval must be 1 to 120 whole months.');
    if(p.lastServiceDate&&p.intervalMonths!=null&&!p.nextDueDate) p.nextDueDate=addMonths(p.lastServiceDate,p.intervalMonths);
    return p;
  }
  function makeId(){return `property-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`;}
  function createStore(storage) {
    let memory=null, loadError=null;
    const read=()=>{if(memory)return memory;if(!storage){memory=[];return memory;}const raw=storage.getItem(KEY);if(raw==null){memory=[];return memory;}try{const parsed=JSON.parse(raw);if(!Array.isArray(parsed))throw new Error('Saved property data has an invalid format.');memory=parsed.filter(x=>x&&typeof x==='object').map(x=>normalize(x,x));loadError=null;return memory;}catch(e){loadError=new Error('Saved property data could not be read; it was left untouched.');loadError.cause=e;throw loadError;}};
    function save(next){const cleanRows=next.map(x=>normalize(x,x));if(storage){try{storage.setItem(KEY,JSON.stringify(cleanRows));}catch(e){const err=new Error('Could not save properties on this device. Existing saved data was kept.');err.cause=e;throw err;}}memory=cleanRows;loadError=null;return cleanRows;}
    return {key:KEY,load:()=>read().map(x=>({...x})),get:id=>read().find(x=>x.id===id)||null,upsert(value){const rows=read(), prior=rows.find(x=>x.id===value?.id);const item=normalize(value,prior||{});save(prior?rows.map(x=>x.id===item.id?item:x):[...rows,item]);return {...item};},archive(id){const item=this.get(id);if(!item)throw new Error('Property profile was not found.');return this.upsert({...item,archived:true});},reopen(id){const item=this.get(id);if(!item)throw new Error('Property profile was not found.');return this.upsert({...item,archived:false});},getError:()=>loadError};
  }
  function recordCustomer(record) {
    const c=record?.customer&&typeof record.customer==='object'?record.customer:{};
    const rawRooms=record?.rooms;
    const rooms=Array.isArray(rawRooms)?rawRooms.map((room,index)=>{
      if(typeof room==='string'||typeof room==='number')return text(room,80);
      if(!room||typeof room!=='object')return '';
      const name=text(room.name||room.roomName||room.label||`Room ${index+1}`,60),surface=text(room.surface,24);
      return surface?`${name} (${surface})`:name;
    }).filter(Boolean).join(', '):typeof rawRooms==='string'||typeof rawRooms==='number'?text(rawRooms,100):record?.roomCount!=null?`${text(record.roomCount,4)} rooms`:'';
    return {name:text(typeof record?.customer==='string'?record.customer:record?.customerName||c.name||record?.name,160),phone:text(record?.phone||c.phone,60),email:text(record?.email||c.email,254),address:text(record?.address||record?.serviceAddress||c.address,240),rooms};
  }
  function findCustomers(records, query='') {
    const q=text(query,200).toLowerCase(), result=[];
    for(const r of Array.isArray(records)?records:[]){if(!r||typeof r!=='object')continue;const c=recordCustomer(r);if(!c.name)continue;const key=c.address?`${c.name.toLowerCase()}|${c.address.toLowerCase()}`:`${c.name.toLowerCase()}|${c.phone}`;if(q&&!Object.values(c).join(' ').toLowerCase().includes(q))continue;const duplicate=result.find(x=>x.key===key);if(duplicate){for(const field of ['phone','email','address','rooms'])if(!duplicate[field]&&c[field])duplicate[field]=c[field];continue;}result.push({key,...c,sourceRecordId:r.id||''});}
    return result;
  }
  async function findCustomersAsync(getRecords, query='') {
    const records=typeof getRecords==='function'?await getRecords():[];
    return findCustomers(records,query);
  }
  function reminders(profiles, now = new Date(), windowDays = 30) {
    const today=businessDate(now), limit=new Date(`${today}T12:00:00Z`);limit.setUTCDate(limit.getUTCDate()+windowDays);const until=limit.toISOString().slice(0,10);
    return (Array.isArray(profiles)?profiles:[]).filter(p=>p&&!p.archived&&validDate(p.nextDueDate)&&p.nextDueDate<=until).map(p=>({...p,state:p.nextDueDate<today?'overdue':p.nextDueDate===today?'due':'upcoming'})).sort((a,b)=>a.nextDueDate.localeCompare(b.nextDueDate));
  }
  function reminderDraft(profile, businessName='Regal Carpet Cleaning') {
    const name=text(profile?.name,120)||'there', biz=text(businessName,120)||'Regal Carpet Cleaning';
    return `Hi ${name},\n\nThis is ${biz}. It may be time to schedule your carpet service. Reply here if you would like to find a convenient date.\n\nThank you!`;
  }
  function install({host,getRecords=()=>[],storage}={}) {
    const root=getRoot(),doc=root?.document,target=typeof host==='string'?doc?.querySelector(host):host;if(!doc?.createElement||!target)throw new Error('Property host element was not found.');
    const store=createStore(storage||root.localStorage), el=(tag,cls,value)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(value!=null)n.textContent=value;return n;};
    const page=el('section','properties-layout'), title=el('h2','','Customer properties'), hint=el('p','','Saved on this device. Reminders are drafts only; no messages are sent automatically.');page.append(title,hint);
    const search=el('input');search.type='search';search.maxLength=200;search.placeholder='Search saved customers or properties';search.setAttribute('aria-label','Search saved customer properties');page.append(search);
    const matchHost=el('div','property-matches'), list=el('div','property-list'), form=el('form','property-form');form.noValidate=true;form.append(el('h3','','Customer property profile'));const fields={};
    const specs=[['name','Customer name','text',160],['phone','Phone','tel',60],['email','Email','email',254],['address','Service address','text',240],['rooms','Rooms / areas','text',1000],['notes','Service notes','textarea',2000],['accessInstructions','Access instructions','textarea',1000],['pets','Pets','text',500],['parking','Parking','text',500],['lastServiceDate','Last service date','date',10],['nextDueDate','Next due date','date',10],['intervalMonths','Repeat interval · months','number',3]];
    for(const [key,label,type,max] of specs){const wrap=el('label','property-field');wrap.append(el('span','',label));const input=doc.createElement(type==='textarea'?'textarea':'input');if(type!=='textarea')input.type=type;input.maxLength=max;if(key==='intervalMonths'){input.min='1';input.max='120';input.step='1';}fields[key]=input;wrap.append(input);form.append(wrap);}
    const buttons=el('div','property-actions'), save=el('button','primary','Save profile'), clear=el('button','secondary','New profile');save.type='submit';clear.type='button';buttons.append(save,clear);form.append(buttons);const message=el('p','property-message');message.setAttribute('role','status');form.append(message);
    const confirm=el('div','property-inline-confirm');confirm.hidden=true;confirm.setAttribute('role','group');const confirmText=el('p'),keep=el('button','secondary','Keep editing'),discard=el('button','secondary','Discard changes');keep.type=discard.type='button';confirm.append(confirmText,keep,discard);form.append(confirm);page.append(matchHost,list,form);target.replaceChildren(page);
    let editing=null,dirty=false,pendingAction=null,cachedRecords=[],recordRevision=0;
    function snapshot(){return Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v.value]));}
    function reset(){editing=null;dirty=false;pendingAction=null;form.reset();form.querySelector('h3').textContent='Customer property profile';save.textContent='Save profile';confirm.hidden=true;message.textContent='';}
    function guard(action,prompt){if(!dirty){action();return;}pendingAction=action;confirmText.textContent=prompt;confirm.hidden=false;keep.focus();}
    function edit(p){editing=p;dirty=false;for(const k of Object.keys(fields))fields[k].value=p[k]??'';form.querySelector('h3').textContent='Edit customer property';save.textContent='Save changes';message.textContent='';confirm.hidden=true;}
    function renderMatches(){matchHost.replaceChildren();const q=search.value.trim().toLowerCase();let profiles=[];try{profiles=store.load().filter(p=>!q||[p.name,p.phone,p.email,p.address,p.rooms,p.notes,p.accessInstructions,p.pets,p.parking].join(' ').toLowerCase().includes(q));}catch(e){message.textContent=e.message;}
      if(profiles.length){matchHost.append(el('h3','','Saved property profiles'));for(const p of profiles.slice(0,8)){const card=el('article','property-match');card.append(el('strong','',`${p.name}${p.archived?' · archived':''}`));if(p.address)card.append(el('p','',p.address));const b=el('button','secondary','Edit profile');b.type='button';b.addEventListener('click',()=>guard(()=>edit(p),'Discard unsaved property changes and edit this profile?'));card.append(b);matchHost.append(card);}}
      const rows=findCustomers(cachedRecords,search.value);if(rows.length){matchHost.append(el('h3','','Saved service records'));for(const c of rows.slice(0,8)){const card=el('article','property-match');card.append(el('strong','',c.name));if(c.address)card.append(el('p','',c.address));const b=el('button','secondary','Use customer details');b.type='button';b.addEventListener('click',()=>guard(()=>{for(const k of ['name','phone','email','address','rooms'])if(c[k])fields[k].value=c[k];dirty=true;},'Discard unsaved property changes and use these customer details?'));card.append(b);matchHost.append(card);}}}
    async function loadRecords(){const revision=++recordRevision;try{const rows=typeof getRecords==='function'?await getRecords():[];if(revision!==recordRevision)return;cachedRecords=Array.isArray(rows)?rows:[];renderMatches();}catch(e){message.textContent=`Could not load saved service records: ${text(e?.message||'Please try again.',180)}`;}}
    function render(){list.replaceChildren();let rows;try{rows=store.load();}catch(e){message.textContent=e.message;save.disabled=true;return;}save.disabled=false;const due=reminders(rows);if(due.length){list.append(el('h3','','Repeat-service reminders'));for(const p of due){const card=el('article','property-reminder');card.append(el('strong','',`${p.name} · ${p.state} ${p.nextDueDate}`));if(p.phone)card.append(el('p','',p.phone));const draft=el('textarea','property-reminder-draft',reminderDraft(p));draft.readOnly=true;draft.setAttribute('aria-label',`Message draft for ${p.name}`);card.append(draft);const copy=el('button','secondary','Copy draft');copy.type='button';copy.addEventListener('click',async()=>{try{await root.navigator.clipboard.writeText(draft.value);message.textContent='Draft copied. Review it before sending.';}catch(_){draft.focus();draft.select();message.textContent='Select and copy this draft. Nothing was sent.';}});card.append(copy);list.append(card);}}
      const q=search.value.trim().toLowerCase(), matching=rows.filter(p=>!q||[p.name,p.phone,p.email,p.address,p.rooms,p.notes,p.accessInstructions,p.pets,p.parking].join(' ').toLowerCase().includes(q));const active=matching.filter(x=>!x.archived), archived=matching.filter(x=>x.archived);list.append(el('h3','','Saved customer properties'));if(!matching.length)list.append(el('p','property-empty','No matching saved property profiles.'));for(const p of [...active,...archived]){const card=el('article','property-card');card.append(el('strong','',`${p.name}${p.archived?' · archived':''}`));if(p.address)card.append(el('p','',p.address));if(p.phone)card.append(el('p','',p.phone));if(p.rooms)card.append(el('p','',`Rooms: ${p.rooms}`));if(p.lastServiceDate)card.append(el('p','',`Last service: ${p.lastServiceDate}${p.nextDueDate?` · next due: ${p.nextDueDate}`:''}`));if(p.notes)card.append(el('p','',p.notes));const editBtn=el('button','secondary','Edit profile');editBtn.type='button';editBtn.addEventListener('click',()=>guard(()=>edit(p),'Discard unsaved property changes and edit this profile?'));const archive=el('button','secondary',p.archived?'Reopen profile':'Archive profile');archive.type='button';archive.addEventListener('click',()=>{try{p.archived?store.reopen(p.id):store.archive(p.id);root.dispatchEvent?.(new root.CustomEvent('regal:data-changed',{detail:{source:'properties'}}));render();}catch(e){message.textContent=e.message;}});card.append(editBtn,archive);list.append(card);}}
    form.addEventListener('input',e=>{if(e.target!==search){dirty=true;confirm.hidden=true;}});form.addEventListener('change',e=>{if(e.target!==search){dirty=true;confirm.hidden=true;}});
    form.addEventListener('submit',e=>{e.preventDefault();try{const p=store.upsert({...snapshot(),...(editing?{id:editing.id,createdAt:editing.createdAt}:{})});editing=p;dirty=false;confirm.hidden=true;message.textContent='Property profile saved on this device.';root.dispatchEvent?.(new root.CustomEvent('regal:data-changed',{detail:{source:'properties',id:p.id}}));render();renderMatches();}catch(err){message.textContent=err.message;}});
    clear.addEventListener('click',()=>guard(reset,'Discard unsaved property changes and start a new profile?'));keep.addEventListener('click',()=>{pendingAction=null;confirm.hidden=true;});discard.addEventListener('click',()=>{const action=pendingAction;reset();if(action)action();});search.addEventListener('input',()=>{render();renderMatches();});render();renderMatches();loadRecords();
    return {store,refresh(){render();return loadRecords();},destroy(){recordRevision++;target.replaceChildren();}};
  }
  return {KEY,TZID,validDate,businessDate,addMonths,normalize,createStore,findCustomers,findCustomersAsync,reminders,reminderDraft,install};
});
