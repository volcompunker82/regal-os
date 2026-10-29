(function (root, factory) {
  'use strict';
  const api = factory(() => root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RegalCustomerTools = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (getRoot) {
  'use strict';

  const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const cleanText = (value, max = 240) => String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
  const normalizeWords = (value) => cleanText(value, 500).normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const isAmount = (value) => Number.isFinite(Number(value)) && Number(value) >= 0;
  const money = (value) => isAmount(value) ? MONEY.format(Number(value)) : 'Amount unavailable';
  const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

  function normalizedEmail(value) {
    const email = cleanText(value, 254).toLowerCase();
    if (!email || /[\r\n\s<>]/.test(email)) return '';
    return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email) ? email : '';
  }
  function normalizedPhone(value) {
    const raw = cleanText(value, 60);
    if (!raw || /[^\d+().\s-]/.test(raw) || (raw.match(/\+/g) || []).length > 1 || (raw.includes('+') && !raw.startsWith('+'))) return '';
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return '';
    return (raw.startsWith('+') ? '+' : '') + digits;
  }
  function customerParts(input) {
    const source = input && typeof input === 'object' ? input : { customer: input };
    const customer = source.customer && typeof source.customer === 'object' ? source.customer : null;
    const name = typeof source.customer === 'string' ? source.customer
      : source.name || customer?.name || customer?.customerName || '';
    const id = source.customerId || source.customer_id || customer?.customerId || customer?.customer_id || customer?.id || '';
    const address = source.address || source.serviceAddress || customer?.address || '';
    const phone = source.phone || customer?.phone || '';
    const email = source.email || customer?.email || '';
    return { id: cleanText(id, 160), name: normalizeWords(name), address: normalizeWords(address), phone: normalizedPhone(phone), email: normalizedEmail(email) };
  }

  function normalizeCustomerKey(input) {
    const part = customerParts(input);
    if (part.id) return `id:${part.id.toLowerCase()}`;
    if (part.phone) return `phone:${part.phone}`;
    if (part.email) return `email:${part.email}`;
    if (part.name && part.address) return `name-address:${part.name}|${part.address}`;
    if (part.name) return `name:${part.name}`;
    return 'customer:unknown';
  }

  function groupHistory(records) {
    const groups = [];
    for (const job of Array.isArray(records) ? records : []) {
      if (!job || typeof job !== 'object') continue;
      const part = customerParts(job);
      let group = groups.find((candidate) => {
        const match = candidate.jobs.some((existing) => {
          const prior = customerParts(existing);
          if (part.id && prior.id && part.id.toLowerCase() !== prior.id.toLowerCase()) return false;
          if (part.id && prior.id) return part.id.toLowerCase() === prior.id.toLowerCase();
          if (part.phone && prior.phone && part.phone === prior.phone) return true;
          if (part.email && prior.email && part.email === prior.email) return true;
          return !!(part.name && part.address && part.name === prior.name && part.address === prior.address);
        });
        return match;
      });
      if (!group) {
        group = { key: normalizeCustomerKey(job), customer: cleanText(typeof job.customer === 'string' ? job.customer : job.customer?.name || job.name || '', 160) || 'Unnamed customer', address: cleanText(job.address || job.customer?.address || '', 240), jobs: [] };
        groups.push(group);
      }
      group.jobs.push(job);
    }
    const result = groups;
    result.forEach((group) => group.jobs.sort((a, b) => (Date.parse(b.completedAt || b.updatedAt || '') || 0) - (Date.parse(a.completedAt || a.updatedAt || '') || 0)));
    return result.sort((a, b) => (Date.parse(b.jobs[0]?.completedAt || b.jobs[0]?.updatedAt || '') || 0) - (Date.parse(a.jobs[0]?.completedAt || a.jobs[0]?.updatedAt || '') || 0));
  }

  function findHistory(records, query) {
    const needle = normalizeWords(query);
    const source = Array.isArray(records) ? records : [];
    if (!needle) return source.filter((job) => job && typeof job === 'object');
    return source.filter((job) => {
      if (!job || typeof job !== 'object') return false;
      const terms = [job.customer?.name, job.customer, job.customerName, job.address, job.phone, job.email, job.id, job.tier, job.service,
        ...(Array.isArray(job.lineItems) ? job.lineItems.map((item) => item?.description || item?.name) : []),
        ...(Array.isArray(job.items) ? job.items.map((item) => item?.name || item?.description) : [])];
      return normalizeWords(terms.join(' ')).includes(needle);
    });
  }

  function getLineItems(job) {
    if (Array.isArray(job?.lineItems)) return job.lineItems.filter((item) => item && typeof item === 'object');
    if (Array.isArray(job?.items)) return job.items.filter((item) => item && typeof item === 'object');
    const sqft = Number(job?.sqft);
    const rate = Number(job?.rate);
    if (Number.isFinite(sqft) && sqft > 0 && Number.isFinite(rate) && rate >= 0) {
      return [{ description: `${sqft.toLocaleString('en-US')} sq ft service`, quantity: sqft, unit: 'sq ft', rate, total: roundMoney(sqft * rate) }];
    }
    return [];
  }
  function lineValues(item) {
    const quantity = isAmount(item.quantity) ? Number(item.quantity) : null;
    const rate = isAmount(item.rate) ? Number(item.rate) : null;
    const total = isAmount(item.total) ? Number(item.total) : quantity !== null && rate !== null ? roundMoney(quantity * rate) : null;
    let detail = cleanText(item.description || item.name || 'Service', 120);
    if (quantity !== null) detail += ` — ${quantity.toLocaleString('en-US')} ${cleanText(item.unit || 'item', 24)}`;
    if (rate !== null) detail += ` × ${money(rate)}`;
    return { detail, total };
  }
  function deriveTotal(job, items) {
    if (isAmount(job?.total)) return Number(job.total);
    const itemTotals = items.map((item) => lineValues(item).total);
    if (itemTotals.length && itemTotals.every((value) => value !== null)) return roundMoney(itemTotals.reduce((sum, value) => sum + value, 0));
    const sqft = Number(job?.sqft), rate = Number(job?.rate);
    return Number.isFinite(sqft) && sqft >= 0 && Number.isFinite(rate) && rate >= 0 ? roundMoney(sqft * rate) : null;
  }
  function createMessage(job, options = {}) {
    const kind = ['quote', 'invoice', 'receipt'].includes(options.kind) ? options.kind : (job?.payment === 'cash' ? 'receipt' : 'quote');
    const businessName = cleanText(options.businessName || 'Your service provider', 120) || 'Your service provider';
    const customer = cleanText(typeof job?.customer === 'string' ? job.customer : job?.customer?.name || job?.customerName || 'there', 120) || 'there';
    const items = getLineItems(job);
    const suppliedRoomPrices = job?.pricingSnapshot?.carpetPricing?.confirmed === true && items.length > 0 && items.every(item => item.package === 'carpet-room');
    const rows = items.map(lineValues);
    const total = deriveTotal(job, items);
    const paid = job?.payment === 'cash';
    const received = paid ? (isAmount(job?.amountReceived) ? Number(job.amountReceived) : (total ?? 0)) : 0;
    const balance = total === null ? null : Math.max(0, roundMoney(total - received));
    const title = kind === 'quote' ? 'Quote' : kind === 'invoice' ? 'Invoice' : 'Receipt';
    const id = cleanText(job?.id, 50);
    const subject = cleanText(`${title}${id ? ` ${id.slice(-8).toUpperCase()}` : ''} from ${businessName}`, 180);
    const lines = [
      `Hi ${customer},`,
      '',
      `${businessName} ${kind === 'quote' ? 'prepared this quote' : kind === 'invoice' ? 'prepared this invoice' : 'recorded this payment'}.`,
      ...(job?.pricingSnapshot?.confirmed === true || suppliedRoomPrices ? [] : ['DEMO PRICING — please confirm pricing before relying on this amount.']),
      ...(rows.length ? ['', 'Items:', ...rows.map((row) => `• ${row.detail}: ${row.total === null ? 'Amount unavailable' : money(row.total)}`)] : []),
      '',
      `Total: ${total === null ? 'Amount unavailable' : money(total)}`,
      ...(kind === 'quote' ? [] : [`Amount received: ${money(received)}`, `Balance due: ${balance === null ? 'Amount unavailable' : money(balance)}`]),
      ...(options.phone ? [`Business phone: ${cleanText(options.phone, 40)}`] : []),
      '',
      `— ${businessName}`,
    ];
    return { subject, text: lines.join('\n'), body: lines.join('\n'), kind, total, amountReceived: received, balanceDue: balance };
  }

  function buildMailto(email, subject, body) {
    const recipient = normalizedEmail(email);
    if (!recipient) return '';
    const safeSubject = cleanText(subject, 180).replace(/[\r\n]/g, ' ');
    const safeBody = String(body == null ? '' : body).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    return `mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(safeSubject)}&body=${encodeURIComponent(safeBody)}`;
  }
  function buildSms(phone, body) {
    const normalized = normalizedPhone(phone);
    if (!normalized) return '';
    const safeBody = String(body == null ? '' : body).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    return `sms:${normalized}?body=${encodeURIComponent(safeBody)}`;
  }

  function messageForShare(job, options) {
    if (typeof options.text === 'string' && options.text.trim()) return options.text;
    return createMessage(job, { kind: options.kind || (job?.payment === 'cash' ? 'receipt' : 'invoice'), businessName: options.businessName, phone: options.phone }).text;
  }
  async function shareDocument(job, options = {}) {
    const root = getRoot() || {};
    const title = cleanText(options.title || createMessage(job, { kind: options.kind, businessName: options.businessName }).subject, 180);
    const text = messageForShare(job, options);
    try {
      if (root.navigator && typeof root.navigator.share === 'function') {
        await root.navigator.share({ title, text });
        return { status: 'opened', method: 'share' };
      }
      if (root.navigator?.clipboard && typeof root.navigator.clipboard.writeText === 'function') {
        await root.navigator.clipboard.writeText(text);
        return { status: 'copied', method: 'clipboard' };
      }
      return { status: 'unavailable', method: null };
    } catch (error) {
      if (error?.name === 'AbortError') return { status: 'cancelled', method: 'share' };
      return { status: 'failed', method: root.navigator?.share ? 'share' : 'clipboard', error };
    }
  }

  function safeThumbnail(value) {
    return typeof value === 'string' && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(value) ? value : '';
  }
  function formatDate(value) {
    const timestamp = Date.parse(value || '');
    return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleDateString() : 'Date unavailable';
  }
  function renderHistory(host, records, onOpen) {
    const root = getRoot() || {};
    const doc = root.document;
    if (!host || !doc?.createElement) return [];
    const groups = groupHistory(records);
    host.replaceChildren();
    if (!groups.length) {
      const empty = doc.createElement('p'); empty.className = 'history-empty'; empty.textContent = 'No saved customer history yet.'; host.appendChild(empty); return groups;
    }
    const list = doc.createElement('div'); list.setAttribute('role', 'list'); list.setAttribute('aria-label', 'Customer history');
    for (const group of groups) {
      const section = doc.createElement('section'); section.className = 'customer-history-group'; section.setAttribute('role', 'listitem');
      const heading = doc.createElement('h3'); heading.textContent = group.customer; section.appendChild(heading);
      if (group.address) { const address = doc.createElement('p'); address.className = 'customer-history-address'; address.textContent = group.address; section.appendChild(address); }
      const jobs = doc.createElement('ul'); jobs.className = 'customer-history-jobs';
      for (const job of group.jobs) {
        const item = doc.createElement('li'); item.className = 'customer-history-job';
        const title = doc.createElement('span'); title.className = 'customer-history-job-title'; title.textContent = cleanText(job.service || job.tier || job.documentType || 'Saved job', 100);
        const meta = doc.createElement('span'); meta.className = 'customer-history-job-meta';
        const total = deriveTotal(job, getLineItems(job));
        meta.textContent = `${formatDate(job.completedAt || job.updatedAt)} · ${total === null ? 'Amount unavailable' : money(total)} · ${job.payment === 'cash' ? 'Paid' : 'Unpaid'}`;
        item.append(title, meta);
        for (const [field, label] of [['before', 'Before photo'], ['after', 'After photo']]) {
          const src = safeThumbnail(job[field]);
          if (src) { const image = doc.createElement('img'); image.src = src; image.alt = label; image.loading = 'lazy'; image.className = 'customer-history-photo'; item.appendChild(image); }
        }
        const button = doc.createElement('button'); button.type = 'button'; button.className = 'customer-history-open'; button.textContent = 'Open saved job';
        button.addEventListener('click', () => { if (typeof onOpen === 'function') onOpen(job); }); item.appendChild(button);
        jobs.appendChild(item);
      }
      section.appendChild(jobs); list.appendChild(section);
    }
    host.appendChild(list);
    return groups;
  }

  function install({ host, getRecords, onOpen, getBusiness } = {}) {
    const root = getRoot() || {};
    const target = typeof host === 'string' ? root.document?.querySelector(host) : host;
    let disposed = false;
    const refresh = async () => {
      if (disposed || !target) return [];
      let records = typeof getRecords === 'function' ? getRecords() : getRecords;
      records = await Promise.resolve(records || []);
      if (disposed) return [];
      const groups = renderHistory(target, records, onOpen);
      target.dataset.customerHistoryCount = String(groups.length);
      if (typeof getBusiness === 'function') await Promise.resolve(getBusiness());
      return groups;
    };
    const ready = refresh();
    return { refresh, ready, dispose() { disposed = true; if (target) delete target.dataset.customerHistoryCount; } };
  }

  return { normalizeCustomerKey, groupHistory, findHistory, createMessage, buildMailto, buildSms, shareDocument, renderHistory, install };
});
