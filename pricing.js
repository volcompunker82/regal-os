(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RegalPricing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const STORAGE_KEY = 'regal-pricing-v1';
  const ROOM_RATE_MIGRATION_KEY = 'regal-carpet-room-rates-migrated-v1';
  const TIERS = ['standard', 'deep', 'premium'];
  const SURFACES = ['carpet', 'tile', 'upholstery'];
  const ADDON_UNITS = ['job', 'stair', 'room', 'item', 'sqft', 'hour'];
  const DEFAULTS = Object.freeze({
    version: 1,
    mode: 'demo',
    confirmed: false,
    minimumCharge: 0,
    carpetPricing: { model: 'room', firstRoomRate: 150, additionalRoomRate: 25, confirmed: true },
    rates: {
      carpet: { standard: null, deep: null, premium: null },
      tile: { standard: null, deep: null, premium: null },
      upholstery: { standard: null, deep: null, premium: null },
    },
    addons: [],
  });

  function isAmount(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function validateConfig(input) {
    const issues = [];
    if (!input || typeof input !== 'object') return { ok: false, issues: ['Pricing settings must be an object.'] };
    if (!isAmount(input.minimumCharge)) issues.push('Minimum charge must be a finite amount of zero or more.');
    if (!['demo', 'confirmed'].includes(input.mode)) issues.push('Choose demo or confirmed pricing mode.');
    if (input.mode === 'confirmed' && input.confirmed === true) {
      const surfacesToConfirm = input.carpetPricing?.model === 'room' ? SURFACES.filter(surface => surface !== 'carpet') : SURFACES;
      for (const surface of surfacesToConfirm) for (const tier of TIERS) {
        if (!isAmount(input.rates?.[surface]?.[tier])) issues.push(`Set a ${surface} ${tier} rate before confirming the full rate card.`);
      }
      if (input.carpetPricing?.model === 'room' && input.carpetPricing.confirmed !== true) issues.push('Confirm the carpet room package prices before confirming the full rate card.');
    }
    for (const surface of SURFACES) {
      for (const tier of TIERS) {
        const rate = input.rates?.[surface]?.[tier];
        if (rate !== null && rate !== undefined && !isAmount(rate)) issues.push(`${surface} ${tier} rate must be a finite amount of zero or more.`);
      }
    }
    if (input.carpetPricing !== undefined) {
      const cp = input.carpetPricing;
      if (!cp || !['room', 'sqft'].includes(cp.model)) issues.push('Choose room-package or square-foot carpet pricing.');
      if (cp?.model === 'room' && (!isAmount(cp.firstRoomRate) || !isAmount(cp.additionalRoomRate))) issues.push('Carpet room prices must be finite amounts of zero or more.');
      if (cp && typeof cp.confirmed !== 'boolean') issues.push('Carpet room pricing confirmation must be true or false.');
    }
    if (!Array.isArray(input.addons)) issues.push('Add-on catalog must be a list.');
    else {
      const ids = new Set();
      for (const [i, item] of input.addons.entries()) {
        if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) issues.push(`Add-on ${i + 1} needs a unique ID.`);
        else ids.add(item.id);
        if (typeof item.name !== 'string' || !item.name.trim()) issues.push(`Add-on ${i + 1} needs a name.`);
        if (!isAmount(item.rate)) issues.push(`Add-on ${i + 1} rate must be a finite amount of zero or more.`);
        if (!ADDON_UNITS.includes(item.unit)) issues.push(`Add-on ${i + 1} unit is not supported.`);
      }
    }
    return { ok: issues.length === 0, issues };
  }
  function normalizeConfig(input) {
    const result = clone(DEFAULTS);
    if (input && typeof input === 'object') {
      result.mode = input.mode === 'confirmed' ? 'confirmed' : 'demo';
      result.confirmed = input.confirmed === true && result.mode === 'confirmed';
      if (input.carpetPricing && typeof input.carpetPricing === 'object') {
        result.carpetPricing = {
          model: input.carpetPricing.model === 'room' ? 'room' : 'sqft',
          firstRoomRate: isAmount(input.carpetPricing.firstRoomRate) ? input.carpetPricing.firstRoomRate : DEFAULTS.carpetPricing.firstRoomRate,
          additionalRoomRate: isAmount(input.carpetPricing.additionalRoomRate) ? input.carpetPricing.additionalRoomRate : DEFAULTS.carpetPricing.additionalRoomRate,
          confirmed: input.carpetPricing.confirmed === true,
        };
      } else {
        // Old saved configurations and quote snapshots used square-foot carpet rates.
        result.carpetPricing = { model: 'sqft', firstRoomRate: 150, additionalRoomRate: 25, confirmed: false };
      }
      if (isAmount(input.minimumCharge)) result.minimumCharge = input.minimumCharge;
      for (const surface of SURFACES) for (const tier of TIERS) {
        const value = input.rates?.[surface]?.[tier];
        result.rates[surface][tier] = isAmount(value) ? value : null;
      }
      result.addons = Array.isArray(input.addons) ? input.addons.map((item) => ({
        id: String(item.id || ''), name: String(item.name || '').trim(), rate: item.rate, unit: item.unit,
      })) : [];
    }
    return result;
  }
  function load(storage) {
    const target = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!target) return clone(DEFAULTS);
    try {
      const raw = target.getItem(STORAGE_KEY);
      if (!raw) return clone(DEFAULTS);
      const parsed = JSON.parse(raw);
      const result = normalizeConfig(parsed);
      if (!Object.prototype.hasOwnProperty.call(parsed, 'carpetPricing') && target.getItem(ROOM_RATE_MIGRATION_KEY) !== 'done') {
        result.carpetPricing = { model: 'room', firstRoomRate: 150, additionalRoomRate: 25, confirmed: true };
        result.rates.carpet = { standard: null, deep: null, premium: null };
        result.addons = result.addons.filter(item => item.name.trim().toLowerCase() !== 'stair cleaning (demo)');
        try { target.setItem(STORAGE_KEY, JSON.stringify(result)); }
        catch (_) { return normalizeConfig(parsed); }
        try { target.setItem(ROOM_RATE_MIGRATION_KEY, 'done'); } catch (_) { /* The migrated config itself prevents a repeated migration. */ }
      }
      return result;
    }
    catch (_) { return clone(DEFAULTS); }
  }
  function save(config, storage) {
    const validation = validateConfig(config);
    if (!validation.ok) throw new Error(validation.issues.join(' '));
    const result = normalizeConfig(config);
    const target = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!target) throw new Error('Local pricing storage is unavailable.');
    target.setItem(STORAGE_KEY, JSON.stringify(result));
    return result;
  }
  function roundMoney(amount) { return Math.round((amount + Number.EPSILON) * 100) / 100; }
  function calculate(rooms, selectedAddons, config, options) {
    const settings = normalizeConfig(config);
    const issues = [];
    const items = [];
    const measuredSqft = (rooms || []).reduce((sum, room) => room.surface === 'upholstery' ? sum : sum + (room.overrideSqft === '' || room.overrideSqft == null ? (room.sections || []).reduce((sectionTotal, section) => sectionTotal + Number(section.lengthFt || 0) * Number(section.widthFt || 0), 0) : Number(room.overrideSqft)), 0);
    const sqftRooms = (rooms || []).filter(room => room.surface !== 'upholstery' && !(room.surface === 'carpet' && settings.carpetPricing.model === 'room'));
    const sqftMeasured = sqftRooms.reduce((sum, room) => sum + (room.overrideSqft === '' || room.overrideSqft == null ? (room.sections || []).reduce((sectionTotal, section) => sectionTotal + Number(section.lengthFt || 0) * Number(section.widthFt || 0), 0) : Number(room.overrideSqft)), 0);
    const areaOverride = options && options.areaOverride !== '' && options.areaOverride != null ? Number(options.areaOverride) : null;
    if (areaOverride !== null && sqftRooms.length && (rooms || []).some(room => room.surface === 'carpet' && settings.carpetPricing.model === 'room')) issues.push('For mixed room-price carpet and square-foot services, clear the total-area override and enter dimensions for each area.');
    if (areaOverride !== null && (!isAmount(areaOverride) || areaOverride <= 0)) issues.push('Square-foot override must be a finite area greater than zero.');
    const areaRatio = areaOverride !== null && sqftMeasured > 0 ? areaOverride / sqftMeasured : 1;
    let manualOverrideAssigned = false;
    let carpetRoomIndex = 0;
    for (const room of rooms || []) {
      if (!room || !SURFACES.includes(room.surface) || !TIERS.includes(room.tier)) { issues.push('Each room needs a supported surface and service tier.'); continue; }
      const roomPackage = room.surface === 'carpet' && settings.carpetPricing.model === 'room';
      if (roomPackage) {
        for (const [index, section] of (room.sections || []).entries()) {
          const length = section.lengthFt === '' || section.lengthFt == null ? null : Number(section.lengthFt);
          const width = section.widthFt === '' || section.widthFt == null ? null : Number(section.widthFt);
          if (length === null && width === null) continue;
          if (!isAmount(length) || length <= 0 || !isAmount(width) || width <= 0) issues.push(`Section ${index + 1} in ${room.name || 'each room'} needs both finite, positive dimensions.`);
        }
        const rate = carpetRoomIndex++ === 0 ? settings.carpetPricing.firstRoomRate : settings.carpetPricing.additionalRoomRate;
        const name = room.name || 'Carpet room';
        items.push({ id: `room:${room.id}`, kind: 'room', package: 'carpet-room', description: `${name} · Carpet room service`, name: 'Carpet room service', surface: 'carpet', tier: room.tier, quantity: 1, unit: 'room', rate, total: roundMoney(rate), confirmed: true });
        continue;
      }
      const rate = settings.rates[room.surface][room.tier];
      if (!isAmount(rate)) { issues.push(`Set a ${room.surface} ${room.tier} rate in pricing settings before quoting.`); continue; }
      const sectionArea = (room.sections || []).reduce((sum, section) => sum + Number(section.lengthFt || 0) * Number(section.widthFt || 0), 0);
      let badDimensions = false;
      for (const [index, section] of (room.surface === 'upholstery' ? [] : (room.sections || [])).entries()) {
        const length = section.lengthFt === '' || section.lengthFt == null ? null : Number(section.lengthFt);
        const width = section.widthFt === '' || section.widthFt == null ? null : Number(section.widthFt);
        const bothBlank = length === null && width === null;
        if (bothBlank && areaOverride !== null) continue;
        if (bothBlank) { issues.push(`Enter length and width for section ${index + 1} in ${room.name || 'each room'}.`); badDimensions = true; continue; }
        if (!isAmount(length) || length <= 0 || !isAmount(width) || width <= 0) { issues.push(`Section ${index + 1} in ${room.name || 'each room'} needs finite, positive dimensions.`); badDimensions = true; }
      }
      if (badDimensions) continue;
      let quantity = room.surface === 'upholstery' ? Number(room.itemCount || 0) : (room.overrideSqft === '' || room.overrideSqft === null || room.overrideSqft === undefined ? sectionArea : Number(room.overrideSqft));
      if (room.surface !== 'upholstery' && areaOverride !== null) {
        if (sqftMeasured > 0) quantity *= areaRatio;
        else if (!manualOverrideAssigned) { quantity = areaOverride; manualOverrideAssigned = true; }
        else quantity = 0;
      }
      if (room.surface !== 'upholstery' && quantity === 0 && areaOverride !== null && manualOverrideAssigned) continue;
      if (!isAmount(quantity) || quantity <= 0) { issues.push(`Enter a measured area or item count for ${room.name || 'each room'}.`); continue; }
      const unit = room.surface === 'upholstery' ? 'item' : 'sqft';
      const lineTotal = roundMoney(quantity * rate);
      items.push({ id: `room:${room.id}`, kind: 'room', name: room.name || 'Area', surface: room.surface, tier: room.tier, quantity, unit, rate, total: lineTotal });
    }
    if (!items.some(item => item.kind === 'room')) issues.push('Add a room with a positive area or an upholstery item count.');
    if (areaOverride !== null && sqftMeasured === 0 && sqftRooms.length > 1) issues.push('Measure each room before applying a total-area override to multiple rooms.');
    const addonIds = Array.isArray(selectedAddons) ? selectedAddons : [];
    for (const selection of addonIds) {
      const id = typeof selection === 'string' ? selection : selection.id;
      const addon = settings.addons.find((entry) => entry.id === id);
      if (!addon) { issues.push('An add-on selection is no longer in the pricing catalog.'); continue; }
      const qty = addon.unit === 'sqft' ? (areaOverride !== null ? areaOverride : measuredSqft)
        : addon.unit === 'room' ? (rooms || []).length
        : addon.unit === 'job' ? 1
        : Number(typeof selection === 'string' ? 1 : selection.quantity || 0);
      if (!isAmount(qty) || qty <= 0) { issues.push(`Enter a quantity for ${addon.name}.`); continue; }
      items.push({ id: `addon:${addon.id}`, kind: 'addon', name: addon.name, quantity: qty, unit: addon.unit, rate: addon.rate, total: roundMoney(qty * addon.rate) });
    }
    const subtotal = roundMoney(items.reduce((sum, item) => sum + item.total, 0));
    const minimumAdjustment = Math.max(0, roundMoney(settings.minimumCharge - subtotal));
    if (minimumAdjustment > 0) items.push({ id: 'minimum-adjustment', kind: 'minimum', name: 'Minimum charge adjustment', quantity: 1, unit: 'item', rate: minimumAdjustment, total: minimumAdjustment });
    return { ok: issues.length === 0, issues, items, subtotal, minimumAdjustment, total: roundMoney(subtotal + minimumAdjustment), pricingSnapshot: clone(settings) };
  }
  return { STORAGE_KEY, ROOM_RATE_MIGRATION_KEY, TIERS, SURFACES, DEFAULTS, clone, isAmount, validateConfig, normalizeConfig, load, save, calculate, roundMoney };
});
