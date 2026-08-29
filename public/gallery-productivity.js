let enhancedGalleryFiles = [];
const selectedGalleryOutputs = new Set();

function galleryUrl(name) {
  return `/outputs/${encodeURIComponent(name || '')}`;
}

async function patchGalleryMetadata(filename, patch) {
  const response = await fetch(`/api/output-meta/${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const file = enhancedGalleryFiles.find(item => item.name === filename);
  if (file) Object.assign(file, patch);
}

function updateGalleryAlbumOptions() {
  const select = document.getElementById('galleryAlbum');
  const current = select.value;
  const albums = [...new Set(enhancedGalleryFiles.map(file => String(file.album || '').trim()).filter(Boolean))].sort();
  select.innerHTML = '<option value="all">All albums</option><option value="none">No album</option>'
    + albums.map(album => `<option value="${esc(album)}">${esc(album)}</option>`).join('');
  if ([...select.options].some(option => option.value === current)) select.value = current;
}

function filteredGalleryFiles() {
  const query = document.getElementById('gallerySearch').value.trim().toLowerCase();
  const type = document.getElementById('galleryType').value;
  const album = document.getElementById('galleryAlbum').value;
  const favoritesOnly = document.getElementById('galleryFavoritesOnly').checked;
  return enhancedGalleryFiles.filter(file => {
    const isVideo = /\.(mp4|webm)$/i.test(file.name || '');
    if (type === 'video' && !isVideo) return false;
    if (type === 'image' && isVideo) return false;
    if (album === 'none' && file.album) return false;
    if (!['all', 'none'].includes(album) && file.album !== album) return false;
    if (favoritesOnly && !file.favorite) return false;
    return !query || `${file.name} ${file.prompt || ''} ${file.model || ''} ${file.album || ''}`.toLowerCase().includes(query);
  });
}

function renderEnhancedGallery() {
  const grid = document.getElementById('grid');
  const empty = document.getElementById('empty');
  const files = filteredGalleryFiles();
  grid.replaceChildren();
  document.getElementById('meta').textContent = `${files.length} shown · ${enhancedGalleryFiles.length} total · ${selectedGalleryOutputs.size} selected`;
  empty.style.display = files.length ? 'none' : 'block';
  empty.textContent = enhancedGalleryFiles.length ? 'No outputs match these filters.' : 'No outputs found yet.';

  files.forEach(file => {
    const name = file.name || '';
    const url = galleryUrl(name);
    const isVideo = /\.(mp4|webm)$/i.test(name);
    const prompt = String(file.prompt || '');
    const hasPrompt = Boolean(prompt.trim());
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <input class="card-select" type="checkbox" ${selectedGalleryOutputs.has(name) ? 'checked' : ''} aria-label="Select ${esc(name)}">
      ${isVideo
        ? `<video src="${esc(url)}" controls playsinline preload="metadata"></video>`
        : `<img src="${esc(url)}" alt="${esc(name)}" loading="lazy">`}
      <div class="info">
        <div class="name" title="${esc(name)}">${esc(name)}${file.album ? `<div class="album-label">${esc(file.album)}</div>` : ''}</div>
        <div class="card-actions">
          <button class="btn favorite-btn${file.favorite ? ' active' : ''}" aria-label="Toggle favorite">★</button>
          <button class="btn copy-prompt-btn" ${hasPrompt ? '' : 'disabled'}>${hasPrompt ? 'Copy prompt' : 'No prompt'}</button>
          <button class="btn use-studio-btn" ${hasPrompt ? '' : 'disabled'}>Use</button>
          <button class="btn regenerate-btn" ${hasPrompt ? '' : 'disabled'}>Regenerate</button>
          <button class="btn album-btn">Album</button>
          <button class="btn save-output-btn">Save</button>
          <button class="btn delete-output-btn" style="color:var(--danger)">Delete</button>
        </div>
      </div>`;
    card.querySelector('.card-select').addEventListener('change', event => {
      if (event.target.checked) selectedGalleryOutputs.add(name); else selectedGalleryOutputs.delete(name);
      document.getElementById('meta').textContent = `${files.length} shown · ${enhancedGalleryFiles.length} total · ${selectedGalleryOutputs.size} selected`;
    });
    card.querySelector('.favorite-btn').addEventListener('click', async event => {
      await patchGalleryMetadata(name, { favorite: !file.favorite });
      renderEnhancedGallery();
    });
    if (hasPrompt) card.querySelector('.copy-prompt-btn').addEventListener('click', event => copyPrompt(prompt, event.currentTarget));
    card.querySelector('.use-studio-btn').addEventListener('click', () => reuseGalleryOutput(file, false));
    card.querySelector('.regenerate-btn').addEventListener('click', () => reuseGalleryOutput(file, true));
    card.querySelector('.album-btn').addEventListener('click', () => setGalleryAlbum(file));
    card.querySelector('.save-output-btn').addEventListener('click', () => download(url, name));
    card.querySelector('.delete-output-btn').addEventListener('click', event => deleteOutput(name, event.currentTarget));
    card.querySelector('img')?.addEventListener('click', () => openImage(url));
    grid.appendChild(card);
  });
}

