(function (root, factory) {
  'use strict';
  const api = factory(() => root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RegalDashboard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (getRoot) {
  'use strict';
  const money = value => {
    if (value == null || value === '') return null;
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0 ? Math.round((amount + Number.EPSILON) * 100) / 100 : null;
  };
  const dateOf = record => {
    const value = record?.completedAt || record?.updatedAt;
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? new Date(parsed) : null;
  };
  const day = date => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const recordName = record => typeof record?.customer === 'string' ? record.customer : record?.customer?.name || record?.customerName || 'Unnamed customer';
  function summarize(records, from = '', to = '') {
    if (from && to && from > to) throw new RangeError('Start date must be on or before the end date.');
    const rows = (Array.isArray(records) ? records : []).filter(record => {
      if (!record || typeof record !== 'object') return false;
      const date = dateOf(record);
      if (!date) return false;
      const key = day(date);
      return (!from || key >= from) && (!to || key <= to);
    });
    const quotes = rows.filter(r => r.recordType === 'quote');
    const jobs = rows.filter(r => r.recordType !== 'quote');
    const unpaid = jobs.filter(r => r.payment !== 'cash');
    const amount = record => money(record.total);
    const balance = record => {
      const total = amount(record);
      if (total === null) return null;
      const received = money(record.amountReceived);
      return Math.max(0, Math.round((total - (received ?? 0)) * 100) / 100);
    };
    const sum = (items, fn) => Math.round((items.reduce((acc, item) => { const value = fn(item); return value === null ? acc : acc + value; }, 0) + Number.EPSILON) * 100) / 100;
    return {
      records: rows,
      quotes: { count: quotes.length, amount: sum(quotes, amount) },
      jobs: { count: jobs.length },
      received: { amount: sum(jobs.filter(r => r.payment === 'cash'), r => money(r.amountReceived) ?? amount(r) ?? 0) },
      unpaid: { count: unpaid.length, amount: sum(unpaid, balance), records: unpaid.map(record => ({ record, balance: balance(record) })) }
    };
  }
  function createElement(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }
  function install({ host, getRecords } = {}) {
    if (!host) throw new Error('Dashboard host is required.');
    const root = getRoot(), doc = host.ownerDocument || root.document;
    const page = createElement(doc, 'section', 'dashboard');
    const heading = createElement(doc, 'h2', '', 'Business dashboard');
    const intro = createElement(doc, 'p', 'dashboard-note', 'Recorded activity from saved quotes and jobs. Cash received reflects payments recorded on this device.');
    const filters = createElement(doc, 'div', 'dashboard-filters');
    const fromLabel = createElement(doc, 'label', '', 'From date');
    const from = doc.createElement('input'); from.type = 'date'; fromLabel.append(from);
    const toLabel = createElement(doc, 'label', '', 'Through date');
    const to = doc.createElement('input'); to.type = 'date'; toLabel.append(to);
    filters.append(fromLabel, toLabel);
    const metrics = createElement(doc, 'div', 'dashboard-metrics');
    const quoteMetric = createElement(doc, 'article', 'dashboard-metric');
    const jobMetric = createElement(doc, 'article', 'dashboard-metric');
    const receivedMetric = createElement(doc, 'article', 'dashboard-metric');
    const unpaidMetric = createElement(doc, 'article', 'dashboard-metric');
    const metricValues = [];
    for (const [card, label] of [[quoteMetric, 'Saved quotes'], [jobMetric, 'Completed jobs'], [receivedMetric, 'Cash received'], [unpaidMetric, 'Unpaid balances']]) {
      const value = createElement(doc, 'p', '', '—');
      card.append(createElement(doc, 'h3', '', label), value); metricValues.push(value);
    }
    metrics.append(quoteMetric, jobMetric, receivedMetric, unpaidMetric);
    const unpaidList = createElement(doc, 'section', 'dashboard-list'); unpaidList.append(createElement(doc, 'h3', '', 'Unpaid jobs'));
    const stops = createElement(doc, 'section', 'dashboard-list'); stops.append(createElement(doc, 'h3', '', 'Today and upcoming appointments'));
    const followups = createElement(doc, 'section', 'dashboard-list'); followups.append(createElement(doc, 'h3', '', 'Due follow-ups'));
    const status = createElement(doc, 'p', 'dashboard-status', '');
    page.append(heading, intro, filters, metrics, unpaidList, stops, followups, status);
    host.replaceChildren(page);
    function renderList(section, items, empty, labelFor) {
      const list = createElement(doc, 'ul', 'dashboard-items');
      if (!items.length) list.append(createElement(doc, 'li', '', empty));
      for (const item of items) list.append(createElement(doc, 'li', '', labelFor(item)));
      const old = section.querySelector('ul');
      if (old) old.replaceWith(list); else section.append(list);
    }
    function dollars(value) {
      return value === null ? 'Amount unavailable' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
    }
    async function refresh() {
      status.textContent = '';
      try {
        const records = await (typeof getRecords === 'function' ? getRecords() : []);
        const summary = summarize(records, from.value, to.value);
        metricValues[0].textContent = `${summary.quotes.count} · ${dollars(summary.quotes.amount)} quoted`;
        metricValues[1].textContent = `${summary.jobs.count} recorded`;
        metricValues[2].textContent = dollars(summary.received.amount);
        metricValues[3].textContent = `${summary.unpaid.count} · ${dollars(summary.unpaid.amount)} due`;
        renderList(unpaidList, summary.unpaid.records, 'No unpaid jobs in this date range.', item => `${recordName(item.record)} · ${dollars(item.balance)}`);
      } catch (error) {
        metricValues.forEach(value => { value.textContent = '—'; });
        unpaidList.querySelector('ul')?.replaceChildren(createElement(doc, 'li', '', 'Dashboard totals unavailable for this date range.'));
        status.textContent = `Dashboard data could not be loaded: ${error.message}`;
      }
      const today = root.RegalCalendar?.businessDate?.() || day(new Date());
      try {
        const appointments = root.RegalCalendar?.createStore?.().load?.() || [];
        const upcoming = appointments.filter(a => a && a.status !== 'cancelled' && a.date >= today).sort((a, b) => a.date.localeCompare(b.date) || String(a.startTime).localeCompare(String(b.startTime)));
        renderList(stops, upcoming, 'No upcoming appointments.', a => `${a.date === today ? 'Today' : a.date} · ${a.startTime || ''} · ${a.name || 'Unnamed customer'}${a.address ? ` · ${a.address}` : ''}`);
      } catch (error) { renderList(stops, [], `Appointments unavailable: ${error.message}`, String); }
      try {
        const profiles = root.RegalProperties?.createStore?.().load?.() || [];
        const propertyReminders = root.RegalProperties?.reminders?.(profiles) || [];
        const callStore = root.RegalCalls?.createStore?.();
        const due = root.RegalCalls?.listCallbacks?.(callStore?.load?.() || []).filter(item => item.state === 'due') || [];
        const combined = [
          ...propertyReminders.filter(item => item.state !== 'upcoming').map(item => ({ label: `${item.name} · property service ${item.state} · ${item.nextDueDate}` })),
          ...due.map(item => ({ label: `${item.lead.name || 'Unnamed contact'} · callback due · ${new Date(item.at).toLocaleString()}` }))
        ];
        renderList(followups, combined, 'No due follow-ups.', item => item.label);
      } catch (error) { renderList(followups, [], `Follow-ups unavailable: ${error.message}`, String); }
      return true;
    }
    from.addEventListener('change', refresh); to.addEventListener('change', refresh);
    root.addEventListener?.('regal:data-changed', refresh);
    refresh();
    return { refresh, dispose() { root.removeEventListener?.('regal:data-changed', refresh); } };
  }
  return { summarize, install, money };
});
