/* AIS Audit Sandbox engine.
   Builds a made-up company (people, approval policy, vendor registry) and a purchase ledger
   with problems planted in it. The answer key is not taken from what was planted: every
   transaction is checked against the policy and its own documents, and a round is only used
   when that check finds exactly the problems that were planted, one per row.
   Money is kept in whole cents throughout. Runs in the browser (window.AuditEngine) and in
   Node (module.exports), so it can be tested. */
(function (root) {
  'use strict';

  // ── Problem types ─────────────────────────────────────────────
  var TYPES = {
    DUPLICATE_PAYMENT:     { label: 'Duplicate payment',        color: '#8A5A00', hint: 'A PO that was already paid gets paid again on a second invoice.' },
    SPLIT_PURCHASE:        { label: 'Split purchase',           color: '#B3372E', hint: 'Purchases for the same project from the same vendor, each within the approver’s limit but over it together.' },
    UNREGISTERED_VENDOR:   { label: 'Unregistered vendor',      color: '#6B4FA0', hint: 'The vendor paid isn’t on the Approved Vendor Registry. Check the exact name.' },
    VENDOR_MISMATCH:       { label: 'Vendor mismatch',          color: '#5B6B2F', hint: 'The invoice and payment go to a different vendor than the PO and receiving report.' },
    MISSING_RECEIPT:       { label: 'Missing receiving report', color: '#0E7490', hint: 'A PO and an invoice but no receiving report, so nothing shows the goods arrived.' },
    UNAUTHORIZED_APPROVAL: { label: 'Unauthorized approval',    color: '#1E7A4E', hint: 'The PO is over the approver’s limit, or for a department they can’t approve for.' },
    QTY_MISMATCH:          { label: 'Qty mismatch',             color: '#4E5DA8', hint: 'The invoice bills for more units than the PO ordered and receiving counted.' },
    PRICE_MISMATCH:        { label: 'Price mismatch',           color: '#8A2E5E', hint: 'The invoice unit price is higher than the price on the PO.' }
  };
  var TYPE_KEYS = Object.keys(TYPES);

  // ── Policy ────────────────────────────────────────────────────
  var DEPTS = ['Operations', 'Facilities', 'IT', 'Marketing'];
  var LIMITS = { Supervisor: 1000000, Manager: 2500000, Director: 10000000, CFO: Infinity };
  var SPLIT_WINDOW_DAYS = 30;
  var POLICY = [
    { title: 'Approval limits', text: 'Every purchase order needs one approver whose limit covers the PO total: Supervisor up to $10,000, Manager up to $25,000, Director up to $100,000, CFO any amount. The CEO and receiving staff don’t approve purchases.' },
    { title: 'Department authority', text: 'Supervisors and managers approve for their own department only. Each director approves for the departments listed under them in the directory. The CFO approves for every department.' },
    { title: 'No splitting', text: 'Purchase orders for the same project from the same vendor within ' + SPLIT_WINDOW_DAYS + ' days count as one purchase. Their combined total must be within the approver’s limit.' },
    { title: 'Approved vendors only', text: 'Pay only vendors on the Approved Vendor Registry, under their exact registered name.' },
    { title: 'Three-way match', text: 'Pay an invoice only when the PO, the receiving report and the invoice agree on vendor, quantity and unit price, and the invoice total equals quantity × unit price.' },
    { title: 'One payment per PO', text: 'Each purchase order is paid once. A second invoice against a PO that has been paid is not paid.' },
    { title: 'Exceptions', text: 'None. Emergency purchases still follow these rules in this company.' }
  ];

  // ── Data pools ────────────────────────────────────────────────
  var COMPANIES = [
    { name: 'Meridian Supplies Co.', industry: 'Office Supplies Distribution', employees: 847, revenue: '$12.4M' },
    { name: 'Harlow & Associates', industry: 'Professional Services Firm', employees: 312, revenue: '$8.7M' },
    { name: 'Crestview Manufacturing', industry: 'Industrial Components', employees: 1240, revenue: '$34.2M' },
    { name: 'Pinnacle Retail Group', industry: 'Consumer Goods Retail', employees: 623, revenue: '$19.1M' },
    { name: 'Atlas Logistics Inc.', industry: 'Supply Chain & Freight', employees: 489, revenue: '$22.8M' },
    { name: 'Nexus Tech Solutions', industry: 'IT Services & Consulting', employees: 156, revenue: '$6.3M' },
    { name: 'Beacon Healthcare Systems', industry: 'Healthcare Administration', employees: 2100, revenue: '$87.5M' },
    { name: 'Cobalt Energy Partners', industry: 'Energy Distribution', employees: 390, revenue: '$41.0M' }
  ];

  // Vendors each department buys from. Some sound vague but are real, registered suppliers.
  var VENDORS = {
    Operations: ['Apex Freight Co.', 'Reliable Parts Co.', 'ProSource Materials', 'Alliance Shipping', 'Summit Industrial Supply'],
    Facilities: ['CleanSweep Janitorial', 'Pacific Maintenance', 'Metro Cleaning Services', 'EverGreen Supplies', 'SafeGuard Security'],
    IT:         ['TechCore Systems', 'DataStream Inc.', 'Northgate Computing', 'Brightline Networks', 'Global Solutions LLC'],
    Marketing:  ['BlueLine Printing', 'Premier Advisory Group', 'Horizon Consulting Group', 'Crescent Promotions', 'Atlas Group Inc.']
  };
  var VAGUE = ['Global Solutions LLC', 'Premier Advisory Group', 'Atlas Group Inc.'];

  // Unit prices in cents; quantities are worked out from the amount a scenario needs.
  var ITEMS = {
    Operations: [['Pallet racking', 18000, 46000], ['Packing supplies', 900, 4800], ['Forklift parts', 6500, 52000], ['Safety equipment', 2500, 14000], ['Conveyor belts', 42000, 160000]],
    Facilities: [['Janitorial supplies', 1200, 6500], ['HVAC filters', 2400, 9800], ['Office chairs', 18000, 62000], ['LED fixtures', 4500, 21000], ['Security cameras', 22000, 95000]],
    IT:         [['Laptops', 89000, 210000], ['Monitors', 17000, 68000], ['Network switches', 45000, 280000], ['Docking stations', 9000, 32000], ['Software licenses', 6000, 48000]],
    Marketing:  [['Printed brochures', 120, 650], ['Trade show displays', 35000, 240000], ['Promotional items', 300, 2600], ['Event signage', 4000, 38000], ['Campaign design work', 75000, 450000]]
  };
  var PROJECTS = {
    Operations: ['Warehouse racking refit', 'Dock 3 repairs', 'Line 2 maintenance', 'Fleet parts restock', 'Shipping area safety upgrade', 'Packing station restock', 'Conveyor replacement'],
    Facilities: ['Lobby refresh', 'HVAC service', 'Office move, floor 2', 'Lighting retrofit', 'Building security upgrade', 'Restroom restock', 'Break room refit'],
    IT:         ['Laptop refresh', 'Network upgrade', 'New hire equipment', 'Conference room AV', 'Help desk restock', 'Server room upgrade', 'License renewals'],
    Marketing:  ['Spring trade show', 'Product launch campaign', 'Customer event', 'Brochure reprint', 'Website relaunch', 'Sales kit refresh', 'Fall trade show']
  };
  var SITES = ['North site', 'South site', 'HQ', 'Annex', 'East warehouse', 'West office'];
  var SURNAMES = ['Santos', 'Reyes', 'Williams', 'Chen', 'Patel', 'Morrison', 'Nguyen', 'Okafor', 'Hughes', 'Lindqvist', 'Alvarez', 'Brooks', 'Kaur', 'Tanaka', 'Mendes', 'Dubois', 'Fischer', 'Grant', 'Ito', 'Kowalski', 'Larsen', 'Moreau', 'Novak', 'Price', 'Quinn', 'Rossi', 'Shah', 'Torres', 'Walsh', 'Young', 'Cruz', 'Park', 'Muñoz', 'Singh'];
  var INITIALS = 'ABCDEGHJKLMNPRST';

  // ── Random numbers (seedable, so tests can replay a round) ────
  function makeRng(seed) {
    var a = (seed === undefined ? Math.floor(Math.random() * 4294967296) : seed) >>> 0;
    function next() {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    var rng = {
      next: next,
      int: function (min, max) { return min + Math.floor(next() * (max - min + 1)); },
      pick: function (arr) { return arr[Math.floor(next() * arr.length)]; },
      shuffle: function (arr) {
        var a2 = arr.slice();
        for (var i = a2.length - 1; i > 0; i--) { var j = Math.floor(next() * (i + 1)); var t = a2[i]; a2[i] = a2[j]; a2[j] = t; }
        return a2;
      }
    };
    return rng;
  }

  // ── Dates (day of the fiscal year, Jan 1 = 0) ─────────────────
  function isoDate(year, day) { return new Date(Date.UTC(year, 0, 1) + day * 86400000).toISOString().slice(0, 10); }

  // ── Money ─────────────────────────────────────────────────────
  function money(cents) {
    var neg = cents < 0; cents = Math.abs(cents);
    var s = '$' + Math.floor(cents / 100).toLocaleString('en-US') + '.' + String(cents % 100).padStart(2, '0');
    return neg ? '-' + s : s;
  }

  // ── People and authority ──────────────────────────────────────
  function buildPeople(rng) {
    var names = rng.shuffle(SURNAMES);
    var n = 0;
    function name() { return rng.pick(INITIALS.split('')) + '. ' + names[n++]; }
    var people = [];
    function add(p) { p.id = 'P' + (people.length + 1); people.push(p); return p; }
    var ceo = add({ name: name(), title: 'Chief Executive Officer', dept: 'Executive', level: 'CEO', limit: 0, depts: [], reportsTo: null });
    add({ name: name(), title: 'Chief Financial Officer', dept: 'Finance', level: 'CFO', limit: LIMITS.CFO, depts: DEPTS.slice(), reportsTo: ceo.id });
    var dirOps = add({ name: name(), title: 'Director of Operations', dept: 'Operations', level: 'Director', limit: LIMITS.Director, depts: ['Operations', 'Facilities'], reportsTo: ceo.id });
    var dirTech = add({ name: name(), title: 'Director of Technology & Marketing', dept: 'IT', level: 'Director', limit: LIMITS.Director, depts: ['IT', 'Marketing'], reportsTo: ceo.id });
    DEPTS.forEach(function (d) {
      var dir = (d === 'Operations' || d === 'Facilities') ? dirOps : dirTech;
      var mgr = add({ name: name(), title: d + ' Manager', dept: d, level: 'Manager', limit: LIMITS.Manager, depts: [d], reportsTo: dir.id });
      add({ name: name(), title: d + ' Supervisor', dept: d, level: 'Supervisor', limit: LIMITS.Supervisor, depts: [d], reportsTo: mgr.id });
    });
    var opsMgr = people.filter(function (p) { return p.title === 'Operations Manager'; })[0];
    add({ name: name(), title: 'Receiving Clerk', dept: 'Operations', level: 'Clerk', limit: 0, depts: [], reportsTo: opsMgr.id });
    add({ name: name(), title: 'Receiving Clerk', dept: 'Operations', level: 'Clerk', limit: 0, depts: [], reportsTo: opsMgr.id });
    return people;
  }
  function canApprove(person, dept, totalCents) {
    return !!person && person.limit >= totalCents && person.depts.indexOf(dept) !== -1;
  }

  // ── Vendors ───────────────────────────────────────────────────
  var LOOKALIKES = [[/ Services$/, ' Service'], [/ Supplies$/, ' Supply'], [/ Supply$/, ' Supplies'], [/ Inc\.$/, ' LLC'], [/ LLC$/, ' Inc.'], [/ Co\.$/, ' Company'], [/ Group$/, ' Group LLC'], [/ Systems$/, ' Systems Inc.'], [/ Networks$/, ' Network'], [/ Printing$/, ' Print'], [/ Materials$/, ' Material']];
  function lookalike(name) {
    for (var i = 0; i < LOOKALIKES.length; i++) if (LOOKALIKES[i][0].test(name)) return name.replace(LOOKALIKES[i][0], LOOKALIKES[i][1]);
    return name + ' LLC';
  }
  function buildRegistry(rng, year) {
    var registry = [];
    var id = rng.int(1000, 1400);
    DEPTS.forEach(function (d) {
      rng.shuffle(VENDORS[d]).slice(0, 3).forEach(function (v) {
        registry.push({ id: 'V-' + (id += rng.int(3, 40)), name: v, dept: d, since: isoDate(year - rng.int(1, 6), rng.int(0, 360)) });
      });
    });
    // Make sure at least one vague-sounding vendor is genuinely registered, so names alone don't decide anything.
    if (!registry.some(function (v) { return VAGUE.indexOf(v.name) !== -1; })) {
      var vague = rng.pick(VAGUE);
      var d = DEPTS.filter(function (x) { return VENDORS[x].indexOf(vague) !== -1; })[0];
      var slot = registry.filter(function (v) { return v.dept === d; })[0];
      slot.name = vague;
    }
    return registry;
  }

  // ── Building transactions ─────────────────────────────────────
  // A line is an item, a quantity and a unit price whose total lands in [min, max] cents.
  function makeLine(rng, dept, min, max) {
    var items = ITEMS[dept];
    for (var attempt = 0; attempt < 60; attempt++) {
      var it = rng.pick(items);
      var unit = rng.int(it[1], it[2]);
      var target = rng.int(min, max);
      var qty = Math.max(1, Math.round(target / unit));
      if (qty > 2000) continue;
      if (qty * unit >= min && qty * unit <= max) return { item: it[0], qty: qty, unit: unit };
    }
    // Fallback: keep the quantity small and set the price to hit the range exactly.
    var q = rng.int(2, 12), t = rng.int(min, max);
    var u = Math.max(1, Math.floor(t / q));
    while (q * u < min) u++;
    return { item: items[0][0], qty: q, unit: u };
  }

  function Builder(rng, year, people, registry, unregistered) {
    this.rng = rng; this.year = year; this.people = people; this.registry = registry; this.unregistered = unregistered;
    this.rows = []; this.usedProjects = {};
  }
  Builder.prototype.person = function (pred) { return this.rng.pick(this.people.filter(pred)); };
  Builder.prototype.approverFor = function (dept, total) {
    var ok = this.people.filter(function (p) { return canApprove(p, dept, total); });
    var order = ['Supervisor', 'Manager', 'Director', 'CFO'];
    ok.sort(function (a, b) { return order.indexOf(a.level) - order.indexOf(b.level); });
    // Usually the lowest level that can approve it; sometimes someone more senior.
    return this.rng.next() < 0.75 ? ok[0] : this.rng.pick(ok);
  };
  Builder.prototype.vendorFor = function (dept, exclude) {
    var list = this.registry.filter(function (v) { return v.dept === dept && v.name !== exclude; });
    return this.rng.pick(list).name;
  };
  Builder.prototype.project = function (dept) {
    for (var i = 0; i < 200; i++) {
      var p = this.rng.pick(PROJECTS[dept]) + (i < 20 ? '' : ', ' + this.rng.pick(SITES));
      if (!this.usedProjects[p]) { this.usedProjects[p] = true; return p; }
    }
    throw new Error('ran out of project names');
  };
  Builder.prototype.day = function () { return this.rng.int(40, 345); };
  // A fully consistent purchase: PO, receiving report and invoice agree.
  Builder.prototype.clean = function (o) {
    var rng = this.rng;
    var dept = o.dept || rng.pick(DEPTS);
    var line = o.line || makeLine(rng, dept, o.min || 30000, o.max || 980000);
    var total = line.qty * line.unit;
    var approver = o.approver || this.approverFor(dept, total);
    var vendor = o.vendor || this.vendorFor(dept);
    var day = o.day !== undefined ? o.day : this.day();
    var poDay = day - rng.int(14, 35), rrDay = poDay + rng.int(3, 10);
    var row = {
      planned: o.planned || null,
      day: day, dept: dept,
      po: { day: poDay, project: o.project || this.project(dept), dept: dept, vendor: vendor, item: line.item, qty: line.qty, unit: line.unit, total: total, approver: approver.id, requester: this.person(function (p) { return p.dept === dept && (p.level === 'Supervisor' || p.level === 'Manager'); }).id },
      rr: { day: Math.min(rrDay, day), vendor: vendor, qty: line.qty, clerk: this.person(function (p) { return p.level === 'Clerk'; }).id },
      inv: { day: day, vendor: vendor, qty: line.qty, unit: line.unit, total: total }
    };
    this.rows.push(row);
    return row;
  };
  // Amount bands for everyday purchases, so most rows sit comfortably inside someone's limit.
  Builder.prototype.everyday = function (planned, day) {
    var r = this.rng.next();
    var band = r < 0.55 ? [30000, 920000] : r < 0.9 ? [1050000, 2300000] : [2600000, 8000000];
    return this.clean({ planned: planned, min: band[0], max: band[1], day: day });
  };

  var PLANT = {
    DUPLICATE_PAYMENT: function (b) {
      var orig = b.everyday(null, b.rng.int(40, 300));
      var day = orig.day + b.rng.int(6, 30);
      var dup = { planned: 'DUPLICATE_PAYMENT', day: day, dept: orig.dept, po: orig.po, rr: orig.rr,
        inv: { day: day, vendor: orig.inv.vendor, qty: orig.inv.qty, unit: orig.inv.unit, total: orig.inv.total, resubmitOf: orig } };
      b.rows.push(dup);
    },
    SPLIT_PURCHASE: function (b) {
      var rng = b.rng, dept = rng.pick(DEPTS);
      var level = rng.pick(['Supervisor', 'Manager']);
      var approver = b.person(function (p) { return p.level === level && p.dept === dept; });
      var limit = approver.limit, vendor = b.vendorFor(dept), project = b.project(dept);
      var pieces = rng.int(2, 3), start = rng.int(40, 320);
      // Each piece stays inside the limit; together they go over it.
      var lo = Math.ceil(limit * (pieces === 2 ? 0.56 : 0.38)), hi = Math.floor(limit * 0.97);
      for (var i = 0; i < pieces; i++) {
        b.clean({ planned: 'SPLIT_PURCHASE', dept: dept, approver: approver, vendor: vendor, project: project, day: start + i * rng.int(1, 6), min: lo, max: hi });
      }
    },
    UNREGISTERED_VENDOR: function (b) {
      var row = b.everyday('UNREGISTERED_VENDOR');
      var name = b.rng.pick(b.unregistered[row.dept]);
      row.po.vendor = row.rr.vendor = row.inv.vendor = name;
    },
    VENDOR_MISMATCH: function (b) {
      var row = b.everyday('VENDOR_MISMATCH');
      row.inv.vendor = b.vendorFor(row.dept, row.po.vendor);
    },
    MISSING_RECEIPT: function (b) {
      var row = b.everyday('MISSING_RECEIPT');
      row.rr = null;
    },
    UNAUTHORIZED_APPROVAL: function (b) {
      var rng = b.rng, dept = rng.pick(DEPTS);
      if (rng.next() < 0.6) {
        // Over the approver's limit.
        var level = rng.pick(['Supervisor', 'Manager']);
        var who = b.person(function (p) { return p.level === level && p.dept === dept; });
        b.clean({ planned: 'UNAUTHORIZED_APPROVAL', dept: dept, approver: who, min: who.limit + rng.int(20000, Math.floor(who.limit * 0.5)), max: who.limit * 2 });
      } else {
        // Within the limit, but for a department the approver doesn't cover.
        var other = b.person(function (p) { return (p.level === 'Manager' || p.level === 'Supervisor') && p.dept !== dept; });
        b.clean({ planned: 'UNAUTHORIZED_APPROVAL', dept: dept, approver: other, min: 50000, max: Math.floor(other.limit * 0.9) });
      }
    },
    QTY_MISMATCH: function (b) {
      var row = b.everyday('QTY_MISMATCH');
      row.inv.qty = row.po.qty + Math.max(1, Math.round(row.po.qty * (0.1 + b.rng.next() * 0.3)));
      row.inv.total = row.inv.qty * row.inv.unit;
    },
    PRICE_MISMATCH: function (b) {
      var row = b.everyday('PRICE_MISMATCH');
      row.inv.unit = Math.round(row.po.unit * (1.12 + b.rng.next() * 0.23));
      row.inv.total = row.inv.qty * row.inv.unit;
    }
  };

  // Clean transactions built to look suspicious. Flagging them is a false positive.
  var DECOYS = [
    function nearLimit(b) {
      var rng = b.rng, dept = rng.pick(DEPTS), level = rng.pick(['Supervisor', 'Manager']);
      var who = b.person(function (p) { return p.level === level && p.dept === dept; });
      b.clean({ dept: dept, approver: who, min: Math.floor(who.limit * 0.96), max: who.limit });
    },
    function bigButApproved(b) {
      var dept = b.rng.pick(DEPTS);
      var dir = b.person(function (p) { return p.level === 'Director' && p.depts.indexOf(dept) !== -1; });
      b.clean({ dept: dept, approver: dir, min: 4000000, max: 9500000 });
    },
    function sameVendorTwoProjects(b) {
      // Same vendor and approver a few days apart, together over the limit, but for different projects.
      var rng = b.rng, dept = rng.pick(DEPTS);
      var who = b.person(function (p) { return p.level === 'Supervisor' && p.dept === dept; });
      var vendor = b.vendorFor(dept), day = rng.int(40, 330);
      b.clean({ dept: dept, approver: who, vendor: vendor, day: day, min: 600000, max: 950000 });
      b.clean({ dept: dept, approver: who, vendor: vendor, day: day + rng.int(1, 6), min: 600000, max: 950000 });
    },
    function vagueButRegistered(b) {
      var v = b.registry.filter(function (x) { return VAGUE.indexOf(x.name) !== -1; })[0];
      b.clean({ dept: v.dept, vendor: v.name, min: 200000, max: 900000 });
    }
  ];

  // ── The independent check ─────────────────────────────────────
  // Works only from the round's documents, people, registry and policy, never from what was planted.
  function evaluate(round) {
    var registered = {};
    round.registry.forEach(function (v) { registered[v.name] = true; });
    var people = {};
    round.people.forEach(function (p) { people[p.id] = p; });
    var found = {}, paid = {};
    round.txns.forEach(function (t) {
      var f = [];
      if (!registered[t.inv.vendor] || !registered[t.po.vendor]) f.push('UNREGISTERED_VENDOR');
      else if (t.inv.vendor !== t.po.vendor || (t.rr && t.rr.vendor !== t.po.vendor)) f.push('VENDOR_MISMATCH');
      if (!t.rr) f.push('MISSING_RECEIPT');
      else if (t.inv.qty !== t.po.qty || t.rr.qty !== t.po.qty) f.push('QTY_MISMATCH');
      if (t.inv.unit !== t.po.unit) f.push('PRICE_MISMATCH');
      if (t.inv.total !== t.inv.qty * t.inv.unit || t.po.total !== t.po.qty * t.po.unit) f.push('MATH_ERROR');
      if (paid[t.po.num]) f.push('DUPLICATE_PAYMENT'); else paid[t.po.num] = t.id;
      if (!canApprove(people[t.po.approver], t.po.dept, t.po.total)) f.push('UNAUTHORIZED_APPROVAL');
      found[t.id] = f;
    });
    // Split purchases: distinct POs for one project and vendor within the window, judged on their combined total.
    var groups = {};
    round.txns.forEach(function (t) {
      if (paid[t.po.num] !== t.id) return; // a PO's first payment stands for the PO
      var k = t.po.project + '|' + t.po.vendor;
      (groups[k] = groups[k] || []).push(t);
    });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (g.length < 2) return;
      var days = g.map(function (t) { return t.po.day; });
      if (Math.max.apply(null, days) - Math.min.apply(null, days) > SPLIT_WINDOW_DAYS) return;
      var combined = g.reduce(function (s, t) { return s + t.po.total; }, 0);
      var over = g.some(function (t) { return !canApprove(people[t.po.approver], t.po.dept, combined); });
      if (over) g.forEach(function (t) { found[t.id].push('SPLIT_PURCHASE'); });
    });
    return found;
  }

  // What each problem puts at risk: the amount overpaid, or the whole payment when the payment itself is unsupported.
  function exposure(t, type) {
    if (type === 'QTY_MISMATCH' || type === 'PRICE_MISMATCH') return t.inv.total - Math.min(t.po.qty, t.rr ? t.rr.qty : t.po.qty) * t.po.unit;
    return t.inv.total;
  }

  // The three-way match itself, from the documents alone.
  function threeWayMatch(t) {
    var c = [];
    var vendors = [t.po.vendor, t.inv.vendor].concat(t.rr ? [t.rr.vendor] : []);
    c.push({ label: 'Receiving report on file', ok: !!t.rr });
    c.push({ label: 'Vendor', ok: vendors.every(function (v) { return v === t.po.vendor; }) });
    c.push({ label: 'Quantity', ok: t.inv.qty === t.po.qty && (!t.rr || t.rr.qty === t.po.qty) });
    c.push({ label: 'Unit price', ok: t.inv.unit === t.po.unit });
    c.push({ label: 'Invoice total = qty × unit price', ok: t.inv.total === t.inv.qty * t.inv.unit });
    return { checks: c, ok: c.every(function (x) { return x.ok; }) };
  }

  // ── Rounds ────────────────────────────────────────────────────
  function tryRound(rng) {
    var company = rng.pick(COMPANIES);
    var year = rng.int(2023, 2025);
    var people = buildPeople(rng);
    var registry = buildRegistry(rng, year);
    var registeredNames = registry.map(function (v) { return v.name; });
    var unregistered = {};
    DEPTS.forEach(function (d) {
      var mine = registry.filter(function (v) { return v.dept === d; }).map(function (v) { return v.name; });
      var pool = VENDORS[d].filter(function (v) { return registeredNames.indexOf(v) === -1; }).concat(mine.map(lookalike));
      unregistered[d] = pool.filter(function (v) { return registeredNames.indexOf(v) === -1; });
    });

    var b = new Builder(rng, year, people, registry, unregistered);
    // Three to five problem types per round, always including one that only shows in the documents.
    var types = rng.shuffle(TYPE_KEYS).slice(0, rng.int(3, 5));
    if (types.indexOf('QTY_MISMATCH') === -1 && types.indexOf('PRICE_MISMATCH') === -1) types[0] = rng.pick(['QTY_MISMATCH', 'PRICE_MISMATCH']);
    // A split purchase takes two or three rows, so stop at eight problem rows to keep most of the ledger clean.
    var issues = rng.int(Math.max(4, types.length), 7);
    var planted = function () { return b.rows.filter(function (r) { return r.planned; }).length; };
    for (var i = 0; i < issues && (i < types.length || planted() < 6); i++) PLANT[types[i % types.length]](b);
    rng.shuffle(DECOYS).slice(0, rng.int(2, 3)).forEach(function (d) { d(b); });
    var total = rng.int(18, 22);
    while (b.rows.length < total) b.everyday(null);

    // Number the documents in date order, the way a real system would.
    var rows = b.rows.slice().sort(function (x, y) { return x.day - y.day; });
    var txnNo = rng.int(1000, 5000), poNo = rng.int(2100, 3500), reqNo = rng.int(400, 900), rrNo = rng.int(7000, 7900);
    var pos = []; rows.forEach(function (r) { if (pos.indexOf(r.po) === -1) pos.push(r.po); });
    pos.sort(function (x, y) { return x.day - y.day; }).forEach(function (po) {
      po.num = 'PO-' + (poNo += rng.int(1, 9)); po.req = 'REQ-' + (reqNo += rng.int(1, 6)); po.date = isoDate(year, po.day);
    });
    var rrs = []; rows.forEach(function (r) { if (r.rr && rrs.indexOf(r.rr) === -1) rrs.push(r.rr); });
    rrs.sort(function (x, y) { return x.day - y.day; }).forEach(function (rr) { rr.num = 'RR-' + (rrNo += rng.int(1, 7)); rr.date = isoDate(year, rr.day); });
    var invNums = {};
    rows.forEach(function (r) {
      if (r.inv.resubmitOf) return;
      var n; do { n = 'INV-' + rng.int(10000, 99999); } while (invNums[n]);
      invNums[n] = true; r.inv.num = n;
    });
    rows.forEach(function (r) {
      if (r.inv.resubmitOf) { r.inv.num = r.inv.resubmitOf.inv.num + '-A'; delete r.inv.resubmitOf; }
      r.inv.date = isoDate(year, r.inv.day);
      r.id = 'TXN-' + (txnNo += rng.int(1, 4));
      r.date = isoDate(year, r.day);
      r.vendor = r.inv.vendor;
      r.amount = r.inv.total;
    });
    var round = { company: company, year: year, people: people, registry: registry, txns: rows, policy: POLICY, limits: LIMITS };

    // Only keep the round if the independent check agrees with the plan, one problem per row.
    var found = evaluate(round), key = {}, problems = 0;
    for (var r = 0; r < rows.length; r++) {
      var t = rows[r], f = found[t.id];
      if (f.length > 1 || (f[0] || null) !== t.planned) return null;
      key[t.id] = f[0] || null;
      if (f[0]) problems++;
    }
    rows.forEach(function (t) { delete t.planned; });
    round.key = key;
    round.problemRows = problems;
    round.atRisk = rows.reduce(function (s, t) { return s + (key[t.id] ? exposure(t, key[t.id]) : 0); }, 0);
    return round;
  }

  function generateRound(seed) {
    var rng = makeRng(seed);
    for (var attempt = 1; attempt <= 200; attempt++) {
      var round = tryRound(rng);
      if (round) { round.attempts = attempt; return round; }
    }
    throw new Error('Could not build a valid round');
  }

  // ── Scoring ───────────────────────────────────────────────────
  // Row by row: a flag is right only with the right type. Wrong flags lower precision, missed problems lower recall.
  function score(key, flags) {
    var tp = 0, wrongType = 0, falsePos = 0, problems = 0;
    Object.keys(key).forEach(function (id) { if (key[id]) problems++; });
    Object.keys(flags).forEach(function (id) {
      if (!(id in key)) return;
      if (key[id] === flags[id]) tp++;
      else if (key[id]) wrongType++;
      else falsePos++;
    });
    var flagsMade = tp + wrongType + falsePos;
    var precision = flagsMade ? tp / flagsMade : 0;
    var recall = problems ? tp / problems : 1;
    var f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
    return { correct: tp, wrongType: wrongType, falsePositives: falsePos, wrong: wrongType + falsePos, missed: problems - tp, problems: problems, precision: precision, recall: recall, f1: f1 };
  }

  var api = { TYPES: TYPES, TYPE_KEYS: TYPE_KEYS, DEPTS: DEPTS, LIMITS: LIMITS, POLICY: POLICY, SPLIT_WINDOW_DAYS: SPLIT_WINDOW_DAYS,
    generateRound: generateRound, evaluate: evaluate, threeWayMatch: threeWayMatch, exposure: exposure, score: score, canApprove: canApprove, money: money, makeRng: makeRng, lookalike: lookalike };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AuditEngine = api;
})(this);
