/**
 * Seedream Studio — Local Network Server v2
 * Pure Node.js + JSON store + output file proxy
 */

const http  = require('http');
const https = require('https');
const crypto = require('crypto');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');
const zip   = require('./lib/zip');

const PORT        = process.env.PORT || 7842;
const INSTANCE_TOKEN = process.env.SEEDREAM_INSTANCE_TOKEN || '';
const DATA_DIR    = process.env.SEEDREAM_DATA_DIR
  ? path.resolve(process.env.SEEDREAM_DATA_DIR)
  : path.join(__dirname, 'data');
const DB_FILE     = path.join(DATA_DIR, 'store.json');
const OUTPUT_DIR  = path.join(DATA_DIR, 'outputs');
const REFS_DIR    = path.join(DATA_DIR, 'refs');
const BACKUP_DIR  = path.join(DATA_DIR, 'backups');
const BACKUP_RETENTION = Math.max(1, Number(process.env.SEEDREAM_BACKUP_RETENTION || 7));

fs.mkdirSync(DATA_DIR,   { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(REFS_DIR,   { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const outputSaveLocks = new Map();

// ── JSON key-value store ──────────────────────────────────────────────────────
let store = {};
let storeVersion = Date.now(); // bumped on every write — clients poll this

function loadStore() {
  try {
    if (fs.existsSync(DB_FILE)) store = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) { console.warn('Store load failed, starting fresh:', e.message); store = {}; }
}

let saveTimer = null;
function persistStore() {
  storeVersion = Date.now();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
      fs.renameSync(tmp, DB_FILE);
    } catch (e) { console.error('Persist failed:', e.message); }
  }, 200);
}

loadStore();
console.log('Store loaded — ' + Object.keys(store).length + ' keys');

function copyDirectoryContents(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  if (!fs.existsSync(source)) return;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectoryContents(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function directorySize(target) {
  if (!fs.existsSync(target)) return 0;
  return fs.readdirSync(target, { withFileTypes: true }).reduce((total, entry) => {
    const full = path.join(target, entry.name);
    return total + (entry.isDirectory() ? directorySize(full) : fs.statSync(full).size);
  }, 0);
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.endsWith('.tmp'))
    .map(entry => {
      const full = path.join(BACKUP_DIR, entry.name);
      let manifest = {};
      try { manifest = JSON.parse(fs.readFileSync(path.join(full, 'manifest.json'), 'utf8')); } catch {}
      return { name: entry.name, createdAt: manifest.createdAt || fs.statSync(full).mtime.toISOString(), reason: manifest.reason || 'manual', size: directorySize(full) };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function pruneBackups() {
  listBackups().slice(BACKUP_RETENTION).forEach(backup => {
    fs.rmSync(path.join(BACKUP_DIR, backup.name), { recursive: true, force: true });
  });
}

function createBackup(reason = 'manual', shouldPrune = true) {
  const createdAt = new Date().toISOString();
  const safeReason = String(reason || 'manual').replace(/[^a-z0-9_-]/gi, '-').slice(0, 20) || 'manual';
  const name = `${createdAt.replace(/[:.]/g, '-')}-${safeReason}`;
  const temp = path.join(BACKUP_DIR, `${name}.tmp`);
  const target = path.join(BACKUP_DIR, name);
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  fs.writeFileSync(path.join(temp, 'store.json'), JSON.stringify(store), 'utf8');
  copyDirectoryContents(OUTPUT_DIR, path.join(temp, 'outputs'));
  copyDirectoryContents(REFS_DIR, path.join(temp, 'refs'));
  fs.writeFileSync(path.join(temp, 'manifest.json'), JSON.stringify({ version: 1, createdAt, reason: safeReason }, null, 2), 'utf8');
  fs.renameSync(temp, target);
  if (shouldPrune) pruneBackups();
  return listBackups().find(backup => backup.name === name);
}

function restoreBackup(name) {
  const safeName = path.basename(String(name || ''));
  const source = path.join(BACKUP_DIR, safeName);
  const backupStore = path.join(source, 'store.json');
  if (!safeName || !fs.existsSync(backupStore)) throw new Error('Backup not found');
  createBackup('before-restore', false);
  const parsedStore = JSON.parse(fs.readFileSync(backupStore, 'utf8'));
  for (const [sourceDir, targetDir] of [[path.join(source, 'outputs'), OUTPUT_DIR], [path.join(source, 'refs'), REFS_DIR]]) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    copyDirectoryContents(sourceDir, targetDir);
  }
  store = parsedStore;
  storeVersion = Date.now();
  fs.writeFileSync(DB_FILE, JSON.stringify(store), 'utf8');
  pruneBackups();
  return { ok: true, restored: safeName };
}

function ensureDailyBackup() {
  const today = new Date().toISOString().slice(0, 10);
  if (!listBackups().some(backup => backup.reason === 'auto' && String(backup.createdAt).startsWith(today))) {
    try { createBackup('auto'); } catch (error) { console.error('Automatic backup failed:', error.message); }
  }
}

ensureDailyBackup();
setInterval(ensureDailyBackup, 60 * 60 * 1000).unref();

// ── Helpers ───────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResp(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...CORS });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
};

const EXT_BY_CONTENT_TYPE = {
  'image/jpeg': '.jpg',
  'image/png':  '.png',
  'image/webp': '.webp',
  'image/gif':  '.gif',
};

const OUTPUT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm']);

// ZIP bulk export limits: at most 500 files and 4 GiB - 1 total (ZIP stores
// sizes as uint32, so 0xFFFFFFFF is the hard ceiling per file and in total).
const MAX_ZIP_FILES = 500;
const MAX_ZIP_BYTES = 0xFFFFFFFF;

function makeSafeFilename(baseName, fallbackExt = '.jpg') {
  const parsed = path.parse(baseName || '');
  const base = (parsed.name || 'ref').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'ref';
  const ext = (parsed.ext || fallbackExt).toLowerCase();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}${ext}`;
}

function readJsonStore(key, fallback) {
  try {
    const raw = store[key]?.value;
    if (raw === undefined || raw === null || raw === '') return fallback;
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch { return raw; }
  } catch {
    return fallback;
  }
}

function writeJsonStore(key, value) {
  store[key] = { value: JSON.stringify(value), updated_at: Date.now() };
  persistStore();
}

function outputFilename(value) {
  try {
    const pathname = url.parse(String(value || '')).pathname || '';
    return path.basename(decodeURIComponent(pathname));
  } catch {
    return '';
  }
}

function localOutputFilename(value) {
  try {
    const parsed = url.parse(String(value || ''));
    if (parsed.protocol || parsed.host) return '';
    const pathname = decodeURIComponent(parsed.pathname || '');
    if (!pathname.startsWith('/outputs/')) return '';
    const filename = pathname.slice('/outputs/'.length);
    if (!filename || filename.includes('/') || filename.includes('\\')) return '';
    return path.basename(filename);
  } catch {
    return '';
  }
}

function historyPromptText(item) {
  const prompt = String(item?.promptFull || item?.prompt || '').trim();
  if (item?.promptUnavailable || (item?.model === 'Recovered' && prompt === 'Recovered from server output')) return '';
  return prompt;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function sanitizeZipName(raw) {
  const safe = String(raw || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80).trim();
  if (!safe) return 'outputs.zip';
  return /\.zip$/i.test(safe) ? safe : safe + '.zip';
}

function httpCall(method, fullUrl, headers = {}, body = '') {
  return new Promise((resolve) => {
    const req = https.request(fullUrl, { method, headers }, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode, body: text });
      });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, body: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

function parseXaiResponse(text) {
  const data = JSON.parse(text || '{}');
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (!Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (typeof part.text === 'string' && part.text.trim()) return part.text.trim();
      }
    }
  }
  if (Array.isArray(data.choices) && data.choices[0]?.message?.content) {
    return String(data.choices[0].message.content).trim();
  }
  return '';
}

async function atlasDeletePrediction(predictionId, apiKey) {
  if (!predictionId || !apiKey) return { ok: false, tried: [] };
  const id = encodeURIComponent(predictionId);
  const auth = { Authorization: `Bearer ${apiKey}` };
  const payload = JSON.stringify({ request_id: predictionId, prediction_id: predictionId, id: predictionId });

  const attempts = [
    { method: 'DELETE', url: `https://api.atlascloud.ai/api/v1/model/prediction/${id}`, headers: auth, body: '' },
    { method: 'DELETE', url: `https://api.atlascloud.ai/api/v1/model/result/${id}`, headers: auth, body: '' },
    { method: 'POST',   url: `https://api.atlascloud.ai/api/v1/model/prediction/${id}/delete`, headers: { ...auth, 'Content-Type': 'application/json' }, body: payload },
    { method: 'POST',   url: `https://api.atlascloud.ai/api/v1/model/result/${id}/delete`, headers: { ...auth, 'Content-Type': 'application/json' }, body: payload },
  ];

  const tried = [];
  for (const a of attempts) {
    const r = await httpCall(a.method, a.url, a.headers, a.body);
    tried.push({ method: a.method, url: a.url, status: r.status });
    // Treat 2xx as success, and 404 as "already gone / unavailable to query"
    if (r.ok || r.status === 404) return { ok: true, tried };
  }
  return { ok: false, tried };
}

function serveFile(res, filePath) {
  try {
    const stat = fs.statSync(filePath);
    const ext  = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type':   MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control':  ext === '.html' ? 'no-cache' : 'public, max-age=31536000',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch { res.writeHead(404); res.end('Not found'); }
}

// ── Download a URL and save to disk ──────────────────────────────────────────
function downloadToFile(fileUrl, destPath) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(fileUrl);
    } catch {
      reject(new Error('Invalid output URL'));
      return;
    }

    const proto = parsedUrl.protocol === 'https:' ? https : parsedUrl.protocol === 'http:' ? http : null;
    if (!proto) {
      reject(new Error('Output URL must use HTTP or HTTPS'));
      return;
    }

    const tempPath = `${destPath}.part-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const file = fs.createWriteStream(tempPath);
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      file.destroy();
      fs.unlink(tempPath, () => reject(error));
    };

    file.on('error', fail);
    const request = proto.get(parsedUrl, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        fail(new Error('HTTP ' + response.statusCode));
        return;
      }
      response.on('error', fail);
      response.pipe(file);
      file.on('finish', () => {
        file.close((closeError) => {
          if (closeError) return fail(closeError);
          fs.rename(tempPath, destPath, (renameError) => {
            if (renameError) return fail(renameError);
            settled = true;
            resolve();
          });
        });
      });
    });
    request.on('error', fail);
    request.setTimeout(300000, () => request.destroy(new Error('Output download timed out')));
  });
}

// ── Router ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  // ── Store version (for polling) ──────────────────────────────────────────
  // GET /api/version — returns current storeVersion timestamp
  if (pathname === '/api/version' && req.method === 'GET') {
    return jsonResp(res, 200, { version: storeVersion });
  }

  if (pathname === '/api/backups' && req.method === 'GET') {
    return jsonResp(res, 200, { backups: listBackups(), retention: BACKUP_RETENTION });
  }

  if (pathname === '/api/backups' && req.method === 'POST') {
    try { return jsonResp(res, 200, { ok: true, backup: createBackup('manual') }); }
    catch (error) { return jsonResp(res, 500, { error: error.message }); }
  }

  if (pathname === '/api/backups/restore' && req.method === 'POST') {
    try {
      const { name, confirm } = JSON.parse(await readBody(req) || '{}');
      if (confirm !== 'RESTORE') return jsonResp(res, 400, { error: 'Restore confirmation missing' });
      return jsonResp(res, 200, restoreBackup(name));
    } catch (error) { return jsonResp(res, 500, { error: error.message }); }
  }

  // ── Key-value store ──────────────────────────────────────────────────────
  if (pathname === '/api/store' && req.method === 'GET') {
    const keys = Object.entries(store).map(([k, v]) => ({ key: k, updated_at: v.updated_at }));
    return jsonResp(res, 200, { keys });
  }

  if (pathname.startsWith('/api/store/') && req.method === 'GET') {
    const key   = decodeURIComponent(pathname.slice('/api/store/'.length));
    const entry = store[key];
    if (!entry) return jsonResp(res, 404, { error: 'Not found' });
    return jsonResp(res, 200, { key, value: entry.value });
  }

  if (pathname.startsWith('/api/store/') && req.method === 'POST') {
    const key = decodeURIComponent(pathname.slice('/api/store/'.length));
    try {
      const body    = await readBody(req);
      const { value } = JSON.parse(body);
      if (value === undefined) return jsonResp(res, 400, { error: 'Missing value' });
      store[key] = { value: typeof value === 'string' ? value : JSON.stringify(value), updated_at: Date.now() };
      persistStore();
      return jsonResp(res, 200, { ok: true, key });
    } catch (e) { return jsonResp(res, 400, { error: e.message }); }
  }

  if (pathname.startsWith('/api/store/') && req.method === 'DELETE') {
    const key = decodeURIComponent(pathname.slice('/api/store/'.length));
    delete store[key];
    persistStore();
    return jsonResp(res, 200, { ok: true, key });
  }

  // Generate a polished image/video prompt with xAI.
  // POST /api/xai/prompt { idea, mode, targetModel, token? }
  if (pathname === '/api/xai/prompt' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { idea, mode, targetModel, token } = JSON.parse(body || '{}');
      const xaiToken = String(token || readJsonStore('xaiAuthToken', '') || '').trim();
      const seed = String(idea || '').trim();
      if (!xaiToken) return jsonResp(res, 400, { error: 'Missing xAI auth token' });
      if (!seed) return jsonResp(res, 400, { error: 'Missing prompt idea' });

      const kind = mode === 'video' ? 'video' : 'image';
      const payload = JSON.stringify({
        model: 'grok-4.3',
        input: [
          {
            role: 'system',
            content: [
              'You write production-ready prompts for generative image and video models.',
              'Return only one final prompt, no markdown, no bullets, no explanation.',
              'Make it vivid, specific, visual, and usable as-is.',
              kind === 'video'
                ? 'Include camera movement, subject motion, pacing, lighting, and scene continuity.'
                : 'Include subject, composition, lighting, lens/style, material detail, and mood.',
            ].join(' '),
          },
          {
            role: 'user',
            content: `Create a ${kind} generation prompt for model "${targetModel || 'default'}" from this idea: ${seed}`,
          },
        ],
      });

      const xaiResp = await httpCall('POST', 'https://api.x.ai/v1/responses', {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${xaiToken}`,
      }, payload);

      let prompt = '';
      try { prompt = parseXaiResponse(xaiResp.body); } catch {}
      if (!xaiResp.ok || !prompt) {
        return jsonResp(res, xaiResp.ok ? 502 : xaiResp.status || 502, {
          error: prompt ? 'xAI request failed' : 'xAI response did not contain prompt text',
          status: xaiResp.status,
          details: xaiResp.body?.slice(0, 1000) || '',
        });
      }
      return jsonResp(res, 200, { ok: true, prompt });
    } catch (e) {
      return jsonResp(res, 400, { error: e.message });
    }
  }

  // ── fal.ai proxy (MiniMax H3 Max etc.) ─────────────────────────────────────
  // The fal key is resolved server-side (store key 'falApiKey' or FAL_KEY env)
  // and is never exposed to the browser. Endpoints are whitelisted and request
  // ids sanitized to keep this proxy strictly scoped.
  const FAL_QUEUE_BASE = 'https://queue.fal.run';
  const FAL_ENDPOINTS = new Set([
    'minimax/h3-max/text-to-video',
    'minimax/h3-max/image-to-video',
  ]);

  function falKeyFor(body) {
    return String((body && body.token) || readJsonStore('falApiKey', '') || process.env.FAL_KEY || '').trim();
  }

  function falEndpointFrom(url) {
    const endpoint = String(url || '').trim().replace(/^\//, '').replace(/\/+$/, '');
    return FAL_ENDPOINTS.has(endpoint) ? endpoint : '';
  }

  function sanitizeRequestId(id) {
    const safe = String(id || '').replace(/[^a-zA-Z0-9-]/g, '');
    if (!safe || safe.length > 80) return '';
    return safe;
  }

  // fal.run hosts queue status/result/cancel under the APP path (first two
  // endpoint segments, e.g. 'minimax/h3-max'), not the full sub-endpoint.
  function falAppBase(endpoint) {
    const parts = String(endpoint || '').split('/').filter(Boolean).slice(0, 2);
    return parts.length === 2 ? parts.join('/') : '';
  }

  if (pathname === '/api/fal/submit' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const endpoint = falEndpointFrom(body.endpoint);
      if (!endpoint) return jsonResp(res, 400, { error: 'Unknown fal endpoint' });
      const key = falKeyFor(body);
      if (!key) return jsonResp(res, 400, { error: 'Missing fal.ai API key' });
      const payload = body.payload && typeof body.payload === 'object' ? JSON.stringify(body.payload) : '{}';
      const result = await httpCall('POST', `${FAL_QUEUE_BASE}/${endpoint}`, {
        'Content-Type': 'application/json',
        'Authorization': `Key ${key}`,
      }, payload);
      if (!result.ok) {
        let message = 'fal submit failed';
        try { message = JSON.parse(result.body).detail?.[0]?.msg || JSON.parse(result.body).error || message; } catch {}
        return jsonResp(res, result.status || 502, { error: message, status: result.status, details: result.body?.slice(0, 1000) || '' });
      }
      let data = {};
      try { data = JSON.parse(result.body || '{}'); } catch {}
      const requestId = String(data.request_id || data.requestId || data.status_url || '').split('/').pop();
      if (!requestId) return jsonResp(res, 502, { error: 'fal submit did not return a request id' });
      return jsonResp(res, 200, { ok: true, requestId });
    } catch (e) {
      return jsonResp(res, 400, { error: e.message });
    }
  }

  if (pathname.startsWith('/api/fal/status/') && req.method === 'GET') {
    try {
      const id = sanitizeRequestId(pathname.slice('/api/fal/status/'.length));
      if (!id) return jsonResp(res, 400, { error: 'Invalid request id' });
      const endpoint = falEndpointFrom(new URL(req.url, 'http://x').searchParams.get('endpoint'));
      if (!endpoint) return jsonResp(res, 400, { error: 'Unknown fal endpoint' });
      const key = falKeyFor(null);
      if (!key) return jsonResp(res, 400, { error: 'Missing fal.ai API key' });
      const result = await httpCall('GET', `${FAL_QUEUE_BASE}/${falAppBase(endpoint)}/requests/${id}/status`, { 'Authorization': `Key ${key}` });
      if (!result.ok) return jsonResp(res, result.status || 502, { error: 'fal status failed', status: result.status });
      const data = JSON.parse(result.body || '{}');
      return jsonResp(res, 200, {
        status: data.status || 'IN_QUEUE',
        queuePosition: data.queue_position,
        logs: data.logs,
      });
    } catch (e) {
      return jsonResp(res, 400, { error: e.message });
    }
  }

  if (pathname.startsWith('/api/fal/result/') && req.method === 'GET') {
    try {
      const id = sanitizeRequestId(pathname.slice('/api/fal/result/'.length));
      if (!id) return jsonResp(res, 400, { error: 'Invalid request id' });
      const endpoint = falEndpointFrom(new URL(req.url, 'http://x').searchParams.get('endpoint'));
      if (!endpoint) return jsonResp(res, 400, { error: 'Unknown fal endpoint' });
      const key = falKeyFor(null);
      if (!key) return jsonResp(res, 400, { error: 'Missing fal.ai API key' });
      // The queue reports COMPLETED slightly before the result is retrievable,
      // so tolerate brief upstream failures and retry a few times.
      const url = `${FAL_QUEUE_BASE}/${falAppBase(endpoint)}/requests/${id}`;
      let result;
      for (let attempt = 0; attempt < 4; attempt++) {
        result = await httpCall('GET', url, { 'Authorization': `Key ${key}` });
        if (result.ok) break;
        await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
      }
      if (!result.ok) return jsonResp(res, result.status || 502, { error: 'fal result failed', status: result.status, details: result.body?.slice(0, 1000) || '' });
      return jsonResp(res, 200, JSON.parse(result.body || '{}'));
    } catch (e) {
      return jsonResp(res, 400, { error: e.message });
    }
  }

  if (pathname === '/api/fal/cancel' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const id = sanitizeRequestId(body.requestId);
      const endpoint = falEndpointFrom(body.endpoint);
      if (!id) return jsonResp(res, 400, { error: 'Invalid request id' });
      if (!endpoint) return jsonResp(res, 400, { error: 'Unknown fal endpoint' });
      const key = falKeyFor(body);
      if (!key) return jsonResp(res, 400, { error: 'Missing fal.ai API key' });
      const result = await httpCall('POST', `${FAL_QUEUE_BASE}/${falAppBase(endpoint)}/requests/${id}/cancel`, { 'Authorization': `Key ${key}` }, '');
      return jsonResp(res, result.ok ? 200 : (result.status || 502), { ok: result.ok, status: result.status });
    } catch (e) {
      return jsonResp(res, 400, { error: e.message });
    }
  }

  if (pathname === '/api/store-bulk' && req.method === 'POST') {
    try {
      const body      = await readBody(req);
      const { entries } = JSON.parse(body);
      if (!Array.isArray(entries)) return jsonResp(res, 400, { error: 'entries must be array' });
      const now = Date.now();
      for (const { key, value } of entries) {
        store[key] = { value: typeof value === 'string' ? value : JSON.stringify(value), updated_at: now };
      }
      persistStore();
      return jsonResp(res, 200, { ok: true, count: entries.length });
    } catch (e) { return jsonResp(res, 400, { error: e.message }); }
  }

  // ── Output proxy: save generated image/video to server ──────────────────
  // POST /api/save-output  { url, filename }
  // → downloads the file, saves to data/outputs/, returns { localUrl }
  if (pathname === '/api/save-output' && req.method === 'POST') {
    try {
      const body            = await readBody(req);
      const { url: fileUrl, filename, prompt, metadata } = JSON.parse(body);
      if (!fileUrl || !filename) return jsonResp(res, 400, { error: 'Missing url or filename' });

      // Sanitise filename and only accept formats the Gallery can render.
      const safe = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!OUTPUT_EXTENSIONS.has(path.extname(safe).toLowerCase())) {
        return jsonResp(res, 400, { error: 'Unsupported output file type' });
      }
      const dest    = path.join(OUTPUT_DIR, safe);
      const localUrl = `/outputs/${safe}`;

      const promptText = String(prompt || '').trim();
      if (promptText.length > 50000) {
        return jsonResp(res, 413, { error: 'Prompt is too large' });
      }

      const persistOutputPrompt = () => {
        if (!promptText) return;
        const savedPrompts = readJsonStore('atlasOutputPrompts', {});
        const outputPrompts = savedPrompts && typeof savedPrompts === 'object' && !Array.isArray(savedPrompts)
          ? savedPrompts
          : {};
        if (!Object.hasOwn(outputPrompts, safe)) {
          outputPrompts[safe] = promptText;
          writeJsonStore('atlasOutputPrompts', outputPrompts);
        }
      };

      const persistOutputMetadata = () => {
        const saved = readJsonStore('atlasOutputMeta', {});
        const allMeta = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
        const incoming = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
        const existingMeta = allMeta[safe] || {};
        allMeta[safe] = {
          ...existingMeta,
          ...incoming,
          prompt: String(existingMeta.prompt || promptText || ''),
          createdAt: existingMeta.createdAt || incoming.createdAt || new Date().toISOString(),
        };
        writeJsonStore('atlasOutputMeta', allMeta);
      };

      const activeSave = outputSaveLocks.get(safe);
      if (activeSave) {
        await activeSave;
        persistOutputMetadata();
        return jsonResp(res, 200, { ok: true, localUrl });
      }

      // If already saved, just return
      if (fs.existsSync(dest)) {
        persistOutputPrompt();
        persistOutputMetadata();
        return jsonResp(res, 200, { ok: true, localUrl });
      }

      const download = downloadToFile(fileUrl, dest);
      outputSaveLocks.set(safe, download);
      try {
        await download;
      } finally {
        if (outputSaveLocks.get(safe) === download) outputSaveLocks.delete(safe);
      }
      persistOutputPrompt();
      persistOutputMetadata();
      console.log('Saved output:', safe);
      return jsonResp(res, 200, { ok: true, localUrl });
    } catch (e) {
      console.error('save-output failed:', e.message);
      return jsonResp(res, 500, { error: e.message });
    }
  }

  // Upload reference image as raw bytes and store on server
  // POST /api/upload-ref?filename=foo.jpg
  if (pathname === '/api/upload-ref' && req.method === 'POST') {
    try {
      const rawName = typeof parsed.query.filename === 'string' ? parsed.query.filename : 'ref.jpg';
      const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const fallbackExt = EXT_BY_CONTENT_TYPE[contentType] || '.jpg';
      const safeName = makeSafeFilename(rawName, fallbackExt);
      const dest = path.join(REFS_DIR, safeName);
      const body = await readBodyBuffer(req);
      if (!body.length) return jsonResp(res, 400, { error: 'Empty upload' });
      fs.writeFileSync(dest, body);
      return jsonResp(res, 200, { ok: true, localUrl: `/refs/${safeName}`, filename: safeName });
    } catch (e) {
      return jsonResp(res, 500, { error: e.message });
    }
  }

  // Delete one saved reference image
  // DELETE /api/ref/<filename>
  if (pathname.startsWith('/api/ref/') && req.method === 'DELETE') {
    const filename = path.basename(pathname.slice('/api/ref/'.length));
    const filePath = path.join(REFS_DIR, filename);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return jsonResp(res, 200, { ok: true });
    } catch (e) {
      return jsonResp(res, 500, { error: e.message });
    }
  }

  // ── Insights statistics for the studio dashboard ───────────────────────────
  if (pathname === '/api/stats' && req.method === 'GET') {
    try {
      const savedMeta = readJsonStore('atlasOutputMeta', {});
      const outputMeta = savedMeta && typeof savedMeta === 'object' && !Array.isArray(savedMeta) ? savedMeta : {};
      const byDay = {};
      const byModel = {};
      const byKind = { image: 0, video: 0 };
      const promptCounts = new Map();
      let totalFiles = 0;
      let totalBytes = 0;
      for (const name of fs.readdirSync(OUTPUT_DIR)) {
        if (!OUTPUT_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
        let stat;
        try { stat = fs.statSync(path.join(OUTPUT_DIR, name)); } catch { continue; }
        if (!stat.isFile()) continue;
        totalFiles++;
        totalBytes += stat.size;
        const meta = outputMeta[name] || {};
        const kind = meta.mode === 'video' ? 'video' : 'image';
        byKind[kind] += 1;
        const model = String(meta.model || 'unknown').split('/').pop() || 'unknown';
        byModel[model] = (byModel[model] || 0) + 1;
        const stamp = new Date(meta.createdAt ? Date.parse(meta.createdAt) : stat.mtimeMs);
        const day = isNaN(stamp.getTime()) ? new Date(stat.mtimeMs).toISOString().slice(0, 10) : stamp.toISOString().slice(0, 10);
        byDay[day] = (byDay[day] || 0) + 1;
        const prompt = String(meta.prompt || '').trim().toLowerCase();
        if (prompt) promptCounts.set(prompt, (promptCounts.get(prompt) || 0) + 1);
      }
      const prompts = [...promptCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([prompt, count]) => ({ prompt, count }));
      return jsonResp(res, 200, { totalFiles, totalBytes, byDay, byModel, byKind, topPrompts: prompts, generatedAt: new Date().toISOString() });
    } catch (e) {
      return jsonResp(res, 500, { error: e.message });
    }
  }

  // ── Serve saved output files ─────────────────────────────────────────────
  if (pathname.startsWith('/outputs/')) {
    const filename = outputFilename(pathname); // prevent directory traversal
    return serveFile(res, path.join(OUTPUT_DIR, filename));
  }

  if (pathname.startsWith('/refs/')) {
    const filename = path.basename(pathname); // prevent directory traversal
    return serveFile(res, path.join(REFS_DIR, filename));
  }

  // ── Health ───────────────────────────────────────────────────────────────
  if (pathname === '/api/health') {
    const outputFiles = fs.readdirSync(OUTPUT_DIR).length;
    return jsonResp(res, 200, { ok: true, keys: Object.keys(store).length, outputs: outputFiles, uptime: process.uptime(), instanceToken: INSTANCE_TOKEN });
  }

  if (pathname === '/api/outputs' && req.method === 'GET') {
    try {
      const savedPrompts = readJsonStore('atlasOutputPrompts', {});
      const outputPrompts = savedPrompts && typeof savedPrompts === 'object' && !Array.isArray(savedPrompts)
        ? { ...savedPrompts }
        : {};
      const history = readJsonStore('atlasHistory', []);
      const savedMeta = readJsonStore('atlasOutputMeta', {});
      const outputMeta = savedMeta && typeof savedMeta === 'object' && !Array.isArray(savedMeta) ? savedMeta : {};
      if (Array.isArray(history)) {
        for (const item of history) {
          const prompt = historyPromptText(item);
          if (!prompt) continue;
          const candidates = [
            item?.thumb,
            item?.videoUrl,
            ...(Array.isArray(item?.outputs) ? item.outputs : []),
          ];
          for (const candidate of candidates) {
            const name = localOutputFilename(candidate);
            if (name && !outputPrompts[name]) outputPrompts[name] = prompt;
          }
        }
      }

      const files = fs.readdirSync(OUTPUT_DIR)
        .map(name => {
          const full = path.join(OUTPUT_DIR, name);
          const stat = fs.statSync(full);
          return { name, mtime: stat.mtimeMs, prompt: String(outputPrompts[name] || ''), ...(outputMeta[name] || {}) };
        })
        .filter(f => /\.(png|jpe?g|webp|gif|mp4|webm)$/i.test(f.name))
        .sort((a, b) => b.mtime - a.mtime);
      return jsonResp(res, 200, { files });
    } catch (e) {
      return jsonResp(res, 500, { error: e.message });
    }
  }

  // Bulk export of saved outputs as a ZIP archive (stored, method 0).
  // POST /api/outputs/zip  { files: [names], name?: zipFilename }
  // Streams the archive directly to the client (no in-memory buffering).
  // Invalid or missing files are skipped and reported via X-Seedream-Missing.
  if (pathname === '/api/outputs/zip' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { return jsonResp(res, 400, { error: 'Invalid JSON body' }); }

    const requested = Array.isArray(body.files) ? body.files.map(String).map(s => s.trim()) : [];
    if (!requested.length) return jsonResp(res, 400, { error: 'No files requested' });
    if (requested.length > MAX_ZIP_FILES) return jsonResp(res, 400, { error: `Too many files: max ${MAX_ZIP_FILES} per archive` });

    // Sanitize each name to [a-zA-Z0-9._-] and resolve strictly inside OUTPUT_DIR.
    const entries = [];
    const missing = [];
    for (const raw of requested) {
      const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!safe || safe === '.' || safe === '..') { missing.push(raw); continue; }
      const resolved = path.resolve(OUTPUT_DIR, safe);
      if (resolved !== path.join(OUTPUT_DIR, safe) || path.basename(resolved) !== safe) {
        missing.push(raw); // traversal attempt — never include
        continue;
      }
      let stat;
      try { stat = fs.statSync(resolved); } catch { missing.push(raw); continue; }
      if (!stat.isFile()) { missing.push(raw); continue; }
      entries.push({ name: safe, path: resolved, size: stat.size, mtime: stat.mtime });
    }

    if (!entries.length) {
      return jsonResp(res, 400, { error: 'None of the requested files could be zipped', missing: missing.slice(0, 50) });
    }

    const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (totalBytes > MAX_ZIP_BYTES || entries.some(entry => entry.size > MAX_ZIP_BYTES)) {
      return jsonResp(res, 400, { error: 'Requested files exceed the 4 GiB ZIP limit' });
    }

    const zipName = sanitizeZipName(body.name);
    const headers = {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipName}"`,
      'X-Seedream-Included': String(entries.length),
      ...CORS,
    };
    if (missing.length) {
      const summary = missing.slice(0, 20).join(', ') + (missing.length > 20 ? ` (+${missing.length - 20} more)` : '');
      headers['X-Seedream-Missing'] = summary;
    }
    res.writeHead(200, headers);
    try {
      await zip.streamZip(res, entries);
    } catch (error) {
      console.error('zip stream failed:', error.message);
      if (res.headersSent) return res.destroy();
      return jsonResp(res, 500, { error: error.message });
    }
    return;
  }

  // Duplicate finder: group outputs by SHA-256 (size buckets first, then hash).
  // GET /api/duplicates → { groups, scanned, duplicateBytes } (no singletons)
  if (pathname === '/api/duplicates' && req.method === 'GET') {
    try {
      const savedMeta = readJsonStore('atlasOutputMeta', {});
      const outputMeta = savedMeta && typeof savedMeta === 'object' && !Array.isArray(savedMeta) ? savedMeta : {};
      const savedPrompts = readJsonStore('atlasOutputPrompts', {});
      const outputPrompts = savedPrompts && typeof savedPrompts === 'object' && !Array.isArray(savedPrompts) ? savedPrompts : {};

      const bySize = new Map();
      let scanned = 0;
      for (const name of fs.readdirSync(OUTPUT_DIR)) {
        if (!OUTPUT_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
        let stat;
        try { stat = fs.statSync(path.join(OUTPUT_DIR, name)); } catch { continue; }
        if (!stat.isFile()) continue;
        scanned++;
        const bucket = bySize.get(stat.size);
        if (bucket) bucket.push(name); else bySize.set(stat.size, [name]);
      }

      const groups = [];
      let duplicateBytes = 0;
      for (const [size, names] of bySize) {
        if (names.length < 2) continue;
        const byHash = new Map();
        for (const name of names) {
          let hash;
          try { hash = await sha256File(path.join(OUTPUT_DIR, name)); } catch { continue; }
          const bucket = byHash.get(hash);
          if (bucket) bucket.push(name); else byHash.set(hash, [name]);
        }
        for (const [hash, hashNames] of byHash) {
          if (hashNames.length < 2) continue;
          const files = hashNames.map(name => {
            const meta = outputMeta[name] || {};
            let stat;
            try { stat = fs.statSync(path.join(OUTPUT_DIR, name)); } catch { stat = { size, mtimeMs: 0 }; }
            return {
              name,
              size: stat.size,
              mtime: stat.mtimeMs,
              meta: {
                prompt: String(meta.prompt || outputPrompts[name] || ''),
                model: meta.model || '',
                mode: meta.mode || '',
                album: meta.album || '',
                favorite: Boolean(meta.favorite),
                createdAt: meta.createdAt || '',
              },
            };
          }).sort((a, b) => a.mtime - b.mtime);
          duplicateBytes += size * (files.length - 1);
          groups.push({ hash, size, files });
        }
      }
      groups.sort((a, b) => b.size - a.size);
      return jsonResp(res, 200, { groups, scanned, duplicateBytes });
    } catch (e) {
      return jsonResp(res, 500, { error: e.message });
    }
  }

  if (pathname.startsWith('/api/output-meta/') && req.method === 'POST') {
    const filename = outputFilename(pathname.slice('/api/output-meta/'.length));
    if (!filename) return jsonResp(res, 400, { error: 'Missing filename' });
    try {
      const patch = JSON.parse(await readBody(req) || '{}');
      const saved = readJsonStore('atlasOutputMeta', {});
      const allMeta = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
      allMeta[filename] = { ...(allMeta[filename] || {}), ...patch, updatedAt: new Date().toISOString() };
      writeJsonStore('atlasOutputMeta', allMeta);
      return jsonResp(res, 200, { ok: true, metadata: allMeta[filename] });
    } catch (error) { return jsonResp(res, 400, { error: error.message }); }
  }

  if (pathname === '/api/atlas/cancel' && req.method === 'POST') {
    try {
      const { predictionId } = JSON.parse(await readBody(req) || '{}');
      if (!predictionId) return jsonResp(res, 400, { error: 'Missing prediction ID' });
      const apiKey = String(readJsonStore('atlasApiKey', '') || '');
      if (!apiKey) return jsonResp(res, 400, { error: 'Missing Atlas API key' });
      const result = await atlasDeletePrediction(predictionId, apiKey);
      return jsonResp(res, result.ok ? 200 : 502, { ok: result.ok, attempts: result.tried });
    } catch (error) { return jsonResp(res, 400, { error: error.message }); }
  }

  // Delete one saved output file and scrub history references.
  // Attempts Atlas deletion when prediction IDs are present in history.
  // DELETE /api/output/<filename>
  if (pathname.startsWith('/api/output/') && req.method === 'DELETE') {
    const filename = outputFilename(pathname.slice('/api/output/'.length));
    if (!filename) return jsonResp(res, 400, { error: 'Missing filename' });
    const filePath = path.join(OUTPUT_DIR, filename);

    let localDeleted = false;
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        localDeleted = true;
      }
    } catch (e) {
      return jsonResp(res, 500, { error: e.message });
    }

    let promptMetadataDeleted = false;
    const savedPrompts = readJsonStore('atlasOutputPrompts', {});
    if (savedPrompts && typeof savedPrompts === 'object' && !Array.isArray(savedPrompts) && Object.hasOwn(savedPrompts, filename)) {
      delete savedPrompts[filename];
      writeJsonStore('atlasOutputPrompts', savedPrompts);
      promptMetadataDeleted = true;
    }

    const savedMeta = readJsonStore('atlasOutputMeta', {});
    if (savedMeta && typeof savedMeta === 'object' && !Array.isArray(savedMeta) && Object.hasOwn(savedMeta, filename)) {
      delete savedMeta[filename];
      writeJsonStore('atlasOutputMeta', savedMeta);
    }

    const history = readJsonStore('atlasHistory', []);
    const touchedPredictions = new Set();
    let changed = false;
    let removedRefs = 0;

    if (Array.isArray(history)) {
      const next = [];
      for (const item of history) {
        const outputs = Array.isArray(item.outputs) ? item.outputs.slice() : [];
        const beforeLen = outputs.length;
        const filtered = outputs.filter(u => localOutputFilename(u) !== filename);
        if (filtered.length !== beforeLen) {
          changed = true;
          removedRefs += (beforeLen - filtered.length);
          if (item.predictionId) touchedPredictions.add(item.predictionId);
        }

        const thumbWasDeleted = localOutputFilename(item.thumb) === filename;
        const videoWasDeleted = localOutputFilename(item.videoUrl) === filename;

        if (!filtered.length && (thumbWasDeleted || videoWasDeleted || beforeLen > 0)) {
          changed = true;
          if (item.predictionId) touchedPredictions.add(item.predictionId);
          continue;
        }

        const nextItem = { ...item, outputs: filtered };
        if (thumbWasDeleted) nextItem.thumb = filtered[0] || '';
        if (videoWasDeleted) nextItem.videoUrl = filtered.find(u => /\.(mp4|webm)$/i.test(u)) || '';
        next.push(nextItem);
      }
      if (changed) writeJsonStore('atlasHistory', next);
    }

    let atlasAttempted = 0;
    let atlasDeleted = 0;
    const atlasTried = [];
    const apiKey = String(readJsonStore('atlasApiKey', '') || '');
    if (apiKey && touchedPredictions.size) {
      for (const predictionId of touchedPredictions) {
        atlasAttempted++;
        const rs = await atlasDeletePrediction(predictionId, apiKey);
        atlasTried.push({ predictionId, attempts: rs.tried });
        if (rs.ok) atlasDeleted++;
      }
    }

    return jsonResp(res, 200, {
      ok: true,
      localDeleted,
      promptMetadataDeleted,
      historyRefsRemoved: removedRefs,
      atlasAttempted,
      atlasDeleted,
      note: atlasAttempted && !atlasDeleted ? 'Atlas delete endpoint is likely unsupported or different; local delete still succeeded.' : '',
      atlasTried,
    });
  }

  // ── Static app ───────────────────────────────────────────────────────────
  if (pathname === '/' || pathname === '/index.html') {
    return serveFile(res, path.join(__dirname, 'public', 'index.html'));
  }

  if (pathname === '/gallery' || pathname === '/gallery.html') {
    return serveFile(res, path.join(__dirname, 'public', 'gallery.html'));
  }

  const staticPath = path.join(__dirname, 'public', pathname);
  if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    return serveFile(res, staticPath);
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  const ips  = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  console.log('\n=== Seedream Studio Server v2 ===');
  console.log('Local:   http://localhost:' + PORT);
  ips.forEach(ip => console.log('Network: http://' + ip + ':' + PORT));
  console.log('Outputs: ' + OUTPUT_DIR);
  console.log('=================================\n');
});

process.on('SIGINT',  () => { persistStore(); setTimeout(() => process.exit(0), 300); });
process.on('SIGTERM', () => { persistStore(); setTimeout(() => process.exit(0), 300); });
