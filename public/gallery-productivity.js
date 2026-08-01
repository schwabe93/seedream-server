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