async function loadEnhancedGallery() {
  document.getElementById('meta').textContent = 'Loading outputs...';
  try {
    const [response, historyMap] = await Promise.all([fetch('/api/outputs'), fetchHistoryMap()]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    enhancedGalleryFiles = Array.isArray(data.files) ? data.files : [];
    enhancedGalleryFiles.forEach(file => {
      const mapped = historyMap.get(normalizeOutputUrl(galleryUrl(file.name)));
      if (!file.prompt && mapped) file.prompt = mapped;
      addPromptMapping(historyMap, galleryUrl(file.name), file.prompt);
    });
    promptByOutput = historyMap;
    updateGalleryAlbumOptions();
    renderEnhancedGallery();
  } catch (error) {
    document.getElementById('meta').textContent = `Could not load outputs: ${error.message}`;
  }
}

async function reuseGalleryOutput(file, generateNow) {
  const response = await fetch('/api/store/atlasPendingReuse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify({ prompt: file.prompt, mode: file.mode || (/\.(mp4|webm)$/i.test(file.name) ? 'video' : 'image'), settings: file.settings || {}, generateNow }) }),
  });
  if (response.ok) window.location.href = '/';
}

async function setGalleryAlbum(file) {
  const album = window.prompt('Album name (leave empty to remove):', file.album || '');
  if (album === null) return;
  await patchGalleryMetadata(file.name, { album: album.trim().slice(0, 60) });
  updateGalleryAlbumOptions();
  renderEnhancedGallery();
}

function toggleSelectAllGallery() {
  const visible = filteredGalleryFiles();
  const allSelected = visible.length && visible.every(file => selectedGalleryOutputs.has(file.name));
  visible.forEach(file => allSelected ? selectedGalleryOutputs.delete(file.name) : selectedGalleryOutputs.add(file.name));
  renderEnhancedGallery();
}

function bulkDownloadGallery() {
  enhancedGalleryFiles.filter(file => selectedGalleryOutputs.has(file.name)).forEach((file, index) => {
    setTimeout(() => download(galleryUrl(file.name), file.name), index * 180);
  });
}

async function bulkSetGalleryAlbum() {
  if (!selectedGalleryOutputs.size) return;
  const album = window.prompt('Album name for selected outputs (empty removes album):');
  if (album === null) return;
  await Promise.all([...selectedGalleryOutputs].map(name => patchGalleryMetadata(name, { album: album.trim().slice(0, 60) })));
  updateGalleryAlbumOptions();
  renderEnhancedGallery();
}

async function bulkDeleteGallery() {
  const names = [...selectedGalleryOutputs];
  if (!names.length || !confirm(`Delete ${names.length} selected outputs from server and history?`)) return;
  await Promise.all(names.map(name => fetch(`/api/output/${encodeURIComponent(name)}`, { method: 'DELETE' })));
  selectedGalleryOutputs.clear();
  await loadEnhancedGallery();
}

// ── ZIP bulk download (streams a stored zip from /api/outputs/zip) ──────────
let galleryToastTimer = null;

function showGalleryToast(message, isError) {
  const toast = document.getElementById('galleryToast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle('error', Boolean(isError));
  toast.classList.add('show');
  clearTimeout(galleryToastTimer);
  galleryToastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}

function stampZipSuffix() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function downloadZipGallery(button) {
  const selected = [...selectedGalleryOutputs];
  let files = selected;
  let label = 'selection';
  if (!selected.length) {
    // No explicit selection: export the currently filtered view (max 500).
    files = filteredGalleryFiles().slice(0, 500).map(file => file.name);
    label = 'view';
  }
  if (!files.length) {
    showGalleryToast('Nothing to export — select files first.', true);
    return;
  }
  const zipName = `seedream-${label}-${stampZipSuffix()}.zip`;
  const originalText = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = 'Zipping…'; }
  try {
    const response = await fetch('/api/outputs/zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files, name: zipName }),
    });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try { message = (await response.json()).error || message; } catch {}
      throw new Error(message);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    download(url, zipName);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    const skipped = response.headers.get('X-Seedream-Missing')
      ? Number(response.headers.get('X-Seedream-Included') || 0)
      : files.length;
    showGalleryToast(`ZIP queued: ${skipped} files in ${zipName}`);
  } catch (error) {
    showGalleryToast(`ZIP export failed: ${error.message}`, true);
  } finally {
    if (button) { button.disabled = false; button.textContent = originalText; }
  }
}

// ── Duplicate finder ────────────────────────────────────────────────────────
let duplicateGroups = [];

