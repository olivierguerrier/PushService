/**
 * Reusable column filter popup — Battat funnel pattern (battat-design skill).
 * Singleton popup; caller owns filter state.
 */
(function () {
  if (window.colFilter) return;

  let openHost = null;
  let openAnchor = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  function close() {
    if (openHost && openHost.parentNode) openHost.parentNode.removeChild(openHost);
    if (openAnchor) openAnchor.classList.remove('is-open');
    openHost = null;
    openAnchor = null;
  }
  function isOpen() {
    return !!openHost;
  }

  function position(host, anchor) {
    const r = anchor.getBoundingClientRect();
    const popW = host.offsetWidth || 260;
    const popH = host.offsetHeight || 320;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = Math.max(margin, Math.min(vw - popW - margin, r.right - popW));
    let top = r.bottom + 4;
    if (top + popH + margin > vh) top = Math.max(margin, r.top - popH - 4);
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
  }

  function open(anchor, opts) {
    if (!anchor) return;
    if (openAnchor === anchor) { close(); return; }
    close();

    const label = opts && opts.label != null ? String(opts.label) : 'value';
    const values = Array.isArray(opts && opts.values) ? opts.values : [];
    const initial = (opts && opts.selected instanceof Set)
      ? new Set(opts.selected)
      : new Set(opts && Array.isArray(opts.selected) ? opts.selected : []);
    const draft = initial.size
      ? new Set(initial)
      : new Set(values.map((v) => v.value));
    const hadInitialFilter = initial.size > 0 && initial.size !== values.length;

    const host = document.createElement('div');
    host.className = 'col-filter-popup';
    host.innerHTML = `
      <div class="col-filter-popup-header">
        <input type="text" placeholder="Search ${escapeAttr(label)}…" />
      </div>
      <div class="col-filter-popup-actions">
        <button type="button" data-action="all">Select all</button>
        <button type="button" data-action="clear">Clear</button>
      </div>
      <div class="col-filter-popup-list"></div>
      <div class="col-filter-popup-footer">
        <button type="button" class="btn btn-ghost small" data-action="reset">Reset</button>
        <button type="button" class="btn btn-primary small" data-action="apply">Apply</button>
      </div>
    `;
    document.body.appendChild(host);

    const list = host.querySelector('.col-filter-popup-list');
    const search = host.querySelector('input');
    const resetBtn = host.querySelector('[data-action="reset"]');
    if (!hadInitialFilter) resetBtn.disabled = true;

    function renderList() {
      const term = search.value.trim().toLowerCase();
      const items = term
        ? values.filter((v) => {
          const value = String(v.value == null ? '' : v.value).toLowerCase();
          const lbl = String(v.label == null ? '' : v.label).toLowerCase();
          return value.includes(term) || (lbl && lbl.includes(term));
        })
        : values.slice();
      if (!items.length) {
        list.innerHTML = '<div class="col-filter-popup-empty">No values</div>';
        return;
      }
      list.innerHTML = items.map((v) => {
        const display = v.label != null && v.label !== ''
          ? escapeHtml(v.label)
          : (v.value === '' || v.value == null
            ? '<em class="muted">(empty)</em>'
            : escapeHtml(v.value));
        const count = v.count != null ? `<span class="col-filter-popup-item-count muted small">${v.count}</span>` : '';
        const checked = draft.has(v.value) ? 'checked' : '';
        return `<label class="col-filter-popup-item">
          <input type="checkbox" data-val="${escapeAttr(v.value)}" ${checked} />
          <span class="col-filter-popup-item-label">${display}</span>
          ${count}
        </label>`;
      }).join('');
      list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.addEventListener('change', () => {
          const v = cb.dataset.val;
          if (cb.checked) draft.add(v); else draft.delete(v);
        });
      });
    }
    renderList();
    search.addEventListener('input', renderList);

    host.querySelector('[data-action="all"]').addEventListener('click', () => {
      for (const v of values) draft.add(v.value);
      renderList();
    });
    host.querySelector('[data-action="clear"]').addEventListener('click', () => {
      draft.clear();
      renderList();
    });
    resetBtn.addEventListener('click', () => {
      close();
      if (typeof opts.onReset === 'function') opts.onReset();
    });
    host.querySelector('[data-action="apply"]').addEventListener('click', () => {
      const isAll = draft.size === values.length;
      const next = (!draft.size || isAll) ? new Set() : new Set(draft);
      close();
      if (typeof opts.onApply === 'function') opts.onApply(next);
    });

    anchor.classList.add('is-open');
    openHost = host;
    openAnchor = anchor;
    position(host, anchor);
    setTimeout(() => search.focus(), 0);
  }

  document.addEventListener('mousedown', (ev) => {
    if (!openHost) return;
    if (openHost.contains(ev.target)) return;
    if (openAnchor && openAnchor.contains(ev.target)) return;
    close();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && openHost) close();
  });
  window.addEventListener('resize', () => { if (openHost) close(); });
  window.addEventListener('scroll', () => { if (openHost) close(); }, true);

  function headerCell(opts) {
    opts = opts || {};
    const label = opts.label || '';
    const sortable = !!opts.sortable;
    const filterable = !!opts.filterable;
    const sortActive = !!opts.sortActive;
    const sortDir = opts.sortDir === 'desc' ? 'desc' : 'asc';
    const filterActive = !!opts.filterActive;
    const filterCount = Number(opts.filterCount) || 0;

    const arrow = sortActive ? (sortDir === 'desc' ? ' ▼' : ' ▲') : '';
    const labelHtml = sortable
      ? `<span class="col-header-label" data-action="sort">${escapeHtml(label)}${arrow}</span>`
      : `<span class="col-header-label">${escapeHtml(label)}</span>`;
    const badge = (filterActive && filterCount > 0)
      ? `<span class="col-filter-count-badge">${filterCount}</span>`
      : '';
    const funnelSvg =
      '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">' +
      '<path d="M0 1h10L6.5 5v3.5L3.5 10V5z" fill="currentColor"/></svg>';
    const filterHtml = filterable
      ? `<span class="col-filter-icon${filterActive ? ' filter-active' : ''}" data-action="filter" tabindex="0" role="button" aria-label="Filter ${escapeAttr(label)}" title="Filter ${escapeAttr(label)}">${badge}${funnelSvg}</span>`
      : '';
    return `<span class="col-header-inner">${labelHtml}${filterHtml}</span>`;
  }

  window.colFilter = { open, close, isOpen, headerCell };
})();
