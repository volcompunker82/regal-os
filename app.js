/* Regal field workflow. IndexedDB keeps photos and records on this device. */
(function () {
  'use strict';
  const DB_NAME = 'regal-field-v1';
  const STORE = 'records';
  const FALLBACK = 'regal-field-records-v1';
  const DRAFT = 'regal-field-draft-v1';
  const Pricing = window.RegalPricing;
  const CustomerTools = window.RegalCustomerTools;
  const TIER_NAMES = { standard: 'Standard', deep: 'Deep clean', premium: 'Premium protect' };
  const SURFACE_NAMES = { carpet: 'Carpet', tile: 'Tile', upholstery: 'Upholstery' };
  let pricingConfig = Pricing.load();
  const $ = (id) => document.getElementById(id);

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open local storage'));
      request.onblocked = () => reject(new Error('Local storage is busy in another tab'));
    });
  }

  // Exported for deterministic persistence checks from Node or the browser console.
  const Store = {
    async all() {
      try { const db = await openDatabase(); const indexed = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly'), req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result || []); req.onerror = () => reject(req.error);
      });
        const merged = new Map(indexed.map((item) => [item.id, item]));
        try { Store.fallbackAll().forEach((item) => {
          const old = merged.get(item.id);
          const time = (record) => Date.parse(record.updatedAt || record.completedAt || 0) || 0;
          if (!old || time(item) > time(old)) merged.set(item.id, item);
        }); } catch (_) { /* IndexedDB remains readable even if fallback storage is unavailable. */ }
        return [...merged.values()];
      } catch (error) { return Store.fallbackAll(error); }
    },
    async put(record) {
      try { const db = await openDatabase(); await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(record);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || Error('Save aborted'));
      }); Store.removeFallback(record.id); return 'indexeddb'; } catch (error) { Store.fallbackPut(record, error); return 'localstorage'; }
    },
    async get(id) { return (await Store.all()).find((item) => item.id === id) || null; },
    fallbackAll(error) {
      try { const items = JSON.parse(localStorage.getItem(FALLBACK) || '[]'); return Array.isArray(items) ? items : []; }
      catch (storageError) { throw new Error('Could not read saved jobs: ' + storageError.message + (error ? ' (' + error.message + ')' : '')); }
    },
    fallbackPut(record, error) {
      try { const items = Store.fallbackAll(); const index = items.findIndex((item) => item.id === record.id);
        if (index < 0) items.unshift(record); else items[index] = record;
        localStorage.setItem(FALLBACK, JSON.stringify(items));
      } catch (storageError) { throw new Error('Could not save locally: ' + storageError.message + (error ? ' (' + error.message + ')' : '')); }
    },
    removeFallback(id) {
      try { const items = Store.fallbackAll().filter((item) => item.id !== id); localStorage.setItem(FALLBACK, JSON.stringify(items)); } catch (_) { /* Newer IndexedDB record wins during merge if cleanup is unavailable. */ }
    },
    putDraft(record) { try { localStorage.setItem(DRAFT, JSON.stringify(record)); } catch (error) { throw new Error('Draft could not be autosaved: ' + error.message); } },
    getDraft() { try { return JSON.parse(localStorage.getItem(DRAFT) || 'null'); } catch (_) { return null; } },
    clearDraft() { localStorage.removeItem(DRAFT); }
  };
  window.RegalStore = Store;

  let state = { id: null, recordType: 'quote', customer: '', address: '', phone: '', email: '', rooms: [], selectedAddons: [], areaOverride: '', measurementSource: 'manual', measurementNotes: '', before: '', after: '', signature: '', payment: 'unpaid', pricingSnapshot: null, legacySnapshot: null };
  let saveTimer;
  let drawing = false;
  let hasSignature = false;
  let signatureRevision = 0;
  let saving = false;
  let pendingConfirmation = null;
  let receiptReturnFocus = null;
  const originalTitle = document.title;
  const pendingPhotos = new Set();
  const canvas = $('signature');
  const ctx = canvas.getContext('2d');

  function notify(message, kind) { const box = $('notice'); box.textContent = message; box.className = 'notice show ' + kind; }
  function showConfirmation(action, message, buttonText) {
    pendingConfirmation = action; $('confirm-message').textContent = message; $('confirm-accept').textContent = buttonText;
    $('confirmation').hidden = false; $('confirm-accept').focus();
  }
  function hideConfirmation() { pendingConfirmation = null; $('confirmation').hidden = true; }
  function dollars(amount) { return Number.isFinite(Number(amount)) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(amount)) : '—'; }
  function createId() { return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2, 8); }
  function createRoom(name) { return { id: createId(), name: name || 'Room ' + (state.rooms.length + 1), surface: 'carpet', tier: 'standard', sections: [{ id: createId(), lengthFt: '', widthFt: '' }], itemCount: 1 }; }
  function normalizeRecord(record) {
    const migrated = !Array.isArray(record.rooms) || !Array.isArray(record.lineItems);
    const tier = Pricing.TIERS.includes(record.tier) ? record.tier : 'standard';
    const rooms = Array.isArray(record.rooms) && record.rooms.length ? Pricing.clone(record.rooms) : [{ id: 'legacy-room', name: 'Measured area', surface: 'carpet', tier, sections: [], overrideSqft: Number(record.sqft) || 0, itemCount: 1 }];
    const snapshot = record.pricingSnapshot ? Pricing.normalizeConfig(record.pricingSnapshot) : Pricing.clone(pricingConfig);
    if (!record.pricingSnapshot) {
      // A pre-snapshot saved record was priced by the old square-foot model.
      snapshot.carpetPricing = { ...snapshot.carpetPricing, model: 'sqft', confirmed: false };
      const oldRate = Number.isFinite(Number(record.rate)) ? Number(record.rate) : Number(record.lineItems?.find(item => item.surface === 'carpet' && item.unit === 'sqft')?.rate);
      if (Number.isFinite(oldRate) && oldRate >= 0) snapshot.rates.carpet[tier] = oldRate;
    }
    const legacyTotal = Number(record.total ?? (Number(record.sqft || 0) * Number(record.rate ?? snapshot.rates.carpet[tier] ?? 0)));
    const legacyItems = Array.isArray(record.lineItems) ? Pricing.clone(record.lineItems) : [{ id: 'legacy-room', kind: 'room', name: rooms[0].name, surface: 'carpet', tier, quantity: Number(record.sqft || 0), unit: 'sqft', rate: Number(record.rate ?? snapshot.rates.carpet[tier] ?? 0), total: legacyTotal }];
    const legacySnapshot = !record.pricingSnapshot ? { ok: true, issues: [], items: legacyItems, subtotal: legacyTotal, minimumAdjustment: 0, total: legacyTotal, pricingSnapshot: Pricing.clone(snapshot) } : migrated ? { ok: true, issues: [], items: legacyItems, subtotal: legacyTotal, minimumAdjustment: 0, total: legacyTotal, pricingSnapshot: Pricing.clone(snapshot) } : null;
    return { id: record.id || null, recordType: record.recordType || 'job', leadId: record.leadId || null, customer: record.customer || '', address: record.address || '', phone: record.phone || '', email: record.email || '', rooms, selectedAddons: Array.isArray(record.selectedAddons) ? Pricing.clone(record.selectedAddons) : [], areaOverride: record.areaOverride ?? '', measurementSource: record.measurementSource || 'manual', measurementNotes: record.measurementNotes || '', before: record.before || '', after: record.after || '', signature: record.signature || '', payment: record.recordType === 'quote' ? 'unpaid' : (record.payment || 'unpaid'), pricingSnapshot: snapshot, lineItems: Array.isArray(record.lineItems) ? Pricing.clone(record.lineItems) : legacySnapshot.items, legacySnapshot, total: Number.isFinite(Number(record.total)) ? Number(record.total) : legacyTotal, amountReceived: record.recordType === 'quote' ? 0 : Number(record.amountReceived || 0), completedAt: record.completedAt, updatedAt: record.updatedAt };
  }
  function activePricing() { return state.pricingSnapshot || pricingConfig; }
  function measuredArea(rooms = state.rooms) { return rooms.reduce((sum, room) => room.surface === 'upholstery' ? sum : sum + (room.overrideSqft != null && room.overrideSqft !== '' ? Number(room.overrideSqft) : (room.sections || []).reduce((area, section) => area + (Number(section.lengthFt) || 0) * (Number(section.widthFt) || 0), 0)), 0); }
  function calculateQuote() {
    if (state.legacySnapshot) return state.legacySnapshot;
    return Pricing.calculate(state.rooms, state.selectedAddons, activePricing(), { areaOverride: state.areaOverride });
  }
  function quote() { return calculateQuote().total || 0; }
  function quoteFingerprint() { return JSON.stringify({ customer: state.customer, address: state.address, rooms: state.rooms, addons: state.selectedAddons, override: state.areaOverride, pricing: activePricing() }); }
  function invalidateApproval() {
    if (hasSignature || state.signature) {
      signatureRevision++; hasSignature = false; state.signature = ''; ctx.clearRect(0, 0, canvas.width, canvas.height);
      notify('Customer or quoted work changed. Capture a fresh signature before completing the job.', 'error');
    }
    state.legacySnapshot = null;
  }
  function setLabel(text, control) { const label = document.createElement('label'); label.textContent = text; label.append(control); return label; }
  function makeSelect(options, value) { const select = document.createElement('select'); for (const [key, label] of options) { const option = document.createElement('option'); option.value = key; option.textContent = label; select.append(option); } select.value = value; return select; }
  function renderRooms() {
    const host = $('rooms'); host.replaceChildren();
    state.rooms.forEach((room) => {
      const card = document.createElement('article'); card.className = 'room-card'; card.dataset.roomId = room.id;
      card.innerHTML = '<div class="room-heading"><b></b><button class="text-button" type="button" data-remove-room>Remove room</button></div><div class="room-fields"><label>Room name<input data-room-name maxlength="60"></label><label>Surface<select data-room-surface><option value="carpet">Carpet</option><option value="tile">Tile</option><option value="upholstery">Upholstery</option></select></label><label class="room-tier-field">Service tier<select data-room-tier><option value="standard">Standard</option><option value="deep">Deep clean</option><option value="premium">Premium protect</option></select></label><label class="item-count-field" hidden>Number of items<input data-room-count type="number" min="1" step="1" value="1"></label></div><div class="sections-wrap"><div class="sections-title">Rectangle sections · dimensions in decimal feet</div><div data-sections></div><button class="text-button section-add" type="button" data-add-section>＋ Add another section</button><div class="room-sketch" aria-label="Proportional room sections"></div></div>';
      card.querySelector('.room-heading b').textContent = room.name || 'Room';
      card.querySelector('[data-room-name]').value = room.name || '';
      card.querySelector('[data-room-surface]').value = room.surface;
      card.querySelector('[data-room-tier]').value = room.tier;
      const packageCarpet = room.surface === 'carpet' && activePricing().carpetPricing?.model === 'room';
      card.querySelector('.room-tier-field').hidden = packageCarpet;
      card.querySelector('.sections-title').textContent = packageCarpet ? 'Optional dimensions · sections stay within this one room' : 'Rectangle sections · dimensions in decimal feet';
      const countField = card.querySelector('.item-count-field'); countField.hidden = room.surface !== 'upholstery'; card.querySelector('[data-room-count]').value = room.itemCount || 1;
      card.querySelector('.sections-wrap').hidden = room.surface === 'upholstery';
      const sections = card.querySelector('[data-sections]'); const sketch = card.querySelector('.room-sketch');
      (room.sections || []).forEach((section, index) => {
        const row = document.createElement('div'); row.className = 'section-dimensions'; row.dataset.sectionId = section.id;
        row.innerHTML = `<span class="section-index">${index + 1}</span><label>Length · ft<input data-length type="number" min="0" step="0.01" inputmode="decimal" placeholder="e.g. 12.5"></label><span class="multiply">×</span><label>Width · ft<input data-width type="number" min="0" step="0.01" inputmode="decimal" placeholder="e.g. 10"></label><button class="text-button" type="button" data-remove-section aria-label="Remove rectangle section ${index + 1}">Remove</button>`;
        row.querySelector('[data-length]').value = section.lengthFt ?? '';
        row.querySelector('[data-width]').value = section.widthFt ?? '';
        sections.append(row);
        const l = Number(section.lengthFt) || 1, w = Number(section.widthFt) || 1;
        const rect = document.createElement('span'); rect.className = 'sketch-rect'; rect.style.width = `${Math.max(18, Math.min(92, 26 + 12 * (l / Math.max(l, w))))}%`; rect.style.height = `${Math.max(13, Math.min(28, 10 + 4 * (w / Math.max(l, w))))}px`; rect.title = `Section ${index + 1}: ${section.lengthFt || 0} by ${section.widthFt || 0} ft`; sketch.append(rect);
      });
      host.append(card);
    });
  }
  function renderAddonPicker() {
    const select = $('addon-picker'); select.replaceChildren(); const empty = document.createElement('option'); empty.value = ''; empty.textContent = pricingConfig.addons.length ? 'Choose an add-on' : 'No add-ons in catalog yet'; select.append(empty);
    for (const item of pricingConfig.addons) { const option = document.createElement('option'); option.value = item.id; option.textContent = `${item.name} · ${dollars(item.rate)} / ${item.unit}`; select.append(option); }
    $('add-addon').disabled = pricingConfig.addons.length === 0;
  }
  function renderAddonCatalog() {
    const host = $('addon-catalog'); host.replaceChildren();
    if (!pricingConfig.addons.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'No add-ons configured. Add only services and prices you choose to offer.'; host.append(empty); return; }
    for (const item of pricingConfig.addons) { const row = document.createElement('div'); row.className = 'addon-catalog-row'; const label = document.createElement('span'); label.textContent = `${item.name} · ${dollars(item.rate)} per ${item.unit}`; const edit = document.createElement('button'); edit.type='button';edit.className='text-button';edit.textContent='Edit';edit.dataset.editAddon=item.id;row.append(edit); const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.dataset.removeAddon = item.id; remove.textContent = 'Remove'; row.append(label, remove); host.append(row); }
  }
  function renderSelectedAddons() {
    const host = $('selected-addons'); host.replaceChildren();
    state.selectedAddons.forEach((selection) => {
      const addon = activePricing().addons.find((entry) => entry.id === selection.id); if (!addon) return;
      const row = document.createElement('div'); row.className = 'selected-addon'; const label = document.createElement('span'); label.textContent = addon.name;
      if (['stair', 'item', 'hour'].includes(addon.unit)) { const quantity = document.createElement('input'); quantity.type = 'number'; quantity.min = '1'; quantity.step = '1'; quantity.value = selection.quantity || 1; quantity.dataset.addonQuantity = selection.id; quantity.setAttribute('aria-label', `${addon.name} quantity`); row.append(label, quantity); }
      else row.append(label);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.dataset.removeSelectedAddon = selection.id; remove.textContent = 'Remove'; row.append(remove); host.append(row);
    });
  }
  function renderQuoteLines(result = calculateQuote()) {
    const host = $('quote-lines'); host.replaceChildren();
    result.items.forEach((item) => {
      const row = document.createElement('div'); row.className = 'quote-line';
      const description = document.createElement('span'); description.textContent = item.description || (item.kind === 'room' ? `${item.name} · ${SURFACE_NAMES[item.surface]} · ${TIER_NAMES[item.tier]}` : item.name);
      const math = document.createElement('small'); math.textContent = `${Number(item.quantity).toLocaleString()} ${item.unit} × ${dollars(item.rate)}${item.kind === 'minimum' ? '' : ' / ' + item.unit}`;
      const total = document.createElement('b'); total.textContent = dollars(item.total);
      const text = document.createElement('span'); text.append(description, math); row.append(text, total); host.append(row);
    });
    if (!result.items.length && !result.issues.length) { const blank = document.createElement('p'); blank.className = 'hint'; blank.textContent = 'Add measured rooms to build an itemized quote.'; host.append(blank); }
  }
  function syncPricingEditor() {
    document.querySelectorAll('[data-rate-surface]').forEach((input) => { const rate = pricingConfig.rates[input.dataset.rateSurface][input.dataset.rateTier]; input.value = rate == null ? '' : rate; });
    $('minimum-charge').value = pricingConfig.minimumCharge;
    $('carpet-pricing-model').value = pricingConfig.carpetPricing.model;
    $('carpet-first-room-rate').value = pricingConfig.carpetPricing.firstRoomRate;
    $('carpet-additional-room-rate').value = pricingConfig.carpetPricing.additionalRoomRate;
    syncCarpetPricingEditor();
    $('confirm-prices').checked = pricingConfig.mode === 'confirmed' && pricingConfig.confirmed;
    $('pricing-mode-badge').textContent = pricingConfig.carpetPricing.model === 'room' ? 'Supplied carpet room prices · other rates unconfirmed' : pricingConfig.mode === 'confirmed' && pricingConfig.confirmed ? 'Confirmed by you' : 'Other rates unconfirmed';
    renderAddonCatalog(); renderAddonPicker();
  }
  function syncCarpetPricingEditor() {
    const roomMode = $('carpet-pricing-model').value === 'room';
    $('carpet-room-rates').hidden = !roomMode;
    $('carpet-pricing-help').hidden = !roomMode;
    document.querySelectorAll('.carpet-sqft-field').forEach(input => { input.hidden = roomMode; });
  }
  function packageOnly(result) { return !!(result?.ok && result.items.length && result.items.every(item => item.package === 'carpet-room') && !result.minimumAdjustment); }
  function displayQuote() {
    const result = calculateQuote();
    const total = result.total;
    $('total').textContent = result.ok ? dollars(total) : '—';
    $('rate-note').textContent = packageOnly(result) ? `Supplied carpet room prices · first ${dollars(activePricing().carpetPricing.firstRoomRate)}, each additional ${dollars(activePricing().carpetPricing.additionalRoomRate)}` : state.areaOverride ? `${$('measured-sqft').value} measured sq ft · ${state.areaOverride} sq ft override` : (activePricing().mode === 'demo' || !activePricing().confirmed ? 'Other service rates are not confirmed · review your own prices in settings' : 'Your confirmed local pricing');
    $('cash-amount').textContent = dollars(total); $('cash-note').hidden = state.payment !== 'cash';
    $('pricing-status').textContent = result.issues.join(' ');
    $('pricing-status').hidden = result.issues.length === 0;
    renderQuoteLines(result);
    const area = state.areaOverride === '' ? measuredArea() : Number(state.areaOverride);
    $('measured-sqft').value = measuredArea().toFixed(2).replace(/\.00$/, '');
    $('room-total-label').textContent = `${state.rooms.length} rooms · ${Number.isFinite(area) ? area.toLocaleString() : '0'} sq ft quoted`;
    renderSelectedAddons();
  }
  function readPricingForm() {
    const config = Pricing.clone(pricingConfig);
    config.carpetPricing.model = $('carpet-pricing-model').value;
    config.carpetPricing.firstRoomRate = $('carpet-first-room-rate').valueAsNumber;
    config.carpetPricing.additionalRoomRate = $('carpet-additional-room-rate').valueAsNumber;
    config.carpetPricing.confirmed = true;
    for (const input of document.querySelectorAll('[data-rate-surface]')) {
      const rate = input.value.trim() === '' ? null : input.valueAsNumber;
      config.rates[input.dataset.rateSurface][input.dataset.rateTier] = rate;
    }
    config.minimumCharge = $('minimum-charge').valueAsNumber;
    config.confirmed = $('confirm-prices').checked; config.mode = config.confirmed ? 'confirmed' : 'demo';
    return config;
  }
  function savePricingSettings() {
    const previous = quoteFingerprint();
    try {
      const next = readPricingForm(); const validation = Pricing.validateConfig(next);
      if (!validation.ok) throw new Error(validation.issues.join(' '));
      pricingConfig = Pricing.save(next); $('settings-notice').textContent = `Pricing saved on this device. ${pricingConfig.confirmed ? 'You marked these prices confirmed.' : 'Rates remain labeled as demonstration pricing.'}`; $('settings-notice').className = 'notice show success';
      if (!state.pricingSnapshot && previous !== quoteFingerprint()) invalidateApproval();
      syncPricingEditor(); renderRooms(); displayQuote(); scheduleDraft();
    } catch (error) { $('settings-notice').textContent = error.message; $('settings-notice').className = 'notice show error'; }
  }
  function addCatalogItem() {
    const previousFingerprint = quoteFingerprint();
    const name = $('addon-name').value.trim(), rate = $('addon-rate').valueAsNumber, unit = $('addon-unit').value;
    if (!name || !Number.isFinite(rate) || rate < 0) { $('settings-notice').textContent = 'Enter an add-on name and a finite amount of zero or more.'; $('settings-notice').className = 'notice show error'; return; }
    const next = Pricing.clone(pricingConfig); const editId=$('save-addon').dataset.editId;const item={id:editId||createId(),name,rate,unit};if(editId)next.addons=next.addons.map(a=>a.id===editId?item:a);else next.addons.push(item);
    try { pricingConfig = Pricing.save(next); delete $('save-addon').dataset.editId; $('save-addon').textContent='Add to catalog'; $('addon-name').value = ''; $('addon-rate').value = ''; syncPricingEditor(); $('settings-notice').textContent = 'Add-on saved to your local catalog. It is not automatically included in any quote.'; $('settings-notice').className = 'notice show success'; }
    catch (error) { $('settings-notice').textContent = error.message; $('settings-notice').className = 'notice show error'; }
    if (!state.pricingSnapshot && previousFingerprint !== quoteFingerprint()) { invalidateApproval(); displayQuote(); scheduleDraft(); }
  }
  function addSelectedAddon() {
    const id = $('addon-picker').value; if (!id || state.selectedAddons.some((selection) => selection.id === id)) return;
    state.selectedAddons.push({ id, quantity: 1 }); state.legacySnapshot = null; invalidateApproval(); renderSelectedAddons(); displayQuote(); scheduleDraft();
  }
  function updateRoomInputs() { syncInputs(); }
  function resizeSections(card) {
    const room = state.rooms.find((item) => item.id === card.dataset.roomId); if (!room) return;
    room.sections = [...card.querySelectorAll('.section-dimensions')].map((row) => ({ id: row.dataset.sectionId, lengthFt: row.querySelector('[data-length]').value === '' ? '' : Number(row.querySelector('[data-length]').value), widthFt: row.querySelector('[data-width]').value === '' ? '' : Number(row.querySelector('[data-width]').value) }));
  }
  function drawImage(id, value) { const img = $(id); if (value) { img.src = value; img.hidden = false; img.parentElement.classList.add('has-image'); img.parentElement.querySelector('.photo-help').textContent = 'Tap to replace'; } else { img.removeAttribute('src'); img.hidden = true; img.parentElement.classList.remove('has-image'); img.parentElement.querySelector('.photo-help').textContent = 'Add a photo'; } }
  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect(); const ratio = Math.max(1, window.devicePixelRatio || 1);
    const old = hasSignature ? canvas.toDataURL() : '';
    canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#18232d';
    if (old) { const revision = signatureRevision; const img = new Image(); img.onload = () => { if (revision === signatureRevision) ctx.drawImage(img, 0, 0, rect.width, rect.height); }; img.src = old; }
  }
  function flushDraft() { clearTimeout(saveTimer); try { Store.putDraft({ ...state, updatedAt: new Date().toISOString() }); if (!state.id) $('job-id').textContent = 'DRAFT · autosaved'; } catch (error) { notify(error.message, 'error'); } }
  function scheduleDraft() { clearTimeout(saveTimer); saveTimer = setTimeout(flushDraft, 300); }
  function hydrate() {
    const draft = Store.getDraft(); if (!draft) return;
    state = { ...state, ...(Array.isArray(draft.rooms) ? draft : normalizeRecord(draft)) };
    if (!state.rooms.length) state.rooms = [createRoom('Living room')];
    $('customer').value = state.customer || ''; $('address').value = state.address || ''; $('customer-phone').value = state.phone || ''; $('customer-email').value = state.email || '';
    $('measurement-source').value = state.measurementSource || 'manual'; $('measurement-notes').value = state.measurementNotes || ''; $('sqft-override').value = state.areaOverride || '';
    $('payment').value = state.payment || 'unpaid'; renderRooms(); drawImage('before-preview', state.before); drawImage('after-preview', state.after); displayQuote();
    signatureRevision++; if (state.signature) { const revision = signatureRevision; const img = new Image(); img.onload = () => { if (revision === signatureRevision) { ctx.drawImage(img, 0, 0, canvas.clientWidth, canvas.clientHeight); hasSignature = true; } }; img.src = state.signature; }
    $('job-id').textContent = state.id ? 'JOB · ' + state.id.slice(-6).toUpperCase() + ' · draft' : 'DRAFT · restored';
  }
  function syncInputs() {
    const before = quoteFingerprint(), paymentBefore = state.payment;
    state.customer = $('customer').value.trim(); state.address = $('address').value.trim(); state.phone = $('customer-phone').value.trim(); state.email = $('customer-email').value.trim(); state.payment = $('payment').value;
    state.measurementSource = $('measurement-source').value; state.measurementNotes = $('measurement-notes').value.trim(); state.areaOverride = $('sqft-override').value;
    document.querySelectorAll('.room-card').forEach((card) => {
      const room = state.rooms.find((item) => item.id === card.dataset.roomId); if (!room) return;
      room.name = card.querySelector('[data-room-name]').value.trim() || 'Room';
      room.surface = card.querySelector('[data-room-surface]').value; room.tier = card.querySelector('[data-room-tier]').value;
      room.itemCount = Number(card.querySelector('[data-room-count]').value) || 0;
      room.sections = [...card.querySelectorAll('.section-dimensions')].map((row) => ({ id: row.dataset.sectionId, lengthFt: row.querySelector('[data-length]').value === '' ? '' : Number(row.querySelector('[data-length]').value), widthFt: row.querySelector('[data-width]').value === '' ? '' : Number(row.querySelector('[data-width]').value) }));
    });
    state.selectedAddons = [...document.querySelectorAll('[data-addon-quantity]')].map((input) => ({ id: input.dataset.addonQuantity, quantity: Number(input.value) || 0 })).concat(state.selectedAddons.filter((selection) => !['stair', 'item', 'hour'].includes(activePricing().addons.find((addon) => addon.id === selection.id)?.unit)));
    const confirmationChanged = before !== quoteFingerprint() || paymentBefore !== state.payment;
    if (before !== quoteFingerprint()) invalidateApproval();
    if (confirmationChanged && pendingConfirmation) hideConfirmation();
    $('measurement-guide').hidden = state.measurementSource !== 'phone';
    $('measurement-guide').textContent = 'iPhone: Apple Measure can help check dimensions; RoomPlan depends on a compatible app/device. Android support varies by device and app. This worksheet does not scan or measure with the camera. Record the tool and verify key dimensions manually.';
    const measured = measuredArea(); $('measured-sqft').value = measured.toFixed(2).replace(/\.00$/, '');
    displayQuote(); scheduleDraft();
  }
  async function photoData(file) {
    if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
    if (file.size > 18 * 1024 * 1024) throw new Error('Photo is over 18 MB. Choose a smaller image.');
    const image = await createImageBitmap(file); const scale = Math.min(1, 1200 / Math.max(image.width, image.height));
    const c = document.createElement('canvas'); c.width = Math.round(image.width * scale); c.height = Math.round(image.height * scale);
    c.getContext('2d').drawImage(image, 0, 0, c.width, c.height); image.close();
    return c.toDataURL('image/jpeg', .76);
  }
  async function addPhoto(inputId, key, previewId) {
    const file = $(inputId).files[0]; if (!file) return;
    const photoState = state;
    const task = photoData(file).then((data) => { if (state !== photoState) return; state[key] = data; drawImage(previewId, data); scheduleDraft(); notify('Photo added and autosaved on this device.', 'success'); })
      .catch((error) => { notify(error.message || 'Photo could not be prepared.', 'error'); });
    pendingPhotos.add(task);
    try { await task; } finally { pendingPhotos.delete(task); }
    $(inputId).value = '';
  }
  function pointer(event) { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
  function startSign(event) { event.preventDefault(); drawing = true; hasSignature = true; canvas.setPointerCapture(event.pointerId); const p = pointer(event); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + .01, p.y + .01); ctx.stroke(); }
  function drawSign(event) { if (!drawing) return; const p = pointer(event); ctx.lineTo(p.x, p.y); ctx.stroke(); }
  function endSign() { if (!drawing) return; drawing = false; state.signature = canvas.toDataURL('image/png'); scheduleDraft(); }

  let previewJob = null;
  let callsController = null;
  let calendarController = null;
  let pendingLead = null;
  let pendingLeadResolve = null;
  function freshState() { return {id:null,recordType:'quote',customer:'',address:'',phone:'',email:'',rooms:[],selectedAddons:[],areaOverride:'',measurementSource:'manual',measurementNotes:'',before:'',after:'',signature:'',payment:'unpaid',pricingSnapshot:null,legacySnapshot:null}; }
  function populate() {
    $('customer').value=state.customer; $('address').value=state.address; $('customer-phone').value=state.phone||''; $('customer-email').value=state.email||'';
    $('measurement-source').value=state.measurementSource||'manual'; $('measurement-notes').value=state.measurementNotes||''; $('sqft-override').value=state.areaOverride??''; $('payment').value=state.payment||'unpaid';
    renderRooms(); drawImage('before-preview',state.before); drawImage('after-preview',state.after); displayQuote();
    signatureRevision++; hasSignature=false; ctx.clearRect(0,0,canvas.width,canvas.height);
    if(state.signature){const revision=signatureRevision;const img=new Image();img.onload=()=>{if(revision===signatureRevision){ctx.drawImage(img,0,0,canvas.clientWidth,canvas.clientHeight);hasSignature=true;}};img.src=state.signature;}
    $('job-id').textContent=state.id?'REG-'+state.id.slice(-6).toUpperCase():'NEW QUOTE';
  }
  function reset() {clearTimeout(saveTimer);state=freshState();state.rooms=[createRoom('Living room')];populate();Store.clearDraft();}
  async function renderHistory(){const records=await Store.all();CustomerTools.renderHistory($('customer-history'),CustomerTools.findHistory(records,$('history-search').value),job=>loadJob(job));}
  async function renderSaved(selectedId){
    try{const records=(await Store.all()).sort((a,b)=>String(b.updatedAt||b.completedAt||'').localeCompare(String(a.updatedAt||a.completedAt||'')));$('job-count').textContent=records.length;const host=$('saved-jobs');host.replaceChildren();
      if(!records.length){const p=document.createElement('p');p.textContent='No saved quotes or jobs yet.';host.append(p);}
      records.forEach(job=>{const card=document.createElement('div');card.className='saved-job-card';const open=document.createElement('button');open.type='button';open.className='saved-job';const name=document.createElement('b');name.textContent=job.customer||'Unnamed customer';const meta=document.createElement('small');meta.textContent=(job.recordType==='quote'?'QUOTE':job.payment==='cash'?'CASH PAID':'UNPAID')+' · '+dollars(job.total);open.append(name,meta);open.onclick=()=>loadJob(job);const view=document.createElement('button');view.type='button';view.className='receipt-open';view.textContent=job.recordType==='quote'?'View quote':job.payment==='cash'?'View receipt':'View invoice';view.onclick=()=>showReceipt(job.id);const book=document.createElement('button');book.type='button';book.className='receipt-open';book.textContent='Book appointment';book.onclick=()=>{showCalendar();calendarController?.bookFromRecord(job);};card.append(open,view,book);host.append(card);});
      await renderHistory();if(selectedId)$('job-id').textContent='REG-'+selectedId.slice(-6).toUpperCase();
    }catch(error){notify('Saved work could not be read: '+error.message,'error');}
  }
  function savedLines(job){return Array.isArray(job.lineItems)?job.lineItems:[{description:'Carpet cleaning',quantity:Number(job.sqft)||0,unit:'sqft',rate:Number(job.rate)||0,total:Number(job.total)||0}];}
  async function showReceipt(id){try{const job=await Store.get(id);if(!job)throw Error('Saved record not found');previewJob=job;const isQuote=job.recordType==='quote',paid=!isQuote&&job.payment==='cash',kind=isQuote?'quote':paid?'receipt':'invoice';
    const received=paid?Number(job.amountReceived??job.total):0;
    $('receipt-heading').textContent=isQuote?'Quote':paid?'Receipt':'Invoice';$('receipt-status').textContent=isQuote?'ESTIMATE':paid?'PAID IN CASH':'BALANCE DUE';$('receipt-status').className='receipt-status'+(paid?' paid':'');
    $('receipt-subtitle').textContent=isQuote?'Review and approve before work begins.':paid?'Payment recorded as cash received.':'Payment has not been recorded.';
    const packageOnlySaved = Array.isArray(job.lineItems) && job.lineItems.length > 0 && job.lineItems.every(item => item.package === 'carpet-room') && !job.lineItems.some(item => item.kind === 'minimum');
    document.querySelector('.receipt-preview').textContent=packageOnlySaved?'Supplied carpet room rates':job.pricingSnapshot?.confirmed?'Regal pricing':'Preview · other rates not confirmed';
    $('receipt-job-number').textContent='REG-'+job.id.slice(-6).toUpperCase();$('receipt-date').textContent=new Date(job.updatedAt||job.completedAt).toLocaleDateString();$('receipt-customer-name').textContent=job.customer;$('receipt-address').textContent=job.address||'Address not provided';
    const body=document.querySelector('.receipt-lines tbody');body.replaceChildren();savedLines(job).forEach(item=>{const tr=document.createElement('tr');[item.description||item.name||'Service',Number(item.quantity).toLocaleString()+' '+item.unit,dollars(item.rate),dollars(item.total)].forEach((text,index)=>{const td=document.createElement('td');td.textContent=text;if(index===3)td.className='amount';tr.append(td);});body.append(tr);});
    $('receipt-service-total').textContent=dollars(job.total);$('receipt-received').textContent=dollars(received);$('receipt-balance').textContent=dollars(Math.max(0,job.total-received));
    const safe=typeof job.signature==='string'&&/^data:image\/png;base64,/.test(job.signature);$('receipt-signature-block').hidden=!safe;if(safe)$('receipt-signature').src=job.signature;
    const messageJob = packageOnlySaved ? { ...job, pricingSnapshot: { ...job.pricingSnapshot, confirmed: true } } : job;
    const message=CustomerTools.createMessage(messageJob,{kind,businessName:'Regal Carpet Cleaning',phone:'(772) 778-8480'});const email=CustomerTools.buildMailto(job.email,message.subject,message.text),sms=CustomerTools.buildSms(job.phone,message.text);
    [['receipt-email',email],['receipt-sms',sms]].forEach(([name,url])=>{const a=$(name);a.hidden=!url;if(url)a.href=url;else a.removeAttribute('href');});$('share-status').textContent='Drafts open in your own app; review before sending.';
    receiptReturnFocus=document.activeElement;$('top').inert=true;$('receipt-view').hidden=false;$('receipt-close').focus();document.title=$('receipt-heading').textContent+' '+$('receipt-job-number').textContent+' · Regal';
  }catch(error){notify(error.message,'error');}}
  function loadJob(job,approved=false){if(!approved&&state.customer&&JSON.stringify(state)!==JSON.stringify(normalizeRecord(job))){pendingLoad=job;showConfirmation('load','Open this saved record and replace the current worksheet? Saved work remains available.','Open saved record');return;}clearTimeout(saveTimer);state=normalizeRecord(job);populate();scheduleDraft();window.scrollTo({top:0,behavior:'smooth'});notify('Saved work reopened with its original prices.','success');}
  let pendingLoad=null;
  async function save(type='job',cashApproved=false){if(saving)return;saving=true;const worksheet=$('top');worksheet.inert=true;
    try{syncInputs();if(!state.customer)throw Error('Enter a customer name.');const result=calculateQuote();if(!state.rooms.length||!result.ok)throw Error(result.issues.join(' ')||'Add at least one room.');
      if(type==='job'&&state.payment==='cash'&&!cashApproved){showConfirmation('cash','Record '+dollars(result.total)+' received in cash? No card is charged.','Record cash');return;}
      await Promise.all([...pendingPhotos]);if(type==='job'&&!state.signature&&!hasSignature)throw Error('Capture the customer signature before completing this job.');
      if(hasSignature)state.signature=canvas.toDataURL('image/png');clearTimeout(saveTimer);const previous=state.id?await Store.get(state.id):null;const updatedAt=new Date(Math.max(Date.now(),(Date.parse(previous?.updatedAt)||0)+1)).toISOString();
      const items=result.items.map(item=>({...item,description:item.description||(item.kind==='room'?item.name+' · '+SURFACE_NAMES[item.surface]+' · '+TIER_NAMES[item.tier]:item.name)}));
      const record={...Pricing.clone(state),id:state.id||createId(),recordType:type,documentType:type==='quote'?'quote':state.payment==='cash'?'receipt':'invoice',payment:type==='quote'?'unpaid':state.payment,amountReceived:type==='job'&&state.payment==='cash'?result.total:0,total:result.total,lineItems:items,pricingSnapshot:Pricing.clone(result.pricingSnapshot),legacySnapshot:state.legacySnapshot,completedAt:previous?.completedAt||updatedAt,updatedAt,sqft:state.areaOverride===''?measuredArea():Number(state.areaOverride)};
      await Store.put(record);if(record.leadId && callsController){try{callsController.markQuoted(record.leadId,record.id);}catch(error){notify('Quote saved, but call link could not be updated: '+error.message,'error');}}state={...state,id:record.id,recordType:type,payment:record.payment,pricingSnapshot:record.pricingSnapshot};Store.clearDraft();await renderSaved(record.id);notify(type==='quote'?'Quote saved. No payment recorded.':'Completed job saved on this device.','success');
    }catch(error){notify(error.message,'error');}finally{worksheet.inert=false;saving=false;if(pendingConfirmation)$('confirm-accept').focus();}}
  function setPage(settings){$('tools-page').hidden=true;closeDocumentPreview();$('calendar-page').hidden=true;$('calls-page').hidden=true;window.scrollTo({top:0,behavior:'instant'});$('top').hidden=settings;$('settings-page').hidden=!settings;if(settings)syncPricingEditor();else{resizeCanvas();displayQuote();}}


  function closeDocumentPreview(){if(!$('receipt-view').hidden){$('receipt-view').hidden=true;$('top').inert=false;document.title=originalTitle;}}
  function showCalendar(){$('tools-page').hidden=true;closeDocumentPreview();syncInputs();flushDraft();$('top').hidden=true;$('calls-page').hidden=true;$('settings-page').hidden=true;$('calendar-page').hidden=false;window.scrollTo({top:0,behavior:'instant'});calendarController?.refresh();}
  async function appointmentBooked(appointment){
    if(!appointment.linkedRecordId)return;
    try{const record=await Store.get(appointment.linkedRecordId);if(record?.leadId&&window.RegalCalls){const store=window.RegalCalls.createStore();const lead=store.load().find(row=>row.id===record.leadId);if(lead&&lead.status!=='closed'){store.upsert({...lead,status:'booked'});callsController?.refresh();}}}
    catch(error){notify('Appointment saved, but lead status could not be updated: '+error.message,'error');}
  }
  function worksheetHasWork() {return !!(state.id || state.leadId || state.customer || state.address || state.phone || state.email || state.signature || state.before || state.after || state.measurementNotes || state.measurementSource !== 'manual' || state.payment !== 'unpaid' || state.selectedAddons.length || state.areaOverride !== '' || state.rooms.length !== 1 || state.rooms.some(room=>room.name !== 'Living room' || room.surface !== 'carpet' || room.tier !== 'standard' || Number(room.itemCount) !== 1 || (room.sections||[]).length !== 1 || (room.sections||[]).some(section=>section.lengthFt!==''||section.widthFt!=='')));}
  function startLeadQuote(lead) {
    setPage(false);
    if(worksheetHasWork()){
      return new Promise(resolve=>{pendingLead=lead;pendingLeadResolve=resolve;showConfirmation('lead','Start a quote for this caller and replace the current worksheet? Saved quotes and jobs stay available.','Start caller quote');});
    }
    applyLead(lead);return Promise.resolve(true);
  }
  function applyLead(lead){reset();state.leadId=lead.id;state.customer=lead.name||lead.customer||'';state.phone=lead.phone||'';state.email=lead.email||'';state.address=lead.address||'';populate();flushDraft();notify('Caller details copied to a new quote. Add the work and save it to link this lead.','success');}
  window.addEventListener('DOMContentLoaded',()=>{
    document.querySelectorAll('[data-rate-surface]').forEach(input=>input.setAttribute('aria-label',SURFACE_NAMES[input.dataset.rateSurface]+' '+TIER_NAMES[input.dataset.rateTier]+' rate'));
    resizeCanvas();if(Store.getDraft())hydrate();else{state.rooms=[createRoom('Living room')];populate();}syncPricingEditor();renderSaved();
    if(window.RegalCalls)callsController=window.RegalCalls.install({host:$('calls-host'),getRecords:()=>Store.all(),onStartQuote:startLeadQuote,onDueCount:count=>{const badge=$('calls-due-badge');badge.textContent=String(count);badge.hidden=!count;}});
    if(window.RegalCalendar)calendarController=window.RegalCalendar.install({host:$('calendar-host'),getRecords:()=>Store.all(),onOpenRecord:record=>{setPage(false);loadJob(record);},onBooked:appointmentBooked});
    window.addEventListener('pagehide',flushDraft);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')flushDraft();});
    ['customer','address','customer-phone','customer-email','measurement-source','measurement-notes','sqft-override','payment'].forEach(id=>{$(id).addEventListener('input',syncInputs);$(id).addEventListener('change',syncInputs);});
    $('rooms').addEventListener('input',syncInputs);$('rooms').addEventListener('change',event=>{syncInputs();if(event.target.matches('[data-room-surface]'))renderRooms();});
    $('rooms').addEventListener('click',event=>{const card=event.target.closest('.room-card');if(!card)return;const room=state.rooms.find(r=>r.id===card.dataset.roomId);syncInputs();
      if(event.target.matches('[data-remove-room]'))state.rooms=state.rooms.filter(r=>r.id!==room.id);
      else if(event.target.matches('[data-add-section]')){delete room.overrideSqft;room.sections.push({id:createId(),lengthFt:'',widthFt:''});}
      else if(event.target.matches('[data-remove-section]'))room.sections=room.sections.filter(sec=>sec.id!==event.target.closest('.section-dimensions').dataset.sectionId);else return;
      invalidateApproval();renderRooms();displayQuote();scheduleDraft();});
    $('add-room').onclick=()=>{syncInputs();state.rooms.push(createRoom());invalidateApproval();renderRooms();displayQuote();scheduleDraft();};
    $('add-addon').onclick=()=>{if(state.pricingSnapshot){notify('This record uses saved prices. Start a new job to use the latest catalog.','error');return;}addSelectedAddon();};
    $('selected-addons').addEventListener('input',syncInputs);$('selected-addons').addEventListener('click',event=>{const id=event.target.dataset.removeSelectedAddon;if(!id)return;state.selectedAddons=state.selectedAddons.filter(s=>s.id!==id);invalidateApproval();displayQuote();scheduleDraft();});
    $('open-work').onclick=()=>setPage(false);$('open-calendar').onclick=showCalendar;$('open-calls').onclick=()=>{$('tools-page').hidden=true;closeDocumentPreview();$('calendar-page').hidden=true;syncInputs();flushDraft();$('top').hidden=true;$('settings-page').hidden=true;$('calls-page').hidden=false;window.scrollTo({top:0,behavior:'instant'});callsController?.refresh();};$('open-settings').onclick=()=>setPage(true);$('back-to-work').onclick=()=>setPage(false);$('save-pricing').onclick=savePricingSettings;$('save-addon').onclick=addCatalogItem;$('carpet-pricing-model').addEventListener('change',syncCarpetPricingEditor);
    $('addon-catalog').onclick=event=>{const editId=event.target.dataset.editAddon;if(editId){const item=pricingConfig.addons.find(a=>a.id===editId);$('addon-name').value=item.name;$('addon-rate').value=item.rate;$('addon-unit').value=item.unit;$('save-addon').dataset.editId=editId;$('save-addon').textContent='Update add-on';$('addon-name').focus();return;}const id=event.target.dataset.removeAddon;if(!id)return;try{const next=Pricing.clone(pricingConfig);next.addons=next.addons.filter(a=>a.id!==id);pricingConfig=Pricing.save(next);syncPricingEditor();if(!state.pricingSnapshot){invalidateApproval();displayQuote();scheduleDraft();}}catch(error){notify(error.message,'error');}};
    $('history-search').oninput=()=>renderHistory();
    $('before-file').onchange=()=>addPhoto('before-file','before','before-preview');$('after-file').onchange=()=>addPhoto('after-file','after','after-preview');
    canvas.addEventListener('pointerdown',startSign);canvas.addEventListener('pointermove',drawSign);canvas.addEventListener('pointerup',endSign);canvas.addEventListener('pointercancel',endSign);canvas.addEventListener('pointerleave',endSign);
    $('clear-signature').onclick=()=>{signatureRevision++;hasSignature=false;state.signature='';ctx.clearRect(0,0,canvas.width,canvas.height);scheduleDraft();};
    $('save-quote').onclick=()=>save('quote');$('save-job').onclick=()=>save('job');$('confirm-cancel').onclick=()=>{hideConfirmation();pendingLoad=null;pendingLead=null;if(pendingLeadResolve){pendingLeadResolve(false);pendingLeadResolve=null;}};$('confirm-accept').onclick=()=>{const action=pendingConfirmation;hideConfirmation();if(action==='cash')save('job',true);if(action==='new')reset();if(action==='lead'&&pendingLead){const lead=pendingLead;pendingLead=null;applyLead(lead);if(pendingLeadResolve){pendingLeadResolve(true);pendingLeadResolve=null;}};if(action==='load'&&pendingLoad){const job=pendingLoad;pendingLoad=null;loadJob(job,true);}};
    $('new-job').onclick=()=>{if(worksheetHasWork()){showConfirmation('new','Start a new job and discard the current worksheet? Saved work remains available.','Start new job');}else reset();};
    $('receipt-close').onclick=()=>{$('receipt-view').hidden=true;$('top').inert=false;document.title=originalTitle;if(receiptReturnFocus?.isConnected)receiptReturnFocus.focus();};$('receipt-print').onclick=()=>window.print();
    $('receipt-share').onclick=async()=>{if(!previewJob)return;const message=CustomerTools.createMessage(previewJob,{kind:previewJob.recordType==='quote'?'quote':previewJob.payment==='cash'?'receipt':'invoice',businessName:'Regal Carpet Cleaning',phone:'(772) 778-8480'});try{await navigator.clipboard.writeText(message.text);$('share-status').textContent='Message copied. Paste into your preferred app and review before sending.';}catch(error){$('share-status').textContent='Clipboard unavailable. Use Print / Save PDF or the email/text draft links.';}};
    document.addEventListener('keydown',event=>{if(!$('receipt-view').hidden&&event.key==='Escape')$('receipt-close').click();});window.addEventListener('resize',resizeCanvas);
  });
})();
