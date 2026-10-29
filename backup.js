(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RegalBackup = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  const VERSION = 1;
  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  // Explicit allowlist: never serialize arbitrary localStorage, which may contain credentials.
  const STORAGE_KEYS = ['regal-field-draft-v1', 'regal-calls-v1', 'regal-appointments-v1', 'regal-properties-v1', 'regal-pricing-v1', 'regal-scheduling-defaults-v1'];
  const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
  const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const clone = x => JSON.parse(JSON.stringify(x));
  function checkSafe(value, path = 'backup') {
    if (Array.isArray(value)) { value.forEach((v, i) => checkSafe(v, `${path}[${i}]`)); return; }
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) throw new Error(`Unsafe field at ${path}.${key}.`);
      checkSafe(child, `${path}.${key}`);
    }
  }
  function validTimestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)) return false;
    const date = value.slice(0, 10);
    return validDateOnly(date) && Number.isFinite(Date.parse(value));
  }
  function checkRecordDates(record, label) {
    for (const key of ['createdAt', 'updatedAt', 'completedAt', 'callbackAt']) {
      if (record[key] != null && record[key] !== '' && !validTimestamp(record[key])) throw new Error(`${label} has an invalid ${key} timestamp.`);
    }
  }
  function validateLocalData(key, parsed) {
    if (key === 'regal-calls-v1' || key === 'regal-appointments-v1' || key === 'regal-properties-v1') {
      if (!Array.isArray(parsed) || parsed.some(item => !isObject(item) || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 200)) throw new Error(`Backup data for ${key} has invalid records.`);
      const ids = new Set();
      for (const item of parsed) {
        if (ids.has(item.id)) throw new Error(`Backup data for ${key} contains duplicate IDs.`);
        ids.add(item.id); checkRecordDates(item, key);
        if (key === 'regal-calls-v1' && (!['incoming', 'outgoing', 'missed', 'voicemail', 'manual'].includes(item.type) || !['new', 'contacted', 'quoted', 'booked', 'closed'].includes(item.status))) throw new Error('Backup contains a call with an invalid type or status.');
        if (key === 'regal-appointments-v1' && (!['scheduled', 'confirmed', 'enroute', 'inprogress', 'completed', 'cancelled'].includes(item.status) || typeof item.date !== 'string' || !validDateOnly(item.date))) throw new Error('Backup contains an appointment with an invalid date or status.');
        if (key === 'regal-properties-v1') {
          if (typeof item.name !== 'string' || !item.name.trim() || typeof item.address !== 'string' || (item.intervalMonths != null && (!Number.isInteger(item.intervalMonths) || item.intervalMonths < 1 || item.intervalMonths > 120))) throw new Error('Backup contains a malformed property profile.');
          for (const field of ['lastServiceDate', 'nextDueDate']) if (item[field] && !validDateOnly(item[field])) throw new Error(`Backup property has an invalid ${field}.`);
        }
      }
    }
    if (key === 'regal-field-draft-v1' && parsed !== null) {
      if (!isObject(parsed) || (parsed.id !== null && typeof parsed.id !== 'string') || !['job', 'quote'].includes(parsed.recordType || 'quote')) throw new Error('Backup draft is malformed.');
      checkRecordDates(parsed, 'Backup draft');
    }
    if (key === 'regal-pricing-v1') {
      if (!isObject(parsed) || !['demo', 'confirmed'].includes(parsed.mode) || typeof parsed.confirmed !== 'boolean' || !isObject(parsed.rates) || !Array.isArray(parsed.addons)) throw new Error('Backup pricing settings are malformed.');
      if (!Number.isFinite(parsed.minimumCharge) || parsed.minimumCharge < 0 || !Array.isArray(parsed.addons)) throw new Error('Backup pricing settings are malformed.');
      for (const surface of ['carpet', 'tile', 'upholstery']) {
        if (!isObject(parsed.rates[surface])) throw new Error('Backup pricing settings are missing a rate group.');
        for (const tier of ['standard', 'deep', 'premium']) {
          const rate = parsed.rates[surface][tier];
          if (!(rate === null || (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0))) throw new Error('Backup pricing settings contain an invalid rate.');
          const model = parsed.carpetPricing?.model;
          if (parsed.mode === 'confirmed' && parsed.confirmed && !(surface === 'carpet' && model === 'room') && rate === null) throw new Error('Confirmed backup pricing is missing a rate.');
        }
      }
      if (parsed.carpetPricing && (!['room', 'sqft'].includes(parsed.carpetPricing.model) || typeof parsed.carpetPricing.confirmed !== 'boolean' || !Number.isFinite(parsed.carpetPricing.firstRoomRate) || parsed.carpetPricing.firstRoomRate < 0 || !Number.isFinite(parsed.carpetPricing.additionalRoomRate) || parsed.carpetPricing.additionalRoomRate < 0)) throw new Error('Backup carpet pricing settings are malformed.');
      if (parsed.carpetPricing?.model === 'room' && parsed.confirmed && !parsed.carpetPricing.confirmed) throw new Error('Confirmed backup carpet pricing is not confirmed.');
      const addOnIds = new Set();
      for (const addOn of parsed.addons) {
        if (!isObject(addOn) || typeof addOn.id !== 'string' || !addOn.id || addOnIds.has(addOn.id) || typeof addOn.name !== 'string' || !addOn.name.trim() || !Number.isFinite(addOn.rate) || addOn.rate < 0 || !['job', 'stair', 'room', 'item', 'sqft', 'hour'].includes(addOn.unit)) throw new Error('Backup contains a malformed pricing add-on.');
        addOnIds.add(addOn.id);
      }
    }
    if (key === 'regal-scheduling-defaults-v1') {
      if (!isObject(parsed) || !['minutesPerRoom', 'setupCleanupMinutes', 'travelBufferMinutes'].every(k => Number.isInteger(parsed[k]) && parsed[k] >= 0 && parsed[k] <= 720) || (parsed.minutesPerRoom === 0 && parsed.setupCleanupMinutes === 0)) throw new Error('Backup scheduling defaults are malformed.');
    }
  }
  function validDateOnly(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number), date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }
  function validateBackup(data) {
    if (!isObject(data) || data.format !== 'regal-os-backup' || data.version !== VERSION) throw new Error('This is not a supported Regal OS backup.');
    if (!isObject(data.data) || !Array.isArray(data.data.jobs) || !isObject(data.data.localStorage)) throw new Error('Backup data is incomplete or malformed.');
    checkSafe(data);
    const seen = new Set();
    for (const job of data.data.jobs) {
      if (!isObject(job) || typeof job.id !== 'string' || !job.id.trim() || job.id.length > 200 || !['job', 'quote'].includes(job.recordType || 'job')) throw new Error('Backup contains a malformed job record.');
      checkRecordDates(job, 'Backup job');
      if (seen.has(job.id)) throw new Error(`Backup contains duplicate job ID ${job.id}.`);
      seen.add(job.id);
    }
    for (const key of Object.keys(data.data.localStorage)) if (!STORAGE_KEYS.includes(key)) throw new Error(`Backup contains unsupported local data (${key}).`);
    for (const key of STORAGE_KEYS) {
      if (!(key in data.data.localStorage)) continue;
      const raw = data.data.localStorage[key];
      if (raw !== null && typeof raw !== 'string') throw new Error(`Backup data for ${key} is malformed.`);
      if (raw == null) continue;
      let parsed; try { parsed = JSON.parse(raw); } catch (_) { throw new Error(`Backup data for ${key} is damaged.`); }
      checkSafe(parsed, key);
      validateLocalData(key, parsed);
    }
    return data;
  }
  function newer(candidate, current) {
    const time = x => Date.parse(x?.updatedAt || x?.completedAt || x?.createdAt || 0) || 0;
    return time(candidate) > time(current);
  }
  async function makeBackup(store, storage, now = new Date()) {
    if (!store || typeof store.all !== 'function') throw new Error('Saved jobs are unavailable.');
    const jobs = await store.all();
    if (!Array.isArray(jobs)) throw new Error('Saved jobs could not be read.');
    const localStorage = {};
    for (const key of STORAGE_KEYS) localStorage[key] = storage.getItem(key);
    const result = { format: 'regal-os-backup', version: VERSION, createdAt: now.toISOString(), data: { jobs: clone(jobs), localStorage } };
    validateBackup(result);
    if (new Blob([JSON.stringify(result)]).size > MAX_FILE_BYTES) throw new Error('Backup exceeds the 25 MB limit and was not created.');
    return result;
  }
  async function mergeBackup(backup, store, storage) {
    validateBackup(backup);
    const current = await store.all();
    if (!Array.isArray(current)) throw new Error('Existing saved jobs could not be read; nothing was restored.');
    const byId = new Map(current.map(x => [x.id, x]));
    const jobs = { added: 0, updated: 0, kept: 0 };
    for (const incoming of backup.data.jobs) {
      const old = byId.get(incoming.id);
      if (!old) { await store.put(clone(incoming)); jobs.added++; }
      else if (newer(incoming, old)) { await store.put(clone(incoming)); jobs.updated++; }
      else jobs.kept++;
    }
    let keysWritten = 0;
    for (const key of STORAGE_KEYS) {
      if (!(key in backup.data.localStorage) || backup.data.localStorage[key] == null) continue;
      const incomingRaw = backup.data.localStorage[key], currentRaw = storage.getItem(key);
      if (!currentRaw) { storage.setItem(key, incomingRaw); keysWritten++; continue; }
      // Merge identified call and appointment records, preserving current ties/newer values.
      if (key === 'regal-calls-v1' || key === 'regal-appointments-v1' || key === 'regal-properties-v1') {
        const incoming = JSON.parse(incomingRaw), existing = JSON.parse(currentRaw), merged = new Map(existing.map(x => [x.id, x]));
        for (const item of incoming) { const old = merged.get(item.id); if (!old || newer(item, old)) merged.set(item.id, item); }
        const output = JSON.stringify([...merged.values()]);
        if (output !== currentRaw) { storage.setItem(key, output); keysWritten++; }
      } else if (key === 'regal-field-draft-v1') {
        const incoming = JSON.parse(incomingRaw), existing = JSON.parse(currentRaw);
        if (!existing || newer(incoming, existing)) { storage.setItem(key, incomingRaw); keysWritten++; }
      } else if (key === 'regal-pricing-v1' || key === 'regal-scheduling-defaults-v1') {
        // User settings are a single value; never overwrite a value already on this device.
        jobs.kept += 0;
      }
    }
    return { ...jobs, keysWritten };
  }
  function install({ host, store = typeof window !== 'undefined' ? window.RegalStore : null, storage = typeof window !== 'undefined' ? window.localStorage : null } = {}) {
    if (!host || !store || !storage) return null;
    const doc = host.ownerDocument || document;
    const el = (tag, text) => { const node = doc.createElement(tag); if (text) node.textContent = text; return node; };
    host.replaceChildren();
    const title = el('h2', 'Backup and restore');
    const intro = el('p', 'Export a copy of saved jobs, calls, appointments, pricing, scheduling defaults, and the current draft. Backups exclude browser sign-in and other unrelated data.');
    const exportButton = el('button', 'Download backup'); exportButton.type = 'button';
    const input = el('input'); input.type = 'file'; input.accept = 'application/json,.json'; input.setAttribute('aria-label', 'Choose a Regal OS backup file');
    const status = el('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const preview = el('p', 'Choose a backup file to preview its contents before restoring.');
    const restoreButton = el('button', 'Restore by merging'); restoreButton.type = 'button'; restoreButton.disabled = true;
    const confirmText = el('p', 'Merge this backup into this device? Existing data will not be deleted. A recovery backup will download first.'); confirmText.hidden = true;
    const confirmButton = el('button', 'Confirm restore'); confirmButton.type = 'button'; confirmButton.hidden = true;
    const cancelButton = el('button', 'Cancel'); cancelButton.type = 'button'; cancelButton.hidden = true;
    host.append(title, intro, exportButton, input, preview, restoreButton, confirmText, confirmButton, cancelButton, status);
    let pending = null;
    const download = (data, name) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), link = el('a'); link.href = url; link.download = name; link.hidden = true;
      host.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    exportButton.addEventListener('click', async () => {
      exportButton.disabled = true; status.textContent = 'Preparing backup…';
      try { const data = await makeBackup(store, storage); download(data, `regal-os-backup-${new Date().toISOString().slice(0, 10)}.json`); status.textContent = `Backup downloaded with ${data.data.jobs.length} saved jobs.`; }
      catch (error) { status.textContent = `Backup failed: ${error.message}`; }
      finally { exportButton.disabled = false; }
    });
    input.addEventListener('change', async () => {
      pending = null; restoreButton.disabled = true;
      const file = input.files?.[0]; if (!file) return;
      try {
        if (file.size > MAX_FILE_BYTES) throw new Error('Backup is too large (maximum 25 MB).');
        const data = validateBackup(JSON.parse(await file.text()));
        pending = data; restoreButton.disabled = false;
        const importedCounts = [`${data.data.jobs.length} saved jobs`];
        for (const [key, label] of [['regal-calls-v1', 'calls'], ['regal-appointments-v1', 'appointments'], ['regal-properties-v1', 'property profiles']]) {
          if (data.data.localStorage[key] != null) importedCounts.push(`${JSON.parse(data.data.localStorage[key]).length} ${label}`);
        }
        const otherSets = Object.entries(data.data.localStorage).filter(([key, value]) => value != null && !['regal-calls-v1', 'regal-appointments-v1', 'regal-properties-v1'].includes(key)).length;
        if (otherSets) importedCounts.push(`${otherSets} settings or draft values`);
        const counts = importedCounts.join('; ');
        preview.textContent = `Valid backup from ${data.createdAt || 'an unknown date'}: ${counts} Restore merges records by ID, keeps newer local records, and does not delete anything.`;
        status.textContent = '';
      } catch (error) { preview.textContent = 'This backup cannot be restored.'; status.textContent = error.message; }
    });
    restoreButton.addEventListener('click', () => {
      if (!pending) return;
      confirmText.hidden = false; confirmButton.hidden = false; cancelButton.hidden = false; restoreButton.disabled = true;
      status.textContent = 'Review the confirmation before continuing.';
    });
    cancelButton.addEventListener('click', () => {
      confirmText.hidden = true; confirmButton.hidden = true; cancelButton.hidden = true; restoreButton.disabled = !pending; status.textContent = 'Restore cancelled.';
    });
    confirmButton.addEventListener('click', async () => {
      if (!pending) return;
      confirmText.hidden = true; confirmButton.hidden = true; cancelButton.hidden = true;
      restoreButton.disabled = true; status.textContent = 'Downloading a recovery backup…';
      try {
        const recovery = await makeBackup(store, storage);
        download(recovery, `regal-os-recovery-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        const counts = await mergeBackup(pending, store, storage);
        window.dispatchEvent(new CustomEvent('regal:data-changed', { detail: { source: 'restore' } }));
        status.textContent = `Restore complete: ${counts.added} jobs added, ${counts.updated} updated, ${counts.kept} kept; ${counts.keysWritten} data sets restored. Recovery backup downloaded.`;
        pending = null; input.value = ''; preview.textContent = 'Choose another backup file to preview it.';
      } catch (error) { status.textContent = `Restore incomplete: ${error.message}. Some earlier records may have been saved; review this device before retrying.`; }
      finally { restoreButton.disabled = !pending; }
    });
    return { host, exportButton, input, restoreButton, confirmButton, cancelButton, status, preview };
  }
  return { VERSION, STORAGE_KEYS, MAX_FILE_BYTES, validateBackup, makeBackup, mergeBackup, install };
});