function openDuplicatesPanel() {
  document.getElementById('duplicatesModal').classList.add('show');
  document.getElementById('dupKeepNewestBtn').disabled = true;
  document.getElementById('dupGroups').innerHTML = '';
  document.getElementById('dupStatus').textContent = 'Scanning outputs for duplicates…';
  loadDuplicates();
}

function closeDuplicatesModal() {
  document.getElementById('duplicatesModal').classList.remove('show');
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return Math.max(0, bytes) + ' B';
}

// esc() is defined inline in gallery.html

async function loadDuplicates() {
  const status = document.getElementById('dupStatus');
  try {
    const response = await fetch('/api/duplicates');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    duplicateGroups = Array.isArray(data.groups) ? data.groups : [];
    if (!duplicateGroups.length) {
      status.textContent = `No duplicates found (${data.scanned} files scanned).`;
      document.getElementById('dupGroups').innerHTML = '';
      return;
    }
    const wasted = formatBytes(data.duplicateBytes || 0);
    status.textContent = `${duplicateGroups.length} duplicate group(s) found · ${data.scanned} files scanned · ${wasted} reclaimable.`;
    renderDuplicateGroups();
  } catch (error) {
    status.textContent = `Duplicate scan failed: ${error.message}`;
  }
}

function renderDuplicateGroups() {
  const container = document.getElementById('dupGroups');
  container.innerHTML = duplicateGroups.map((group, gi) => {
    const rows = group.files.map((file, fi) => {
      const newest = fi === group.files.length - 1; // files are sorted oldest → newest server-side
      const date = file.mtime ? new Date(file.mtime).toLocaleString() : 'unknown date';
      const prompt = file.meta.prompt ? esc(file.meta.prompt.slice(0, 90)) : '';
      const fav = file.meta.favorite ? ' · ★ favorite' : '';
      const model = file.meta.model ? ` · ${esc(file.meta.model.split('/').pop())}` : '';
      return `
        <label class="dup-file">
          <span class="dup-keep"><input type="checkbox" checked name="dup-keep-${gi}" value="${esc(file.name)}" ${newest ? 'data-newest="1"' : ''}></span>
          <img class="dup-thumb" src="/outputs/${encodeURIComponent(file.name)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
          <span class="dup-file-info">
            <span class="dup-file-name">${esc(file.name)}${newest ? ' <span class="dup-newest">newest</span>' : ''}${fav}</span>
            <span class="dup-file-sub">${formatBytes(file.size)} · ${date}${model}${fav}</span>
            ${file.meta.prompt ? `<span class="dup-file-prompt">${prompt}…</span>` : ''}
          </span>
        </label>`;
    }).join('');
    return `
      <div class="dup-group" data-hash="${esc(group.hash)}">
        <div class="dup-group-head">
          <div class="dup-group-title">${group.files.length} × identical (${formatBytes(group.size)} each)</div>
          <div style="display:flex;gap:6px">
            <button class="btn dup-group-delete" style="color:var(--danger)" onclick="deleteDupFiles(${gi})">Delete selected in group</button>
          </div>
        </div>
        <div class="dup-files">${rows}</div>
      </div>`;
  }).join('');
}

function deleteDupFiles(groupIndex) {
  const group = document.querySelectorAll('#dupGroups .dup-group')[groupIndex];
  if (!group) return;
  const keeps = [...group.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value);
  const names = [...group.querySelectorAll('input[type="checkbox"]')].map(input => input.value);
  const toDelete = names.filter(name => !keeps.includes(name));
  if (!toDelete.length) {
    showGalleryToast('Nothing selected for deletion — at least one file must stay.', true);
    return;
  }
  if (!confirm(`Delete ${toDelete.length} duplicate file(s)? This cannot be undone.`)) return;
  doDeleteDuplicates(toDelete);
}

function deleteDuplicatesKeepNewest() {
  const toDelete = [];
  for (const group of duplicateGroups) {
    const sorted = [...group.files].sort((a, b) => a.mtime - b.mtime);
    toDelete.push(...sorted.slice(0, -1).map(file => file.name));
  }
  if (!toDelete.length) return;
  const favorites = duplicateGroups.some(g => g.files.some(f => f.meta.favorite));
  const extra = favorites ? '\nWARNING: some duplicates are favorites — they will be deleted too.' : '';
  if (!confirm(`Keep only the newest file in each of ${duplicateGroups.length} group(s)?\n${toDelete.length} file(s) will be deleted.${extra}`)) return;
  doDeleteDuplicates(toDelete);
}

async function doDeleteDuplicates(names) {
  const status = document.getElementById('dupStatus');
  status.textContent = `Deleting ${names.length} file(s)…`;
  await Promise.all(names.map(name => fetch(`/api/output/${encodeURIComponent(name)}`, { method: 'DELETE' })));
  selectedGalleryOutputs.clear();
  await loadEnhancedGallery();
  await loadDuplicates();
}
