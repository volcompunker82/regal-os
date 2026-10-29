(function (root, factory) {
  'use strict';
  const api = factory(() => root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RegalCalendar = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (getRoot) {
  'use strict';
  const KEY = 'regal-appointments-v1';
  const SETTINGS_KEY = 'regal-scheduling-defaults-v1';
  const TZID = 'America/New_York';
  const DEFAULT_SCHEDULING = Object.freeze({ minutesPerRoom: 60, setupCleanupMinutes: 15, travelBufferMinutes: 15 });
  const STATUSES = ['scheduled', 'confirmed', 'enroute', 'inprogress', 'completed', 'cancelled'];
  const ACTIVE = new Set(['scheduled', 'confirmed', 'enroute', 'inprogress']);
  const STATUS_LABELS = { scheduled: 'Scheduled', confirmed: 'Confirmed', enroute: 'En route', inprogress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
  const clean = (v, max = 500) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const validDate = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number), date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  };
  const validTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  function businessDate(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZID, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const value = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
    return `${value.year}-${value.month}-${value.day}`;
  }
  function validateAppointment(value) {
    const a = value && typeof value === 'object' ? value : {}, errors = {};
    if (!clean(a.name, 160)) errors.name = 'Enter a customer name.';
    if (String(a.name || '').length > 160) errors.name = 'Customer name is too long.';
    if (a.phone && String(a.phone).length > 60) errors.phone = 'Phone number is too long.';
    if (!clean(a.address, 240)) errors.address = 'Enter a service address.';
    if (String(a.address || '').length > 240) errors.address = 'Service address is too long.';
    if (!validDate(a.date)) errors.date = 'Choose a real calendar date.';
    if (!validTime(a.startTime)) errors.startTime = 'Choose a valid start time.';
    if (!validTime(a.endTime)) errors.endTime = 'Choose a valid end time.';
    if (validTime(a.startTime) && validTime(a.endTime) && a.endTime <= a.startTime) errors.endTime = 'End time must be after start time on the same day.';
    if (!STATUSES.includes(a.status)) errors.status = 'Choose an appointment status.';
    if (String(a.technician || '').length > 100) errors.technician = 'Technician name is too long.';
    if (String(a.notes || '').length > 2000) errors.notes = 'Notes are too long.';
    if (a.roomCount != null && a.roomCount !== '' && (!Number.isInteger(Number(a.roomCount)) || Number(a.roomCount) < 1 || Number(a.roomCount) > 100)) errors.roomCount = 'Room count must be a whole number from 1 to 100.';
    if (a.estimatedDurationMinutes != null && a.estimatedDurationMinutes !== '' && (!Number.isInteger(Number(a.estimatedDurationMinutes)) || Number(a.estimatedDurationMinutes) < 1 || Number(a.estimatedDurationMinutes) > 1440)) errors.estimatedDurationMinutes = 'Estimated duration must be a whole number from 1 to 1,440 minutes.';
    for (const [key, label] of [['estimatedDriveMinutes','Drive estimate'],['estimatedDistanceMiles','Distance estimate']]) {
      if (a[key] != null && a[key] !== '' && (!Number.isFinite(Number(a[key])) || Number(a[key]) < 0)) errors[key] = `${label} must be a finite number of zero or more.`;
    }
    return { valid: Object.keys(errors).length === 0, errors };
  }
  function validateSchedulingDefaults(value) {
    const errors = {};
    for (const [key, label] of [['minutesPerRoom','Minutes per room'],['setupCleanupMinutes','Setup and cleanup'],['travelBufferMinutes','Travel buffer']]) {
      if (!Number.isInteger(Number(value?.[key])) || Number(value[key]) < 0 || Number(value[key]) > 720) errors[key] = `${label} must be a whole number from 0 to 720.`;
    }
    if (!Object.keys(errors).length && Number(value.minutesPerRoom) === 0 && Number(value.setupCleanupMinutes) === 0) errors.minutesPerRoom = 'The room and setup/cleanup estimate must total at least one minute.';
    return { valid: Object.keys(errors).length === 0, errors };
  }
  function normalizeSchedulingDefaults(value) {
    const result = { ...DEFAULT_SCHEDULING, ...(value || {}) };
    const check = validateSchedulingDefaults(result);
    if (!check.valid) throw Object.assign(new Error(Object.values(check.errors)[0]), { errors: check.errors });
    return { minutesPerRoom: Number(result.minutesPerRoom), setupCleanupMinutes: Number(result.setupCleanupMinutes), travelBufferMinutes: Number(result.travelBufferMinutes) };
  }
  function estimateDuration(roomCount, settings = DEFAULT_SCHEDULING) {
    const rooms = Number(roomCount);
    if (!Number.isInteger(rooms) || rooms < 1 || rooms > 100) return null;
    const defaults = normalizeSchedulingDefaults(settings);
    const duration=rooms * defaults.minutesPerRoom + defaults.setupCleanupMinutes;
    return duration > 0 ? duration : null;
  }
  function estimatedEndTime(startTime, durationMinutes) {
    if (!validTime(startTime) || !Number.isInteger(durationMinutes) || durationMinutes < 1) return null;
    const [h,m] = startTime.split(':').map(Number), end = h*60 + m + durationMinutes;
    if (end > 23*60+59) return null;
    return `${String(Math.floor(end/60)).padStart(2,'0')}:${String(end%60).padStart(2,'0')}`;
  }
  function clearAutoEstimatedEnd(currentEndTime, autoEstimatedEnd) { return autoEstimatedEnd && currentEndTime === autoEstimatedEnd ? '' : currentEndTime; }
  function findConflicts(appointments, candidate) {
    if (!candidate || !validDate(candidate.date) || !validTime(candidate.startTime) || !validTime(candidate.endTime) || !clean(candidate.technician)) return [];
    const tech = clean(candidate.technician, 100).toLowerCase();
    if (!ACTIVE.has(candidate.status)) return [];
    return (Array.isArray(appointments) ? appointments : []).filter(a => a && a.id !== candidate.id && a.date === candidate.date &&
      ACTIVE.has(a.status) && clean(a.technician, 100).toLowerCase() === tech && validTime(a.startTime) && validTime(a.endTime) &&
      candidate.startTime < a.endTime && a.startTime < candidate.endTime);
  }
  function findPreviousStop(appointments, candidate) {
    if (!candidate || !validDate(candidate.date) || !validTime(candidate.startTime) || !clean(candidate.technician)) return null;
    const tech = clean(candidate.technician,100).toLowerCase(), start = candidate.startTime;
    return (Array.isArray(appointments)?appointments:[]).filter(a=>a&&a.id!==candidate.id&&a.date===candidate.date&&a.status!=='cancelled'&&
      clean(a.technician,100).toLowerCase()===tech&&validTime(a.endTime)&&a.endTime<=start).sort((a,b)=>b.endTime.localeCompare(a.endTime))[0]||null;
  }
  function assessTravelGap(appointments,candidate,travelBufferMinutes=DEFAULT_SCHEDULING.travelBufferMinutes) {
    const previous=findPreviousStop(appointments,candidate); if(!previous)return { previous:null,gapMinutes:null,requiredMinutes:null,insufficient:false,unknown:false };
    const [sh,sm]=candidate.startTime.split(':').map(Number),[eh,em]=previous.endTime.split(':').map(Number),gapMinutes=sh*60+sm-(eh*60+em);
    const drive=candidate.estimatedDriveMinutes==null||candidate.estimatedDriveMinutes===''?NaN:Number(candidate.estimatedDriveMinutes),buffer=Number(travelBufferMinutes),known=Number.isFinite(drive)&&drive>=0&&Number.isFinite(buffer)&&buffer>=0;
    const requiredMinutes=known?drive+buffer:null;
    return {previous,gapMinutes,requiredMinutes,insufficient:known&&gapMinutes<requiredMinutes,unknown:!known};
  }
  function monthDays(year, month) {
    const first = new Date(Date.UTC(year, month - 1, 1));
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || first.getUTCFullYear() !== year || first.getUTCMonth() !== month - 1) throw new RangeError('Choose a valid month and year.');
    const start = new Date(Date.UTC(year, month - 1, 1 - first.getUTCDay()));
    const count = Math.ceil((first.getUTCDay() + new Date(Date.UTC(year, month, 0)).getUTCDate()) / 7) * 7;
    return Array.from({ length: count }, (_, i) => {
      const day = new Date(start.getTime() + i * 86400000);
      return `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate()).padStart(2, '0')}`;
    });
  }
  function createStore(storage) {
    const target = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!target) throw new Error('Local appointment storage is unavailable.');
    function load() {
      let raw;
      try { raw = target.getItem(KEY); } catch (e) { throw new Error(`Appointments could not be read: ${e.message}`); }
      if (!raw) return [];
      let data;
      try { data = JSON.parse(raw); } catch (_) { throw new Error('Appointment data is damaged. It was left unchanged.'); }
      if (!Array.isArray(data) || data.some(a => !a || typeof a !== 'object' || typeof a.id !== 'string')) throw new Error('Appointment data has an unexpected format. It was left unchanged.');
      return data;
    }
    function save(data) {
      if (!Array.isArray(data)) throw new TypeError('Appointments must be a list.');
      try { target.setItem(KEY, JSON.stringify(data)); } catch (e) { throw new Error(`Appointments could not be saved: ${e.message}`); }
      return data;
    }
    function upsert(input) {
      const check = validateAppointment(input);
      if (!check.valid) throw Object.assign(new Error(Object.values(check.errors)[0] || 'Check appointment details.'), { errors: check.errors });
      const data = load(), old = data.find(a => a.id === input.id), now = new Date().toISOString();
      const row = { ...old, ...input, id: old?.id || input.id || `appt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: old?.createdAt || input.createdAt || now, updatedAt: now, name: clean(input.name,160), phone: clean(input.phone,60), address: clean(input.address,240),
        date: input.date, startTime: input.startTime, endTime: input.endTime, technician: clean(input.technician,100), status: input.status,
        notes: clean(input.notes,2000), linkedRecordId: input.linkedRecordId || null,
        roomCount: input.roomCount===''||input.roomCount==null?null:Number(input.roomCount),
        estimatedDriveMinutes: input.estimatedDriveMinutes===''||input.estimatedDriveMinutes==null?null:Number(input.estimatedDriveMinutes),
        estimatedDistanceMiles: input.estimatedDistanceMiles===''||input.estimatedDistanceMiles==null?null:Number(input.estimatedDistanceMiles),
        estimatedDurationMinutes: input.estimatedDurationMinutes===''||input.estimatedDurationMinutes==null?null:Number(input.estimatedDurationMinutes) };
      const index = data.findIndex(a => a.id === row.id);
      if (index < 0) data.unshift(row); else data[index] = row;
      save(data); return row;
    }
    return { load, save, upsert };
  }
  function createSettingsStore(storage) {
    const target=storage||(typeof localStorage!=='undefined'?localStorage:null);
    if(!target)throw new Error('Local scheduling settings storage is unavailable.');
    function load(){let raw;try{raw=target.getItem(SETTINGS_KEY);}catch(e){throw new Error(`Scheduling defaults could not be read: ${e.message}`);}if(!raw)return {...DEFAULT_SCHEDULING};let value;try{value=JSON.parse(raw);}catch(_){throw new Error('Scheduling defaults are damaged. They were left unchanged.');}return normalizeSchedulingDefaults(value);}
    function save(value){const result=normalizeSchedulingDefaults(value);try{target.setItem(SETTINGS_KEY,JSON.stringify(result));}catch(e){throw new Error(`Scheduling defaults could not be saved: ${e.message}`);}return result;}
    return {load,save};
  }
  function appleMapsURL(destination, origin) {
    const to=clean(destination,240); if(!to)return '';
    return `https://maps.apple.com/?${origin?`saddr=${encodeURIComponent(clean(origin,240))}&`:''}daddr=${encodeURIComponent(to)}`;
  }
  const escapeICS = value => String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/\r\n?|\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  function foldICSLine(line) {
    const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
    const bytes = c => encoder ? encoder.encode(c).length : c.length;
    const chunks = []; let current = '', size = 0, limit = 75;
    for (const char of line) { const n = bytes(char); if (size + n > limit && current) { chunks.push(current); current = ' '; size = 1; limit = 75; } current += char; size += n; }
    chunks.push(current); return chunks.join('\r\n');
  }
  function buildICS(appointment) {
    const check = validateAppointment(appointment);
    if (!check.valid || !appointment.id) throw new Error('A valid saved appointment is required to create a calendar file.');
    const compact = (date, time) => date.replace(/-/g,'') + 'T' + time.replace(':','') + '00';
    const stamp = new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
    const description = [appointment.address ? `Address: ${appointment.address}` : '', appointment.phone ? `Phone: ${appointment.phone}` : '', appointment.notes || ''].filter(Boolean).join('\n');
    const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Regal OS//Appointments//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH',
      'BEGIN:VTIMEZONE',`TZID:${TZID}`,`X-LIC-LOCATION:${TZID}`,'BEGIN:DAYLIGHT','TZOFFSETFROM:-0500','TZOFFSETTO:-0400','TZNAME:EDT','DTSTART:19700308T020000','RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU','END:DAYLIGHT','BEGIN:STANDARD','TZOFFSETFROM:-0400','TZOFFSETTO:-0500','TZNAME:EST','DTSTART:19701101T020000','RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU','END:STANDARD','END:VTIMEZONE',
      'BEGIN:VEVENT',`UID:${escapeICS(appointment.id)}@regal-os.local`,`DTSTAMP:${stamp}`,`DTSTART;TZID=${TZID}:${compact(appointment.date,appointment.startTime)}`,`DTEND;TZID=${TZID}:${compact(appointment.date,appointment.endTime)}`,
      `SUMMARY:${escapeICS(`Regal appointment · ${appointment.name}`)}`,...(description?[`DESCRIPTION:${escapeICS(description)}`]:[]),...(appointment.address?[`LOCATION:${escapeICS(appointment.address)}`]:[]),`STATUS:${appointment.status==='cancelled'?'CANCELLED':'CONFIRMED'}`,'END:VEVENT','END:VCALENDAR'];
    return lines.map(foldICSLine).join('\r\n')+'\r\n';
  }
  const humanDate = (date, opts = { weekday:'long', year:'numeric', month:'long', day:'numeric' }) => validDate(date) ? new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US',{...opts,timeZone:'UTC'}) : 'Date unavailable';
  function install({ host, getRecords, onOpenRecord, onBooked, storage } = {}) {
    const root = getRoot(), doc = root?.document, target = typeof host === 'string' ? doc?.querySelector(host) : host;
    if (!doc?.createElement || !target) throw new Error('Calendar host element was not found.');
    const store = createStore(storage || root.localStorage); let today = businessDate(), selectedDate = today;
    const schedulingStore=createSettingsStore(storage||root.localStorage);let schedulingDefaults,schedulingSettingsError='';
    try{schedulingDefaults=schedulingStore.load();}catch(error){schedulingDefaults={...DEFAULT_SCHEDULING};schedulingSettingsError=error.message;}
    let viewYear = Number(today.slice(0,4)), viewMonth = Number(today.slice(5,7)), editing = null, dirty = false, pendingAction = null, forceConflict = false, records = [], disposed = false;
    let estimatedDurationMinutes=null, autoEstimatedEndTime=null;
    const el=(tag,cls,value)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(value!=null)n.textContent=value;return n;};
    const page=el('section','calendar-layout');page.setAttribute('aria-labelledby','calendar-title');
    const title=el('h2','','Appointment calendar');title.id='calendar-title';page.append(title);page.append(el('p','calendar-timezone',`Appointment dates and times use the ${TZID} business timezone. Time slots are service or arrival windows. You can download a calendar file to import manually; appointments do not sync and reminders are not sent.`));
    const scheduling=el('details','calendar-scheduling-settings');const schedulingSummary=el('summary','','Scheduling defaults · unconfirmed planning assumptions');scheduling.append(schedulingSummary);
    scheduling.append(el('p','calendar-assumptions-note','These editable local estimates are assumptions for planning, not confirmed service times or live travel data.'));
    const settingsFields=el('div','calendar-settings-fields');const settingInputs={};
    for(const [key,label] of [['minutesPerRoom','Estimated minutes per room'],['setupCleanupMinutes','Setup and cleanup minutes per appointment'],['travelBufferMinutes','Extra travel buffer minutes']]){const wrap=el('label','calendar-field');wrap.append(el('span','',label));const input=el('input');input.type='number';input.min='0';input.max='720';input.step='1';input.value=schedulingDefaults[key];input.id=`calendar-${key}`;wrap.append(input);settingsFields.append(wrap);settingInputs[key]=input;}
    scheduling.append(settingsFields);const saveDefaults=el('button','secondary','Save local scheduling defaults');saveDefaults.type='button';scheduling.append(saveDefaults);const settingsMessage=el('p','calendar-settings-message',schedulingSettingsError);settingsMessage.setAttribute('role','status');scheduling.append(settingsMessage);if(schedulingSettingsError)saveDefaults.disabled=true;page.append(scheduling);
    const layout=el('div','calendar-main'), month=el('section','calendar-month');month.setAttribute('aria-label','Month calendar');
    const toolbar=el('div','calendar-toolbar'), prev=el('button','','Previous month'), next=el('button','','Next month'), current=el('button','','Today'), monthTitle=el('h3'); for(const b of [prev,current,next])b.type='button'; toolbar.append(prev,current,monthTitle,next);month.append(toolbar);
    const grid=el('div','calendar-grid');grid.setAttribute('role','grid');grid.setAttribute('aria-label','Appointment month');month.append(grid);
    const agenda=el('section','calendar-agenda');agenda.setAttribute('aria-labelledby','calendar-agenda-title');const agendaTitle=el('h3');agendaTitle.id='calendar-agenda-title';agenda.append(agendaTitle);const agendaList=el('div','calendar-agenda-list');agenda.append(agendaList);
    const form=el('form','calendar-form');form.noValidate=true;form.append(el('h3','calendar-form-title','New appointment'));const fields={};
    function markDirty(event){dirty=true;if(!conflict.hidden){conflict.hidden=true;forceConflict=false;}const fieldName=event?.target?.name;if(fieldName==='endTime'){autoEstimatedEndTime=null;estimatedDurationMinutes=null;estimateMessage.textContent='End time changed manually; duration estimate is no longer applied.';return;}if(['roomCount','startTime'].includes(fieldName)){fields.endTime.value=clearAutoEstimatedEnd(fields.endTime.value,autoEstimatedEndTime);autoEstimatedEndTime=null;estimatedDurationMinutes=null;estimateMessage.textContent='Room count or start time changed. Recalculate and apply the planning estimate again if needed.';}}
    function field(name,label,type='text',{required=false,maxLength=500}={}){const wrap=el('label','calendar-field');wrap.append(el('span','',label));const input=el('input');input.type=type;input.id=`appointment-${name}`;input.name=name;input.maxLength=maxLength;if(required)input.required=true;wrap.append(input);input.addEventListener('input',markDirty);input.addEventListener('change',markDirty);fields[name]=input;form.append(wrap);return input;}
    field('name','Customer name','text',{required:true,maxLength:160});field('phone','Phone','tel',{maxLength:60});field('address','Service address','text',{required:true,maxLength:240});field('date','Date','date',{required:true});field('startTime','Start time','time',{required:true});field('endTime','End time','time',{required:true});
    field('roomCount','Rooms for duration estimate','number');fields.roomCount.min='1';fields.roomCount.max='100';fields.roomCount.step='1';
    field('estimatedDriveMinutes','Manual estimated drive minutes','number');fields.estimatedDriveMinutes.min='0';fields.estimatedDriveMinutes.step='1';
    field('estimatedDistanceMiles','Manual estimated distance · miles','number');fields.estimatedDistanceMiles.min='0';fields.estimatedDistanceMiles.step='0.1';
    const estimateActions=el('div','calendar-estimate-actions'),estimateButton=el('button','secondary','Estimate duration'),applyEndButton=el('button','secondary','Apply estimated end time');estimateButton.type=applyEndButton.type='button';estimateActions.append(estimateButton,applyEndButton);form.append(estimateActions);const estimateMessage=el('p','calendar-estimate-message');estimateMessage.setAttribute('role','status');form.append(estimateMessage);
    const tech=field('technician','Technician (optional)','text',{maxLength:100});const datalist=el('datalist');datalist.id='calendar-technicians';tech.setAttribute('list',datalist.id);form.append(datalist);
    const statusWrap=el('label','calendar-field');statusWrap.append(el('span','','Status'));const status=el('select');status.id='appointment-status';for(const [v,label] of Object.entries(STATUS_LABELS)){const o=el('option','',label);o.value=v;status.append(o);}statusWrap.append(status);form.append(statusWrap);fields.status=status;status.addEventListener('change',markDirty);
    const linkedWrap=el('label','calendar-field');linkedWrap.append(el('span','','Link saved quote or job (optional)'));const linked=el('select');linked.id='appointment-record';const blank=el('option','','No saved record');blank.value='';linked.append(blank);linkedWrap.append(linked);form.append(linkedWrap);fields.linkedRecordId=linked;linked.addEventListener('change',markDirty);
    const notesWrap=el('label','calendar-field calendar-notes');notesWrap.append(el('span','','Notes'));const notes=el('textarea');notes.id='appointment-notes';notes.rows=3;notes.maxLength=2000;notesWrap.append(notes);form.append(notesWrap);fields.notes=notes;notes.addEventListener('input',markDirty);
    const actions=el('div','calendar-actions'),save=el('button','primary','Save appointment'),clear=el('button','secondary','New appointment');save.type='submit';clear.type='button';actions.append(save,clear);form.append(actions);
    const message=el('p','calendar-message');message.setAttribute('role','status');form.append(message);
    const confirm=el('div','calendar-inline-confirm');confirm.hidden=true;confirm.setAttribute('role','group');const confirmMessage=el('p');const keep=el('button','secondary','Keep editing');keep.type='button';const discard=el('button','secondary','Discard changes');discard.type='button';confirm.append(confirmMessage,keep,discard);form.append(confirm);
    const conflict=el('div','calendar-conflict-confirm');conflict.hidden=true;conflict.setAttribute('role','group');const conflictText=el('p');const conflictCancel=el('button','secondary','Choose another time');conflictCancel.type='button';const overlapSave=el('button','primary','Save overlapping appointment');overlapSave.type='button';conflict.append(conflictText,conflictCancel,overlapSave);form.append(conflict);
    layout.append(month,agenda,form);page.append(layout);target.replaceChildren(page);
    function snapshot(){return {name:fields.name.value,phone:fields.phone.value,address:fields.address.value,date:fields.date.value,startTime:fields.startTime.value,endTime:fields.endTime.value,technician:fields.technician.value,status:fields.status.value,notes:fields.notes.value,linkedRecordId:fields.linkedRecordId.value||null,roomCount:fields.roomCount.value===''?null:Number(fields.roomCount.value),estimatedDriveMinutes:fields.estimatedDriveMinutes.value===''?null:Number(fields.estimatedDriveMinutes.value),estimatedDistanceMiles:fields.estimatedDistanceMiles.value===''?null:Number(fields.estimatedDistanceMiles.value),estimatedDurationMinutes,...(editing?{id:editing.id,createdAt:editing.createdAt}:{})};}
    function reset(){editing=null;dirty=false;pendingAction=null;forceConflict=false;estimatedDurationMinutes=null;autoEstimatedEndTime=null;form.reset();fields.date.value=selectedDate;fields.status.value='scheduled';form.querySelector('.calendar-form-title').textContent='New appointment';save.textContent='Save appointment';message.textContent='';estimateMessage.textContent='';confirm.hidden=true;conflict.hidden=true;}
    function ensureRecordOption(id, record){if(!id)return;const found=[...linked.options].some(option=>option.value===id);if(found)return;const label=record?`${record.recordType==='quote'?'Quote':'Job'} · ${clean(record.customer||'Unnamed customer',80)} · ${clean(id,24)}`:`Saved record unavailable · ${clean(id,48)}`;const option=el('option','',label);option.value=id;linked.append(option);}
    function loadEdit(a){editing=a;if(a.linkedRecordId&&!records.some(r=>r.id===a.linkedRecordId))ensureRecordOption(a.linkedRecordId);for(const k of Object.keys(fields))fields[k].value=a[k]??'';estimatedDurationMinutes=a.estimatedDurationMinutes??null;autoEstimatedEndTime=null;estimateMessage.textContent=estimatedDurationMinutes?`Saved planning estimate: ${estimatedDurationMinutes} minutes.`:'';dirty=false;confirm.hidden=true;conflict.hidden=true;form.querySelector('.calendar-form-title').textContent='Edit appointment';save.textContent='Save changes';message.textContent='';form.scrollIntoView?.({behavior:'smooth',block:'start'});}
    function askDiscard(action, prompt){pendingAction=action;confirmMessage.textContent=prompt;confirm.hidden=false;keep.focus();}
    function setRecordOptions(){const selected=fields.linkedRecordId.value;linked.replaceChildren();const no=el('option','','No saved record');no.value='';linked.append(no);for(const r of records){const o=el('option','',`${r.recordType==='quote'?'Quote':'Job'} · ${clean(r.customer||'Unnamed customer',80)} · ${clean(r.id,24)}`);o.value=r.id;linked.append(o);}if(selected&&!records.some(r=>r.id===selected))ensureRecordOption(selected);fields.linkedRecordId.value=selected;}
    function renderTechOptions(appointments){const names=[...new Set(appointments.map(a=>clean(a.technician,100)).filter(Boolean))].sort((a,b)=>a.localeCompare(b));datalist.replaceChildren();for(const name of names){const o=el('option');o.value=name;datalist.append(o);}}
    function directionsLink(label, destination, origin='') {
      const url=appleMapsURL(destination,origin); if(!url)return null;
      const link=el('a','calendar-map-link',label);link.href=url;link.target='_blank';link.rel='noopener noreferrer';return link;
    }
    function renderAgenda(appointments){
      agendaTitle.textContent=`Appointments · ${humanDate(selectedDate)}`;agendaList.replaceChildren();
      const list=appointments.filter(a=>a.date===selectedDate).sort((a,b)=>a.startTime.localeCompare(b.startTime));
      if(!list.length){agendaList.append(el('p','calendar-empty','No appointments scheduled for this date.'));return;}
      for(const a of list){
        const card=el('article','appointment-card');card.append(el('h4','',a.name));card.append(el('p','appointment-time',`${a.startTime}–${a.endTime} ${TZID} · ${STATUS_LABELS[a.status]||a.status}`));
        if(a.phone)card.append(el('p','',a.phone));card.append(el('p','',a.address));if(a.technician)card.append(el('p','',`Technician: ${a.technician}`));
        if(a.roomCount)card.append(el('p','',`Rooms for duration estimate: ${a.roomCount}${a.estimatedDurationMinutes?` · estimated ${a.estimatedDurationMinutes} minutes`:''}`));
        if(a.estimatedDriveMinutes!=null||a.estimatedDistanceMiles!=null)card.append(el('p','calendar-manual-travel',`Manual travel estimate${a.estimatedDriveMinutes!=null?`: ${a.estimatedDriveMinutes} min`:''}${a.estimatedDistanceMiles!=null?`${a.estimatedDriveMinutes!=null?' · ':': '}${a.estimatedDistanceMiles} mi`:''}`));
        if(a.notes)card.append(el('p','appointment-notes',a.notes));
        const toAddress=directionsLink('Apple Maps directions to this appointment',a.address);if(toAddress)card.append(toAddress);
        const previous=findPreviousStop(appointments,a);
        if(previous){
          card.append(el('p','calendar-previous-stop',`Previous stop for ${clean(a.technician,100)}: ${previous.name} · ends ${previous.endTime} · ${previous.address}`));
          const route=directionsLink('Apple Maps directions from previous stop',a.address,previous.address);if(route)card.append(route);
          const gap=assessTravelGap(appointments,a,schedulingDefaults.travelBufferMinutes);
          if(gap.unknown)card.append(el('p','calendar-travel-note',`Gap: ${gap.gapMinutes} min. Add a manual drive-time estimate to compare it with the ${schedulingDefaults.travelBufferMinutes}-minute travel buffer.`));
          else if(gap.insufficient)card.append(el('p','calendar-travel-warning',`Travel gap may be too short: ${gap.gapMinutes} min available; manual drive estimate plus ${schedulingDefaults.travelBufferMinutes}-minute buffer requires ${gap.requiredMinutes} min.`));
        }
        if(a.linkedRecordId){const record=records.find(r=>r.id===a.linkedRecordId);const link=el('button','calendar-record-link',record?`Open linked ${record.recordType==='quote'?'quote':'job'}`:`Linked saved record · ${clean(a.linkedRecordId,32)} (currently unavailable)`);link.type='button';link.disabled=!record;link.addEventListener('click',()=>{if(record&&typeof onOpenRecord==='function')onOpenRecord(record);});card.append(link);}
        const buttons=el('div','appointment-actions'),edit=el('button','secondary','Edit / reschedule'),cancel=el('button','secondary',a.status==='cancelled'?'Reopen appointment':'Cancel appointment'),ics=el('button','secondary','Download .ics for calendar import');
        for(const b of [edit,cancel,ics])b.type='button';
        edit.addEventListener('click',()=>{if(dirty){askDiscard(()=>loadEdit(a),'Discard unsaved appointment form changes and edit this appointment?');return;}loadEdit(a);});
        cancel.addEventListener('click',()=>{if(a.status==='cancelled'){if(dirty){askDiscard(()=>{loadEdit(a);fields.status.value='scheduled';dirty=true;},'Discard unsaved form changes and reopen this appointment?');return;}loadEdit(a);fields.status.value='scheduled';dirty=true;message.textContent='Review the appointment and save to reopen it.';return;}try{store.upsert({...a,status:'cancelled'});render();}catch(e){message.textContent=e.message;}});
        ics.addEventListener('click',()=>downloadICS(a));buttons.append(edit,cancel,ics);card.append(buttons);agendaList.append(card);
      }
    }
    function render(){if(disposed)return;let appointments;try{appointments=store.load();}catch(e){message.textContent=e.message;grid.replaceChildren();agendaList.replaceChildren(el('p','calendar-storage-error',e.message));return;}
      const monthName=new Date(Date.UTC(viewYear,viewMonth-1,1)).toLocaleDateString('en-US',{month:'long',year:'numeric',timeZone:'UTC'});monthTitle.textContent=monthName;grid.replaceChildren();for(const weekday of ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']){const h=el('div','calendar-weekday',weekday);h.setAttribute('role','columnheader');grid.append(h);}const days=monthDays(viewYear,viewMonth);for(const date of days){const dayAppointments=appointments.filter(a=>a.date===date&&a.status!=='cancelled');const cell=el('button','calendar-day');cell.type='button';cell.setAttribute('role','gridcell');cell.setAttribute('aria-label',`${humanDate(date)}${dayAppointments.length?`, ${dayAppointments.length} appointments`:''}`);cell.classList.toggle('outside-month',date.slice(0,7)!==`${viewYear}-${String(viewMonth).padStart(2,'0')}`);cell.classList.toggle('selected',date===selectedDate);cell.classList.toggle('today',date===today);cell.append(el('span','calendar-day-number',String(Number(date.slice(-2)))));if(dayAppointments.length)cell.append(el('span','calendar-day-count',`${dayAppointments.length} appointment${dayAppointments.length===1?'':'s'}`));cell.addEventListener('click',()=>{selectedDate=date;if(!editing&&!dirty)fields.date.value=date;render();});grid.append(cell);}renderAgenda(appointments);renderTechOptions(appointments);setRecordOptions();}
    async function refresh(){if(disposed)return;try{records=typeof getRecords==='function'?await getRecords():[];records=Array.isArray(records)?records.filter(r=>r&&typeof r==='object'):[];}catch(_){records=[];}setRecordOptions();render();}
    async function persist(force=false){const value=snapshot(),check=validateAppointment(value);if(!check.valid){message.textContent=Object.values(check.errors)[0];return null;}let existing;try{existing=store.load();}catch(e){message.textContent=e.message;return null;}const conflicts=findConflicts(existing,value);if(conflicts.length&&!force){forceConflict=true;conflictText.textContent=`This technician already has ${conflicts.length} overlapping appointment${conflicts.length===1?'':'s'}: ${conflicts.map(a=>`${a.startTime}–${a.endTime} (${a.name})`).join('; ')}. Confirm only if you intend to overlap these service/arrival windows.`;conflict.hidden=false;overlapSave.focus();return null;}
      try{const saved=store.upsert(value);reset();selectedDate=saved.date;fields.date.value=selectedDate;viewYear=Number(selectedDate.slice(0,4));viewMonth=Number(selectedDate.slice(5,7));render();message.textContent='Appointment saved on this device.';if(ACTIVE.has(saved.status)&&saved.linkedRecordId&&typeof onBooked==='function'){try{onBooked(saved);}catch(e){message.textContent=`Appointment saved, but its linked lead could not be updated: ${e.message}`;}}return saved;}catch(e){message.textContent=e.message;return null;}}
    form.addEventListener('submit',e=>{e.preventDefault();persist(false);});overlapSave.addEventListener('click',()=>persist(true));conflictCancel.addEventListener('click',()=>{conflict.hidden=true;forceConflict=false;});keep.addEventListener('click',()=>{pendingAction=null;confirm.hidden=true;});discard.addEventListener('click',()=>{const action=pendingAction;reset();if(action)action();});clear.addEventListener('click',()=>{if(dirty){askDiscard(reset,'Discard unsaved appointment changes and start a new appointment?');return;}reset();});
    prev.addEventListener('click',()=>moveMonth(-1));next.addEventListener('click',()=>moveMonth(1));current.addEventListener('click',()=>{today=businessDate();selectedDate=today;viewYear=Number(today.slice(0,4));viewMonth=Number(today.slice(5,7));if(!editing&&!dirty)fields.date.value=today;render();});function moveMonth(by){const d=new Date(Date.UTC(viewYear,viewMonth-1+by,1));viewYear=d.getUTCFullYear();viewMonth=d.getUTCMonth()+1;render();}
    function bookFromRecord(record){if(!record||typeof record!=='object')return false;const action=()=>{reset();if(record.id)ensureRecordOption(record.id,record);fields.name.value=clean(record.customer?.name||record.customer||record.customerName||'',160);fields.phone.value=clean(record.phone||record.customer?.phone||'',60);fields.address.value=clean(record.address||record.customer?.address||'',240);fields.roomCount.value=Array.isArray(record.rooms)&&record.rooms.length?record.rooms.length:'';fields.linkedRecordId.value=record.id||'';dirty=true;form.scrollIntoView?.({behavior:'smooth',block:'start'});fields.date.focus();};if(dirty)askDiscard(action,'Discard unsaved appointment details and start one for this saved record?');else action();return true;}
    function downloadICS(a){try{const blob=new Blob([buildICS(a)],{type:'text/calendar;charset=utf-8'}),url=root.URL.createObjectURL(blob),anchor=el('a');anchor.href=url;anchor.download=`regal-appointment-${a.date}-${a.id}.ics`;anchor.hidden=true;doc.body.append(anchor);anchor.click();anchor.remove();root.setTimeout(()=>root.URL.revokeObjectURL(url),1000);}catch(e){message.textContent=e.message;}}
    function computeDuration(){return estimateDuration(fields.roomCount.value,schedulingDefaults);}
    estimateButton.addEventListener('click',()=>{try{const duration=computeDuration();if(duration==null){estimateMessage.textContent='Enter a room count to estimate duration.';return;}estimatedDurationMinutes=duration;const end=estimatedEndTime(fields.startTime.value,duration);estimateMessage.textContent=`Planning estimate: ${duration} minutes (${fields.roomCount.value} rooms × ${schedulingDefaults.minutesPerRoom} minutes, plus ${schedulingDefaults.setupCleanupMinutes} setup/cleanup minutes). These assumptions are unconfirmed.${end?` Estimated end time: ${end}.`:''}`;dirty=true;}catch(e){estimateMessage.textContent=e.message;}});
    applyEndButton.addEventListener('click',()=>{try{const duration=computeDuration();if(duration==null){estimateMessage.textContent='Enter a room count and nonzero duration assumptions.';return;}const end=estimatedEndTime(fields.startTime.value,duration);if(!end){estimateMessage.textContent='The estimated end time would pass midnight. Adjust the start time or planning assumptions.';return;}estimatedDurationMinutes=duration;fields.endTime.value=end;autoEstimatedEndTime=end;dirty=true;estimateMessage.textContent=`Applied estimated end time ${end} from the ${duration}-minute planning estimate. Review before saving.`;}catch(e){estimateMessage.textContent=e.message;}});
    saveDefaults.addEventListener('click',()=>{try{const next=normalizeSchedulingDefaults(Object.fromEntries(Object.entries(settingInputs).map(([key,input])=>[key,input.valueAsNumber])));schedulingDefaults=schedulingStore.save(next);fields.endTime.value=clearAutoEstimatedEnd(fields.endTime.value,autoEstimatedEndTime);autoEstimatedEndTime=null;estimatedDurationMinutes=null;estimateMessage.textContent='Planning assumptions changed. Recalculate and apply the estimate if needed.';settingsMessage.textContent='Scheduling assumptions saved on this device. They remain unconfirmed estimates.';render();}catch(e){settingsMessage.textContent=e.message;}});
    reset();const ready=refresh();return {refresh,ready,bookFromRecord,dispose(){disposed=true;target.replaceChildren();}};
  }
  return { KEY, SETTINGS_KEY, TZID, STATUSES, STATUS_LABELS, DEFAULT_SCHEDULING, validateAppointment, validateSchedulingDefaults, normalizeSchedulingDefaults, estimateDuration, estimatedEndTime, clearAutoEstimatedEnd, findConflicts, findPreviousStop, assessTravelGap, monthDays, businessDate, createStore, createSettingsStore, appleMapsURL, escapeICS, foldICSLine, buildICS, install };
});
