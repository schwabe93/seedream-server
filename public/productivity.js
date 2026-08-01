function normalizeFavorites(value) {
  return {
    prompts: [...new Set(Array.isArray(value?.prompts) ? value.prompts.map(String) : [])],
    groups: [...new Set(Array.isArray(value?.groups) ? value.groups.map(String) : [])],
  };
}

function isFavorite(type, id) {
  return Array.isArray(favorites?.[type]) && favorites[type].includes(String(id));
}

async function toggleFavorite(type, id) {
  if (!Array.isArray(favorites[type])) favorites[type] = [];
  const value = String(id);
  favorites[type] = favorites[type].includes(value)
    ? favorites[type].filter(item => item !== value)
    : [...favorites[type], value];
  await serverSet('atlasFavorites', favorites);
  renderPrompts();
  renderReferenceGroups();
}

function setLibrarySearch(value) {
  librarySearchQuery = String(value || '').trim().toLowerCase();
  ['promptLibrarySearch', 'referenceLibrarySearch'].forEach(id => {
    const input = document.getElementById(id);
    if (input && input.value !== value) input.value = value;
  });
  renderPrompts();
  renderFolders();
  renderReferenceGroups();
}

function normalizeWorkflowPresets(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => item && item.id && item.name && item.settings).map(item => ({
    ...item,
    id: String(item.id),
    name: String(item.name).slice(0, 60),
    mode: item.mode === 'video' ? 'video' : 'image',
  }));
}

