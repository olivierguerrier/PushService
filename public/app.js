// Operator console. Read-only views over the push queue, jobs, and audit
// trail, plus in-app approve/reject. Auth follows FlyApp's model: you sign in
// with a ListingApp account on /login.html, the service mints its own JWT
// (kept in localStorage + an httpOnly cookie) and we send it as a Bearer
// token. Any 401 bounces back to the login page.
(function () {
  const $ = (sel) => document.querySelector(sel);
  let token = localStorage.getItem('aps_jwt') || '';

  function redirectToLogin() {
    token = '';
    localStorage.removeItem('aps_jwt');
    const next = encodeURIComponent(location.pathname + location.search);
    location.replace(`/login.html?next=${next}`);
  }

  // No token at all -> straight to the login gate before rendering anything.
  if (!token) { redirectToLogin(); return; }

  function headers() {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  // Human-readable copy for the error codes the API returns, so callers can
  // surface "Select at least one item" instead of a raw `no_submissions`.
  const FRIENDLY_ERRORS = {
    no_submissions: 'Select at least one submission first.',
    no_jobs: 'Select at least one job first.',
    no_package: 'No proposed package to apply — run a review first.',
    writes_disabled: 'Live writes to Amazon are turned off (kill switch).',
    package_invalid: 'The proposed package failed validation.',
    auth_lookup_failed: 'Temporarily can’t reach ListingApp — reconnecting…',
    auth_unavailable: 'ListingApp authentication is unreachable — try again shortly.',
    too_many_login_attempts: 'Too many attempts — wait a few minutes.'
  };
  function friendly(code) { return FRIENDLY_ERRORS[code] || code; }

  // A single, unobtrusive banner for transient backend trouble (ListingApp
  // bridge blips → 503, or a dropped network). We do NOT boot the operator to
  // login for these — the session is still valid; only the backend is briefly
  // unavailable. It auto-clears on the next successful request.
  let _bannerEl = null;
  function connectionBanner(message) {
    if (!_bannerEl) {
      _bannerEl = document.createElement('div');
      _bannerEl.id = 'connectionBanner';
      _bannerEl.setAttribute('role', 'status');
      _bannerEl.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;'
        + 'padding:8px 16px;text-align:center;font-size:13px;font-weight:600;'
        + 'color:#fff;background:#b45309;box-shadow:0 1px 4px rgba(0,0,0,.2);';
      document.body.appendChild(_bannerEl);
    }
    _bannerEl.textContent = message;
    _bannerEl.style.display = 'block';
  }
  function clearConnectionBanner() {
    if (_bannerEl) _bannerEl.style.display = 'none';
  }

  // Decode the server's error code from a non-OK response without throwing.
  async function errorCode(res) {
    try { const j = await res.json(); return j.error || j.status || String(res.status); }
    catch (_) { return String(res.status); }
  }

  // True for transient auth/backend failures we should ride out (banner +
  // retry on next poll) rather than treating as a hard error or a logout.
  function isTransientAuth(code) {
    return code === 'auth_lookup_failed' || code === 'auth_unavailable';
  }

  async function api(path) {
    let res;
    try {
      res = await fetch(path, { headers: headers(), credentials: 'same-origin' });
    } catch (_) {
      connectionBanner('Network error — reconnecting…');
      throw new Error('503');
    }
    if (res.status === 401) { redirectToLogin(); throw new Error('401'); }
    if (res.ok) { clearConnectionBanner(); return res.json(); }
    const code = await errorCode(res);
    if (res.status === 503 && isTransientAuth(code)) {
      connectionBanner('Reconnecting to ListingApp…');
      throw new Error('503');
    }
    throw new Error(friendly(code));
  }
  async function apiPost(path, body) {
    const opts = { method: 'POST', headers: headers(), credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch (_) {
      connectionBanner('Network error — reconnecting…');
      throw new Error('503');
    }
    if (res.status === 401) { redirectToLogin(); throw new Error('401'); }
    if (res.ok) { clearConnectionBanner(); return res.json(); }
    const code = await errorCode(res);
    if (res.status === 503 && isTransientAuth(code)) {
      connectionBanner('Reconnecting to ListingApp…');
      throw new Error('503');
    }
    throw new Error(friendly(code));
  }
  function statusBadge(s) {
    const ok = ['APPLIED', 'completed'];
    const warn = ['PENDING_APPROVAL', 'IN_PROGRESS', 'SUBMITTED', 'running', 'partial', 'SKIPPED'];
    const cls = ok.includes(s) ? 'ok' : warn.includes(s) ? 'warn' : 'bad';
    return `<span class="badge ${cls}">${esc(s)}</span>`;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatDuration(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return '—';
    if (seconds < 60) return '< 1 min';
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `~${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `~${h} h ${m} min` : `~${h} h`;
  }

  async function loadMetrics() {
    try {
      const m = await api('/admin/metrics');
      const w = m.windowHours || 24;
      const j24 = m.jobs24h || {};
      const jobsInProgress = (j24.running || 0) + (j24.pending || 0);
      const active = m.submissionsActive || 0;
      const speed = m.throughput && m.throughput.perMinute != null ? m.throughput.perMinute : 0;
      const windowMin = (m.throughput && m.throughput.windowMinutes) || 15;
      const settledCount = (m.throughput && m.throughput.settled) || 0;
      const speedDetail = m.throughput && m.throughput.sinceStart
        ? `${settledCount} settled since start (${windowMin} min)`
        : `${settledCount} settled in last ${windowMin} min`;
      const etaText = active === 0 && !(m.progress24h && m.progress24h.remaining)
        ? 'Idle'
        : m.eta && m.eta.available
          ? formatDuration(m.eta.seconds)
          : '—';
      const etaTone = (active || (m.progress24h && m.progress24h.remaining)) && m.eta && m.eta.available ? 'warn' : '';
      const finished = j24.finished || ((j24.completed || 0) + (j24.partial || 0) + (j24.failed || 0));
      const cells = [
        [`Jobs (${w}h)`, String(j24.total || 0), jobsInProgress ? 'warn' : (j24.total ? 'pos' : ''),
          `${j24.running || 0} running · ${finished} finished`],
        ['Active submissions', String(active), active ? 'warn' : '',
          `${m.submissionsPendingApproval} awaiting approval · ${m.submissionsInFlight} in flight`],
        ['Job speed', speed ? `${speed}/min` : '0/min', speed ? 'pos' : '', speedDetail],
        ['Est. completion', etaText, etaTone,
          m.approvalQueueDepth ? `${m.approvalQueueDepth} queued for SP-API` : 'No queued writes']
      ];
      $('#metricsGrid').innerHTML = cells.map(([k, v, tone, detail]) =>
        `<div class="kpi${tone ? ' kpi-' + tone : ''}">` +
        `<div class="kpi-label">${esc(k)}</div>` +
        `<div class="kpi-value">${esc(v)}</div>` +
        (detail ? `<div class="kpi-detail">${esc(detail)}</div>` : '') +
        `</div>`
      ).join('');

      const prog = m.progress24h || m.progress || {};
      const showBar = (prog.total || 0) > 0;
      const bar = $('#metricsProgress');
      if (bar) {
        bar.classList.toggle('hidden', !showBar);
        bar.setAttribute('aria-hidden', showBar ? 'false' : 'true');
        if (showBar) {
          const pct = prog.percent || 0;
          const ok = prog.ok || 0;
          const failed = prog.failed || 0;
          const remaining = prog.remaining || 0;
          $('#metricsProgressText').textContent =
            `${prog.done || 0} of ${prog.total || 0} submissions complete (last ${w}h)`;
          $('#metricsProgressDetail').textContent =
            `${ok} applied · ${failed} failed · ${remaining} remaining`;
          $('#metricsProgressPct').textContent = `${pct}%`;
          const fill = $('#metricsProgressBar');
          if (fill) fill.style.width = `${pct}%`;
          const track = bar.querySelector('.metrics-progress-track');
          if (track) {
            track.setAttribute('aria-valuenow', String(pct));
            track.setAttribute('aria-valuetext', `${pct}% complete`);
          }
        }
      }
    } catch (e) {
      if (e.message === '401') return;
      const el = $('#metricsGrid');
      if (el) el.textContent = 'Error: ' + e.message;
    }
  }

  async function loadStatus() {
    try {
      const s = await api('/admin/status');
      $('#versionTag').textContent = 'v' + s.version;
      const dot = $('#writeDot');
      dot.className = 'dot ' + (s.writesEnabled ? 'on' : 'off');
      const chain = s.auditChain || {};
      const credsOk = s.spApi.clientIdConfigured && s.spApi.refreshTokenConfigured;
      const listingOk = !!(s.listingApp && s.listingApp.ok);
      const cells = [
        ['Writes', s.writesEnabled ? 'ENABLED' : 'disabled', s.writesEnabled ? 'pos' : 'warn'],
        ['SP-API creds', credsOk ? 'configured' : 'missing', credsOk ? 'pos' : 'neg'],
        ['ListingApp', listingOk ? 'reachable' : 'unreachable', listingOk ? 'pos' : 'neg'],
        ['Content source', s.contentSource ? s.contentSource.mode : '—', ''],
        ['Callers', s.callersConfigured, ''],
        ['Approvers', s.approversConfigured, ''],
        ['Audit chain', chain.ok ? `intact (${chain.checked})` : `BROKEN @${chain.brokenAtId}`, chain.ok ? 'pos' : 'neg']
      ];
      $('#statusGrid').innerHTML = cells.map(([k, v, tone]) =>
        `<div class="kpi${tone ? ' kpi-' + tone : ''}"><div class="kpi-label">${esc(k)}</div><div class="kpi-value">${esc(v)}</div></div>`
      ).join('');
    } catch (e) {
      if (e.message === '401') return; // redirect already in flight
      $('#statusGrid').textContent = 'Error: ' + e.message;
    }
  }

  const changesCache = new Map(); // submission uuid / 'grp:'+id -> rendered detail HTML
  const groupSubs = new Map();    // group id -> array of submission rows in the group
  const subsByUuid = new Map();   // submission uuid -> last loaded queue row (for meta lookup)
  let queueDisplayItems = [];
  const selectedQueueUuids = new Set();
  let queueBulkBusy = false;
  let queueBulkMessage = '';
  const selectedJobIds = new Set();
  let jobBulkBusy = false;
  let jobBulkMessage = '';
  const selectedErrorUuids = new Set();
  let errorBulkBusy = false;
  let errorBulkMessage = '';

  // ── Queue table columns (sort / filter / reorder / resize) ───────────────
  const QUEUE_COLUMN_DEFS = [
    { key: 'select', label: '', nohide: true, sortable: false, filterable: false, fixed: true },
    { key: 'caret', label: '', nohide: true, sortable: false, filterable: false, fixed: true },
    { key: 'created_at', label: 'Created', sortable: true, filterable: true },
    { key: 'uuid', label: 'UUID', sortable: true, filterable: true },
    { key: 'caller', label: 'Caller', sortable: true, filterable: true },
    { key: 'scope', label: 'Scope', sortable: true, filterable: true },
    { key: 'operation', label: 'Op', sortable: true, filterable: true },
    { key: 'asin', label: 'ASIN', sortable: true, filterable: true },
    { key: 'customer', label: 'Customer', sortable: true, filterable: true },
    { key: 'season', label: 'Season', sortable: true, filterable: true },
    { key: 'lifecycle', label: 'Lifecycle', sortable: true, filterable: true, title: 'FlyApp lifecycle status (meta.status)' },
    { key: 'vendor_code', label: 'Vendor', sortable: true, filterable: true },
    { key: 'item_number', label: 'Item #', sortable: true, filterable: true },
    { key: 'sku', label: 'SKU', sortable: true, filterable: true },
    { key: 'marketplace_code', label: 'Mkt', sortable: true, filterable: true },
    { key: 'status', label: 'Status', sortable: true, filterable: true },
    { key: 'approved_by', label: 'Approved by', sortable: true, filterable: true },
    { key: 'updated_at', label: 'Updated', sortable: true, filterable: true },
    { key: 'error', label: 'Error', sortable: true, filterable: true },
    { key: 'actions', label: 'Action', nohide: true, sortable: false, filterable: false, fixed: true }
  ];
  const QUEUE_COL_KEYS = QUEUE_COLUMN_DEFS.map((c) => c.key);
  const QUEUE_STORAGE = {
    hidden: 'aps_queue_hidden',
    order: 'aps_queue_order',
    sort: 'aps_queue_sort',
    filters: 'aps_queue_col_filters',
    legacyHidden: 'aps_queue_cols'
  };
  const queueColState = {
    hidden: new Set(),
    order: [],
    sortField: 'created_at',
    sortDir: 'desc',
    filters: {}
  };
  const LEGACY_QUEUE_COL_KEYS = QUEUE_COL_KEYS.filter((k) => k !== 'select');

  // ── Pagination ───────────────────────────────────────────────────────────
  // The console loads the FULL submission history (not just the most recent
  // page) by fetching it from the server in batches via a keyset cursor.
  // Filtering and sorting then run over that whole set client-side, and only the
  // slice for the current page is rendered — so filters/sort affect every record
  // and the operator can page back to the oldest submissions.
  //   QUEUE_FETCH_LIMIT — rows per server request (the server caps this at 1000).
  //   QUEUE_MAX_ROWS     — safety ceiling on how many rows we hold in the browser.
  const QUEUE_FETCH_LIMIT = 1000;
  const QUEUE_MAX_ROWS = 25000;
  const QUEUE_PAGE_SIZES = [50, 100, 200, 500, 1000];
  const QUEUE_PAGE_STORAGE = 'aps_queue_page_size';
  const queuePageState = { page: 1, pageSize: 200, fetchCapped: false };
  function loadQueuePageSize() {
    try {
      const saved = Number(localStorage.getItem(QUEUE_PAGE_STORAGE));
      if (QUEUE_PAGE_SIZES.includes(saved)) queuePageState.pageSize = saved;
    } catch (_) { /* default */ }
  }
  function saveQueuePageSize() {
    try { localStorage.setItem(QUEUE_PAGE_STORAGE, String(queuePageState.pageSize)); } catch (_) {}
  }

  function migrateLegacyQueueCols() {
    if (localStorage.getItem(QUEUE_STORAGE.hidden)) return;
    try {
      const raw = localStorage.getItem(QUEUE_STORAGE.legacyHidden);
      if (!raw) return;
      const indices = JSON.parse(raw);
      const hidden = new Set();
      for (const i of indices) {
        if (LEGACY_QUEUE_COL_KEYS[i]) hidden.add(LEGACY_QUEUE_COL_KEYS[i]);
      }
      localStorage.setItem(QUEUE_STORAGE.hidden, JSON.stringify([...hidden]));
    } catch (_) { /* ignore */ }
  }
  function loadQueueColState() {
    migrateLegacyQueueCols();
    try {
      const hidden = JSON.parse(localStorage.getItem(QUEUE_STORAGE.hidden) || '[]');
      queueColState.hidden = new Set(Array.isArray(hidden) ? hidden : []);
    } catch (_) { queueColState.hidden = new Set(); }
    try {
      const order = (localStorage.getItem(QUEUE_STORAGE.order) || '').split(',').map((s) => s.trim()).filter(Boolean);
      queueColState.order = order.filter((k) => QUEUE_COL_KEYS.includes(k));
    } catch (_) { queueColState.order = []; }
    try {
      const sort = JSON.parse(localStorage.getItem(QUEUE_STORAGE.sort) || '{}');
      if (sort.field && QUEUE_COL_KEYS.includes(sort.field)) {
        queueColState.sortField = sort.field;
        queueColState.sortDir = sort.dir === 'asc' ? 'asc' : 'desc';
      }
    } catch (_) { /* defaults */ }
    try {
      const filters = JSON.parse(localStorage.getItem(QUEUE_STORAGE.filters) || '{}');
      queueColState.filters = {};
      for (const [k, vals] of Object.entries(filters)) {
        if (QUEUE_COL_KEYS.includes(k) && Array.isArray(vals) && vals.length) {
          queueColState.filters[k] = new Set(vals.map(String));
        }
      }
    } catch (_) { queueColState.filters = {}; }
    for (const def of QUEUE_COLUMN_DEFS) {
      if (def.nohide) queueColState.hidden.delete(def.key);
    }
  }
  function saveQueueHidden() {
    localStorage.setItem(QUEUE_STORAGE.hidden, JSON.stringify([...queueColState.hidden]));
  }
  function saveQueueOrder() {
    localStorage.setItem(QUEUE_STORAGE.order, queueColState.order.join(','));
  }
  function saveQueueSort() {
    localStorage.setItem(QUEUE_STORAGE.sort, JSON.stringify({ field: queueColState.sortField, dir: queueColState.sortDir }));
  }
  function saveQueueFilters() {
    const out = {};
    for (const [k, set] of Object.entries(queueColState.filters)) {
      if (set && set.size) out[k] = [...set];
    }
    localStorage.setItem(QUEUE_STORAGE.filters, JSON.stringify(out));
  }
  function fullQueueColumnOrder() {
    const base = queueColState.order.length
      ? queueColState.order.slice()
      : QUEUE_COL_KEYS.slice();
    for (const k of QUEUE_COL_KEYS) {
      if (!base.includes(k)) base.push(k);
    }
    const fixedStart = ['select', 'caret'];
    const fixedEnd = ['actions'];
    const middle = base.filter((k) => QUEUE_COL_KEYS.includes(k) && !fixedStart.includes(k) && !fixedEnd.includes(k));
    return fixedStart.concat(middle, fixedEnd.filter((k) => QUEUE_COL_KEYS.includes(k)));
  }
  function visibleQueueColumns() {
    return fullQueueColumnOrder()
      .map((k) => QUEUE_COLUMN_DEFS.find((d) => d.key === k))
      .filter((c) => c && (!queueColState.hidden.has(c.key) || c.nohide));
  }
  function visibleQueueColCount() {
    return visibleQueueColumns().length;
  }

  // Well-known keys promoted from a submission's free-form meta blob to their
  // own columns. Lookup is case-insensitive and tolerant of common synonyms.
  const META_KEY_ALIASES = {
    customer: ['customer', 'customerCode', 'customer_code', 'customerName', 'customer_name'],
    season: ['season', 'seasonCode', 'season_code'],
    lifecycle: ['lifecycle', 'status', 'lifecycleStatus', 'lifecycle_status']
  };
  function pickMeta(meta, key) {
    if (!meta || typeof meta !== 'object') return '';
    const aliases = META_KEY_ALIASES[key] || [key];
    // Direct alias match first (case-sensitive then lower-cased).
    for (const a of aliases) {
      if (meta[a] != null && meta[a] !== '') return meta[a];
    }
    const lowered = {};
    for (const k of Object.keys(meta)) lowered[k.toLowerCase()] = meta[k];
    for (const a of aliases) {
      const v = lowered[a.toLowerCase()];
      if (v != null && v !== '') return v;
    }
    return '';
  }
  function metaCell(meta, key) {
    const v = pickMeta(meta, key);
    return v === '' ? '' : esc(typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  // Group aggregate of a promoted meta key across submissions in the group.
  function sharedMetaCell(items, key) {
    const vals = [...new Set(items.map((i) => pickMeta(i.meta, key))
      .filter((v) => v !== '' && v != null)
      .map((v) => typeof v === 'object' ? JSON.stringify(v) : String(v)))];
    if (vals.length === 0) return '';
    if (vals.length === 1) return esc(vals[0]);
    return `<span class="muted">(${vals.length})</span>`;
  }
  // Full meta payload as a small key/value block for the expanded detail row.
  function renderMetaBlock(meta) {
    if (!meta || typeof meta !== 'object') return '';
    const entries = Object.entries(meta).filter(([, v]) => v != null && v !== '');
    if (!entries.length) return '';
    const items = entries.map(([k, v]) => {
      const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `<div class="meta-item"><span class="meta-key">${esc(k)}</span><span class="meta-val">${esc(val)}</span></div>`;
    }).join('');
    return `<div class="meta-block"><div class="meta-head">FlyApp context</div><div class="meta-grid">${items}</div></div>`;
  }

  // Requester's note for the approver, shown in the expanded detail row when
  // present. Preserves line breaks; escaped to stay XSS-safe.
  function renderCommentBlock(comment) {
    const text = (comment == null ? '' : String(comment)).trim();
    if (!text) return '';
    return `<div class="meta-block"><div class="meta-head">Note from requester</div>`
      + `<div class="meta-comment" style="white-space:pre-wrap;word-break:break-word;">${esc(text)}</div></div>`;
  }

  // SVG glyphs reused by the per-row and group-level approve/reject buttons.
  const CHECK_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><polyline points="20 6 9 17 4 12"/></svg>';
  const X_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  // Per-submission Approve/Reject pair (used in single rows and inside the
  // grouped detail table). Reuses the existing `button.act` click handler.
  function rowActions(uuid) {
    return `<div style="display:inline-flex;gap:4px;align-items:center;">
        <button class="btn-ghost btn-ghost--success act approve" data-uuid="${esc(uuid)}" title="Approve">${CHECK_SVG} Approve</button>
        <button class="btn-ghost btn-ghost--danger act reject" data-uuid="${esc(uuid)}" title="Reject">${X_SVG} Reject</button>
      </div>`;
  }

  // Compact, persisted error diagnostics for a submission. Combines the human
  // error_message with the structured issues (issues_json) / SP-API error blob
  // (amazon_response_json) distilled by /admin/queue into r.errorDetails. The
  // visible cell stays short; the full detail is exposed via a hover title so
  // the cause is never lost.
  function formatErrorDetail(d) {
    if (!d) return '';
    const attrs = (d.attributeNames && d.attributeNames.length) ? ` [${d.attributeNames.join(', ')}]` : '';
    const code = d.code ? `${d.code}: ` : '';
    return `${code}${d.message || ''}${attrs}`.trim();
  }
  function errorCellHtml(r) {
    const details = Array.isArray(r.errorDetails) ? r.errorDetails : [];
    const lines = details.map(formatErrorDetail).filter(Boolean);
    const summary = r.error_message || lines[0] || '';
    if (!summary) return '';
    const title = [r.error_message, ...lines].filter(Boolean).join('\n');
    return `<span class="err-detail" title="${esc(title)}">${esc(summary)}</span>`;
  }
  // Group error cell: count of failing submissions in the batch, with the full
  // per-submission diagnostics exposed on hover.
  function groupErrorCellHtml(items) {
    const failed = items.filter((i) => i.error_message || (i.errorDetails && i.errorDetails.length));
    if (!failed.length) return '';
    const title = failed.map((i) => {
      const lines = (i.errorDetails || []).map(formatErrorDetail).filter(Boolean);
      const head = `${i.vendor_code || ''}/${i.sku || ''}`.replace(/^\/+|\/+$/g, '');
      const body = [i.error_message, ...lines].filter(Boolean).join('; ');
      return head ? `${head} — ${body}` : body;
    }).filter(Boolean).join('\n');
    const n = failed.length;
    return `<span class="err-detail" title="${esc(title)}">${esc(n + ' error' + (n === 1 ? '' : 's'))}</span>`;
  }

  function queueFilterValue(item, key) {
    if (item.type === 'solo') {
      const r = item.data;
      switch (key) {
        case 'customer': return String(pickMeta(r.meta, 'customer') || '');
        case 'season': return String(pickMeta(r.meta, 'season') || '');
        case 'lifecycle': return String(pickMeta(r.meta, 'lifecycle') || '');
        case 'uuid': return String(r.submission_uuid || '').slice(0, 8);
        case 'error': return r.error_message || (r.errorDetails && r.errorDetails.length ? 'has error' : '');
        case 'status': return String(r.status || '');
        default: return r[key] == null ? '' : String(r[key]);
      }
    }
    const { items } = item;
    switch (key) {
      case 'uuid': return 'GROUP';
      case 'customer': {
        const vals = [...new Set(items.map((i) => pickMeta(i.meta, 'customer')).filter(Boolean).map(String))];
        return vals.length === 1 ? vals[0] : `(${vals.length})`;
      }
      case 'season': {
        const vals = [...new Set(items.map((i) => pickMeta(i.meta, 'season')).filter(Boolean).map(String))];
        return vals.length === 1 ? vals[0] : `(${vals.length})`;
      }
      case 'lifecycle': {
        const vals = [...new Set(items.map((i) => pickMeta(i.meta, 'lifecycle')).filter(Boolean).map(String))];
        return vals.length === 1 ? vals[0] : `(${vals.length})`;
      }
      case 'vendor_code': {
        const n = new Set(items.map((i) => i.vendor_code).filter(Boolean)).size || items.length;
        return `${n} vendor code${n === 1 ? '' : 's'}`;
      }
      case 'status': {
        const counts = {};
        items.forEach((i) => { counts[i.status] = (counts[i.status] || 0) + 1; });
        return Object.entries(counts).map(([s, n]) => `${s}×${n}`).join(', ');
      }
      case 'error': {
        const failed = items.filter((i) => i.error_message || (i.errorDetails && i.errorDetails.length));
        return failed.length ? `${failed.length} error${failed.length === 1 ? '' : 's'}` : '';
      }
      case 'approved_by':
        return [...new Set(items.map((i) => i.approved_by).filter(Boolean))].join(', ');
      case 'updated_at':
        return items.map((i) => i.updated_at).filter(Boolean).sort().slice(-1)[0] || '';
      default: {
        const vals = [...new Set(items.map((i) => (i[key] == null ? '' : String(i[key]))).filter((v) => v !== ''))];
        if (vals.length === 0) return '';
        if (vals.length === 1) return vals[0];
        return `(${vals.length})`;
      }
    }
  }

  function queueSortValue(item, key) {
    const raw = queueFilterValue(item, key);
    if (key === 'created_at' || key === 'updated_at') return raw;
    if (key === 'status' && item.type === 'solo') return item.data.status || '';
    return raw.toLowerCase();
  }

  function applyQueueFiltersAndSort(items) {
    let rows = items.slice();
    for (const [key, allowed] of Object.entries(queueColState.filters)) {
      if (!allowed || !allowed.size) continue;
      rows = rows.filter((item) => allowed.has(queueFilterValue(item, key)));
    }
    const field = queueColState.sortField;
    const dir = queueColState.sortDir === 'asc' ? 1 : -1;
    if (field && QUEUE_COL_KEYS.includes(field)) {
      rows.sort((a, b) => {
        const av = queueSortValue(a, field);
        const bv = queueSortValue(b, field);
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }
    return rows;
  }

  function pendingQueueUuidsForItem(item) {
    if (item.type === 'solo') {
      const r = item.data;
      return r.status === 'PENDING_APPROVAL' && r.submission_uuid ? [r.submission_uuid] : [];
    }
    return item.items
      .filter((s) => s.status === 'PENDING_APPROVAL' && s.submission_uuid)
      .map((s) => s.submission_uuid);
  }

  function allPendingQueueUuids() {
    const out = [];
    const seen = new Set();
    for (const item of queueDisplayItems) {
      for (const uuid of pendingQueueUuidsForItem(item)) {
        if (seen.has(uuid)) continue;
        seen.add(uuid);
        out.push(uuid);
      }
    }
    return out;
  }

  function visiblePendingQueueUuids() {
    const out = [];
    const seen = new Set();
    for (const item of applyQueueFiltersAndSort(queueDisplayItems)) {
      for (const uuid of pendingQueueUuidsForItem(item)) {
        if (seen.has(uuid)) continue;
        seen.add(uuid);
        out.push(uuid);
      }
    }
    return out;
  }

  function pruneQueueSelection() {
    const valid = new Set(allPendingQueueUuids());
    for (const uuid of [...selectedQueueUuids]) {
      if (!valid.has(uuid)) selectedQueueUuids.delete(uuid);
    }
  }

  function renderQueueCell(item, col) {
    const key = col.key;
    if (item.type === 'solo') {
      const r = item.data;
      const uuid = r.submission_uuid || '';
      switch (key) {
        case 'select': {
          const uuids = pendingQueueUuidsForItem(item);
          const checked = uuids.length && uuids.every((u) => selectedQueueUuids.has(u)) ? 'checked' : '';
          const disabled = uuids.length ? '' : 'disabled';
          return `<td class="select-cell"><input class="queue-select" type="checkbox" data-uuids="${esc(uuids.join(','))}" ${checked} ${disabled} aria-label="Select submission ${esc(uuid.slice(0, 8))}" /></td>`;
        }
        case 'caret':
          return `<td class="col-caret"><button class="caret" type="button" data-uuid="${esc(uuid)}" aria-label="Show changes">&#9654;</button></td>`;
        case 'created_at': return `<td>${esc(r.created_at)}</td>`;
        case 'uuid': return `<td><code>${esc(uuid.slice(0, 8))}</code></td>`;
        case 'caller': return `<td>${esc(r.caller)}</td>`;
        case 'scope': return `<td>${esc(r.scope)}</td>`;
        case 'operation': return `<td>${esc(r.operation)}</td>`;
        case 'asin': return `<td><code>${esc(r.asin || '')}</code></td>`;
        case 'customer': return `<td>${metaCell(r.meta, 'customer')}</td>`;
        case 'season': return `<td>${metaCell(r.meta, 'season')}</td>`;
        case 'lifecycle': return `<td>${metaCell(r.meta, 'lifecycle')}</td>`;
        case 'vendor_code': return `<td>${esc(r.vendor_code || '')}</td>`;
        case 'item_number': return `<td><code>${esc(r.item_number || '')}</code></td>`;
        case 'sku': return `<td><code>${esc(r.sku || '')}</code></td>`;
        case 'marketplace_code': return `<td>${esc(r.marketplace_code || '')}</td>`;
        case 'status': return `<td>${statusBadge(r.status)}</td>`;
        case 'approved_by': return `<td>${esc(r.approved_by || '')}</td>`;
        case 'updated_at': return `<td>${esc(r.updated_at || '')}</td>`;
        case 'error': return `<td class="err">${errorCellHtml(r)}</td>`;
        case 'actions': {
          const actions = r.status === 'PENDING_APPROVAL' ? rowActions(uuid) : '';
          return `<td class="actions">${actions}</td>`;
        }
        default: return '<td></td>';
      }
    }
    const { id, items } = item;
    const vendorCount = new Set(items.map((i) => i.vendor_code).filter(Boolean)).size;
    const pending = items.filter((i) => i.status === 'PENDING_APPROVAL').length;
    const updated = items.map((i) => i.updated_at).filter(Boolean).sort().slice(-1)[0] || '';
    const approvers = [...new Set(items.map((i) => i.approved_by).filter(Boolean))].join(', ');
    const groupActions = pending
      ? `<div style="display:inline-flex;gap:4px;align-items:center;">
          <button class="btn-ghost btn-ghost--success gact approve" data-group="${esc(id)}" data-count="${pending}" title="Approve all pending">${CHECK_SVG} Approve all</button>
          <button class="btn-ghost btn-ghost--danger gact reject" data-group="${esc(id)}" data-count="${pending}" title="Reject all pending">${X_SVG} Reject all</button>
        </div>`
      : '';
    const vendorLabel = `${vendorCount || items.length} vendor code${(vendorCount || items.length) === 1 ? '' : 's'}`;
    switch (key) {
      case 'select': {
        const uuids = pendingQueueUuidsForItem(item);
        const checked = uuids.length && uuids.every((u) => selectedQueueUuids.has(u)) ? 'checked' : '';
        const disabled = uuids.length ? '' : 'disabled';
        return `<td class="select-cell"><input class="queue-select" type="checkbox" data-uuids="${esc(uuids.join(','))}" ${checked} ${disabled} aria-label="Select ${esc(String(uuids.length))} pending submission(s) in group" /></td>`;
      }
      case 'caret':
        return `<td class="col-caret"><button class="caret" type="button" data-group="${esc(id)}" aria-label="Show grouped changes">&#9654;</button></td>`;
      case 'created_at': return `<td>${esc(items[0].created_at)}</td>`;
      case 'uuid': return `<td><span class="group-tag">GROUP</span> <span class="group-pill">${items.length}</span></td>`;
      case 'caller': return `<td>${sharedCell(items, 'caller')}</td>`;
      case 'scope': return `<td>${sharedCell(items, 'scope')}</td>`;
      case 'operation': return `<td>${sharedCell(items, 'operation')}</td>`;
      case 'asin': return `<td><code>${sharedCell(items, 'asin')}</code></td>`;
      case 'customer': return `<td>${sharedMetaCell(items, 'customer')}</td>`;
      case 'season': return `<td>${sharedMetaCell(items, 'season')}</td>`;
      case 'lifecycle': return `<td>${sharedMetaCell(items, 'lifecycle')}</td>`;
      case 'vendor_code': return `<td><span class="group-vendors">${esc(vendorLabel)}</span></td>`;
      case 'item_number': return `<td><code>${sharedCell(items, 'item_number')}</code></td>`;
      case 'sku': return `<td><code>${sharedCell(items, 'sku')}</code></td>`;
      case 'marketplace_code': return `<td>${sharedCell(items, 'marketplace_code')}</td>`;
      case 'status': return `<td class="group-status">${statusSummary(items)}</td>`;
      case 'approved_by': return `<td>${esc(approvers)}</td>`;
      case 'updated_at': return `<td>${esc(updated)}</td>`;
      case 'error': return `<td class="err">${groupErrorCellHtml(items)}</td>`;
      case 'actions': return `<td class="actions">${groupActions}</td>`;
      default: return '<td></td>';
    }
  }

  function buildQueueTableHeader(cols) {
    return cols.map((col) => {
      if (col.key === 'select') {
        return '<th class="select-cell no-resize" data-col="select"><input id="selectAllQueueRows" type="checkbox" aria-label="Select all visible pending submissions" /></th>';
      }
      const sortActive = queueColState.sortField === col.key;
      const filterSet = queueColState.filters[col.key];
      const filterActive = !!(filterSet && filterSet.size);
      const extraCls = [
        col.key === 'select' ? 'select-cell' : '',
        col.key === 'caret' ? 'col-caret' : '',
        col.sortable ? 'sortable-header' : '',
        sortActive ? 'sort-active' : '',
        col.fixed ? 'no-resize' : ''
      ].filter(Boolean).join(' ');
      const title = col.title ? ` title="${esc(col.title)}"` : '';
      const drag = col.fixed ? '' : ' draggable="true"';
      const inner = (col.sortable || col.filterable)
        ? colFilter.headerCell({
          label: col.label,
          sortable: col.sortable,
          filterable: col.filterable,
          sortActive,
          sortDir: queueColState.sortDir,
          filterActive,
          filterCount: filterActive ? filterSet.size : 0
        })
        : esc(col.label);
      return `<th class="${extraCls}" data-col="${esc(col.key)}"${title}${drag}>${inner}</th>`;
    }).join('');
  }

  function renderQueueColumnFiltersBar() {
    const bar = $('#queueColumnFiltersBar');
    const text = $('#queueColumnFiltersBarText');
    if (!bar || !text) return;
    const active = Object.entries(queueColState.filters).filter(([, set]) => set && set.size);
    if (!active.length) {
      bar.classList.add('hidden');
      return;
    }
    const labels = active.map(([key]) => {
      const def = QUEUE_COLUMN_DEFS.find((c) => c.key === key);
      return def ? def.label : key;
    });
    text.textContent = `Column filters active: ${labels.join(', ')} (${active.length})`;
    bar.classList.remove('hidden');
  }

  function renderQueuePagination({ total, start, shown, pageCount }) {
    const bar = $('#queuePagination');
    if (!bar) return;
    if (!total) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const sizeSel = $('#queuePageSize');
    if (sizeSel && Number(sizeSel.value) !== queuePageState.pageSize) {
      sizeSel.value = String(queuePageState.pageSize);
    }
    const info = $('#queuePaginationInfo');
    if (info) {
      const from = total ? start + 1 : 0;
      const to = start + shown;
      const capNote = queuePageState.fetchCapped
        ? ` <span class="pagination-cap" title="Showing the ${QUEUE_MAX_ROWS.toLocaleString()} most recent submissions; older ones are not loaded.">(most recent ${QUEUE_MAX_ROWS.toLocaleString()} loaded)</span>`
        : '';
      info.innerHTML = `Showing <strong>${from.toLocaleString()}–${to.toLocaleString()}</strong> of <strong>${total.toLocaleString()}</strong>${capNote}`;
    }
    const indicator = $('#queuePageIndicator');
    if (indicator) indicator.textContent = `Page ${queuePageState.page} of ${pageCount}`;
    const atFirst = queuePageState.page <= 1;
    const atLast = queuePageState.page >= pageCount;
    const first = $('#queuePageFirst');
    const prev = $('#queuePagePrev');
    const next = $('#queuePageNext');
    const last = $('#queuePageLast');
    if (first) first.disabled = atFirst;
    if (prev) prev.disabled = atFirst;
    if (next) next.disabled = atLast;
    if (last) last.disabled = atLast;
  }

  function goToQueuePage(page) {
    const next = Number(page);
    if (!Number.isFinite(next)) return;
    queuePageState.page = Math.max(1, Math.round(next));
    renderQueueTable();
  }

  function wireQueueTableHeaders(table, cols) {
    table.querySelectorAll('th[data-col]').forEach((th) => {
      const key = th.dataset.col;
      const col = cols.find((c) => c.key === key);
      if (!col) return;
      const sortEl = th.querySelector('[data-action="sort"]');
      if (sortEl) {
        sortEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (queueColState.sortField === key) {
            queueColState.sortDir = queueColState.sortDir === 'asc' ? 'desc' : 'asc';
          } else {
            queueColState.sortField = key;
            queueColState.sortDir = 'asc';
          }
          saveQueueSort();
          queuePageState.page = 1;
          renderQueueTable();
        });
      }
      const filterEl = th.querySelector('[data-action="filter"]');
      if (filterEl) {
        filterEl.addEventListener('click', (e) => {
          e.stopPropagation();
          openQueueColumnFilter(key, filterEl);
        });
      }
      if (!col.fixed) {
        columnUi.wireColumnDrag(th, {
          canDrag: (el) => {
            const k = el.dataset.col;
            return k !== 'select' && k !== 'caret' && k !== 'actions';
          },
          onReorder: (srcKey, targetKey, insertBefore) => {
            applyQueueColumnReorder(srcKey, targetKey, insertBefore);
          }
        });
      }
    });
    columnUi.enhanceResize(table);
  }

  function applyQueueColumnReorder(srcKey, targetKey, insertBefore) {
    if (srcKey === 'select' || srcKey === 'caret' || srcKey === 'actions' || targetKey === 'select' || targetKey === 'caret' || targetKey === 'actions') return;
    const visible = visibleQueueColumns().map((c) => c.key);
    const full = fullQueueColumnOrder();
    const hidden = full.filter((k) => !visible.includes(k));
    const order = visible.filter((k) => k !== 'select' && k !== 'caret' && k !== 'actions');
    const from = order.indexOf(srcKey);
    if (from < 0) return;
    order.splice(from, 1);
    let to = order.indexOf(targetKey);
    if (to < 0) return;
    if (!insertBefore) to++;
    order.splice(to, 0, srcKey);
    queueColState.order = ['select', 'caret', ...order, 'actions'].concat(hidden.filter((k) => k !== 'select' && k !== 'caret' && k !== 'actions'));
    saveQueueOrder();
    renderQueueTable();
  }

  function openQueueColumnFilter(key, anchor) {
    const col = QUEUE_COLUMN_DEFS.find((c) => c.key === key);
    if (!col) return;
    const counts = new Map();
    for (const item of queueDisplayItems) {
      const label = queueFilterValue(item, key);
      const v = label === '' ? '' : String(label);
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    const values = [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([value, count]) => ({ value, count }));
    const current = queueColState.filters[key] || new Set();
    colFilter.open(anchor, {
      label: col.label,
      values,
      selected: current,
      onApply: (next) => {
        if (next.size) queueColState.filters[key] = next;
        else delete queueColState.filters[key];
        saveQueueFilters();
        queuePageState.page = 1;
        renderQueueTable();
      },
      onReset: () => {
        delete queueColState.filters[key];
        saveQueueFilters();
        queuePageState.page = 1;
        renderQueueTable();
      }
    });
  }

  function clearAllQueueColumnFilters() {
    queueColState.filters = {};
    saveQueueFilters();
    queuePageState.page = 1;
    renderQueueTable();
  }

  function renderQueueTable() {
    const table = $('#queueTable');
    const thead = table && table.querySelector('thead tr');
    const tbody = table && table.querySelector('tbody');
    if (!table || !thead || !tbody) return;
    const cols = visibleQueueColumns();
    const colCount = cols.length;
    thead.innerHTML = buildQueueTableHeader(cols);
    // Filter + sort the WHOLE loaded set first, then page over the result.
    const filtered = applyQueueFiltersAndSort(queueDisplayItems);
    const total = filtered.length;
    const pageSize = queuePageState.pageSize;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    if (queuePageState.page > pageCount) queuePageState.page = pageCount;
    if (queuePageState.page < 1) queuePageState.page = 1;
    const start = (queuePageState.page - 1) * pageSize;
    const pageItems = filtered.slice(start, start + pageSize);
    if (!total) {
      const msg = queueDisplayItems.length
        ? 'No rows match the current column filters.'
        : 'No rows.';
      tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align:center;color:var(--text-muted);padding:20px;">${msg}</td></tr>`;
    } else {
      tbody.innerHTML = pageItems.map((item) => {
        const attrs = item.type === 'solo'
          ? ` data-uuid="${esc(item.data.submission_uuid || '')}"`
          : ` class="group-row" data-group="${esc(item.id)}"`;
        return `<tr${attrs}>${cols.map((col) => renderQueueCell(item, col)).join('')}</tr>`;
      }).join('');
    }
    renderQueueColumnFiltersBar();
    renderQueuePagination({ total, start, shown: pageItems.length, pageCount });
    wireQueueTableHeaders(table, cols);
    if (queueColSelectorOpen) buildQueueColSelectorList();
    syncQueueSelectionControls();
  }

  function syncQueueSelectionControls() {
    pruneQueueSelection();
    const visiblePending = visiblePendingQueueUuids();
    const selectedVisible = visiblePending.filter((uuid) => selectedQueueUuids.has(uuid));
    const selectedCount = selectedQueueUuids.size;
    const selectAllRows = $('#selectAllQueueRows');
    const selectAllBtn = $('#selectAllQueue');
    const clearBtn = $('#clearQueueSelection');
    const approveBtn = $('#approveSelectedQueue');
    const rejectBtn = $('#rejectSelectedQueue');
    const status = $('#queueBulkStatus');

    document.querySelectorAll('#queueTable tbody input.queue-select').forEach((cb) => {
      const uuids = (cb.dataset.uuids || '').split(',').filter(Boolean);
      const selectedInRow = uuids.filter((uuid) => selectedQueueUuids.has(uuid));
      cb.checked = uuids.length > 0 && selectedInRow.length === uuids.length;
      cb.indeterminate = selectedInRow.length > 0 && selectedInRow.length < uuids.length;
      cb.disabled = queueBulkBusy || uuids.length === 0;
    });

    if (selectAllRows) {
      selectAllRows.disabled = queueBulkBusy || visiblePending.length === 0;
      selectAllRows.checked = visiblePending.length > 0 && selectedVisible.length === visiblePending.length;
      selectAllRows.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visiblePending.length;
    }
    if (selectAllBtn) {
      selectAllBtn.disabled = queueBulkBusy || visiblePending.length === 0;
      selectAllBtn.textContent = visiblePending.length ? `Select all visible (${visiblePending.length})` : 'Select all visible';
    }
    if (clearBtn) clearBtn.disabled = queueBulkBusy || selectedCount === 0;
    if (approveBtn) {
      approveBtn.disabled = queueBulkBusy || selectedCount === 0;
      approveBtn.textContent = selectedCount ? `Approve selected (${selectedCount})` : 'Approve selected';
    }
    if (rejectBtn) {
      rejectBtn.disabled = queueBulkBusy || selectedCount === 0;
      rejectBtn.textContent = selectedCount ? `Reject selected (${selectedCount})` : 'Reject selected';
    }
    if (status && !queueBulkBusy) {
      status.textContent = selectedCount ? `${selectedCount} submission${selectedCount === 1 ? '' : 's'} selected` : queueBulkMessage;
    }
  }

  function setQueueSelection(uuids, selected) {
    uuids.forEach((uuid) => {
      if (!uuid) return;
      if (selected) selectedQueueUuids.add(uuid);
      else selectedQueueUuids.delete(uuid);
    });
    queueBulkMessage = '';
    syncQueueSelectionControls();
  }

  async function approveSelectedQueue() {
    if (queueBulkBusy) return;
    pruneQueueSelection();
    const uuids = [...selectedQueueUuids];
    if (!uuids.length) return;
    if (!confirm(`Approve and push ${uuids.length} selected pending submission(s)? They will be queued and pushed to Amazon one at a time.`)) return;
    const status = $('#queueBulkStatus');
    queueBulkBusy = true;
    syncQueueSelectionControls();
    if (status) status.textContent = 'Queueing approvals...';
    try {
      const result = await apiPost('/admin/group/approve', { uuids });
      selectedQueueUuids.clear();
      queueBulkMessage = `Queued ${result.approved || 0} approval${result.approved === 1 ? '' : 's'}; skipped ${result.skipped || 0}.`;
      if (status) status.textContent = queueBulkMessage;
      await loadQueue();
      loadJobs();
    } catch (err) {
      if (err.message === '401') return;
      queueBulkMessage = 'Approval failed: ' + err.message;
      if (status) status.textContent = queueBulkMessage;
      alert('Approve selected submissions failed: ' + err.message);
    } finally {
      queueBulkBusy = false;
      syncQueueSelectionControls();
    }
  }

  async function rejectSelectedQueue() {
    if (queueBulkBusy) return;
    pruneQueueSelection();
    const uuids = [...selectedQueueUuids];
    if (!uuids.length) return;
    if (!confirm(`Reject ${uuids.length} selected pending submission(s)? They will NOT be sent to Amazon.`)) return;
    const status = $('#queueBulkStatus');
    queueBulkBusy = true;
    syncQueueSelectionControls();
    if (status) status.textContent = 'Rejecting submissions...';
    try {
      const result = await apiPost('/admin/group/reject', { uuids });
      selectedQueueUuids.clear();
      queueBulkMessage = `Rejected ${result.rejected || 0} submission${result.rejected === 1 ? '' : 's'}; skipped ${result.skipped || 0}.`;
      if (status) status.textContent = queueBulkMessage;
      await loadQueue();
      loadJobs();
    } catch (err) {
      if (err.message === '401') return;
      queueBulkMessage = 'Rejection failed: ' + err.message;
      if (status) status.textContent = queueBulkMessage;
      alert('Reject selected submissions failed: ' + err.message);
    } finally {
      queueBulkBusy = false;
      syncQueueSelectionControls();
    }
  }

  function buildQueueColSelectorList() {
    const list = $('#queueColSelectorList');
    if (!list) return;
    const widths = (() => {
      try { return JSON.parse(localStorage.getItem('aps_queue_col_widths') || '{}'); }
      catch { return {}; }
    })();
    list.innerHTML = fullQueueColumnOrder().map((key) => {
      const col = QUEUE_COLUMN_DEFS.find((c) => c.key === key);
      if (!col || !col.label) return '';
      const checked = !queueColState.hidden.has(key);
      const w = widths[key];
      const widthBadge = w ? `<span class="col-width">${Math.round(w)}px</span>` : '';
      if (col.nohide) {
        return `<div class="col-selector-item fixed-col"><input type="checkbox" checked disabled /><span class="col-selector-item-label">${esc(col.label)}</span>${widthBadge}</div>`;
      }
      return `<label class="col-selector-item"><input type="checkbox" data-col-key="${esc(key)}" ${checked ? 'checked' : ''} /><span class="col-selector-item-label">${esc(col.label)}</span>${widthBadge}</label>`;
    }).join('');
    list.querySelectorAll('input[data-col-key]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const k = cb.dataset.colKey;
        if (cb.checked) queueColState.hidden.delete(k);
        else queueColState.hidden.add(k);
        saveQueueHidden();
        renderQueueTable();
      });
    });
    const panel = $('#queueColSelectorPanel');
    if (panel) columnUi.reapplyColSelectorSearch(panel);
  }

  let queueColSelectorOpen = false;
  function openQueueColSelector() {
    const panel = $('#queueColSelectorPanel');
    const overlay = $('#queueColSelectorOverlay');
    const btn = $('#queueColSelectorBtn');
    if (!panel || !overlay || !btn) return;
    buildQueueColSelectorList();
    panel.classList.add('open');
    overlay.classList.add('open');
    btn.classList.add('active');
    btn.setAttribute('aria-expanded', 'true');
    queueColSelectorOpen = true;
    columnUi.initColSelectorSearch(panel);
  }
  function closeQueueColSelector() {
    const panel = $('#queueColSelectorPanel');
    const overlay = $('#queueColSelectorOverlay');
    const btn = $('#queueColSelectorBtn');
    if (!panel) return;
    columnUi.clearColSelectorSearch(panel);
    panel.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
    if (btn) {
      btn.classList.remove('active');
      btn.setAttribute('aria-expanded', 'false');
    }
    queueColSelectorOpen = false;
  }
  function toggleQueueColSelector() {
    if (queueColSelectorOpen) closeQueueColSelector();
    else openQueueColSelector();
  }
  function resetQueueColumns() {
    queueColState.hidden = new Set();
    queueColState.order = [];
    queueColState.sortField = 'created_at';
    queueColState.sortDir = 'desc';
    queueColState.filters = {};
    queuePageState.page = 1;
    saveQueueHidden();
    saveQueueOrder();
    saveQueueSort();
    saveQueueFilters();
    const table = $('#queueTable');
    if (table) columnUi.resetResize(table);
    renderQueueTable();
  }

  // Distinct non-empty values for a field across a group's submissions; renders
  // a single shared value, or "(N)" when the group mixes values.
  function sharedCell(items, key) {
    const vals = [...new Set(items.map((i) => (i[key] == null ? '' : String(i[key]))).filter((v) => v !== ''))];
    if (vals.length === 0) return '';
    if (vals.length === 1) return esc(vals[0]);
    return `<span class="muted">(${vals.length})</span>`;
  }

  // One status badge per distinct status in the group, with a count suffix.
  function statusSummary(items) {
    const counts = {};
    items.forEach((i) => { counts[i.status] = (counts[i.status] || 0) + 1; });
    return Object.entries(counts)
      .map(([s, n]) => statusBadge(s).replace('</span>', ` &times;${n}</span>`))
      .join(' ');
  }

  // Group key: one submission batch (job) for one ASIN. This intentionally does
  // NOT merge past submissions with new ones — only rows pushed together in the
  // same job for the same ASIN collapse into a group. Rows without an ASIN never
  // group (each stays a plain row) so unrelated failures don't collapse. Legacy
  // rows missing a job_uuid fall back to the submission's created_at as the
  // batch boundary.
  function groupKeyOf(r) {
    const asin = r.asin || '';
    if (!asin) return null;
    const batch = r.job_uuid || ('t:' + (r.created_at || ''));
    return `${batch}||${asin}`;
  }

  async function loadQueue() {
    const tbody = $('#queueTable tbody');
    try {
      // Pull the whole history in keyset batches (newest -> oldest) until the
      // server has nothing older, or we hit the in-browser safety ceiling.
      const submissions = [];
      let beforeId = null;
      let total = Infinity;
      for (let guard = 0; submissions.length < QUEUE_MAX_ROWS && guard < 1000; guard++) {
        const qs = beforeId == null
          ? `?limit=${QUEUE_FETCH_LIMIT}`
          : `?limit=${QUEUE_FETCH_LIMIT}&beforeId=${encodeURIComponent(beforeId)}`;
        const data = await api('/admin/queue' + qs);
        const batch = Array.isArray(data.submissions) ? data.submissions : [];
        if (typeof data.total === 'number') total = data.total;
        submissions.push(...batch);
        if (!data.nextBeforeId || batch.length < QUEUE_FETCH_LIMIT) break;
        beforeId = data.nextBeforeId;
      }
      // True only if more rows exist on the server than we loaded (ceiling hit).
      queuePageState.fetchCapped = Number.isFinite(total) && submissions.length < total;
      changesCache.clear();
      groupSubs.clear();
      subsByUuid.clear();
      for (const r of submissions) {
        if (r.submission_uuid) subsByUuid.set(r.submission_uuid, r);
      }
      const order = [];
      const byKey = new Map();
      for (const r of submissions) {
        const key = groupKeyOf(r) || ('solo:' + r.submission_uuid);
        if (!byKey.has(key)) { const g = { key, items: [] }; byKey.set(key, g); order.push(g); }
        byKey.get(key).items.push(r);
      }
      let gi = 0;
      queueDisplayItems = order.map((g) => {
        if (g.key.startsWith('solo:') || g.items.length < 2) {
          return { type: 'solo', data: g.items[0] };
        }
        const id = 'g' + (gi++);
        groupSubs.set(id, g.items);
        return { type: 'group', id, items: g.items };
      });
      queuePageState.page = 1;
      renderQueueTable();
    } catch (e) {
      if (e.message !== '401') {
        queueDisplayItems = [];
        tbody.innerHTML = errRow(visibleQueueColCount() || QUEUE_COL_KEYS.length, e);
        syncQueueSelectionControls();
      }
    }
  }

  function renderAppliedChanges({ changes, warnings, pushedAt, currentAt, currentSource }) {
    let html = '';
    const srcLabel = currentSource === 'reconciliation' ? ' (reconciliation snapshot)' : currentSource === 'live' ? ' (live from Amazon)' : '';
    const meta = [];
    if (pushedAt) meta.push(`Pushed: ${esc(pushedAt)}`);
    meta.push(currentAt ? `Current value as of ${esc(currentAt)}${esc(srcLabel)}` : `Current value${esc(srcLabel)} unavailable`);
    html += `<div class="changes-head">${meta.join(' &middot; ')}</div>`;
    if (!changes || !changes.length) {
      html += '<div class="detail-empty">No field changes for this submission.</div>';
    } else {
      html += `<div class="changes-head"><span class="diff-old-legend">Old value (before push)</span> <span class="diff-arrow">&#8594;</span> <span class="diff-new-legend">Pushed value</span> <span class="diff-arrow">|</span> <span class="diff-current-legend">Current value</span></div>`;
      html += '<div class="changes">' + changes.map((c) => {
        const label = c.field && c.field !== c.attribute ? `${esc(c.field)} <span class="diff-attr">(${esc(c.attribute)})</span>` : esc(c.attribute);
        const oldVal = c.oldAvailable
          ? `<span class="diff-old">${esc(c.old)}</span>`
          : '<span class="diff-na">(no prior value)</span>';
        const curVal = c.currentAvailable
          ? `<span class="diff-current">${esc(c.current)}</span>`
          : '<span class="diff-na">(unavailable)</span>';
        return `<div class="diff-field"><div class="diff-label">${label}</div><div class="diff-vals">${oldVal} <span class="diff-arrow">&#8594;</span> <span class="diff-new">${esc(c.pushed)}</span> <span class="diff-arrow">|</span> ${curVal}</div></div>`;
      }).join('') + '</div>';
    }
    if (warnings && warnings.length) {
      html += `<div class="detail-warn">${warnings.map((w) => esc(w)).join('<br>')}</div>`;
    }
    return html;
  }

  function renderChanges(data) {
    if (data && data.applied) return renderAppliedChanges(data);
    const { changes, warnings, source } = data;
    let html = '';
    if (!changes || !changes.length) {
      html = '<div class="detail-empty">No field changes for this submission.</div>';
    } else {
      const srcLabel = source === 'prior_state' ? ' (captured before push)' : source === 'live' ? ' (live from Amazon)' : '';
      html = `<div class="changes-head"><span class="diff-old-legend">Current value on Amazon${esc(srcLabel)}</span> <span class="diff-arrow">&#8594;</span> <span class="diff-new-legend">New value being pushed</span></div>`;
      html += '<div class="changes">' + changes.map((c) => {
        const label = c.field && c.field !== c.attribute ? `${esc(c.field)} <span class="diff-attr">(${esc(c.attribute)})</span>` : esc(c.attribute);
        const from = c.sourceAvailable
          ? `<span class="diff-old">${esc(c.from)}</span>`
          : '<span class="diff-na">(no current value / unavailable)</span>';
        return `<div class="diff-field"><div class="diff-label">${label}</div><div class="diff-vals">${from} <span class="diff-arrow">&#8594;</span> <span class="diff-new">${esc(c.to)}</span></div></div>`;
      }).join('') + '</div>';
    }
    if (warnings && warnings.length) {
      html += `<div class="detail-warn">${warnings.map((w) => esc(w)).join('<br>')}</div>`;
    }
    return html;
  }

  async function toggleChanges(row, uuid) {
    const next = row.nextElementSibling;
    if (next && next.classList.contains('detail-row')) {
      next.remove();
      row.classList.remove('expanded');
      return;
    }
    row.classList.add('expanded');
    const detail = document.createElement('tr');
    detail.className = 'detail-row';
    detail.innerHTML = `<td></td><td colspan="${visibleQueueColCount() - 1}"><div class="detail-body">Loading changes…</div></td>`;
    row.insertAdjacentElement('afterend', detail);
    const body = detail.querySelector('.detail-body');
    try {
      let rendered = changesCache.get(uuid);
      if (rendered == null) {
        const data = await api(`/admin/submissions/${encodeURIComponent(uuid)}/changes`);
        const sub = subsByUuid.get(uuid);
        rendered = (sub ? renderCommentBlock(sub.approver_comment) + renderMetaBlock(sub.meta) : '') + renderChanges(data);
        changesCache.set(uuid, rendered);
      }
      if (body) body.innerHTML = rendered;
    } catch (e) {
      if (e.message === '401') return;
      if (body) body.innerHTML = `<div class="detail-warn">Failed to load changes: ${esc(e.message)}</div>`;
    }
  }

  // Render the grouped before/posted/after table: one section per submission
  // (vendor code), with a row per changed field. Vendor/SKU/Mkt and the
  // per-submission status + Approve/Reject span the submission's field rows.
  function renderGroupChanges(data) {
    const subs = (data && data.submissions) || [];
    if (!subs.length) return '<div class="detail-empty">No submissions in this group.</div>';
    const metaSubs = subs.filter((s) => (s.approver_comment && String(s.approver_comment).trim())
      || (s.meta && Object.keys(s.meta).some((k) => s.meta[k] != null && s.meta[k] !== '')));
    let metaHeader = '';
    if (metaSubs.length) {
      metaHeader = '<div class="meta-block-group">'
        + metaSubs.map((s) => `<div class="meta-block-row"><div class="meta-block-label"><code>${esc((s.submission_uuid || '').slice(0, 8))}</code> ${esc(s.vendor_code || '')} / ${esc(s.sku || '')}</div>${renderCommentBlock(s.approver_comment)}${renderMetaBlock(s.meta)}</div>`).join('')
        + '</div>';
    }
    let rows = '';
    for (const s of subs) {
      const changes = (s.changes && s.changes.length) ? s.changes : [];
      const span = Math.max(1, changes.length);
      const statusCell = `<div class="bpa-status">${statusBadge(s.status)}${s.status === 'PENDING_APPROVAL' ? rowActions(s.submission_uuid) : ''}</div>`;
      const idCells = `<td class="bpa-id" rowspan="${span}">${esc(s.vendor_code || '')}</td>`
        + `<td class="bpa-id" rowspan="${span}"><code>${esc(s.sku || '')}</code></td>`
        + `<td class="bpa-id" rowspan="${span}">${esc(s.marketplace_code || '')}</td>`;
      if (!changes.length) {
        rows += `<tr class="bpa-sub bpa-sub-first">${idCells}<td class="bpa-nochange" colspan="4">No field changes</td><td class="bpa-statuscell">${statusCell}</td></tr>`;
        continue;
      }
      changes.forEach((c, idx) => {
        const label = c.field && c.field !== c.attribute ? `${esc(c.field)} <span class="diff-attr">(${esc(c.attribute)})</span>` : esc(c.attribute);
        const before = c.beforeAvailable ? `<span class="bpa-before">${esc(c.before)}</span>` : '<span class="diff-na">(n/a)</span>';
        const after = c.afterAvailable
          ? `<span class="bpa-after">${esc(c.after)}</span>`
          : (s.applied ? '<span class="diff-na">(unavailable)</span>' : '<span class="diff-na">pending push</span>');
        rows += `<tr class="bpa-sub${idx === 0 ? ' bpa-sub-first' : ''}">`
          + (idx === 0 ? idCells : '')
          + `<td class="bpa-field">${label}</td>`
          + `<td>${before}</td>`
          + `<td><span class="bpa-posted">${esc(c.posted)}</span></td>`
          + `<td>${after}</td>`
          + (idx === 0 ? `<td class="bpa-statuscell" rowspan="${span}">${statusCell}</td>` : '')
          + `</tr>`;
      });
    }
    let html = `<div class="changes-head"><span class="diff-old-legend">Before (current on Amazon)</span> <span class="diff-arrow">&#8594;</span> <span class="diff-new-legend">Posted (pushed)</span> <span class="diff-arrow">&#8594;</span> <span class="diff-current-legend">After (read-back)</span></div>`;
    html += `<table class="bpa-table"><thead><tr><th>Vendor</th><th>SKU</th><th>Mkt</th><th>Field</th><th>Before</th><th>Posted</th><th>After</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
    const warns = [...new Set(subs.flatMap((s) => s.warnings || []))];
    if (warns.length) html += `<div class="detail-warn">${warns.map((w) => esc(w)).join('<br>')}</div>`;
    return metaHeader + html;
  }

  async function toggleGroupChanges(row, groupId) {
    const next = row.nextElementSibling;
    if (next && next.classList.contains('detail-row')) {
      next.remove();
      row.classList.remove('expanded');
      return;
    }
    row.classList.add('expanded');
    const detail = document.createElement('tr');
    detail.className = 'detail-row';
    detail.innerHTML = `<td></td><td colspan="${visibleQueueColCount() - 1}"><div class="detail-body">Loading changes…</div></td>`;
    row.insertAdjacentElement('afterend', detail);
    const body = detail.querySelector('.detail-body');
    try {
      const cacheKey = 'grp:' + groupId;
      let rendered = changesCache.get(cacheKey);
      if (rendered == null) {
        const uuids = (groupSubs.get(groupId) || []).map((s) => s.submission_uuid);
        const data = await apiPost('/admin/group/changes', { uuids });
        rendered = renderGroupChanges(data);
        changesCache.set(cacheKey, rendered);
      }
      if (body) body.innerHTML = rendered;
    } catch (e) {
      if (e.message === '401') return;
      if (body) body.innerHTML = `<div class="detail-warn">Failed to load changes: ${esc(e.message)}</div>`;
    }
  }

  // ── Queue column selector wiring ─────────────────────────────────────────
  const queueColBtn = $('#queueColSelectorBtn');
  const queueColOverlay = $('#queueColSelectorOverlay');
  if (queueColBtn) queueColBtn.addEventListener('click', toggleQueueColSelector);
  if (queueColOverlay) queueColOverlay.addEventListener('click', closeQueueColSelector);
  const queueColAutoFit = $('#queueColAutoFit');
  if (queueColAutoFit) {
    queueColAutoFit.addEventListener('click', () => {
      const table = $('#queueTable');
      if (table) columnUi.autoFitAllColumns(table);
      buildQueueColSelectorList();
    });
  }
  const queueColReset = $('#queueColReset');
  if (queueColReset) queueColReset.addEventListener('click', resetQueueColumns);
  const queueFiltersClear = $('#queueColumnFiltersClear');
  if (queueFiltersClear) queueFiltersClear.addEventListener('click', clearAllQueueColumnFilters);

  // ── Jobs column selector wiring ──────────────────────────────────────────
  const jobsColBtn = $('#jobsColSelectorBtn');
  const jobsColOverlay = $('#jobsColSelectorOverlay');
  if (jobsColBtn) jobsColBtn.addEventListener('click', toggleJobsColSelector);
  if (jobsColOverlay) jobsColOverlay.addEventListener('click', closeJobsColSelector);
  const jobsColAutoFit = $('#jobsColAutoFit');
  if (jobsColAutoFit) {
    jobsColAutoFit.addEventListener('click', () => {
      const table = $('#jobsTable');
      if (table) columnUi.autoFitAllColumns(table);
      buildJobsColSelectorList();
    });
  }
  const jobsColReset = $('#jobsColReset');
  if (jobsColReset) jobsColReset.addEventListener('click', resetJobsColumns);
  const jobsFiltersClear = $('#jobsColumnFiltersClear');
  if (jobsFiltersClear) jobsFiltersClear.addEventListener('click', clearAllJobsColumnFilters);

  // ── Pagination controls ──────────────────────────────────────────────────
  loadQueuePageSize();
  const queuePageSizeSel = $('#queuePageSize');
  if (queuePageSizeSel) {
    queuePageSizeSel.value = String(queuePageState.pageSize);
    queuePageSizeSel.addEventListener('change', () => {
      const size = Number(queuePageSizeSel.value);
      if (!QUEUE_PAGE_SIZES.includes(size)) return;
      queuePageState.pageSize = size;
      queuePageState.page = 1;
      saveQueuePageSize();
      renderQueueTable();
    });
  }
  const queuePageFirst = $('#queuePageFirst');
  if (queuePageFirst) queuePageFirst.addEventListener('click', () => goToQueuePage(1));
  const queuePagePrev = $('#queuePagePrev');
  if (queuePagePrev) queuePagePrev.addEventListener('click', () => goToQueuePage(queuePageState.page - 1));
  const queuePageNext = $('#queuePageNext');
  if (queuePageNext) queuePageNext.addEventListener('click', () => goToQueuePage(queuePageState.page + 1));
  const queuePageLast = $('#queuePageLast');
  if (queuePageLast) queuePageLast.addEventListener('click', () => goToQueuePage(Number.MAX_SAFE_INTEGER));

  const JOBS_FETCH_LIMIT = 500;
  const JOBS_MAX_ROWS = 25000;
  const JOBS_PAGE_SIZES = [50, 100, 200, 500, 1000];
  const JOBS_PAGE_STORAGE = 'aps_jobs_page_size';
  const jobsPageState = { page: 1, pageSize: 200, fetchCapped: false };
  let jobsSearchTimer = null;
  let jobsDisplayItems = [];

  function loadJobsPageSize() {
    try {
      const saved = Number(localStorage.getItem(JOBS_PAGE_STORAGE));
      if (JOBS_PAGE_SIZES.includes(saved)) jobsPageState.pageSize = saved;
    } catch (_) { /* default */ }
  }
  function saveJobsPageSize() {
    try { localStorage.setItem(JOBS_PAGE_STORAGE, String(jobsPageState.pageSize)); } catch (_) {}
  }

  loadJobsPageSize();
  const jobsPageSizeSel = $('#jobsPageSize');
  if (jobsPageSizeSel) {
    jobsPageSizeSel.value = String(jobsPageState.pageSize);
    jobsPageSizeSel.addEventListener('change', () => {
      const size = Number(jobsPageSizeSel.value);
      if (!JOBS_PAGE_SIZES.includes(size)) return;
      jobsPageState.pageSize = size;
      jobsPageState.page = 1;
      saveJobsPageSize();
      renderJobsTable();
    });
  }
  const jobsPageFirst = $('#jobsPageFirst');
  if (jobsPageFirst) jobsPageFirst.addEventListener('click', () => goToJobsPage(1));
  const jobsPagePrev = $('#jobsPagePrev');
  if (jobsPagePrev) jobsPagePrev.addEventListener('click', () => goToJobsPage(jobsPageState.page - 1));
  const jobsPageNext = $('#jobsPageNext');
  if (jobsPageNext) jobsPageNext.addEventListener('click', () => goToJobsPage(jobsPageState.page + 1));
  const jobsPageLast = $('#jobsPageLast');
  if (jobsPageLast) jobsPageLast.addEventListener('click', () => goToJobsPage(Number.MAX_SAFE_INTEGER));

  // ── Jobs table columns (sort / filter / reorder / resize) ────────────────
  const JOBS_COLUMN_DEFS = [
    { key: 'select', label: '', nohide: true, sortable: false, filterable: false, fixed: true },
    { key: 'created_at', label: 'Created', sortable: true, filterable: true },
    { key: 'job_id', label: 'Job', sortable: true, filterable: true },
    { key: 'kind', label: 'Kind', sortable: true, filterable: true },
    { key: 'caller', label: 'Caller', sortable: true, filterable: true },
    { key: 'asin', label: 'ASIN', sortable: true, filterable: true },
    { key: 'item_number', label: 'Item #', sortable: true, filterable: true },
    { key: 'marketplace_code', label: 'Mkt', sortable: true, filterable: true },
    { key: 'label', label: 'Label', sortable: true, filterable: true },
    { key: 'fields', label: 'Fields', sortable: true, filterable: true, title: 'Amazon attributes included in this push' },
    { key: 'ok_count', label: 'OK', sortable: true, filterable: true },
    { key: 'failed_count', label: 'Failed', sortable: true, filterable: true },
    { key: 'target_count', label: 'Total', sortable: true, filterable: true },
    { key: 'pending_approval', label: 'Pending approval', sortable: true, filterable: true },
    { key: 'status', label: 'Status', sortable: true, filterable: true },
    { key: 'requested_by', label: 'Requested by', sortable: true, filterable: true }
  ];
  const JOBS_COL_KEYS = JOBS_COLUMN_DEFS.map((c) => c.key);
  const JOBS_STORAGE = {
    hidden: 'aps_jobs_hidden',
    order: 'aps_jobs_order',
    sort: 'aps_jobs_sort',
    filters: 'aps_jobs_col_filters'
  };
  const jobsColState = {
    hidden: new Set(['item_number', 'marketplace_code', 'label', 'requested_by']),
    order: [],
    sortField: 'created_at',
    sortDir: 'desc',
    filters: {}
  };

  function loadJobsColState() {
    try {
      const hidden = JSON.parse(localStorage.getItem(JOBS_STORAGE.hidden) || '[]');
      jobsColState.hidden = new Set(Array.isArray(hidden) ? hidden : []);
    } catch (_) { jobsColState.hidden = new Set(['item_number', 'marketplace_code', 'label', 'requested_by']); }
    try {
      const order = (localStorage.getItem(JOBS_STORAGE.order) || '').split(',').map((s) => s.trim()).filter(Boolean);
      jobsColState.order = order.filter((k) => JOBS_COL_KEYS.includes(k));
    } catch (_) { jobsColState.order = []; }
    try {
      const sort = JSON.parse(localStorage.getItem(JOBS_STORAGE.sort) || '{}');
      if (sort.field && JOBS_COL_KEYS.includes(sort.field)) {
        jobsColState.sortField = sort.field;
        jobsColState.sortDir = sort.dir === 'asc' ? 'asc' : 'desc';
      }
    } catch (_) { /* defaults */ }
    try {
      const filters = JSON.parse(localStorage.getItem(JOBS_STORAGE.filters) || '{}');
      jobsColState.filters = {};
      for (const [k, vals] of Object.entries(filters)) {
        if (JOBS_COL_KEYS.includes(k) && Array.isArray(vals) && vals.length) {
          jobsColState.filters[k] = new Set(vals.map(String));
        }
      }
    } catch (_) { jobsColState.filters = {}; }
    for (const def of JOBS_COLUMN_DEFS) {
      if (def.nohide) jobsColState.hidden.delete(def.key);
    }
  }
  function saveJobsHidden() {
    localStorage.setItem(JOBS_STORAGE.hidden, JSON.stringify([...jobsColState.hidden]));
  }
  function saveJobsOrder() {
    localStorage.setItem(JOBS_STORAGE.order, jobsColState.order.join(','));
  }
  function saveJobsSort() {
    localStorage.setItem(JOBS_STORAGE.sort, JSON.stringify({ field: jobsColState.sortField, dir: jobsColState.sortDir }));
  }
  function saveJobsFilters() {
    const out = {};
    for (const [k, set] of Object.entries(jobsColState.filters)) {
      if (set && set.size) out[k] = [...set];
    }
    localStorage.setItem(JOBS_STORAGE.filters, JSON.stringify(out));
  }
  function fullJobsColumnOrder() {
    const base = jobsColState.order.length
      ? jobsColState.order.slice()
      : JOBS_COL_KEYS.slice();
    for (const k of JOBS_COL_KEYS) {
      if (!base.includes(k)) base.push(k);
    }
    const fixedStart = ['select'];
    const middle = base.filter((k) => JOBS_COL_KEYS.includes(k) && !fixedStart.includes(k));
    return fixedStart.concat(middle);
  }
  function visibleJobsColumns() {
    return fullJobsColumnOrder()
      .map((k) => JOBS_COLUMN_DEFS.find((d) => d.key === k))
      .filter((c) => c && (!jobsColState.hidden.has(c.key) || c.nohide));
  }
  function visibleJobsColCount() {
    return visibleJobsColumns().length;
  }

  function jobFieldNames(j) {
    return Array.isArray(j.fieldNames) ? j.fieldNames.filter(Boolean).map(String) : [];
  }
  function fieldsCellHtml(j) {
    const names = jobFieldNames(j);
    if (!names.length) return '<span class="muted-cell">—</span>';
    const title = names.join(', ');
    if (names.length <= 3) {
      return `<span class="field-tags" title="${esc(title)}">${names.map((n) => `<span class="field-tag">${esc(n)}</span>`).join('')}</span>`;
    }
    const shown = names.slice(0, 2).map((n) => `<span class="field-tag">${esc(n)}</span>`).join('');
    return `<span class="field-tags" title="${esc(title)}">${shown}<span class="field-tag field-tag-more">+${names.length - 2}</span></span>`;
  }

  function jobFilterValue(j, key) {
    switch (key) {
      case 'job_id': return String(j.jobId || '').slice(0, 8);
      case 'created_at': return String(j.createdAt || '');
      case 'item_number': return String(j.itemNumber || '');
      case 'marketplace_code': return String(j.marketplaceCode || '');
      case 'label': return String(j.label || '');
      case 'fields': return jobFieldNames(j).sort().join(', ');
      case 'ok_count': return String(j.okCount ?? '');
      case 'failed_count': return String(j.failedCount ?? '');
      case 'target_count': return String(j.targetCount ?? '');
      case 'pending_approval': return String(j.pendingApprovalCount ?? '');
      case 'requested_by': return String(j.requestedBy || '');
      case 'status': return String(j.status || '');
      default: return j[key] == null ? '' : String(j[key]);
    }
  }

  function jobSortValue(j, key) {
    if (key === 'created_at') return j.createdAt || '';
    if (key === 'ok_count' || key === 'failed_count' || key === 'target_count' || key === 'pending_approval') {
      return Number(jobFilterValue(j, key)) || 0;
    }
    const raw = jobFilterValue(j, key);
    return typeof raw === 'string' ? raw.toLowerCase() : raw;
  }

  function jobMatchesColumnFilter(j, key, allowed) {
    if (!allowed || !allowed.size) return true;
    if (key === 'fields') {
      const names = jobFieldNames(j);
      return names.some((n) => allowed.has(n));
    }
    return allowed.has(jobFilterValue(j, key));
  }

  function applyJobsFiltersAndSort(items) {
    let rows = items.slice();
    for (const [key, allowed] of Object.entries(jobsColState.filters)) {
      if (!allowed || !allowed.size) continue;
      rows = rows.filter((j) => jobMatchesColumnFilter(j, key, allowed));
    }
    const field = jobsColState.sortField;
    const dir = jobsColState.sortDir === 'asc' ? 1 : -1;
    if (field && JOBS_COL_KEYS.includes(field)) {
      rows.sort((a, b) => {
        const av = jobSortValue(a, field);
        const bv = jobSortValue(b, field);
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }
    return rows;
  }

  function renderJobsCell(j, col) {
    const jobId = j.jobId || '';
    const pendingApprovalCount = Number(j.pendingApprovalCount) || 0;
    const canApprove = pendingApprovalCount > 0;
    const checked = selectedJobIds.has(jobId) ? 'checked' : '';
    const disabled = canApprove ? '' : 'disabled';
    switch (col.key) {
      case 'select':
        return `<td class="select-cell"><input class="job-select" type="checkbox" data-job-id="${esc(jobId)}" ${checked} ${disabled} aria-label="Select job ${esc(jobId.slice(0, 8))}" /></td>`;
      case 'created_at': return `<td>${esc(j.createdAt)}</td>`;
      case 'job_id': return `<td><code title="${esc(jobId)}">${esc(jobId.slice(0, 8))}</code></td>`;
      case 'kind': return `<td>${esc(j.kind)}</td>`;
      case 'caller': return `<td>${esc(j.caller)}</td>`;
      case 'asin': return `<td><code>${esc(j.asin || '')}</code></td>`;
      case 'item_number': return `<td><code>${esc(j.itemNumber || '')}</code></td>`;
      case 'marketplace_code': return `<td>${esc(j.marketplaceCode || '')}</td>`;
      case 'label': return `<td>${esc(j.label || '')}</td>`;
      case 'fields': return `<td>${fieldsCellHtml(j)}</td>`;
      case 'ok_count': return `<td>${esc(j.okCount)}</td>`;
      case 'failed_count': return `<td>${esc(j.failedCount)}</td>`;
      case 'target_count': return `<td>${esc(j.targetCount)}</td>`;
      case 'pending_approval': return `<td>${esc(pendingApprovalCount)}</td>`;
      case 'status': return `<td>${statusBadge(j.status)}</td>`;
      case 'requested_by': return `<td>${esc(j.requestedBy || '')}</td>`;
      default: return '<td></td>';
    }
  }

  function buildJobsTableHeader(cols) {
    return cols.map((col) => {
      if (col.key === 'select') {
        return '<th class="select-cell no-resize" data-col="select"><input id="selectAllJobsRows" type="checkbox" aria-label="Select all approvable jobs" /></th>';
      }
      const sortActive = jobsColState.sortField === col.key;
      const filterSet = jobsColState.filters[col.key];
      const filterActive = !!(filterSet && filterSet.size);
      const extraCls = [
        col.key === 'select' ? 'select-cell' : '',
        col.sortable ? 'sortable-header' : '',
        sortActive ? 'sort-active' : '',
        col.fixed ? 'no-resize' : ''
      ].filter(Boolean).join(' ');
      const title = col.title ? ` title="${esc(col.title)}"` : '';
      const drag = col.fixed ? '' : ' draggable="true"';
      const inner = (col.sortable || col.filterable)
        ? colFilter.headerCell({
          label: col.label,
          sortable: col.sortable,
          filterable: col.filterable,
          sortActive,
          sortDir: jobsColState.sortDir,
          filterActive,
          filterCount: filterActive ? filterSet.size : 0
        })
        : esc(col.label);
      return `<th class="${extraCls}" data-col="${esc(col.key)}"${title}${drag}>${inner}</th>`;
    }).join('');
  }

  function renderJobsColumnFiltersBar() {
    const bar = $('#jobsColumnFiltersBar');
    const text = $('#jobsColumnFiltersBarText');
    if (!bar || !text) return;
    const active = Object.entries(jobsColState.filters).filter(([, set]) => set && set.size);
    if (!active.length) {
      bar.classList.add('hidden');
      return;
    }
    const labels = active.map(([key]) => {
      const def = JOBS_COLUMN_DEFS.find((c) => c.key === key);
      return def ? def.label : key;
    });
    text.textContent = `Column filters active: ${labels.join(', ')} (${active.length})`;
    bar.classList.remove('hidden');
  }

  function wireJobsTableHeaders(table, cols) {
    table.querySelectorAll('th[data-col]').forEach((th) => {
      const key = th.dataset.col;
      const col = cols.find((c) => c.key === key);
      if (!col) return;
      const sortEl = th.querySelector('[data-action="sort"]');
      if (sortEl) {
        sortEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (jobsColState.sortField === key) {
            jobsColState.sortDir = jobsColState.sortDir === 'asc' ? 'desc' : 'asc';
          } else {
            jobsColState.sortField = key;
            jobsColState.sortDir = 'asc';
          }
          saveJobsSort();
          jobsPageState.page = 1;
          renderJobsTable();
        });
      }
      const filterEl = th.querySelector('[data-action="filter"]');
      if (filterEl) {
        filterEl.addEventListener('click', (e) => {
          e.stopPropagation();
          openJobsColumnFilter(key, filterEl);
        });
      }
      if (!col.fixed) {
        columnUi.wireColumnDrag(th, {
          canDrag: (el) => el.dataset.col !== 'select',
          onReorder: (srcKey, targetKey, insertBefore) => {
            applyJobsColumnReorder(srcKey, targetKey, insertBefore);
          }
        });
      }
    });
    columnUi.enhanceResize(table);
  }

  function applyJobsColumnReorder(srcKey, targetKey, insertBefore) {
    if (srcKey === 'select' || targetKey === 'select') return;
    const visible = visibleJobsColumns().map((c) => c.key);
    const full = fullJobsColumnOrder();
    const hidden = full.filter((k) => !visible.includes(k));
    const order = visible.filter((k) => k !== 'select');
    const from = order.indexOf(srcKey);
    if (from < 0) return;
    order.splice(from, 1);
    let to = order.indexOf(targetKey);
    if (to < 0) return;
    if (!insertBefore) to++;
    order.splice(to, 0, srcKey);
    jobsColState.order = ['select', ...order].concat(hidden.filter((k) => k !== 'select'));
    saveJobsOrder();
    renderJobsTable();
  }

  function openJobsColumnFilter(key, anchor) {
    const col = JOBS_COLUMN_DEFS.find((c) => c.key === key);
    if (!col) return;
    const counts = new Map();
    if (key === 'fields') {
      for (const j of jobsDisplayItems) {
        for (const name of jobFieldNames(j)) {
          counts.set(name, (counts.get(name) || 0) + 1);
        }
      }
    } else {
      for (const j of jobsDisplayItems) {
        const label = jobFilterValue(j, key);
        const v = label === '' ? '' : String(label);
        counts.set(v, (counts.get(v) || 0) + 1);
      }
    }
    const values = [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([value, count]) => ({ value, count }));
    const current = jobsColState.filters[key] || new Set();
    colFilter.open(anchor, {
      label: col.label,
      values,
      selected: current,
      onApply: (next) => {
        if (next.size) jobsColState.filters[key] = next;
        else delete jobsColState.filters[key];
        saveJobsFilters();
        jobsPageState.page = 1;
        renderJobsTable();
      },
      onReset: () => {
        delete jobsColState.filters[key];
        saveJobsFilters();
        jobsPageState.page = 1;
        renderJobsTable();
      }
    });
  }

  function clearAllJobsColumnFilters() {
    jobsColState.filters = {};
    saveJobsFilters();
    jobsPageState.page = 1;
    renderJobsTable();
  }

  function buildJobsColSelectorList() {
    const list = $('#jobsColSelectorList');
    if (!list) return;
    const widths = (() => {
      try { return JSON.parse(localStorage.getItem('aps_jobs_col_widths') || '{}'); }
      catch { return {}; }
    })();
    list.innerHTML = fullJobsColumnOrder().map((key) => {
      const col = JOBS_COLUMN_DEFS.find((c) => c.key === key);
      if (!col || !col.label) return '';
      const checked = !jobsColState.hidden.has(key);
      const w = widths[key];
      const widthBadge = w ? `<span class="col-width">${Math.round(w)}px</span>` : '';
      if (col.nohide) {
        return `<div class="col-selector-item fixed-col"><input type="checkbox" checked disabled /><span class="col-selector-item-label">${esc(col.label)}</span>${widthBadge}</div>`;
      }
      return `<label class="col-selector-item"><input type="checkbox" data-col-key="${esc(key)}" ${checked ? 'checked' : ''} /><span class="col-selector-item-label">${esc(col.label)}</span>${widthBadge}</label>`;
    }).join('');
    list.querySelectorAll('input[data-col-key]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const k = cb.dataset.colKey;
        if (cb.checked) jobsColState.hidden.delete(k);
        else jobsColState.hidden.add(k);
        saveJobsHidden();
        renderJobsTable();
      });
    });
    const panel = $('#jobsColSelectorPanel');
    if (panel) columnUi.reapplyColSelectorSearch(panel);
  }

  let jobsColSelectorOpen = false;
  function openJobsColSelector() {
    const panel = $('#jobsColSelectorPanel');
    const overlay = $('#jobsColSelectorOverlay');
    const btn = $('#jobsColSelectorBtn');
    if (!panel || !overlay || !btn) return;
    buildJobsColSelectorList();
    panel.classList.add('open');
    overlay.classList.add('open');
    btn.classList.add('active');
    btn.setAttribute('aria-expanded', 'true');
    jobsColSelectorOpen = true;
    columnUi.initColSelectorSearch(panel);
  }
  function closeJobsColSelector() {
    const panel = $('#jobsColSelectorPanel');
    const overlay = $('#jobsColSelectorOverlay');
    const btn = $('#jobsColSelectorBtn');
    if (!panel) return;
    columnUi.clearColSelectorSearch(panel);
    panel.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
    if (btn) {
      btn.classList.remove('active');
      btn.setAttribute('aria-expanded', 'false');
    }
    jobsColSelectorOpen = false;
  }
  function toggleJobsColSelector() {
    if (jobsColSelectorOpen) closeJobsColSelector();
    else openJobsColSelector();
  }
  function resetJobsColumns() {
    jobsColState.hidden = new Set(['item_number', 'marketplace_code', 'label', 'requested_by']);
    jobsColState.order = [];
    jobsColState.sortField = 'created_at';
    jobsColState.sortDir = 'desc';
    jobsColState.filters = {};
    saveJobsHidden();
    saveJobsOrder();
    saveJobsSort();
    saveJobsFilters();
    jobsPageState.page = 1;
    const table = $('#jobsTable');
    if (table) columnUi.resetResize(table);
    renderJobsTable();
  }

  function renderJobsPagination({ total, start, shown, pageCount }) {
    const bar = $('#jobsPagination');
    if (!bar) return;
    if (!total) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const sizeSel = $('#jobsPageSize');
    if (sizeSel && Number(sizeSel.value) !== jobsPageState.pageSize) {
      sizeSel.value = String(jobsPageState.pageSize);
    }
    const info = $('#jobsPaginationInfo');
    if (info) {
      const from = total ? start + 1 : 0;
      const to = start + shown;
      const capNote = jobsPageState.fetchCapped
        ? ` <span class="pagination-cap" title="Showing the ${JOBS_MAX_ROWS.toLocaleString()} most recent jobs; older ones are not loaded.">(most recent ${JOBS_MAX_ROWS.toLocaleString()} loaded)</span>`
        : '';
      info.innerHTML = `Showing <strong>${from.toLocaleString()}–${to.toLocaleString()}</strong> of <strong>${total.toLocaleString()}</strong>${capNote}`;
    }
    const indicator = $('#jobsPageIndicator');
    if (indicator) indicator.textContent = `Page ${jobsPageState.page} of ${pageCount}`;
    const atFirst = jobsPageState.page <= 1;
    const atLast = jobsPageState.page >= pageCount;
    const first = $('#jobsPageFirst');
    const prev = $('#jobsPagePrev');
    const next = $('#jobsPageNext');
    const last = $('#jobsPageLast');
    if (first) first.disabled = atFirst;
    if (prev) prev.disabled = atFirst;
    if (next) next.disabled = atLast;
    if (last) last.disabled = atLast;
  }

  function goToJobsPage(page) {
    const next = Number(page);
    if (!Number.isFinite(next)) return;
    jobsPageState.page = Math.max(1, Math.round(next));
    renderJobsTable();
  }

  function renderJobsTable() {
    const table = $('#jobsTable');
    const thead = table && table.querySelector('thead tr');
    const tbody = table && table.querySelector('tbody');
    if (!table || !thead || !tbody) return;
    const cols = visibleJobsColumns();
    const colCount = cols.length;
    thead.innerHTML = buildJobsTableHeader(cols);
    const filtered = applyJobsFiltersAndSort(jobsDisplayItems);
    const total = filtered.length;
    const pageSize = jobsPageState.pageSize;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    if (jobsPageState.page > pageCount) jobsPageState.page = pageCount;
    if (jobsPageState.page < 1) jobsPageState.page = 1;
    const start = (jobsPageState.page - 1) * pageSize;
    const pageItems = filtered.slice(start, start + pageSize);
    const approvable = new Set(filtered.filter((j) => Number(j.pendingApprovalCount) > 0).map((j) => j.jobId));
    for (const id of [...selectedJobIds]) {
      if (!approvable.has(id)) selectedJobIds.delete(id);
    }
    if (!total) {
      const msg = jobsDisplayItems.length
        ? 'No rows match the current column filters.'
        : 'No rows.';
      tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align:center;color:var(--text-muted);padding:20px;">${msg}</td></tr>`;
    } else {
      tbody.innerHTML = pageItems.map((j) => {
        const jobId = j.jobId || '';
        return `<tr data-job-id="${esc(jobId)}">${cols.map((col) => renderJobsCell(j, col)).join('')}</tr>`;
      }).join('');
    }
    renderJobsColumnFiltersBar();
    renderJobsPagination({ total, start, shown: pageItems.length, pageCount });
    wireJobsTableHeaders(table, cols);
    if (jobsColSelectorOpen) buildJobsColSelectorList();
    syncJobSelectionControls();
  }

  async function loadJobs() {
    const tbody = $('#jobsTable tbody');
    const searchEl = $('#jobsSearch');
    const statusEl = $('#jobsSearchStatus');
    const exportLink = $('#jobsExportLink');
    const search = searchEl ? searchEl.value.trim() : '';
    const exportQs = new URLSearchParams({ token });
    if (search) exportQs.set('search', search);
    if (exportLink) {
      exportLink.href = `/admin/jobs/export?${exportQs.toString()}`;
      exportLink.classList.remove('disabled');
    }
    try {
      const jobs = [];
      let beforeId = null;
      let total = Infinity;
      for (let guard = 0; jobs.length < JOBS_MAX_ROWS && guard < 1000; guard++) {
        const params = new URLSearchParams();
        params.set('limit', String(JOBS_FETCH_LIMIT));
        if (search) params.set('search', search);
        if (beforeId != null) params.set('beforeId', String(beforeId));
        const data = await api('/admin/jobs?' + params.toString());
        const batch = Array.isArray(data.jobs) ? data.jobs : [];
        if (typeof data.total === 'number') total = data.total;
        jobs.push(...batch);
        if (!data.nextBeforeId || batch.length < JOBS_FETCH_LIMIT) break;
        beforeId = data.nextBeforeId;
      }
      jobsPageState.fetchCapped = Number.isFinite(total) && jobs.length < total;
      jobsDisplayItems = jobs;
      jobsPageState.page = 1;
      if (statusEl) {
        const filteredCount = applyJobsFiltersAndSort(jobs).length;
        if (search) {
          const loaded = jobs.length;
          if (!loaded) statusEl.textContent = 'No matches';
          else if (jobsPageState.fetchCapped) {
            statusEl.textContent = `${loaded.toLocaleString()} of ${total.toLocaleString()} matches loaded${filteredCount !== loaded ? ` (${filteredCount.toLocaleString()} after column filters)` : ''}`;
          } else {
            const suffix = filteredCount !== loaded ? ` (${filteredCount.toLocaleString()} after column filters)` : '';
            statusEl.textContent = `${loaded.toLocaleString()} match${loaded === 1 ? '' : 'es'}${suffix}`;
          }
        } else {
          statusEl.textContent = jobs.length
            ? `${filteredCount.toLocaleString()} job${filteredCount === 1 ? '' : 's'}${filteredCount !== jobs.length ? ` of ${jobs.length.toLocaleString()} loaded` : ''}`
            : '';
        }
      }
      if (exportLink) exportLink.classList.toggle('disabled', !jobs.length);
      renderJobsTable();
    } catch (e) {
      if (e.message !== '401') {
        const n = visibleJobsColCount() || JOBS_COL_KEYS.length;
        tbody.innerHTML = errRow(n, e);
        const bar = $('#jobsPagination');
        if (bar) bar.classList.add('hidden');
      }
      if (exportLink) exportLink.classList.add('disabled');
    }
  }

  function syncJobSelectionControls() {
    const boxes = Array.from(document.querySelectorAll('#jobsTable tbody input.job-select:not(:disabled)'));
    const selectedCount = [...selectedJobIds].length;
    const selectAll = $('#selectAllJobsRows');
    const approveBtn = $('#approveSelectedJobs');
    if (selectAll) {
      selectAll.disabled = jobBulkBusy || boxes.length === 0;
      selectAll.checked = boxes.length > 0 && boxes.every((cb) => cb.checked);
      selectAll.indeterminate = boxes.some((cb) => cb.checked) && !selectAll.checked;
    }
    if (approveBtn) {
      approveBtn.disabled = jobBulkBusy || selectedCount === 0;
      approveBtn.textContent = selectedCount ? `Approve selected (${selectedCount})` : 'Approve selected';
    }
    const status = $('#jobBulkStatus');
    if (status && !jobBulkBusy) status.textContent = selectedCount ? `${selectedCount} job${selectedCount === 1 ? '' : 's'} selected` : jobBulkMessage;
  }

  async function approveSelectedJobs() {
    if (jobBulkBusy) return;
    const jobIds = [...selectedJobIds];
    if (!jobIds.length) return;
    if (!confirm(`Approve pending submissions in ${jobIds.length} selected job(s)? They will be queued and pushed to Amazon one at a time.`)) return;
    const status = $('#jobBulkStatus');
    jobBulkBusy = true;
    syncJobSelectionControls();
    if (status) status.textContent = 'Queueing approvals...';
    try {
      const result = await apiPost('/admin/jobs/approve', { jobIds });
      selectedJobIds.clear();
      jobBulkMessage = `Queued ${result.approved || 0} approval${result.approved === 1 ? '' : 's'}; skipped ${result.skipped || 0}.`;
      if (status) {
        status.textContent = jobBulkMessage;
      }
      await loadJobs();
      loadQueue();
    } catch (err) {
      if (err.message === '401') return;
      jobBulkMessage = 'Approval failed: ' + err.message;
      if (status) status.textContent = jobBulkMessage;
      alert('Approve selected jobs failed: ' + err.message);
    } finally {
      jobBulkBusy = false;
      syncJobSelectionControls();
    }
  }

  async function loadAudit() {
    const tbody = $('#auditTable tbody');
    const sub = $('#auditSubmission').value.trim();
    const q = sub ? `?submissionUuid=${encodeURIComponent(sub)}` : '';
    $('#exportLink').href = `/audit/export?format=jsonl${sub ? '&submissionUuid=' + encodeURIComponent(sub) : ''}&token=${encodeURIComponent(token)}`;
    try {
      const verify = await api('/audit/verify');
      const badge = $('#chainBadge');
      badge.textContent = verify.ok ? `chain intact (${verify.checked})` : `chain BROKEN @${verify.brokenAtId}`;
      badge.className = 'badge ' + (verify.ok ? 'ok' : 'bad');
      const { events } = await api('/audit' + q);
      tbody.innerHTML = events.map((e) => `<tr>
        <td>${esc(e.at)}</td><td>${esc(e.event)}</td><td>${esc(e.actor || '')}</td>
        <td><code>${esc((e.submission_uuid || '').slice(0, 8))}</code></td>
        <td>${e.details ? `<details><summary>view</summary><pre>${esc(JSON.stringify(e.details, null, 2))}</pre></details>` : ''}</td>
        <td><code>${esc((e.hash || '').slice(0, 10))}</code></td></tr>`).join('') || emptyRow(6);
    } catch (e) { if (e.message !== '401') tbody.innerHTML = errRow(6, e); }
  }

  const emptyRow = (n) => `<tr><td colspan="${n}" style="text-align:center;color:var(--text-muted);padding:20px;">No rows.</td></tr>`;
  const errRow = (n, e) => {
    const msg = e.message === '401' ? 'Unauthorized'
      : e.message === '503' ? 'Reconnecting to ListingApp…'
      : esc(e.message);
    return `<tr><td colspan="${n}" style="text-align:center;color:var(--color-neg-text);padding:20px;">${msg}</td></tr>`;
  };

  // Distinct Amazon issue codes for one error record, in first-seen order.
  function errorCodes(rec) {
    const codes = [];
    (rec.errorDetails || []).forEach((d) => { if (d && d.code && !codes.includes(d.code)) codes.push(d.code); });
    return codes.join(', ');
  }

  // Errors tab state for the AI resolver: the latest fetched error records
  // (keyed by submission_uuid) and whether the resolver feature is enabled.
  const errorsByUuid = new Map();
  let resolverEnabled = false;

  // Small pill summarising a submission's AI-resolution state, if any.
  function aiBadge(rs) {
    if (!rs || !rs.status) return '';
    const tone = rs.status === 'APPLIED' ? 'ok' : rs.status === 'REJECTED' || rs.status === 'FAILED' ? 'bad' : 'warn';
    const conf = (rs.confidence != null) ? ` ${rs.confidence}%` : '';
    return `<span class="badge ${tone}" title="AI resolution: ${esc(rs.status)}">AI ${esc(rs.status)}${conf}</span>`;
  }

  function aiActionCell(r) {
    if (!resolverEnabled) return '<span class="muted-cell">—</span>';
    // Archived errors are excluded from AI assessment: show the state, not a
    // review action (unless a fix was already applied before archiving).
    if (r.archived && !(r.aiResolution && r.aiResolution.status === 'APPLIED')) {
      return '<span class="muted-cell" title="Archived — AI fixes are not assessed">Archived</span>';
    }
    const rs = r.aiResolution;
    const label = rs ? (rs.status === 'APPLIED' ? 'View fix' : 'Review fix') : 'Review &amp; fix (AI)';
    const badge = aiBadge(rs);
    return `<div class="ai-cell">
      <button class="btn-ghost ai-review-btn" data-uuid="${esc(r.submission_uuid)}" title="Review this error with AI">${label}</button>
      ${badge}
    </div>`;
  }

  // Archive toggle for one error. Archiving excludes the row from AI review
  // (single and "Review all"); the row stays visible, marked archived.
  function archiveCell(r) {
    const label = r.archived ? 'Unarchive' : 'Archive';
    const title = r.archived
      ? `Archived${r.archived_by ? ' by ' + r.archived_by : ''} — click to re-enable AI fixes`
      : 'Archive this error so no AI fixes are assessed';
    return `<button class="btn-ghost ai-archive-btn" data-uuid="${esc(r.submission_uuid)}" data-archived="${r.archived ? '1' : '0'}" title="${esc(title)}">${label}</button>`;
  }

  // ── Errors table columns (sort / filter — Battat funnel pattern) ─────────
  // Sort + per-value column filters, persisted to localStorage, applied
  // client-side over the full error set before rendering. The select / details
  // / AI fix / archive columns are fixed action columns (not sortable/filterable).
  const ERROR_COLUMN_DEFS = [
    { key: 'select', label: '', fixed: true, sortable: false, filterable: false },
    { key: 'created_at', label: 'Created', sortable: true, filterable: true },
    { key: 'status', label: 'Status', sortable: true, filterable: true },
    { key: 'asin', label: 'ASIN', sortable: true, filterable: true },
    { key: 'sku', label: 'SKU', sortable: true, filterable: true },
    { key: 'marketplace_code', label: 'Mkt', sortable: true, filterable: true },
    { key: 'codes', label: 'Codes', sortable: true, filterable: true },
    { key: 'message', label: 'Message', sortable: true, filterable: true },
    { key: 'message_en', label: 'English', sortable: true, filterable: true },
    { key: 'details', label: 'Details', fixed: true, sortable: false, filterable: false },
    { key: 'retry', label: 'Retry', fixed: true, sortable: false, filterable: false },
    { key: 'aifix', label: 'AI fix', fixed: true, sortable: false, filterable: false },
    { key: 'archive', label: 'Archive', fixed: true, sortable: false, filterable: false }
  ];
  const ERROR_COL_KEYS = ERROR_COLUMN_DEFS.map((c) => c.key);
  const ERROR_STORAGE = { sort: 'aps_errors_sort', filters: 'aps_errors_col_filters' };
  const errorColState = { sortField: 'created_at', sortDir: 'desc', filters: {} };
  let errorRecords = [];
  let errorsView = 'active';
  const ERROR_VIEW_STORAGE = 'aps_errors_view';
  const ERROR_PAGE_SIZES = [50, 100, 200, 500, 1000];
  const ERROR_PAGE_STORAGE = 'aps_errors_page_size';
  const errorPageState = { page: 1, pageSize: 200 };

  function loadErrorsView() {
    try {
      const v = localStorage.getItem(ERROR_VIEW_STORAGE);
      if (v === 'archived' || v === 'active') errorsView = v;
    } catch (_) { /* default active */ }
  }
  function loadErrorPageSize() {
    try {
      const saved = Number(localStorage.getItem(ERROR_PAGE_STORAGE));
      if (ERROR_PAGE_SIZES.includes(saved)) errorPageState.pageSize = saved;
    } catch (_) { /* default */ }
  }
  function saveErrorPageSize() {
    try { localStorage.setItem(ERROR_PAGE_STORAGE, String(errorPageState.pageSize)); } catch (_) {}
  }
  function errorsForCurrentView() {
    const wantArchived = errorsView === 'archived';
    return errorRecords.filter((r) => (wantArchived ? !!r.archived : !r.archived));
  }
  function errorViewCounts() {
    let active = 0; let archived = 0;
    for (const r of errorRecords) {
      if (r.archived) archived++; else active++;
    }
    return { active, archived };
  }

  function updateErrorsCountLabel() {
    const { active, archived } = errorViewCounts();
    const countEl = $('#errorsCount');
    if (!countEl) return;
    const n = errorsView === 'archived' ? archived : active;
    const label = errorsView === 'archived' ? 'archived error' : 'active error';
    countEl.textContent = n
      ? `${n} ${label}${n === 1 ? '' : 's'}`
      : (errorsView === 'archived' ? 'No archived errors' : 'No active errors');
  }

  function loadErrorColState() {
    try {
      const sort = JSON.parse(localStorage.getItem(ERROR_STORAGE.sort) || '{}');
      if (sort.field && ERROR_COL_KEYS.includes(sort.field)) {
        errorColState.sortField = sort.field;
        errorColState.sortDir = sort.dir === 'asc' ? 'asc' : 'desc';
      }
    } catch (_) { /* defaults */ }
    try {
      const filters = JSON.parse(localStorage.getItem(ERROR_STORAGE.filters) || '{}');
      errorColState.filters = {};
      for (const [k, vals] of Object.entries(filters)) {
        if (ERROR_COL_KEYS.includes(k) && Array.isArray(vals) && vals.length) {
          errorColState.filters[k] = new Set(vals.map(String));
        }
      }
    } catch (_) { errorColState.filters = {}; }
  }
  function saveErrorSort() {
    try { localStorage.setItem(ERROR_STORAGE.sort, JSON.stringify({ field: errorColState.sortField, dir: errorColState.sortDir })); } catch (_) {}
  }
  function saveErrorFilters() {
    const out = {};
    for (const [k, set] of Object.entries(errorColState.filters)) if (set && set.size) out[k] = [...set];
    try { localStorage.setItem(ERROR_STORAGE.filters, JSON.stringify(out)); } catch (_) {}
  }

  // Canonical value used for both filtering (exact match) and grouping.
  function errorFilterValue(r, key) {
    switch (key) {
      case 'created_at': return r.created_at || '';
      case 'codes': return errorCodes(r);
      case 'message': {
        const details = Array.isArray(r.errorDetails) ? r.errorDetails : [];
        return r.error_message || (details[0] ? formatErrorDetail(details[0]) : '');
      }
      case 'message_en': {
        if (r.error_message_en) return r.error_message_en;
        const detailsEn = Array.isArray(r.errorDetailsEn) ? r.errorDetailsEn : [];
        return detailsEn[0] || errorFilterValue(r, 'message');
      }
      default: return r[key] == null ? '' : String(r[key]);
    }
  }
  function errorSortValue(r, key) {
    const raw = errorFilterValue(r, key);
    if (key === 'created_at') return raw; // ISO-ish strings sort lexically
    return String(raw).toLowerCase();
  }
  function applyErrorFiltersAndSort(records) {
    let rows = records.slice();
    for (const [key, allowed] of Object.entries(errorColState.filters)) {
      if (!allowed || !allowed.size) continue;
      rows = rows.filter((r) => allowed.has(errorFilterValue(r, key)));
    }
    const field = errorColState.sortField;
    const dir = errorColState.sortDir === 'asc' ? 1 : -1;
    if (field && ERROR_COL_KEYS.includes(field)) {
      rows.sort((a, b) => {
        const av = errorSortValue(a, field);
        const bv = errorSortValue(b, field);
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }
    return rows;
  }

  function buildErrorsTableHeader() {
    return ERROR_COLUMN_DEFS.map((col) => {
      if (col.key === 'select') {
        return '<th class="select-cell no-resize" data-col="select"><input id="selectAllErrors" type="checkbox" aria-label="Select all visible errors" /></th>';
      }
      const sortActive = errorColState.sortField === col.key;
      const filterSet = errorColState.filters[col.key];
      const filterActive = !!(filterSet && filterSet.size);
      const extraCls = [col.sortable ? 'sortable-header' : '', sortActive ? 'sort-active' : ''].filter(Boolean).join(' ');
      const inner = (col.sortable || col.filterable)
        ? colFilter.headerCell({
          label: col.label,
          sortable: col.sortable,
          filterable: col.filterable,
          sortActive,
          sortDir: errorColState.sortDir,
          filterActive,
          filterCount: filterActive ? filterSet.size : 0
        })
        : esc(col.label);
      return `<th class="${extraCls}" data-col="${esc(col.key)}">${inner}</th>`;
    }).join('');
  }

  function renderErrorCell(r, col) {
    switch (col.key) {
      case 'select': {
        const checked = selectedErrorUuids.has(r.submission_uuid) ? 'checked' : '';
        return `<td class="select-cell"><input class="error-select" type="checkbox" data-uuid="${esc(r.submission_uuid)}" ${checked} aria-label="Select error ${esc(r.submission_uuid.slice(0, 8))}" /></td>`;
      }
      case 'created_at': return `<td>${esc(r.created_at || '')}</td>`;
      case 'status': return `<td>${statusBadge(r.status)}</td>`;
      case 'asin': return `<td>${esc(r.asin || '')}</td>`;
      case 'sku': return `<td>${esc(r.sku || '')}</td>`;
      case 'marketplace_code': return `<td>${esc(r.marketplace_code || '')}</td>`;
      case 'codes': return `<td>${esc(errorCodes(r))}</td>`;
      case 'message': {
        const details = Array.isArray(r.errorDetails) ? r.errorDetails : [];
        const msg = r.error_message || (details[0] ? formatErrorDetail(details[0]) : '');
        return `<td>${esc(msg)}</td>`;
      }
      case 'message_en': {
        const english = errorFilterValue(r, 'message_en');
        const original = errorFilterValue(r, 'message');
        const same = english === original;
        const cls = same ? ' class="muted-cell"' : '';
        const title = same ? ' title="Already in English"' : '';
        return `<td${cls}${title}>${esc(english)}</td>`;
      }
      case 'details': {
        const details = Array.isArray(r.errorDetails) ? r.errorDetails : [];
        const issueLines = details.map(formatErrorDetail).filter(Boolean).join('\n');
        let raw = '';
        if (r.rawResponse) {
          try { raw = JSON.stringify(JSON.parse(r.rawResponse), null, 2); } catch (_) { raw = r.rawResponse; }
        }
        const detailText = [issueLines, raw ? '--- Raw Amazon response ---\n' + raw : ''].filter(Boolean).join('\n\n');
        return `<td>${detailText ? `<details><summary>view</summary><pre>${esc(detailText)}</pre></details>` : ''}</td>`;
      }
      case 'aifix': return `<td>${aiActionCell(r)}</td>`;
      case 'retry': {
        const retryable = r.status === 'FAILED' || r.status === 'BLOCKED';
        if (!retryable) return '<td></td>';
        return `<td><button class="btn-ghost error-retry-btn" data-uuid="${esc(r.submission_uuid)}" title="Re-submit the same package to Amazon">Retry</button></td>`;
      }
      case 'archive': return `<td>${archiveCell(r)}</td>`;
      default: return '<td></td>';
    }
  }

  function wireErrorsTableHeaders(table) {
    table.querySelectorAll('th[data-col]').forEach((th) => {
      const key = th.dataset.col;
      const col = ERROR_COLUMN_DEFS.find((c) => c.key === key);
      if (!col) return;
      const sortEl = th.querySelector('[data-action="sort"]');
      if (sortEl) {
        sortEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (errorColState.sortField === key) {
            errorColState.sortDir = errorColState.sortDir === 'asc' ? 'desc' : 'asc';
          } else {
            errorColState.sortField = key;
            errorColState.sortDir = 'asc';
          }
          saveErrorSort();
          errorPageState.page = 1;
          renderErrorsTable();
        });
      }
      const filterEl = th.querySelector('[data-action="filter"]');
      if (filterEl) {
        filterEl.addEventListener('click', (e) => {
          e.stopPropagation();
          openErrorColumnFilter(key, filterEl);
        });
      }
    });
  }

  function openErrorColumnFilter(key, anchor) {
    const col = ERROR_COLUMN_DEFS.find((c) => c.key === key);
    if (!col) return;
    const counts = new Map();
    for (const r of errorsForCurrentView()) {
      const v = String(errorFilterValue(r, key));
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    const values = [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([value, count]) => ({ value, count }));
    const current = errorColState.filters[key] || new Set();
    colFilter.open(anchor, {
      label: col.label,
      values,
      selected: current,
      onApply: (next) => {
        if (next.size) errorColState.filters[key] = next;
        else delete errorColState.filters[key];
        saveErrorFilters();
        errorPageState.page = 1;
        renderErrorsTable();
      },
      onReset: () => {
        delete errorColState.filters[key];
        saveErrorFilters();
        errorPageState.page = 1;
        renderErrorsTable();
      }
    });
  }

  function clearAllErrorColumnFilters() {
    errorColState.filters = {};
    saveErrorFilters();
    errorPageState.page = 1;
    renderErrorsTable();
  }

  function renderErrorsColumnFiltersBar(shown, total, viewTotal) {
    const bar = $('#errorsColumnFiltersBar');
    const text = $('#errorsColumnFiltersBarText');
    if (!bar || !text) return;
    const active = Object.entries(errorColState.filters).filter(([, set]) => set && set.size);
    if (!active.length) { bar.classList.add('hidden'); return; }
    const labels = active.map(([key]) => {
      const def = ERROR_COLUMN_DEFS.find((c) => c.key === key);
      return def ? def.label : key;
    });
    const viewLabel = errorsView === 'archived' ? 'archived' : 'active';
    text.textContent = `Column filters active: ${labels.join(', ')} — showing ${shown} of ${total} ${viewLabel} (${viewTotal} total)`;
    bar.classList.remove('hidden');
  }

  function renderErrorsPagination({ total, start, shown, pageCount }) {
    const bar = $('#errorsPagination');
    if (!bar) return;
    if (!total) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const sizeSel = $('#errorsPageSize');
    if (sizeSel && Number(sizeSel.value) !== errorPageState.pageSize) {
      sizeSel.value = String(errorPageState.pageSize);
    }
    const info = $('#errorsPaginationInfo');
    if (info) {
      const from = total ? start + 1 : 0;
      const to = start + shown;
      info.innerHTML = `Showing <strong>${from.toLocaleString()}–${to.toLocaleString()}</strong> of <strong>${total.toLocaleString()}</strong>`;
    }
    const indicator = $('#errorsPageIndicator');
    if (indicator) indicator.textContent = `Page ${errorPageState.page} of ${pageCount}`;
    const atFirst = errorPageState.page <= 1;
    const atLast = errorPageState.page >= pageCount;
    const first = $('#errorsPageFirst');
    const prev = $('#errorsPagePrev');
    const next = $('#errorsPageNext');
    const last = $('#errorsPageLast');
    if (first) first.disabled = atFirst;
    if (prev) prev.disabled = atFirst;
    if (next) next.disabled = atLast;
    if (last) last.disabled = atLast;
  }

  function goToErrorsPage(page) {
    const next = Number(page);
    if (!Number.isFinite(next)) return;
    errorPageState.page = Math.max(1, Math.round(next));
    renderErrorsTable();
  }

  function syncErrorsSubtabs() {
    const { active, archived } = errorViewCounts();
    document.querySelectorAll('#errorsSubtabs .view-subtab').forEach((btn) => {
      const view = btn.dataset.errorsView;
      btn.classList.toggle('active', view === errorsView);
      if (view === 'active') btn.textContent = `Active (${active})`;
      else if (view === 'archived') btn.textContent = `Archived (${archived})`;
    });
  }

  function syncErrorsToolbarForView() {
    const isArchived = errorsView === 'archived';
    const archiveBtn = $('#archiveSelectedErrors');
    const unarchiveBtn = $('#unarchiveSelectedErrors');
    const reviewBtn = $('#reviewSelectedErrors');
    const reviewAllBtn = $('#reviewAllErrors');
    if (archiveBtn) archiveBtn.hidden = isArchived;
    if (unarchiveBtn) unarchiveBtn.hidden = !isArchived;
    if (reviewBtn) reviewBtn.hidden = !resolverEnabled || isArchived;
    if (reviewAllBtn) reviewAllBtn.hidden = !resolverEnabled || isArchived;
  }

  function setErrorsView(view) {
    if (view !== 'active' && view !== 'archived') return;
    if (errorsView === view) return;
    errorsView = view;
    try { localStorage.setItem(ERROR_VIEW_STORAGE, view); } catch (_) {}
    selectedErrorUuids.clear();
    errorBulkMessage = '';
    errorPageState.page = 1;
    updateErrorsCountLabel();
    syncErrorsSubtabs();
    syncErrorsToolbarForView();
    renderErrorsTable();
  }

  // Render the errors table from the in-memory record set (no refetch). Filter
  // and sort run over the full active/archived view set client-side; only the
  // slice for the current page is rendered.
  function renderErrorsTable() {
    const table = $('#errorsTable');
    const thead = table && table.querySelector('thead tr');
    const tbody = table && table.querySelector('tbody');
    if (!table || !thead || !tbody) return;
    thead.innerHTML = buildErrorsTableHeader();
    wireErrorsTableHeaders(table);
    const viewRecords = errorsForCurrentView();
    const filtered = applyErrorFiltersAndSort(viewRecords);
    const total = filtered.length;
    const pageSize = errorPageState.pageSize;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    if (errorPageState.page > pageCount) errorPageState.page = pageCount;
    if (errorPageState.page < 1) errorPageState.page = 1;
    const start = (errorPageState.page - 1) * pageSize;
    const pageRows = filtered.slice(start, start + pageSize);
    const colCount = ERROR_COLUMN_DEFS.length;
    if (!total) {
      const msg = viewRecords.length
        ? 'No rows match the current column filters.'
        : (errorsView === 'archived' ? 'No archived errors.' : 'No active errors.');
      tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align:center;color:var(--text-muted);padding:20px;">${msg}</td></tr>`;
    } else {
      tbody.innerHTML = pageRows.map((r) =>
        `<tr data-uuid="${esc(r.submission_uuid)}">${ERROR_COLUMN_DEFS.map((col) => renderErrorCell(r, col)).join('')}</tr>`
      ).join('');
    }
    renderErrorsColumnFiltersBar(pageRows.length, total, viewRecords.length);
    renderErrorsPagination({ total, start, shown: pageRows.length, pageCount });
    syncErrorsSubtabs();
    syncErrorSelectionControls();
  }

  async function loadErrors() {
    const link = $('#errorsExportLink');
    if (link) link.href = `/admin/errors/export?token=${encodeURIComponent(token)}`;
    try {
      const resp = await api('/admin/errors');
      const { count, errors } = resp;
      resolverEnabled = !!resp.resolverEnabled;
      const reviewAllBtn = $('#reviewAllErrors');
      if (reviewAllBtn) reviewAllBtn.hidden = !resolverEnabled;
      errorRecords = Array.isArray(errors) ? errors : [];
      errorsByUuid.clear();
      errorRecords.forEach((r) => errorsByUuid.set(r.submission_uuid, r));
      updateErrorsCountLabel();
      if (link) link.classList.toggle('disabled', !count);
      errorPageState.page = 1;
      syncErrorsSubtabs();
      syncErrorsToolbarForView();
      renderErrorsTable();
    } catch (e) {
      if (e.message === '401') return;
      const tbody = $('#errorsTable tbody');
      if (tbody) tbody.innerHTML = errRow(ERROR_COLUMN_DEFS.length, e);
    }
  }

  // Reflect the current error selection on the toolbar controls. Archive and
  // Review act on the *active* (un-archived) subset of the selection; Unarchive
  // acts on the archived subset — so a mixed selection enables the right
  // buttons. Prunes selections whose rows are no longer present.
  function syncErrorSelectionControls() {
    const boxes = Array.from(document.querySelectorAll('#errorsTable tbody input.error-select'));
    const present = new Set(boxes.map((b) => b.dataset.uuid));
    const viewUuids = new Set(errorsForCurrentView().map((r) => r.submission_uuid));
    for (const u of [...selectedErrorUuids]) {
      if (!present.has(u) || !viewUuids.has(u)) selectedErrorUuids.delete(u);
    }

    let selArchived = 0; let selActive = 0;
    for (const u of selectedErrorUuids) {
      const rec = errorsByUuid.get(u);
      if (rec && rec.archived) selArchived++; else selActive++;
    }
    const selectedCount = selectedErrorUuids.size;

    const selectAll = $('#selectAllErrors');
    if (selectAll) {
      selectAll.disabled = errorBulkBusy || boxes.length === 0;
      selectAll.checked = boxes.length > 0 && boxes.every((cb) => selectedErrorUuids.has(cb.dataset.uuid));
      selectAll.indeterminate = selectedCount > 0 && !selectAll.checked;
    }
    const archiveBtn = $('#archiveSelectedErrors');
    if (archiveBtn) {
      archiveBtn.disabled = errorBulkBusy || selActive === 0;
      archiveBtn.textContent = selActive ? `Archive selected (${selActive})` : 'Archive selected';
    }
    const unarchiveBtn = $('#unarchiveSelectedErrors');
    if (unarchiveBtn) {
      unarchiveBtn.disabled = errorBulkBusy || selArchived === 0;
      unarchiveBtn.textContent = selArchived ? `Unarchive selected (${selArchived})` : 'Unarchive selected';
    }
    const reviewBtn = $('#reviewSelectedErrors');
    if (reviewBtn) {
      reviewBtn.hidden = !resolverEnabled;
      reviewBtn.disabled = errorBulkBusy || selActive === 0;
      reviewBtn.textContent = selActive ? `Review selected (${selActive})` : 'Review selected (AI)';
    }
    const retryBtn = $('#retrySelectedErrors');
    if (retryBtn) {
      let selRetryable = 0;
      for (const u of selectedErrorUuids) {
        const rec = errorsByUuid.get(u);
        if (rec && (rec.status === 'FAILED' || rec.status === 'BLOCKED')) selRetryable++;
      }
      retryBtn.disabled = errorBulkBusy || selRetryable === 0;
      retryBtn.textContent = selRetryable ? `Retry selected (${selRetryable})` : 'Retry selected';
    }
    const status = $('#errorsBulkStatus');
    if (status && !errorBulkBusy) status.textContent = selectedCount ? `${selectedCount} selected` : errorBulkMessage;
  }

  // ── AI error-resolution modal ────────────────────────────────────────────
  let aiModalUuid = null;
  let aiModalResolution = null;

  const aiOverlay = $('#aiModalOverlay');
  const aiBody = $('#aiModalBody');
  const aiStatusEl = $('#aiModalStatus');
  const aiSubtitle = $('#aiModalSubtitle');
  const aiApplyBtn = $('#aiApplyBtn');
  const aiRejectBtn = $('#aiRejectBtn');
  const aiRerunBtn = $('#aiRerunBtn');

  function setAiStatus(text, tone) {
    if (!aiStatusEl) return;
    aiStatusEl.textContent = text || '';
    aiStatusEl.style.color = tone === 'bad' ? 'var(--color-neg-text)' : tone === 'ok' ? 'var(--color-pos-text)' : '';
  }
  function setAiButtonsDisabled(disabled) {
    [aiApplyBtn, aiRejectBtn, aiRerunBtn].forEach((b) => { if (b) b.disabled = disabled; });
  }

  function openAiModal(uuid) {
    aiModalUuid = uuid;
    aiModalResolution = null;
    const rec = errorsByUuid.get(uuid);
    if (aiSubtitle) {
      aiSubtitle.textContent = rec
        ? `${rec.asin || ''} · ${rec.sku || ''} · ${rec.marketplace_code || ''} · ${rec.product_type || ''}`
        : uuid;
    }
    if (aiBody) aiBody.innerHTML = '<div class="ai-loading">Reviewing the error with the model… this can take several seconds.</div>';
    setAiStatus('');
    setAiButtonsDisabled(true);
    if (aiOverlay) aiOverlay.hidden = false;
    // Use the cached resolution if present (status badge implies one exists),
    // otherwise kick off a fresh review.
    const hasCached = rec && rec.aiResolution;
    runReview(uuid, false, !hasCached);
  }

  function closeAiModal() {
    if (aiOverlay) aiOverlay.hidden = true;
    aiModalUuid = null;
    aiModalResolution = null;
  }

  async function runReview(uuid, force, postIfMissing) {
    setAiButtonsDisabled(true);
    setAiStatus(force ? 'Re-running model…' : 'Loading review…');
    try {
      let resolution = null;
      if (!force && !postIfMissing) {
        // Try the cached resolution first (no model call).
        try {
          const got = await api(`/admin/errors/${encodeURIComponent(uuid)}/review`);
          resolution = got.resolution;
        } catch (_) { /* fall through to POST */ }
      }
      if (!resolution) {
        const out = await apiPost(`/admin/errors/${encodeURIComponent(uuid)}/review${force ? '?force=1' : ''}`);
        resolution = out.resolution;
      }
      aiModalResolution = resolution;
      renderResolution(resolution);
      setAiStatus('');
    } catch (err) {
      if (err.message === '401') return;
      if (aiBody) aiBody.innerHTML = `<div class="ai-error">Review failed: ${esc(err.message)}</div>`;
      setAiStatus(err.message, 'bad');
      // Re-run stays enabled so the operator can retry.
      if (aiRerunBtn) aiRerunBtn.disabled = false;
    }
  }

  function listBlock(title, items, tone) {
    if (!items || !items.length) return '';
    const lis = items.map((x) => `<li>${esc(typeof x === 'string' ? x : (x.field ? `${x.field}: ${x.reason || ''}` : JSON.stringify(x)))}</li>`).join('');
    return `<div class="ai-section ${tone || ''}"><h4>${esc(title)}</h4><ul>${lis}</ul></div>`;
  }

  function renderResolution(r) {
    if (!r) { if (aiBody) aiBody.innerHTML = '<div class="ai-error">No resolution returned.</div>'; return; }
    const applied = r.status === 'APPLIED';
    const pkgJson = r.proposedPackage ? JSON.stringify(r.proposedPackage, null, 2) : '';
    const validationProblems = (r.validation && !r.validation.ok) ? (r.validation.problems || []) : [];
    const confTxt = (r.confidence != null) ? `${r.confidence}%` : '—';
    const head = `<div class="ai-meta">
        <span class="badge ${applied ? 'ok' : r.status === 'REJECTED' || r.status === 'FAILED' ? 'bad' : 'warn'}">${esc(r.status)}</span>
        <span class="ai-meta-item">Confidence: <strong>${esc(confTxt)}</strong></span>
        <span class="ai-meta-item">Operation: <code>${esc(r.operation || '')}</code></span>
        <span class="ai-meta-item">Model: <code>${esc(r.model || '')}</code></span>
        ${r.appliedSubmissionUuid ? `<span class="ai-meta-item">Pushed as <code>${esc(String(r.appliedSubmissionUuid).slice(0, 8))}</code></span>` : ''}
      </div>`;
    const diag = `<div class="ai-section"><h4>Diagnosis</h4><p>${esc(r.diagnosis || '—')}</p></div>`;
    const root = r.root_cause ? `<div class="ai-section"><h4>Root cause</h4><p>${esc(r.root_cause)}</p></div>` : '';
    const changed = (r.changedAttrNames && r.changedAttrNames.length)
      ? `<div class="ai-section"><h4>Attributes changed</h4><p>${r.changedAttrNames.map((n) => `<code>${esc(n)}</code>`).join(' ')}</p></div>`
      : '';
    const valueSources = (r.valueSources && typeof r.valueSources === 'object' && Object.keys(r.valueSources).length)
      ? `<div class="ai-section"><h4>Value sources (where each value came from)</h4><ul>${Object.entries(r.valueSources).map(([attr, src]) => `<li><code>${esc(attr)}</code> &larr; ${esc(String(src))}</li>`).join('')}</ul></div>`
      : '';
    const unresolved = listBlock('Unresolved (needs data the model could not source)', r.unresolved, 'warn');
    const warnings = listBlock('Warnings', r.warnings, 'warn');
    const valBlock = validationProblems.length ? listBlock('Validation problems (must be fixed before push)', validationProblems, 'bad') : '';
    const editorNote = applied
      ? '<p class="ai-hint">This fix has already been pushed. The package is read-only.</p>'
      : '<p class="ai-hint">Review and edit the corrected package below if needed, then Approve &amp; push. It will be validated against the live product type schema before being sent.</p>';
    const editor = `<div class="ai-section">
        <h4>Proposed package (${esc(r.operation || '')})</h4>
        ${editorNote}
        <textarea id="aiPackageEditor" class="ai-editor" spellcheck="false" ${applied ? 'readonly' : ''}>${esc(pkgJson)}</textarea>
      </div>`;
    if (aiBody) aiBody.innerHTML = head + diag + root + changed + valueSources + unresolved + warnings + valBlock + editor;

    // Button states.
    if (aiApplyBtn) {
      aiApplyBtn.disabled = applied || !pkgJson;
      aiApplyBtn.textContent = applied ? 'Pushed' : 'Approve & push';
    }
    if (aiRejectBtn) aiRejectBtn.disabled = applied || r.status === 'REJECTED';
    if (aiRerunBtn) aiRerunBtn.disabled = applied;
  }

  async function applyAiFix() {
    if (!aiModalUuid || !aiModalResolution) return;
    const editor = $('#aiPackageEditor');
    if (!editor) return;
    let pkg;
    try { pkg = JSON.parse(editor.value); }
    catch (err) { alert('The package is not valid JSON: ' + err.message); return; }
    if (!confirm('Approve and push this corrected package to Amazon? It will be validated and sent as a new submission.')) return;
    setAiButtonsDisabled(true);
    setAiStatus('Validating and pushing…');
    try {
      const out = await apiPost(`/admin/errors/${encodeURIComponent(aiModalUuid)}/apply`, {
        package: pkg,
        operation: aiModalResolution.operation
      });
      setAiStatus(`Pushed as ${String(out.submissionId).slice(0, 8)} — status ${out.status}`, out.status === 'APPLIED' ? 'ok' : 'bad');
      await loadErrors();
      loadQueue();
      // Reflect the applied state in the modal.
      const refreshed = errorsByUuid.get(aiModalUuid);
      if (refreshed && refreshed.aiResolution) {
        aiModalResolution.status = 'APPLIED';
        aiModalResolution.appliedSubmissionUuid = out.submissionId;
        renderResolution(aiModalResolution);
      }
    } catch (err) {
      if (err.message === '401') return;
      setAiStatus('Push failed: ' + err.message, 'bad');
      setAiButtonsDisabled(false);
      alert('Approve & push failed: ' + err.message);
    }
  }

  async function rejectAiFix() {
    if (!aiModalUuid) return;
    if (!confirm('Reject this proposed fix? It will be discarded (nothing is sent to Amazon).')) return;
    setAiButtonsDisabled(true);
    setAiStatus('Rejecting…');
    try {
      await apiPost(`/admin/errors/${encodeURIComponent(aiModalUuid)}/reject`);
      setAiStatus('Rejected.', 'ok');
      await loadErrors();
      closeAiModal();
    } catch (err) {
      if (err.message === '401') return;
      setAiStatus('Reject failed: ' + err.message, 'bad');
      setAiButtonsDisabled(false);
    }
  }

  async function reviewAllErrors() {
    const btn = $('#reviewAllErrors');
    const statusEl = $('#errorsReviewStatus');
    if (!confirm('Run the AI review on all un-reviewed failed submissions? This calls the model once per submission.')) return;
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Reviewing…';
    try {
      const out = await apiPost('/admin/errors/review-batch', { limit: 25 });
      if (statusEl) statusEl.textContent = `Reviewed ${out.reviewed}, skipped ${out.skipped}, failed ${out.failed} of ${out.totalFailed}.`;
      await loadErrors();
    } catch (err) {
      if (err.message === '401') return;
      if (statusEl) statusEl.textContent = 'Batch review failed: ' + err.message;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function toggleArchiveError(uuid, archived) {
    try {
      await apiPost(`/admin/errors/${encodeURIComponent(uuid)}/archive`, { archived });
      await loadErrors();
    } catch (err) {
      if (err.message === '401') return;
      alert('Could not update archive state: ' + err.message);
    }
  }

  // Bulk archive (archived=true) or un-archive (archived=false) the relevant
  // subset of the current selection.
  async function bulkArchiveErrors(archived) {
    if (errorBulkBusy) return;
    const uuids = [...selectedErrorUuids].filter((u) => {
      const rec = errorsByUuid.get(u);
      return rec && (archived ? !rec.archived : rec.archived);
    });
    if (!uuids.length) return;
    const verb = archived ? 'Archive' : 'Unarchive';
    if (!confirm(`${verb} ${uuids.length} selected error${uuids.length === 1 ? '' : 's'}?${archived ? ' Archived errors are skipped by the AI resolver.' : ''}`)) return;
    errorBulkBusy = true;
    syncErrorSelectionControls();
    const status = $('#errorsBulkStatus');
    if (status) status.textContent = 'Working…';
    try {
      const out = await apiPost('/admin/errors/archive-batch', { uuids, archived });
      selectedErrorUuids.clear();
      errorBulkMessage = `${archived ? 'Archived' : 'Unarchived'} ${out.changed}${out.missing ? `, ${out.missing} missing` : ''}.`;
      await loadErrors();
      if (status) status.textContent = errorBulkMessage;
    } catch (err) {
      if (err.message === '401') return;
      errorBulkMessage = `${verb} failed: ` + err.message;
      if (status) status.textContent = errorBulkMessage;
      alert(`${verb} selected failed: ` + err.message);
    } finally {
      errorBulkBusy = false;
      syncErrorSelectionControls();
    }
  }

  async function retryOneError(uuid) {
    if (errorBulkBusy) return;
    const rec = errorsByUuid.get(uuid);
    if (!rec || (rec.status !== 'FAILED' && rec.status !== 'BLOCKED')) return;
    const label = [rec.asin, rec.sku, rec.marketplace_code].filter(Boolean).join(' · ');
    if (!confirm(`Re-submit this package to Amazon?${label ? '\n\n' + label : ''}`)) return;
    errorBulkBusy = true;
    syncErrorSelectionControls();
    const status = $('#errorsBulkStatus');
    if (status) status.textContent = 'Retrying…';
    try {
      const out = await apiPost(`/admin/errors/${encodeURIComponent(uuid)}/retry`);
      errorBulkMessage = `Retry → ${out.status}${out.errorMessage ? ': ' + out.errorMessage : ''}`;
      await loadErrors();
    } catch (err) {
      errorBulkMessage = 'Retry failed: ' + err.message;
      if (status) status.textContent = errorBulkMessage;
    } finally {
      errorBulkBusy = false;
      syncErrorSelectionControls();
    }
  }

  async function retrySelectedErrors() {
    if (errorBulkBusy) return;
    const uuids = [...selectedErrorUuids].filter((u) => {
      const rec = errorsByUuid.get(u);
      return rec && (rec.status === 'FAILED' || rec.status === 'BLOCKED');
    });
    if (!uuids.length) return;
    if (!confirm(`Re-submit ${uuids.length} package${uuids.length === 1 ? '' : 's'} to Amazon with the same payload?`)) return;
    errorBulkBusy = true;
    syncErrorSelectionControls();
    const status = $('#errorsBulkStatus');
    if (status) status.textContent = `Retrying ${uuids.length}…`;
    try {
      const out = await apiPost('/admin/errors/retry-batch', { uuids });
      errorBulkMessage = `Retried ${out.retried}, skipped ${out.skipped}${out.failed ? `, ${out.failed} failed` : ''}${out.missing ? `, ${out.missing} missing` : ''}.`;
      await loadErrors();
    } catch (err) {
      errorBulkMessage = 'Bulk retry failed: ' + err.message;
      if (status) status.textContent = errorBulkMessage;
    } finally {
      errorBulkBusy = false;
      syncErrorSelectionControls();
    }
  }

  // Run the AI review on the active (un-archived) errors in the selection.
  async function reviewSelectedErrors() {
    if (errorBulkBusy) return;
    const uuids = [...selectedErrorUuids].filter((u) => {
      const rec = errorsByUuid.get(u);
      return rec && !rec.archived;
    });
    if (!uuids.length) return;
    if (!confirm(`Run the AI review on ${uuids.length} selected error${uuids.length === 1 ? '' : 's'}? This calls the model once per submission.`)) return;
    errorBulkBusy = true;
    syncErrorSelectionControls();
    const status = $('#errorsBulkStatus');
    if (status) status.textContent = 'Reviewing…';
    try {
      const out = await apiPost('/admin/errors/review-batch', { uuids });
      errorBulkMessage = `Reviewed ${out.reviewed}, skipped ${out.skipped}, failed ${out.failed} of ${out.totalFailed}.`;
      await loadErrors();
      if (status) status.textContent = errorBulkMessage;
    } catch (err) {
      if (err.message === '401') return;
      errorBulkMessage = 'Batch review failed: ' + err.message;
      if (status) status.textContent = errorBulkMessage;
    } finally {
      errorBulkBusy = false;
      syncErrorSelectionControls();
    }
  }

  if (aiApplyBtn) aiApplyBtn.addEventListener('click', applyAiFix);
  if (aiRejectBtn) aiRejectBtn.addEventListener('click', rejectAiFix);
  if (aiRerunBtn) aiRerunBtn.addEventListener('click', () => { if (aiModalUuid) runReview(aiModalUuid, true, true); });
  const aiModalClose = $('#aiModalClose');
  if (aiModalClose) aiModalClose.addEventListener('click', closeAiModal);
  if (aiOverlay) aiOverlay.addEventListener('click', (e) => { if (e.target === aiOverlay) closeAiModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && aiOverlay && !aiOverlay.hidden) closeAiModal(); });

  const reviewAllBtn = $('#reviewAllErrors');
  if (reviewAllBtn) reviewAllBtn.addEventListener('click', reviewAllErrors);
  const archiveSelectedBtn = $('#archiveSelectedErrors');
  if (archiveSelectedBtn) archiveSelectedBtn.addEventListener('click', () => bulkArchiveErrors(true));
  const unarchiveSelectedBtn = $('#unarchiveSelectedErrors');
  if (unarchiveSelectedBtn) unarchiveSelectedBtn.addEventListener('click', () => bulkArchiveErrors(false));
  const reviewSelectedBtn = $('#reviewSelectedErrors');
  if (reviewSelectedBtn) reviewSelectedBtn.addEventListener('click', reviewSelectedErrors);
  const retrySelectedBtn = $('#retrySelectedErrors');
  if (retrySelectedBtn) retrySelectedBtn.addEventListener('click', retrySelectedErrors);
  const errorsFiltersClear = $('#errorsColumnFiltersClear');
  if (errorsFiltersClear) errorsFiltersClear.addEventListener('click', clearAllErrorColumnFilters);

  document.querySelectorAll('#errorsSubtabs .view-subtab').forEach((btn) => {
    btn.addEventListener('click', () => setErrorsView(btn.dataset.errorsView));
  });

  loadErrorPageSize();
  const errorsPageSizeSel = $('#errorsPageSize');
  if (errorsPageSizeSel) {
    errorsPageSizeSel.value = String(errorPageState.pageSize);
    errorsPageSizeSel.addEventListener('change', () => {
      const size = Number(errorsPageSizeSel.value);
      if (!ERROR_PAGE_SIZES.includes(size)) return;
      errorPageState.pageSize = size;
      errorPageState.page = 1;
      saveErrorPageSize();
      renderErrorsTable();
    });
  }
  const errorsPageFirst = $('#errorsPageFirst');
  if (errorsPageFirst) errorsPageFirst.addEventListener('click', () => goToErrorsPage(1));
  const errorsPagePrev = $('#errorsPagePrev');
  if (errorsPagePrev) errorsPagePrev.addEventListener('click', () => goToErrorsPage(errorPageState.page - 1));
  const errorsPageNext = $('#errorsPageNext');
  if (errorsPageNext) errorsPageNext.addEventListener('click', () => goToErrorsPage(errorPageState.page + 1));
  const errorsPageLast = $('#errorsPageLast');
  if (errorsPageLast) errorsPageLast.addEventListener('click', () => goToErrorsPage(Number.MAX_SAFE_INTEGER));

  $('#errorsTable').addEventListener('change', (e) => {
    const selectAll = e.target.closest('#selectAllErrors');
    if (selectAll) {
      errorBulkMessage = '';
      document.querySelectorAll('#errorsTable tbody input.error-select').forEach((cb) => {
        cb.checked = selectAll.checked;
        if (cb.checked) selectedErrorUuids.add(cb.dataset.uuid);
        else selectedErrorUuids.delete(cb.dataset.uuid);
      });
      syncErrorSelectionControls();
      return;
    }
    const cb = e.target.closest('input.error-select');
    if (!cb) return;
    errorBulkMessage = '';
    if (cb.checked) selectedErrorUuids.add(cb.dataset.uuid);
    else selectedErrorUuids.delete(cb.dataset.uuid);
    syncErrorSelectionControls();
  });

  $('#errorsTable').addEventListener('click', (e) => {
    const retryBtn = e.target.closest('button.error-retry-btn');
    if (retryBtn) {
      retryOneError(retryBtn.dataset.uuid);
      return;
    }
    const archiveBtn = e.target.closest('button.ai-archive-btn');
    if (archiveBtn) {
      toggleArchiveError(archiveBtn.dataset.uuid, archiveBtn.dataset.archived !== '1');
      return;
    }
    const btn = e.target.closest('button.ai-review-btn');
    if (!btn) return;
    openAiModal(btn.dataset.uuid);
  });

  const loaders = { queue: loadQueue, jobs: loadJobs, audit: loadAudit, errors: loadErrors };
  function activeTab() {
    const el = document.querySelector('.sidebar-item.active[data-tab]');
    return el ? el.dataset.tab : 'queue';
  }
  function refreshActive() {
    loadMetrics();
    loadStatus();
    loaders[activeTab()]();
  }
  function selectTab(tab) {
    document.querySelectorAll('.sidebar-item[data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
    document.querySelectorAll('.tabview').forEach((v) => v.classList.add('hidden'));
    const view = $('#tab-' + tab);
    if (view) view.classList.remove('hidden');
    try { localStorage.setItem('aps_active_tab', tab); } catch (_) {}
    loaders[tab]();
  }

  document.querySelectorAll('.sidebar-item[data-tab]').forEach((t) => t.addEventListener('click', () => {
    selectTab(t.dataset.tab);
    if (window.matchMedia('(max-width: 1023px)').matches) closeSidebar();
  }));
  document.querySelectorAll('.refresh').forEach((b) => b.addEventListener('click', () => loaders[b.dataset.refresh]()));

  $('#jobsTable').addEventListener('change', (e) => {
    const selectAllRows = e.target.closest('#selectAllJobsRows');
    if (selectAllRows) {
      jobBulkMessage = '';
      document.querySelectorAll('#jobsTable tbody input.job-select:not(:disabled)').forEach((cb) => {
        cb.checked = selectAllRows.checked;
        if (cb.checked) selectedJobIds.add(cb.dataset.jobId);
        else selectedJobIds.delete(cb.dataset.jobId);
      });
      syncJobSelectionControls();
      return;
    }
    const cb = e.target.closest('input.job-select');
    if (!cb) return;
    jobBulkMessage = '';
    if (cb.checked) selectedJobIds.add(cb.dataset.jobId);
    else selectedJobIds.delete(cb.dataset.jobId);
    syncJobSelectionControls();
  });
  $('#approveSelectedJobs').addEventListener('click', approveSelectedJobs);

  // ── Sidebar (hamburger) navigation drawer ────────────────────────────────
  const sidebar = $('#sidebar');
  const overlay = $('#sidebarOverlay');
  const container = document.querySelector('.container');
  function openSidebar() {
    sidebar.classList.add('active');
    overlay.classList.add('active');
    if (container) container.classList.add('sidebar-open');
    try { localStorage.setItem('aps_sidebar_open', '1'); } catch (_) {}
  }
  function closeSidebar() {
    sidebar.classList.remove('active');
    overlay.classList.remove('active');
    if (container) container.classList.remove('sidebar-open');
    try { localStorage.setItem('aps_sidebar_open', '0'); } catch (_) {}
  }
  $('#sidebarToggle').addEventListener('click', () => {
    sidebar.classList.contains('active') ? closeSidebar() : openSidebar();
  });
  $('#sidebarClose').addEventListener('click', closeSidebar);
  overlay.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });

  // Restore last view + sidebar state. Default the sidebar open on desktop so
  // the navigation is visible; collapsed on small screens to free up width.
  try {
    const savedTab = localStorage.getItem('aps_active_tab');
    if (savedTab && loaders[savedTab]) selectTab(savedTab);
  } catch (_) {}
  const sidebarPref = (function () { try { return localStorage.getItem('aps_sidebar_open'); } catch (_) { return null; } })();
  const wideViewport = window.matchMedia('(min-width: 1024px)').matches;
  if (sidebarPref === '1' || (sidebarPref === null && wideViewport)) openSidebar();

  // Sign out: drop the local token, clear the cookie, and return to login.
  async function logout() {
    try { await fetch('/admin/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_) {}
    redirectToLogin();
  }
  const logoutBtn = $('#logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', logout);

  $('#auditSubmission').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadAudit(); });

  const jobsSearch = $('#jobsSearch');
  if (jobsSearch) {
    jobsSearch.addEventListener('input', () => {
      clearTimeout(jobsSearchTimer);
      jobsSearchTimer = setTimeout(loadJobs, 300);
    });
    jobsSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(jobsSearchTimer);
        loadJobs();
      }
    });
  }

  $('#queueTable').addEventListener('change', (e) => {
    const selectAllRows = e.target.closest('#selectAllQueueRows');
    if (selectAllRows) {
      setQueueSelection(visiblePendingQueueUuids(), selectAllRows.checked);
      return;
    }
    const cb = e.target.closest('input.queue-select');
    if (!cb) return;
    setQueueSelection((cb.dataset.uuids || '').split(',').filter(Boolean), cb.checked);
  });
  $('#selectAllQueue').addEventListener('click', () => setQueueSelection(visiblePendingQueueUuids(), true));
  $('#clearQueueSelection').addEventListener('click', () => {
    selectedQueueUuids.clear();
    queueBulkMessage = '';
    syncQueueSelectionControls();
  });
  $('#approveSelectedQueue').addEventListener('click', approveSelectedQueue);
  $('#rejectSelectedQueue').addEventListener('click', rejectSelectedQueue);

  // Expand a row to show field-by-field change details. Group rows (carry
  // data-job) expand into the before/posted/after table for the whole job.
  $('#queueTable tbody').addEventListener('click', async (e) => {
    const caret = e.target.closest('button.caret');
    if (!caret) return;
    const row = caret.closest('tr');
    if (!row) return;
    if (caret.dataset.group) toggleGroupChanges(row, caret.dataset.group);
    else toggleChanges(row, caret.dataset.uuid);
  });

  // Approve / reject the whole group (every pending submission for one item
  // across its vendor codes / marketplaces) at once.
  $('#queueTable tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button.gact');
    if (!btn) return;
    const groupId = btn.dataset.group;
    const count = btn.dataset.count || 'all';
    const isApprove = btn.classList.contains('approve');
    const verb = isApprove ? 'Approve and push' : 'Reject';
    if (!confirm(`${verb} ${count} pending submission(s) in this group?`)) return;
    const uuids = (groupSubs.get(groupId) || []).map((s) => s.submission_uuid);
    btn.disabled = true;
    try {
      await apiPost(`/admin/group/${isApprove ? 'approve' : 'reject'}`, { uuids });
      loadQueue();
    } catch (err) {
      if (err.message === '401') return;
      alert((isApprove ? 'Approve' : 'Reject') + ' all failed: ' + err.message);
      btn.disabled = false;
    }
  });

  // Approve / reject a held submission straight from the queue.
  $('#queueTable tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button.act');
    if (!btn) return;
    const uuid = btn.dataset.uuid;
    const isApprove = btn.classList.contains('approve');
    if (!isApprove && !confirm('Reject this submission? It will NOT be sent to Amazon.')) return;
    if (isApprove && !confirm('Approve and push this submission to Amazon?')) return;
    btn.disabled = true;
    try {
      await apiPost(`/admin/submissions/${encodeURIComponent(uuid)}/${isApprove ? 'approve' : 'reject'}`);
      loadQueue();
    } catch (err) {
      if (err.message === '401') return;
      alert((isApprove ? 'Approve' : 'Reject') + ' failed: ' + err.message);
      btn.disabled = false;
    }
  });

  // Populate the signed-in identity (and validate the token); a 401 here
  // sends us back to the login page automatically.
  function showSession(user) {
    if (!user) return;
    const label = user.full_name || user.username || 'Signed in';
    const nameEl = $('#sessionUser');
    if (nameEl) nameEl.textContent = label;
    const roleEl = $('#sessionRole');
    if (roleEl) roleEl.textContent = user.role || '';
    const avatar = $('#sidebarAvatar');
    if (avatar) {
      const initials = label.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('') || label.slice(0, 2);
      avatar.textContent = initials.toUpperCase();
    }
  }
  api('/admin/me').then((r) => showSession(r.user)).catch(() => {});

  loadQueueColState();
  loadJobsColState();
  loadErrorsView();
  loadErrorColState();
  refreshActive();
  setInterval(loadMetrics, 15000);
  setInterval(loadStatus, 30000);
})();
