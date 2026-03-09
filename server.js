/**
 * Seedream Studio — Local Network Server v2
 * Pure Node.js + JSON store + output file proxy
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT        = process.env.PORT || 7842;
const DATA_DIR    = path.join(__dirname, 'data');
const DB_FILE     = path.join(DATA_DIR, 'store.json');
const OUTPUT_DIR  = path.join(DATA_DIR, 'outputs');
const REFS_DIR    = path.join(DATA_DIR, 'refs');

fs.mkdirSync(DATA_DIR,   { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(REFS_DIR,   { recursive: true });

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
      'Cache-Control':  'public, max-age=31536000',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch { res.writeHead(404); res.end('Not found'); }
}

// ── Download a URL and save to disk ──────────────────────────────────────────
function downloadToFile(fileUrl, destPath) {
  return new Promise((resolve, reject) => {
    const proto = fileUrl.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(destPath);
    proto.get(fileUrl, (r) => {
      if (r.statusCode !== 200) { reject(new Error('HTTP ' + r.statusCode)); return; }
      r.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (e) => { fs.unlink(destPath, () => {}); reject(e); });
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
      const { url: fileUrl, filename } = JSON.parse(body);
      if (!fileUrl || !filename) return jsonResp(res, 400, { error: 'Missing url or filename' });

      // Sanitise filename
      const safe    = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const dest    = path.join(OUTPUT_DIR, safe);
      const localUrl = `/outputs/${safe}`;

      // If already saved, just return
      if (fs.existsSync(dest)) return jsonResp(res, 200, { ok: true, localUrl });

      await downloadToFile(fileUrl, dest);
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

  // ── Serve saved output files ─────────────────────────────────────────────
  if (pathname.startsWith('/outputs/')) {
    const filename = path.basename(pathname); // prevent directory traversal
    return serveFile(res, path.join(OUTPUT_DIR, filename));
  }

  if (pathname.startsWith('/refs/')) {
    const filename = path.basename(pathname); // prevent directory traversal
    return serveFile(res, path.join(REFS_DIR, filename));
  }

  // ── Health ───────────────────────────────────────────────────────────────
  if (pathname === '/api/health') {
    const outputFiles = fs.readdirSync(OUTPUT_DIR).length;
    return jsonResp(res, 200, { ok: true, keys: Object.keys(store).length, outputs: outputFiles, uptime: process.uptime() });
  }

  if (pathname === '/api/outputs' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(OUTPUT_DIR)
        .map(name => {
          const full = path.join(OUTPUT_DIR, name);
          const stat = fs.statSync(full);
          return { name, mtime: stat.mtimeMs };
        })
        .filter(f => /\.(png|jpe?g|webp|gif|mp4|webm)$/i.test(f.name))
        .sort((a, b) => b.mtime - a.mtime);
      return jsonResp(res, 200, { files });
    } catch (e) {
      return jsonResp(res, 500, { error: e.message });
    }
  }

  // Delete one saved output file and scrub history references.
  // Attempts Atlas deletion when prediction IDs are present in history.
  // DELETE /api/output/<filename>
  if (pathname.startsWith('/api/output/') && req.method === 'DELETE') {
    const filename = path.basename(pathname.slice('/api/output/'.length));
    if (!filename) return jsonResp(res, 400, { error: 'Missing filename' });
    const targetUrl = `/outputs/${filename}`;
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

    const history = readJsonStore('atlasHistory', []);
    const touchedPredictions = new Set();
    let changed = false;
    let removedRefs = 0;

    if (Array.isArray(history)) {
      const next = [];
      for (const item of history) {
        const outputs = Array.isArray(item.outputs) ? item.outputs.slice() : [];
        const beforeLen = outputs.length;
        const filtered = outputs.filter(u => u !== targetUrl);
        if (filtered.length !== beforeLen) {
          changed = true;
          removedRefs += (beforeLen - filtered.length);
          if (item.predictionId) touchedPredictions.add(item.predictionId);
        }

        const thumbWasDeleted = item.thumb === targetUrl;
        const videoWasDeleted = item.videoUrl === targetUrl;

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
