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
  async function api(path) {
    const res = await fetch(path, { headers: headers(), credentials: 'same-origin' });
    if (res.status === 401) { redirectToLogin(); throw new Error('401'); }
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  }
  async function apiPost(path, body) {
    const opts = { method: 'POST', headers: headers(), credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    if (res.status === 401) { redirectToLogin(); throw new Error('401'); }
    if (!res.ok) {
      let detail = String(res.status);
      try { const j = await res.json(); detail = j.error || j.status || detail; } catch (_) {}
      throw new Error(detail);
    }
    return res.json();
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

  const QUEUE_COLS = 19; // keep in sync with #queueTable header cell count
  const changesCache = new Map(); // submission uuid / 'grp:'+id -> rendered detail HTML
  const groupSubs = new Map();    // group id -> array of submission rows in the group
  const subsByUuid = new Map();   // submission uuid -> last loaded queue row (for meta lookup)

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

  // A normal single-submission row (one job -> one target).
  function renderQueueRow(r) {
    const uuid = r.submission_uuid || '';
    const actions = r.status === 'PENDING_APPROVAL' ? rowActions(uuid) : '';
    return `<tr data-uuid="${esc(uuid)}">
      <td class="col-caret"><button class="caret" type="button" data-uuid="${esc(uuid)}" aria-label="Show changes">&#9654;</button></td>
      <td>${esc(r.created_at)}</td><td><code>${esc(uuid.slice(0, 8))}</code></td>
      <td>${esc(r.caller)}</td><td>${esc(r.scope)}</td><td>${esc(r.operation)}</td>
      <td><code>${esc(r.asin || '')}</code></td>
      <td>${metaCell(r.meta, 'customer')}</td><td>${metaCell(r.meta, 'season')}</td><td>${metaCell(r.meta, 'lifecycle')}</td>
      <td>${esc(r.vendor_code || '')}</td><td><code>${esc(r.item_number || '')}</code></td>
      <td><code>${esc(r.sku || '')}</code></td><td>${esc(r.marketplace_code || '')}</td>
      <td>${statusBadge(r.status)}</td><td>${esc(r.approved_by || '')}</td><td>${esc(r.updated_at || '')}</td>
      <td class="err">${errorCellHtml(r)}</td><td class="actions">${actions}</td></tr>`;
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

  // A collapsible group header for one item pushed across multiple targets.
  function renderGroupRow(group) {
    const { id, items } = group;
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
    return `<tr class="group-row" data-group="${esc(id)}">
      <td class="col-caret"><button class="caret" type="button" data-group="${esc(id)}" aria-label="Show grouped changes">&#9654;</button></td>
      <td>${esc(items[0].created_at)}</td>
      <td><span class="group-tag">GROUP</span> <span class="group-pill">${items.length}</span></td>
      <td>${sharedCell(items, 'caller')}</td><td>${sharedCell(items, 'scope')}</td><td>${sharedCell(items, 'operation')}</td>
      <td><code>${sharedCell(items, 'asin')}</code></td>
      <td>${sharedMetaCell(items, 'customer')}</td><td>${sharedMetaCell(items, 'season')}</td><td>${sharedMetaCell(items, 'lifecycle')}</td>
      <td><span class="group-vendors">${esc(vendorLabel)}</span></td>
      <td><code>${sharedCell(items, 'item_number')}</code></td>
      <td><code>${sharedCell(items, 'sku')}</code></td><td>${sharedCell(items, 'marketplace_code')}</td>
      <td class="group-status">${statusSummary(items)}</td>
      <td>${esc(approvers)}</td><td>${esc(updated)}</td>
      <td class="err">${groupErrorCellHtml(items)}</td>
      <td class="actions">${groupActions}</td></tr>`;
  }

  async function loadQueue() {
    const tbody = $('#queueTable tbody');
    try {
      const { submissions } = await api('/admin/queue');
      changesCache.clear();
      groupSubs.clear();
      subsByUuid.clear();
      for (const r of submissions) {
        if (r.submission_uuid) subsByUuid.set(r.submission_uuid, r);
      }
      // Group by item identity + change type, preserving first-seen order.
      const order = [];
      const byKey = new Map();
      for (const r of submissions) {
        const key = groupKeyOf(r) || ('solo:' + r.submission_uuid);
        if (!byKey.has(key)) { const g = { key, items: [] }; byKey.set(key, g); order.push(g); }
        byKey.get(key).items.push(r);
      }
      let gi = 0;
      tbody.innerHTML = order.map((g) => {
        if (g.key.startsWith('solo:') || g.items.length < 2) return renderQueueRow(g.items[0]);
        const id = 'g' + (gi++);
        groupSubs.set(id, g.items);
        return renderGroupRow({ id, items: g.items });
      }).join('') || emptyRow(QUEUE_COLS);
      applyColVisibility();
    } catch (e) { if (e.message !== '401') tbody.innerHTML = errRow(QUEUE_COLS, e); }
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
    detail.innerHTML = `<td></td><td colspan="${QUEUE_COLS - 1}"><div class="detail-body">Loading changes…</div></td>`;
    row.insertAdjacentElement('afterend', detail);
    const body = detail.querySelector('.detail-body');
    try {
      let rendered = changesCache.get(uuid);
      if (rendered == null) {
        const data = await api(`/admin/submissions/${encodeURIComponent(uuid)}/changes`);
        const sub = subsByUuid.get(uuid);
        rendered = (sub ? renderMetaBlock(sub.meta) : '') + renderChanges(data);
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
    const metaSubs = subs.filter((s) => s.meta && Object.keys(s.meta).some((k) => s.meta[k] != null && s.meta[k] !== ''));
    let metaHeader = '';
    if (metaSubs.length) {
      metaHeader = '<div class="meta-block-group">'
        + metaSubs.map((s) => `<div class="meta-block-row"><div class="meta-block-label"><code>${esc((s.submission_uuid || '').slice(0, 8))}</code> ${esc(s.vendor_code || '')} / ${esc(s.sku || '')}</div>${renderMetaBlock(s.meta)}</div>`).join('')
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
    detail.innerHTML = `<td></td><td colspan="${QUEUE_COLS - 1}"><div class="detail-body">Loading changes…</div></td>`;
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

  // ── Column show/hide selector (persisted in localStorage) ─────────────────
  const COLS_KEY = 'aps_queue_cols';
  function hiddenCols() {
    try { return new Set(JSON.parse(localStorage.getItem(COLS_KEY) || '[]')); } catch { return new Set(); }
  }
  function saveHiddenCols(set) {
    localStorage.setItem(COLS_KEY, JSON.stringify([...set]));
  }
  // Column indices that must never be hidden (caret + Action). These carry the
  // expand control and the Approve/Reject buttons, and they have no checkbox in
  // the column menu — so a stale index landing here would hide them with no way
  // to restore them from the UI.
  function nohideCols() {
    const head = $('#queueTable thead tr');
    const set = new Set();
    if (head) Array.from(head.children).forEach((th, idx) => { if (th.hasAttribute('data-nohide')) set.add(idx); });
    return set;
  }
  // Drop any persisted indices that point at a never-hide column (or are out of
  // range). Self-heals settings saved under an older column layout.
  function pruneHiddenCols() {
    const head = $('#queueTable thead tr');
    if (!head) return;
    const colCount = head.children.length;
    const nohide = nohideCols();
    const hidden = hiddenCols();
    const cleaned = new Set([...hidden].filter((i) => i < colCount && !nohide.has(i)));
    if (cleaned.size !== hidden.size) saveHiddenCols(cleaned);
  }
  function applyColVisibility() {
    const hidden = hiddenCols();
    const nohide = nohideCols();
    const table = $('#queueTable');
    if (!table) return;
    // Only the table's own header/body rows — never the nested bpa-table rows
    // that live inside an expanded group's detail cell.
    const rows = table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr');
    rows.forEach((tr) => {
      if (tr.classList.contains('detail-row')) return; // colspan cell: leave as-is
      Array.from(tr.children).forEach((cell, idx) => {
        cell.classList.toggle('col-hidden', hidden.has(idx) && !nohide.has(idx));
      });
    });
  }
  function buildColMenu() {
    const menu = $('#queueCols .colmenu-body');
    const head = $('#queueTable thead tr');
    if (!menu || !head) return;
    const hidden = hiddenCols();
    const items = Array.from(head.children).map((th, idx) => {
      if (th.hasAttribute('data-nohide')) return '';
      const label = th.textContent.trim() || `Col ${idx}`;
      const checked = hidden.has(idx) ? '' : 'checked';
      return `<label class="colmenu-item"><input type="checkbox" data-col="${idx}" ${checked}/> ${esc(label)}</label>`;
    }).join('');
    menu.innerHTML = items;
    menu.querySelectorAll('input[data-col]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const set = hiddenCols();
        const idx = Number(cb.dataset.col);
        if (cb.checked) set.delete(idx); else set.add(idx);
        saveHiddenCols(set);
        applyColVisibility();
      });
    });
  }

  async function loadJobs() {
    const tbody = $('#jobsTable tbody');
    try {
      const { jobs } = await api('/admin/jobs');
      tbody.innerHTML = jobs.map((j) => `<tr>
        <td>${esc(j.createdAt)}</td><td><code>${esc((j.jobId || '').slice(0, 8))}</code></td>
        <td>${esc(j.kind)}</td><td>${esc(j.caller)}</td><td>${esc(j.asin || '')}</td>
        <td>${esc(j.okCount)}</td><td>${esc(j.failedCount)}</td><td>${esc(j.targetCount)}</td>
        <td>${statusBadge(j.status)}</td></tr>`).join('') || emptyRow(9);
    } catch (e) { if (e.message !== '401') tbody.innerHTML = errRow(9, e); }
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
  const errRow = (n, e) => `<tr><td colspan="${n}" style="text-align:center;color:var(--color-neg-text);padding:20px;">${e.message === '401' ? 'Unauthorized' : esc(e.message)}</td></tr>`;

  const loaders = { queue: loadQueue, jobs: loadJobs, audit: loadAudit };
  function activeTab() {
    const el = document.querySelector('.sidebar-item.active[data-tab]');
    return el ? el.dataset.tab : 'queue';
  }
  function refreshActive() {
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

  pruneHiddenCols();
  buildColMenu();
  refreshActive();
  setInterval(loadStatus, 30000);
})();
