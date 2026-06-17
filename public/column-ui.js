/**
 * Shared column UI helpers — selector search, header drag-reorder, resize.
 * Matches battat-design skill (Products column selector + grid resize).
 */
(function () {
  if (window.columnUi) return;

  const MIN_COL_WIDTH = 48;
  const MAX_COL_WIDTH = 640;
  const RESIZE_FLAG = '__apsColResize';

  // ── Column selector search ───────────────────────────────────────────────
  function applyColSelectorSearch(panel, term) {
    const list = panel && panel.querySelector('.col-selector-list');
    if (!list) return;
    const q = (term || '').trim().toLowerCase();
    list.querySelectorAll('.col-selector-item').forEach((item) => {
      const label = (item.querySelector('.col-selector-item-label') || item).textContent.toLowerCase();
      item.style.display = !q || label.includes(q) ? '' : 'none';
    });
    list.querySelectorAll('.col-selector-group').forEach((group) => {
      const visible = [...group.querySelectorAll('.col-selector-item')].some((i) => i.style.display !== 'none');
      group.style.display = visible ? '' : 'none';
    });
  }

  function initColSelectorSearch(panel) {
    if (!panel || panel.querySelector('.col-selector-search')) return null;
    const list = panel.querySelector('.col-selector-list');
    if (!list) return null;
    const row = document.createElement('div');
    row.className = 'col-selector-search';
    row.innerHTML = '<input type="text" class="col-selector-search-input" placeholder="Search columns…" />';
    list.parentNode.insertBefore(row, list);
    const input = row.querySelector('input');
    input.addEventListener('input', () => applyColSelectorSearch(panel, input.value));
    setTimeout(() => input.focus(), 0);
    panel._colSearchInput = input;
    return input;
  }

  function reapplyColSelectorSearch(panel) {
    const input = panel && (panel._colSearchInput || panel.querySelector('.col-selector-search-input'));
    if (input && input.value) applyColSelectorSearch(panel, input.value);
  }

  function clearColSelectorSearch(panel) {
    const input = panel && (panel._colSearchInput || panel.querySelector('.col-selector-search-input'));
    if (input) input.value = '';
    if (panel) applyColSelectorSearch(panel, '');
  }

  // ── Column resize ────────────────────────────────────────────────────────
  function widthsKey(table) {
    return table.dataset.colWidthsKey || 'aps_col_widths';
  }

  function readWidths(table) {
    try { return JSON.parse(localStorage.getItem(widthsKey(table)) || '{}'); }
    catch { return {}; }
  }

  function writeWidths(table, widths) {
    try { localStorage.setItem(widthsKey(table), JSON.stringify(widths)); }
    catch { /* best-effort */ }
  }

  function ensureColgroup(table, count) {
    let cg = table.querySelector(':scope > colgroup');
    if (!cg) {
      cg = document.createElement('colgroup');
      table.insertBefore(cg, table.firstChild);
    }
    while (cg.children.length < count) cg.appendChild(document.createElement('col'));
    while (cg.children.length > count) cg.lastChild.remove();
    return cg;
  }

  function applyStoredWidths(table) {
    const widths = readWidths(table);
    const headerRow = table.tHead && table.tHead.rows[0];
    if (!headerRow) return;
    const cg = ensureColgroup(table, headerRow.cells.length);
    [...headerRow.cells].forEach((th, i) => {
      const key = th.dataset.col;
      const w = key && widths[key];
      if (Number.isFinite(w) && w > 0 && cg.children[i]) {
        cg.children[i].style.width = `${w}px`;
      }
    });
  }

  function persistWidth(table, colKey, width) {
    const widths = readWidths(table);
    widths[colKey] = Math.round(width);
    writeWidths(table, widths);
  }

  function autoFitColumn(table, colIdx, colKey) {
    const cg = table.querySelector(':scope > colgroup');
    if (!cg || !cg.children[colIdx]) return;
    cg.children[colIdx].style.width = '';
    requestAnimationFrame(() => {
      const headerRow = table.tHead && table.tHead.rows[0];
      if (!headerRow || !headerRow.cells[colIdx]) return;
      const measured = headerRow.cells[colIdx].getBoundingClientRect().width;
      if (measured > 0) {
        cg.children[colIdx].style.width = `${Math.round(measured)}px`;
        if (colKey) persistWidth(table, colKey, measured);
      }
    });
  }

  function isResizableHeader(th) {
    if (!th || th.dataset.resize === 'false' || th.classList.contains('no-resize')) return false;
    if (th.colSpan && th.colSpan > 1) return false;
    return true;
  }

  function attachResizeHandle(table, th, colIdx, colKey) {
    if (th.querySelector(':scope > .grid-col-resize-handle')) return;
    const handle = document.createElement('span');
    handle.className = 'grid-col-resize-handle';
    handle.setAttribute('aria-hidden', 'true');
    handle.title = 'Drag to resize · double-click to auto-fit';
    th.appendChild(handle);

    let dragging = false;
    let startX = 0;
    let startWidth = 0;
    let cgCol = null;

    const onMove = (ev) => {
      if (!dragging) return;
      ev.preventDefault();
      const dx = ev.clientX - startX;
      const next = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, startWidth + dx));
      if (cgCol) cgCol.style.width = `${next}px`;
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('grid-col-resizing');
      handle.classList.remove('is-dragging');
      const w = cgCol && parseFloat(cgCol.style.width);
      if (Number.isFinite(w) && w > 0 && colKey) persistWidth(table, colKey, w);
    };

    handle.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const cg = ensureColgroup(table, table.tHead.rows[0].cells.length);
      cgCol = cg.children[colIdx];
      const measured = th.getBoundingClientRect().width;
      const colW = parseFloat((cgCol && cgCol.style.width) || '0');
      startWidth = colW > 0 ? colW : measured;
      startX = ev.clientX;
      dragging = true;
      handle.classList.add('is-dragging');
      document.body.classList.add('grid-col-resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    handle.addEventListener('click', (ev) => ev.stopPropagation());
    handle.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      autoFitColumn(table, colIdx, colKey);
    });
  }

  function enhanceResize(table) {
    if (!table || table.tagName !== 'TABLE') return;
    const headerRow = table.tHead && table.tHead.rows[0];
    if (!headerRow) return;
    const cells = [...headerRow.cells];
    table[RESIZE_FLAG] = true;
    table.classList.add('grid-resizable');
    ensureColgroup(table, cells.length);
    applyStoredWidths(table);
    for (let i = 0; i < cells.length - 1; i++) {
      const th = cells[i];
      if (!isResizableHeader(th)) continue;
      attachResizeHandle(table, th, i, th.dataset.col);
    }
  }

  function resetResize(table) {
    if (table) {
      try { localStorage.removeItem(widthsKey(table)); } catch { /* */ }
      const cg = table.querySelector(':scope > colgroup');
      if (cg) [...cg.children].forEach((col) => { col.style.width = ''; });
    }
  }

  function autoFitAllColumns(table) {
    if (!table || !table.tHead) return;
    const headerRow = table.tHead.rows[0];
    if (!headerRow) return;
    [...headerRow.cells].forEach((th, i) => {
      if (isResizableHeader(th)) autoFitColumn(table, i, th.dataset.col);
    });
  }

  // ── Header drag-reorder ──────────────────────────────────────────────────
  const colDrag = { srcKey: null };

  function wireColumnDrag(th, handlers) {
    const { canDrag, onReorder } = handlers;
    if (!canDrag(th)) return;

    th.setAttribute('draggable', 'true');
    th.addEventListener('dragstart', (e) => {
      const t = e.target;
      if (t && (t.closest('[data-action="sort"]') || t.closest('[data-action="filter"]') || t.closest('.grid-col-resize-handle'))) {
        e.preventDefault();
        return;
      }
      colDrag.srcKey = th.dataset.col;
      th.classList.add('is-dragging');
      try { e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
      try { e.dataTransfer.setData('text/plain', th.dataset.col); } catch (_) {}
    });
    th.addEventListener('dragover', (e) => {
      if (!colDrag.srcKey || th.dataset.col === colDrag.srcKey || !canDrag(th)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
      const rect = th.getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      th.classList.remove('is-drop-left', 'is-drop-right');
      th.classList.add(e.clientX < mid ? 'is-drop-left' : 'is-drop-right');
    });
    th.addEventListener('dragleave', () => {
      th.classList.remove('is-drop-left', 'is-drop-right');
    });
    th.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetKey = th.dataset.col;
      th.classList.remove('is-drop-left', 'is-drop-right');
      if (!colDrag.srcKey || targetKey === colDrag.srcKey) return;
      const rect = th.getBoundingClientRect();
      const insertBefore = e.clientX < rect.left + rect.width / 2;
      onReorder(colDrag.srcKey, targetKey, insertBefore);
    });
    th.addEventListener('dragend', () => {
      colDrag.srcKey = null;
      const table = th.closest('table');
      if (table) {
        table.querySelectorAll('.is-dragging, .is-drop-left, .is-drop-right')
          .forEach((el) => el.classList.remove('is-dragging', 'is-drop-left', 'is-drop-right'));
      }
    });
  }

  window.columnUi = {
    initColSelectorSearch,
    reapplyColSelectorSearch,
    clearColSelectorSearch,
    applyColSelectorSearch,
    enhanceResize,
    resetResize,
    autoFitAllColumns,
    wireColumnDrag
  };
})();
