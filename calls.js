(function (root, factory) {
  'use strict';
  const api = factory(() => root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RegalCalls = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (getRoot) {
  'use strict';
  const KEY = 'regal-calls-v1';
  const TYPES = ['incoming', 'outgoing', 'missed', 'voicemail', 'manual'];
  const STATUSES = ['new', 'contacted', 'quoted', 'booked', 'closed'];
  const text = (v, max = 500) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  function normalizePhone(value) {
    const raw = text(value, 60);
    if (!raw || /[^\d+().\s-]/.test(raw) || (raw.match(/\+/g) || []).length > 1 || (raw.includes('+') && !raw.startsWith('+'))) return '';
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits[0] === '1' && (!raw.startsWith('+') || raw.startsWith('+1'))) return `+${digits}`;
    return '';
  }
  function validateLead(input) {
    const lead = input && typeof input === 'object' ? input : {};
    const errors = {};
    if (!text(lead.name, 160)) errors.name = 'Enter a contact name.';
    if (lead.phone && !normalizePhone(lead.phone)) errors.phone = 'Enter a valid US phone number.';
    if (lead.email && !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(text(lead.email, 254))) errors.email = 'Enter a valid email address.';
    if (!TYPES.includes(lead.type)) errors.type = 'Choose a call type.';
    if (!STATUSES.includes(lead.status)) errors.status = 'Choose a status.';
    if (lead.callbackAt && !Number.isFinite(Date.parse(lead.callbackAt))) errors.callbackAt = 'Choose a valid callback date and time.';
    return { valid: Object.keys(errors).length === 0, errors };
  }
  function lookupCustomers(records, phoneOrQuery) {
    const list = Array.isArray(records) ? records.filter(x => x && typeof x === 'object') : [];
    const query = text(phoneOrQuery, 200), phone = normalizePhone(query);
    if (phone) {
      const matches = list.filter(r => normalizePhone(r.phone || r.customer?.phone || '') === phone);
      const groups = [];
      for (const record of matches) {
        const name = text(typeof record.customer === 'string' ? record.customer : record.customer?.name || record.customerName || record.name || 'Unnamed customer', 160);
        const address = text(record.address || record.serviceAddress || record.customer?.address || '', 240);
        let group = groups.find(g => g.customer.toLowerCase() === name.toLowerCase() && g.address.toLowerCase() === address.toLowerCase());
        if (!group) groups.push(group = { key: `${name}|${address}`, customer: name, address, phone, jobs: [] });
        group.jobs.push(record);
      }
      return groups;
    }
    if (!query) return [];
    const tool = getRoot()?.RegalCustomerTools;
    const found = typeof tool?.findHistory === 'function' ? tool.findHistory(list, query) : list.filter(r => `${r.customer?.name || r.customer || ''} ${r.customerName || r.name || ''} ${r.address || r.serviceAddress || ''} ${r.phone || ''} ${r.email || ''}`.toLowerCase().includes(query.toLowerCase()));
    const groups = [];
    for (const record of found) {
      const name = text(typeof record.customer === 'string' ? record.customer : record.customer?.name || record.customerName || record.name || 'Unnamed customer', 160);
      const address = text(record.address || record.serviceAddress || record.customer?.address || '', 240);
      let group = groups.find(g => g.customer.toLowerCase() === name.toLowerCase() && g.address.toLowerCase() === address.toLowerCase());
      if (!group) groups.push(group = { key: `${name}|${address}`, customer: name, address, phone: normalizePhone(record.phone || record.customer?.phone || ''), jobs: [] });
      group.jobs.push(record);
    }
    return groups;
  }
  function listCallbacks(leads, now = new Date()) {
    const time = now instanceof Date ? now.getTime() : Date.parse(now);
    return (Array.isArray(leads) ? leads : []).filter(l => l && l.status !== 'closed' && l.callbackAt && !l.callbackDone && Number.isFinite(Date.parse(l.callbackAt)))
      .map(lead => ({ lead, at: Date.parse(lead.callbackAt), state: Date.parse(lead.callbackAt) <= time ? 'due' : 'upcoming' }))
      .sort((a, b) => a.at - b.at);
  }
  function createStore(storage) {
    const target = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!target) throw new Error('Local storage is unavailable. Calls could not be saved.');
    function load() {
      let raw;
      try { raw = target.getItem(KEY); } catch (e) { throw new Error(`Calls could not be read: ${e.message}`); }
      if (raw == null || raw === '') return [];
      let data;
      try { data = JSON.parse(raw); } catch (_) { throw new Error('Calls data is damaged. It was left unchanged; export or recover it before saving new calls.'); }
      if (!Array.isArray(data) || data.some(x => !x || typeof x !== 'object' || typeof x.id !== 'string')) throw new Error('Calls data has an unexpected format. It was left unchanged.');
      return data;
    }
    function save(leads) {
      if (!Array.isArray(leads)) throw new TypeError('Calls must be a list.');
      try { target.setItem(KEY, JSON.stringify(leads)); } catch (e) { throw new Error(`Calls could not be saved: ${e.message}`); }
      return leads;
    }
    function upsert(input) {
      const validation = validateLead(input);
      if (!validation.valid) throw Object.assign(new Error('Check the call details.'), { errors: validation.errors });
      const leads = load(), old = leads.find(x => x.id === input.id);
      const now = new Date().toISOString();
      const callbackAt = input.callbackAt ? new Date(input.callbackAt).toISOString() : null;
      const row = { ...old, ...input, id: old?.id || input.id || `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, createdAt: old?.createdAt || input.createdAt || now,
        name: text(input.name, 160), phone: normalizePhone(input.phone) || '', email: text(input.email, 254), address: text(input.address, 240), type: input.type, status: input.status,
        notes: text(input.notes, 4000), callbackAt, callbackDone: !!input.callbackDone && callbackAt === old?.callbackAt, linkedQuoteId: input.linkedQuoteId || old?.linkedQuoteId || null, updatedAt: now };
      const index = leads.findIndex(x => x.id === row.id);
      if (index < 0) leads.unshift(row); else leads[index] = row;
      save(leads); return row;
    }
    return { load, save, upsert };
  }
  const when = (value) => { const d = new Date(value); return Number.isNaN(d.getTime()) ? 'Date unavailable' : d.toLocaleString(); };
  const dateInput = value => { const d = new Date(value); if (Number.isNaN(d.getTime())) return ''; const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return local.toISOString().slice(0, 16); };
  function install({ host, getRecords, onStartQuote, onDueCount, storage } = {}) {
    const root = getRoot(), doc = root?.document, target = typeof host === 'string' ? doc?.querySelector(host) : host;
    if (!doc?.createElement || !target) throw new Error('Calls & Leads host element was not found.');
    const store = createStore(storage || root.localStorage);
    let editing = null, dirty = false, disposed = false, query = '', filter = 'all', matchRevision = 0, pendingAction = null;
    const el = (tag, cls, value) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (value != null) n.textContent = value; return n; };
    const page = el('section', 'calls-page'); page.setAttribute('aria-labelledby', 'calls-title');
    const title = el('h2', '', 'Calls & Leads'); title.id = 'calls-title'; page.appendChild(title);
    page.appendChild(el('p', 'calls-local-note', 'Enter calls manually. Call details stay on this device. Callback reminders appear here while this page is open.'));
    const summary = el('div', 'callbacks-summary'); summary.setAttribute('aria-live', 'polite'); page.appendChild(summary);
    const layout = el('div', 'calls-layout'), form = el('form', 'calls-form'); form.noValidate = true;
    const formTitle = el('h3', '', 'New call'); form.appendChild(formTitle);
    const fields = {};
    function field(name, label, type = 'text', opts = {}) {
      const wrap = el('label', 'calls-field'); wrap.appendChild(el('span', '', label)); let input;
      if (opts.select) { input = el('select'); for (const [v, t] of opts.select) { const o = el('option', '', t); o.value = v; input.appendChild(o); } }
      else if (opts.textarea) input = el('textarea'); else { input = el('input'); input.type = type; }
      input.name = name; input.id = `calls-${name}`; if (opts.required) input.required = true; if (opts.maxLength) input.maxLength = opts.maxLength;
      input.addEventListener('input', () => { dirty = true; if (name === 'phone' || name === 'name' || name === 'address') renderMatches(); });
      input.addEventListener('change', () => { dirty = true; }); wrap.appendChild(input); fields[name] = input; form.appendChild(wrap); return input;
    }
    field('name', 'Contact name', 'text', { required: true, maxLength: 160 }); field('phone', 'Phone', 'tel', { maxLength: 60 }); field('email', 'Email', 'email', { maxLength: 254 }); field('address', 'Service address', 'text', { maxLength: 240 });
    field('type', 'Call type', 'text', { select: [['incoming','Incoming'],['outgoing','Outgoing'],['missed','Missed'],['voicemail','Voicemail'],['manual','Manual note']] });
    field('status', 'Status', 'text', { select: [['new','New'],['contacted','Contacted'],['quoted','Quoted'],['booked','Booked'],['closed','Closed']] });
    field('notes', 'Notes', 'text', { textarea: true, maxLength: 4000 }); field('callbackAt', 'Callback date and time', 'datetime-local');
    const matchHost = el('div', 'calls-matches'); matchHost.setAttribute('aria-live','polite'); form.appendChild(matchHost);
    const confirmHost = el('div','calls-inline-confirm'); confirmHost.hidden = true; confirmHost.setAttribute('role','group'); confirmHost.setAttribute('aria-label','Confirm form change');
    const confirmText = el('p'); const keepButton = el('button','','Keep editing'); keepButton.type='button'; const discardButton=el('button','','Discard changes'); discardButton.type='button'; confirmHost.append(confirmText,keepButton,discardButton); form.appendChild(confirmHost);
    const actions = el('div', 'calls-form-actions'), saveButton = el('button', '', 'Save call'); saveButton.type = 'submit';
    const clearButton = el('button', '', 'Clear form'); clearButton.type = 'button'; actions.append(saveButton, clearButton); form.appendChild(actions); const formMessage = el('p','calls-form-message'); formMessage.setAttribute('role','status'); form.appendChild(formMessage);
    const listPane = el('section', 'calls-list-pane'); listPane.setAttribute('aria-label','Saved calls and leads');
    const controls = el('div','calls-list-controls'); const search = el('input'); search.type='search'; search.placeholder='Search calls and leads'; search.setAttribute('aria-label','Search calls and leads');
    const filterSelect=el('select'); filterSelect.setAttribute('aria-label','Filter calls and leads'); for(const [v,t] of [['all','All calls and leads'],['open','Open leads'],['callbacks','Callbacks']]){const o=el('option','',t);o.value=v;filterSelect.appendChild(o);} controls.append(search,filterSelect);listPane.appendChild(controls);
    const list = el('div','calls-list'); listPane.appendChild(list); layout.append(form,listPane); page.appendChild(layout); target.replaceChildren(page);
    function snapshot(){ return {name:fields.name.value,phone:fields.phone.value,email:fields.email.value,address:fields.address.value,type:fields.type.value,status:fields.status.value,notes:fields.notes.value,callbackAt:fields.callbackAt.value?new Date(fields.callbackAt.value).toISOString():null,callbackDone:editing?.callbackDone||false,linkedQuoteId:editing?.linkedQuoteId||null,...(editing?{id:editing.id,createdAt:editing.createdAt}: {})}; }
    function reset(){editing=null;dirty=false;pendingAction=null;confirmHost.hidden=true;form.reset();fields.type.value='incoming';fields.status.value='new';formTitle.textContent='New call';saveButton.textContent='Save call';formMessage.textContent='';matchHost.replaceChildren();}
    async function records(){return Promise.resolve(typeof getRecords==='function'?getRecords():[]).catch(()=>[]);}
    function renderMatches(){const revision=++matchRevision;matchHost.replaceChildren();const q=fields.phone.value||fields.name.value||fields.address.value;if(!q)return;records().then(rows=>{if(disposed||revision!==matchRevision)return;const groups=lookupCustomers(rows,q);if(!groups.length)return;matchHost.appendChild(el('h4','','Possible saved customer history'));for(const group of groups){const box=el('article','calls-match');box.appendChild(el('strong','',group.customer));if(group.address)box.appendChild(el('p','',group.address));const latest=[...group.jobs].sort((a,b)=>(Date.parse(b.completedAt||b.updatedAt)||0)-(Date.parse(a.completedAt||a.updatedAt)||0))[0];const date=latest?.completedAt||latest?.updatedAt;box.appendChild(el('p','',`${group.jobs.length} saved ${group.jobs.length===1?'record':'records'}${date?` · latest ${when(date)}`:''} · history is not merged automatically`));const use=el('button','','Fill contact details');use.type='button';use.addEventListener('click',()=>{fields.name.value=group.customer;if(group.phone)fields.phone.value=group.phone;else if(latest?.phone)fields.phone.value=latest.phone;fields.email.value=latest?.email||latest?.customer?.email||fields.email.value;fields.address.value=group.address;dirty=true;});box.appendChild(use);matchHost.appendChild(box);}});}
    function render(){if(disposed)return;let leads;try{leads=store.load();}catch(e){formMessage.textContent=e.message;list.replaceChildren(el('p','calls-storage-error',e.message));return;}const callbacks=listCallbacks(leads,new Date()), due=callbacks.filter(x=>x.state==='due').length;summary.textContent=`${due} callback${due===1?'':'s'} due · ${callbacks.length-due} upcoming`;if(typeof onDueCount==='function')onDueCount(due);
      list.replaceChildren();let shown=leads.filter(l=>{if(filter==='open'&&['closed','booked'].includes(l.status))return false;if(filter==='callbacks'&&!l.callbackAt)return false;return !query||`${l.name} ${l.phone} ${l.email} ${l.address} ${l.notes} ${l.status} ${l.type}`.toLowerCase().includes(query.toLowerCase());});
      if(!shown.length){list.appendChild(el('p','calls-empty',leads.length?'No calls match this view.':'No calls saved yet. Add a call manually to get started.'));return;}
      const ordered=[...shown].sort((a,b)=>(Date.parse(b.updatedAt||b.createdAt)||0)-(Date.parse(a.updatedAt||a.createdAt)||0));
      for(const lead of ordered){const card=el('article','lead-card');const h=el('h3','',lead.name);card.appendChild(h);card.appendChild(el('p','lead-meta',`${lead.type} · ${lead.status} · ${when(lead.createdAt)}`));if(lead.phone)card.appendChild(el('p','',lead.phone));if(lead.email)card.appendChild(el('p','',lead.email));if(lead.address)card.appendChild(el('p','',lead.address));if(lead.notes)card.appendChild(el('p','lead-notes',lead.notes));
        if(lead.callbackAt){const at=Date.parse(lead.callbackAt),state=lead.callbackDone?'completed':at<=Date.now()?'overdue':'upcoming';card.appendChild(el('p',`callback-badge callback-${state}`,`Callback ${state}: ${when(lead.callbackAt)}`));if(!lead.callbackDone){const done=el('button','','Mark callback done');done.type='button';done.addEventListener('click',()=>{try{store.upsert({...lead,callbackDone:true});render();}catch(e){formMessage.textContent=e.message;}});card.appendChild(done);}}
        const edit=el('button','','Edit');edit.type='button';edit.addEventListener('click',()=>{if(dirty){askDiscard(()=>loadForEdit(lead),'Discard unsaved form changes and edit this saved call?');return;}loadForEdit(lead);});card.appendChild(edit);
        if(typeof onStartQuote==='function'){const quote=el('button','','Start quote');quote.type='button';quote.addEventListener('click',()=>onStartQuote(lead));card.appendChild(quote);}list.appendChild(card);}
    }
    function askDiscard(action,message){pendingAction=action;confirmText.textContent=message;confirmHost.hidden=false;keepButton.focus();}
    function loadForEdit(lead){editing=lead;for(const key of Object.keys(fields)){fields[key].value=key==='callbackAt'?dateInput(lead.callbackAt):lead[key]||'';}dirty=false;confirmHost.hidden=true;formTitle.textContent='Edit call';saveButton.textContent='Save changes';formMessage.textContent='';form.scrollIntoView?.({behavior:'smooth',block:'start'});}
    keepButton.addEventListener('click',()=>{pendingAction=null;confirmHost.hidden=true;});discardButton.addEventListener('click',()=>{const action=pendingAction;reset();if(action)action();});
    form.addEventListener('submit',event=>{event.preventDefault();try{const value=snapshot(),check=validateLead(value);if(!check.valid){formMessage.textContent=Object.values(check.errors)[0];return;}store.upsert(value);reset();formMessage.textContent='Call saved on this device.';render();}catch(e){formMessage.textContent=e.message;}});
    clearButton.addEventListener('click',()=>{if(dirty){askDiscard(reset,'Discard unsaved call details?');return;}reset();});search.addEventListener('input',()=>{query=search.value;render();});filterSelect.addEventListener('change',()=>{filter=filterSelect.value;render();});
    const onFocus=()=>render(); root.addEventListener?.('focus',onFocus); const timer=root.setInterval?.(render,60000); render();
    return {refresh:render,ready:Promise.resolve(),markQuoted(leadId,quoteId){const lead=store.load().find(row=>row.id===leadId);if(!lead)return null;const status=['booked','closed'].includes(lead.status)?lead.status:'quoted';const updated=store.upsert({...lead,status,linkedQuoteId:quoteId||null});render();return updated;},dispose(){disposed=true;root.removeEventListener?.('focus',onFocus);if(timer)root.clearInterval(timer);target.replaceChildren();}};
  }
  return { KEY, TYPES, STATUSES, normalizePhone, validateLead, lookupCustomers, listCallbacks, createStore, install };
});
