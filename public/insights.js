'use strict';
/* Insights dashboard + Compare view for Seedream Studio.
 * Talks to GET /api/stats and /api/store/atlasOutputMeta, both dependency-free
 * server endpoints. Everything renders inline — no chart libraries. */

// ── Insights ────────────────────────────────────────────────────────────────

function formatInsightBytes(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return Math.max(0, bytes) + ' B';
}

async function openInsights() {
  const modal = document.getElementById('insightsModal');
  if (!modal) return;
  modal.classList.add('show');
  const body = document.getElementById('insightsBody');
  body.innerHTML = '<div class="insights-empty">Loading statistics…</div>';
  try {
    const response = await fetch('/api/stats');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const stats = await response.json();
    renderInsights(stats);
  } catch (error) {
    body.innerHTML = `<div class="insights-empty">Could not load statistics: ${escHtml(error.message)}</div>`;
  }
}

function closeInsights() {
  const modal = document.getElementById('insightsModal');
  if (modal) modal.classList.remove('show');
}

function renderInsights(stats) {
  const body = document.getElementById('insightsBody');
  const total = stats.totalFiles || 0;
  if (!total) {
    body.innerHTML = '<div class="insights-empty">No outputs yet — generate something first! ✦</div>';
    return;
  }

  // 90-day activity series (empty days included).
  const byDay = stats.byDay || {};
  const days = [];
  for (let i = 89; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }
  const maxDay = Math.max(1, ...days.map(day => byDay[day] || 0));
  const bars = days.map(day => {
    const count = byDay[day] || 0;
    const height = count ? Math.max(4, Math.round((count / maxDay) * 80)) : 1;
    return `<div class="activity-bar" style="height:${height}px" title="${day}: ${count}"></div>`;
  }).join('');

  const modelEntries = Object.entries(stats.byModel || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxModel = Math.max(1, ...modelEntries.map(entry => entry[1]));
  const modelRows = modelEntries.map(([model, count]) => `
    <div class="bar-row">
      <span class="bar-label" title="${escHtml(model)}">${escHtml(model)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.round((count / maxModel) * 100)}%"></span></span>
      <span class="bar-count">${count}</span>
    </div>`).join('') || '<div class="insights-empty">No model data.</div>';

  const promptRows = (stats.topPrompts || []).map(entry => `
    <div class="prompt-row">
      <span class="p-count">${entry.count}×</span>
      <span class="p-text" title="${escHtml(entry.prompt)}">${escHtml(entry.prompt)}</span>
      <button class="btn-secondary" style="padding:2px 8px;font-size:10px" onclick="copyInsightPrompt(this)" data-prompt="${escHtml(entry.prompt)}" title="Copy prompt">⧉</button>
    </div>`).join('') || '<div class="insights-empty">No prompts recorded.</div>';

  const gb = formatInsightBytes(stats.totalBytes || 0);
  body.innerHTML = `
    <div class="insights-kpis">
      <div class="insight-kpi"><div class="kpi-value">${total}</div><div class="kpi-label">Outputs</div></div>
      <div class="insight-kpi"><div class="kpi-value">${gb}</div><div class="kpi-label">Storage</div></div>
      <div class="insight-kpi"><div class="kpi-value">${stats.byKind?.image || 0}</div><div class="kpi-label">Images</div></div>
      <div class="insight-kpi"><div class="kpi-value">${stats.byKind?.video || 0}</div><div class="kpi-label">Videos</div></div>
    </div>
    <div class="insights-section-title">Last 90 days</div>
    <div class="activity-chart">${bars}</div>
    <div class="insights-section-title">Top models</div>
    ${modelRows}
    <div class="insights-section-title">Top prompts</div>
    ${promptRows}`;
}

function copyInsightPrompt(button) {
  const text = button.getAttribute('data-prompt') || '';
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => showToast('Prompt copied to clipboard', 'success')).catch(() => {});
  }
}

// ── Compare view ────────────────────────────────────────────────────────────

const compareSlots = [null, null];