const queueRunnerId = (() => {
  const saved = localStorage.getItem('seedreamQueueRunnerId');
  if (saved) return saved;
  const created = `runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  localStorage.setItem('seedreamQueueRunnerId', created);
  return created;
})();

function normalizeGenerationQueue(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map(job => {
    const completed = job.predictionId && history.some(item => String(item.predictionId) === String(job.predictionId));
    const resumableHere = job.ownerId === queueRunnerId && job.status === 'running';
    return {
      ...job,
      status: completed ? 'done' : (resumableHere ? 'queued' : job.status),
      createdAt: job.createdAt || new Date().toISOString(),
    };
  });
}

function applyGalleryReuse(payload) {
  if (!payload || !payload.prompt) return;
  const mode = payload.mode === 'video' ? 'video' : 'image';
  switchMode(mode, document.getElementById(mode === 'video' ? 'modeVideoBtn' : 'modeImageBtn'));
  document.getElementById('promptTextarea').value = payload.prompt;
  const settings = payload.settings || {};
  const preset = { id: 'gallery-reuse', name: 'Gallery reuse', mode, prompt: payload.prompt, settings };
  workflowPresets.push(preset);
  applyWorkflowPreset(preset.id);
  workflowPresets = workflowPresets.filter(item => item.id !== preset.id);
  renderWorkflowPresets();
  showToast('Gallery prompt and settings loaded', 'success');
  if (payload.generateNow) setTimeout(() => generate(), 350);
}

function renderWorkflowPresets(selectedId = '') {
  const select = document.getElementById('workflowPresetSelect');
  if (!select) return;
  select.innerHTML = '<option value="">Workflow presets...</option>' + workflowPresets
    .map(item => `<option value="${escHtml(item.id)}">${escHtml(item.name)}</option>`).join('');
  if (selectedId && workflowPresets.some(item => item.id === selectedId)) select.value = selectedId;
  document.getElementById('deleteWorkflowPresetButton').disabled = !select.value;
}

async function saveWorkflowPreset() {
  const name = window.prompt('Name for this workflow preset:');
  if (!String(name || '').trim()) return;
  const cleanName = String(name).trim().slice(0, 60);
  const existing = workflowPresets.find(item => item.name.toLowerCase() === cleanName.toLowerCase());
  const preset = {
    id: existing?.id || makeId('preset'),
    name: cleanName,
    mode: currentMode,
    prompt: document.getElementById('promptTextarea').value,
    settings: snapshotSettings(currentMode),
    updatedAt: new Date().toISOString(),
  };
  if (existing) workflowPresets = workflowPresets.map(item => item.id === existing.id ? preset : item);
  else workflowPresets.push(preset);
  await serverSet('atlasWorkflowPresets', workflowPresets);
  renderWorkflowPresets(preset.id);
  showToast(`Workflow preset “${cleanName}” saved`, 'success');
}

function setToggleState(id, enabled) {
  document.getElementById(id)?.classList.toggle('on', Boolean(enabled));
}

function applyWorkflowPreset(id) {
  const preset = workflowPresets.find(item => item.id === id);
  document.getElementById('deleteWorkflowPresetButton').disabled = !preset;
  if (!preset) return;
  switchMode(preset.mode, document.getElementById(preset.mode === 'video' ? 'modeVideoBtn' : 'modeImageBtn'));
  const settings = preset.settings || {};
  const setValue = (elementId, value) => {
    const element = document.getElementById(elementId);
    if (element && value !== undefined && optionExists(element, value)) element.value = String(value);
  };
  if (preset.mode === 'image') {
    setValue('modelSelect', settings.model);
    setValue('sizeSelect', settings.size);
    setValue('countSelect', settings.count);
    setToggleState('syncToggle', settings.syncMode);
    setToggleState('pngToggle', settings.pngOutput);
    const guidance = document.querySelector('#imgSettings input[type="range"]');
    if (guidance && Number.isFinite(Number(settings.guidance))) {
      guidance.value = String(settings.guidance);
      document.getElementById('guidanceVal').textContent = String(settings.guidance);
    }
  } else {
    setValue('videoModelSelect', settings.model);
    setValue('aspectSelect', settings.aspectRatio);
    setValue('durationSelect', settings.duration);
    setToggleState('audioToggle', settings.generateAudio);
    setToggleState('cameraFixedToggle', settings.cameraFixed);
  }
  document.getElementById('promptTextarea').value = preset.prompt || '';
  refImages = (settings.refImages || []).slice(0, 10).map(item => ({ ...item }));
  renderFolders();
  renderRefStrip();
  scheduleWorkspaceSave();
  showToast(`Workflow “${preset.name}” loaded`, 'success');
}

async function deleteWorkflowPreset() {
  const select = document.getElementById('workflowPresetSelect');
  const preset = workflowPresets.find(item => item.id === select?.value);
  if (!preset || !confirm(`Delete workflow preset "${preset.name}"?`)) return;
  workflowPresets = workflowPresets.filter(item => item.id !== preset.id);
  await serverSet('atlasWorkflowPresets', workflowPresets);
  renderWorkflowPresets();
  showToast('Workflow preset deleted', 'success');
}

function formatBackupSize(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

async function loadServerBackups() {
  const list = document.getElementById('serverBackupList');
  if (!list) return;
  list.textContent = 'Loading backups...';
  try {
    const response = await fetch('/api/backups');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    list.innerHTML = data.backups.length ? data.backups.map(backup => `
      <div class="backup-item">
        <div><strong>${escHtml(new Date(backup.createdAt).toLocaleString())}</strong>${escHtml(backup.reason)} · ${formatBackupSize(backup.size)}</div>
        <button class="btn-secondary backup-restore" onclick="restoreServerBackup('${escHtml(backup.name)}')">Restore</button>
      </div>`).join('') : '<div class="dm-info-box">No backups created yet.</div>';
  } catch (error) { list.textContent = `Could not load backups: ${error.message}`; }
}

async function createServerBackup() {
  const response = await fetch('/api/backups', { method: 'POST' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return showToast(data.error || 'Backup failed', 'error');
  showToast('Server backup created', 'success');
  loadServerBackups();
}

async function restoreServerBackup(name) {
  if (!confirm('Restore this complete server backup? A safety backup of the current state will be created first.')) return;
  const response = await fetch('/api/backups/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, confirm: 'RESTORE' }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return showToast(data.error || 'Restore failed', 'error');
  window.location.reload();
}