function extractOutputName(url) {
  const match = String(url || '').match(/\/outputs\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

async function metadataForOutput(outputUrl) {
  const name = extractOutputName(outputUrl);
  if (!name) return null;
  if (!metadataForOutput.cache) {
    try {
      const response = await fetch('/api/store/atlasOutputMeta');
      const data = await response.json().catch(() => ({}));
      const value = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
      metadataForOutput.cache = value && typeof value === 'object' ? value : {};
    } catch {
      metadataForOutput.cache = {};
    }
  }
  return metadataForOutput.cache[name] || null;
}

async function compareOutput(outputUrl) {
  const existingIndex = compareSlots.findIndex(slot => slot && slot.url === outputUrl);
  if (existingIndex !== -1) {
    compareSlots[existingIndex] = null;
  } else {
    const freeIndex = compareSlots.findIndex(slot => !slot);
    const targetIndex = freeIndex !== -1 ? freeIndex : 0;
    compareSlots[targetIndex] = { url: outputUrl, meta: await metadataForOutput(outputUrl) };
  }
  renderCompareModal();
  const modal = document.getElementById('compareModal');
  if (!modal.classList.contains('show')) modal.classList.add('show');
}

function swapCompareSlots() {
  compareSlots.reverse();
  renderCompareModal();
}

function clearCompareSlots() {
  compareSlots[0] = null;
  compareSlots[1] = null;
  renderCompareModal();
}

function closeCompareModal() {
  const modal = document.getElementById('compareModal');
  if (modal) modal.classList.remove('show');
}

function compareMediaHtml(slot) {
  if (!slot) return '<div class="compare-empty">Click ⚖ on an output card<br>to fill this slot.</div>';
  const isVideo = /\.(mp4|webm)$/i.test(slot.url);
  return isVideo
    ? `<video class="compare-slot-media" src="${escHtml(slot.url)}" controls playsinline></video>`
    : `<img class="compare-slot-media" src="${escHtml(slot.url)}" alt="">`;
}

function compareMetaHtml(slot, other) {
  if (!slot) return '';
  const meta = slot.meta || {};
  const settings = meta.settings || {};
  const keys = ['model', 'size', 'resolution', 'aspectRatio', 'duration', 'guidance', 'count', 'seed'];
  const rows = keys.map(key => {
    const value = settings[key] ?? meta[key];
    if (value === undefined || value === null || value === '') return '';
    const otherValue = other && other.meta ? (other.meta.settings?.[key] ?? other.meta[key]) : undefined;
    const differs = other && String(value) !== String(otherValue ?? '') && otherValue !== undefined;
    return `<div class="cmp-row"><span class="cmp-key">${escHtml(key)}</span><span class="cmp-val ${differs ? 'compare-diff' : ''}">${escHtml(String(value))}</span></div>`;
  }).join('');
  return `
    ${rows ? `<div class="compare-slot-meta">${rows}</div>` : ''}
    ${meta.prompt ? `<div class="compare-prompt">${escHtml(meta.prompt)}</div>` : ''}`;
}

function renderCompareModal() {
  const [a, b] = compareSlots;
  const slotHtml = (slot, tag, other) => `
    <div class="compare-slot" data-slot="${slot ? 'filled' : 'empty'}">
      <span class="compare-slot-tag">${slot ? escHtml(slot.tag) : 'EMPTY'}</span>
      ${slot ? compareMediaHtml(slot) : '<div class="compare-empty">Click ⚖ Compare<br>on an output card to fill this slot.</div>'}
      ${slot ? compareMetaHtml(slot, other) : ''}
      ${slot ? `<div style="display:flex;gap:6px;margin-top:auto"><button class="btn-secondary" style="padding:4px 10px;font-size:10px" onclick="copyPromptForOutput('${escHtml(slot.url)}')">Copy prompt</button></div>` : ''}
    </div>`;
  if (a) a.tag = 'A';
  if (b) b.tag = 'B';
  document.getElementById('compareSlotA').outerHTML = slotHtml(a, 'A', b).replace('<div class="compare-slot" data-slot', '<div id="compareSlotA" data-slot');
  document.getElementById('compareSlotB').outerHTML = slotHtml(b, 'B', a).replace('<div class="compare-slot" data-slot', '<div id="compareSlotB" data-slot');
}

// Rebuild the two slot containers once at startup so renderCompareModal can
// keep replacing them via outerHTML.
function initCompareModal() {
  const grid = document.getElementById('compareGrid');
  if (!grid) return;
  grid.innerHTML = `
    <div class="compare-slot" id="compareSlotA" data-slot="empty"><div class="compare-empty">Click ⚖ Compare<br>on an output card to fill this slot.</div></div>
    <div class="compare-slot" id="compareSlotB" data-slot="empty" data-slot-b="1"><div class="compare-empty">Click ⚖ Compare<br>on an output card to fill this slot.</div></div>`;
}

// Global Escape handling: close the topmost panel first.
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const compareModal = document.getElementById('compareModal');
  const insightsModal = document.getElementById('insightsModal');
  if (compareModal?.classList.contains('show')) { closeCompareModal(); return; }
  if (insightsModal?.classList.contains('show')) closeInsights();
});