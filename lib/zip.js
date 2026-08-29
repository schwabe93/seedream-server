'use strict';
/**
 * Minimal streaming ZIP writer (stored entries only, method 0).
 *
 * Dependency-free: uses only node:fs and node:stream. Streams entry bytes
 * straight to the HTTP response while computing CRC-32 on the fly; local file
 * headers carry a data-descriptor flag so the central directory can be
 * appended once all sizes/CRCs are known. Nothing is buffered in memory.
 */

const fs = require('fs');

// ── CRC-32 (IEEE 802.3, same table as zlib) ─────────────────────────────────
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}

/**
 * Incremental CRC-32. Pass the previous return value as `crc` to continue.
 * crc32(buf) computes the CRC of `buf`; crc32(buf2, crc32(buf1)) computes the
 * CRC of the concatenation.
 */
function crc32(buf, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date && !isNaN(date) ? date : new Date();
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() & 0x3e) >>> 1);
  const day = ((Math.max(0, d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time: time & 0xffff, date: day & 0xffff };
}

// Local file header with bit 3 set (sizes/CRC delivered in a data descriptor).
function localHeader(entry) {
  const nameBuf = Buffer.from(entry.name, 'utf8');
  const { time, date } = dosDateTime(entry.mtime);
  const flags = 0x0008 | (nameBuf.length !== entry.name.length ? 0x0800 : 0); // data descriptor (+ UTF-8 when needed)
  const buf = Buffer.alloc(30 + nameBuf.length);
  buf.writeUInt32LE(0x04034b50, 0); // local file header signature
  buf.writeUInt16LE(20, 4);         // version needed
  buf.writeUInt16LE(flags, 6);
  buf.writeUInt16LE(0, 8);          // method: stored
  buf.writeUInt16LE(time, 10);
  buf.writeUInt16LE(date, 12);
  buf.writeUInt32LE(0, 14);         // crc placeholder (in data descriptor)
  buf.writeUInt32LE(0, 18);         // compressed size placeholder
  buf.writeUInt32LE(0, 22);         // uncompressed size placeholder
  buf.writeUInt16LE(nameBuf.length, 26);
  buf.writeUInt16LE(0, 28);         // extra field length
  nameBuf.copy(buf, 30);
  return buf;
}

function dataDescriptor(crc, size) {
  const buf = Buffer.alloc(16);
  buf.writeUInt32LE(0x08074b50, 0); // data descriptor signature
  buf.writeUInt32LE(crc >>> 0, 4);
  buf.writeUInt32LE(size >>> 0, 8);
  buf.writeUInt32LE(size >>> 0, 12);
  return buf;
}

function centralHeader(entry, localOffset) {
  const nameBuf = Buffer.from(entry.name, 'utf8');
  const { time, date } = dosDateTime(entry.mtime);
  const flags = 0x0008 | (nameBuf.length !== entry.name.length ? 0x0800 : 0);
  const buf = Buffer.alloc(46 + nameBuf.length);
  buf.writeUInt32LE(0x02014b50, 0); // central directory signature
  buf.writeUInt16LE(0x0314, 4);     // version made by (UNIX, 2.0)
  buf.writeUInt16LE(20, 6);         // version needed
  buf.writeUInt16LE(flags, 8);
  buf.writeUInt16LE(0, 10);         // method: stored
  buf.writeUInt16LE(time, 12);
  buf.writeUInt16LE(date, 14);
  buf.writeUInt32LE(entry.crc >>> 0, 16);
  buf.writeUInt32LE(entry.size >>> 0, 20);
  buf.writeUInt32LE(entry.size >>> 0, 24);
  buf.writeUInt16LE(nameBuf.length, 28);
  buf.writeUInt16LE(0, 30);         // extra field length
  buf.writeUInt16LE(0, 32);         // comment length
  buf.writeUInt16LE(0, 34);         // disk number start
  buf.writeUInt16LE(0, 36);         // internal file attributes
  buf.writeUInt32LE(0, 38);         // external file attributes
  buf.writeUInt32LE(localOffset >>> 0, 42);
  nameBuf.copy(buf, 46);
  return buf;
}

function endOfCentralDirectory(entryCount, cdSize, cdOffset) {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(0x06054b50, 0); // EOCD signature
  buf.writeUInt16LE(0, 4);          // disk number
  buf.writeUInt16LE(0, 6);          // disk with central directory
  buf.writeUInt16LE(entryCount, 8); // entries on this disk
  buf.writeUInt16LE(entryCount, 10);
  buf.writeUInt32LE(cdSize >>> 0, 12);
  buf.writeUInt32LE(cdOffset >>> 0, 16);
  buf.writeUInt16LE(0, 20);         // comment length
  return buf;
}

function writeChunk(res, chunk) {
  return new Promise((resolve, reject) => {
    if (res.writableEnded || res.destroyed) {
      reject(new Error('Response closed before zip completed'));
      return;
    }
    if (res.write(chunk)) {
      resolve();
      return;
    }
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('Response closed before zip completed')); };
    const onError = err => { cleanup(); reject(err); };
    const cleanup = () => {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onClose);
      res.removeListener('error', onError);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
  });
}

/**
 * Stream a stored-method ZIP archive to `res`.
 *
 * @param {http.ServerResponse} res
 * @param {Array<{name: string, path: string, size: number, mtime: Date}>} entries
 *   File metadata must be stat'd by the caller before the stream starts; the
 *   writer streams each file from disk while hashing it.
 * @returns {Promise<void>} resolves once the central directory + EOCD are
 *   flushed, rejects on I/O or client-disconnect errors.
 */
async function streamZip(res, entries) {
  let offset = 0;
  const central = [];

  for (const entry of entries) {
    const localOffset = offset;
    const nameBuf = Buffer.from(entry.name, 'utf8');
    offset += 30 + nameBuf.length;
    await writeChunk(res, localHeader(entry));

    // Stream file bytes into the response while accumulating CRC-32.
    let crc = 0;
    const source = fs.createReadStream(entry.path);
    try {
      for await (const chunk of source) {
        crc = crc32(chunk, crc);
        await writeChunk(res, chunk);
        offset += chunk.length;
      }
    } finally {
      source.destroy();
    }

    const finalCrc = crc >>> 0;
    await writeChunk(res, dataDescriptor(finalCrc, entry.size));
    offset += 16;
    central.push(centralHeader({ ...entry, crc: finalCrc }, localOffset));
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const header of central) {
    await writeChunk(res, header);
    cdSize += header.length;
  }
  await writeChunk(res, endOfCentralDirectory(entries.length, cdSize, cdOffset));
  if (!res.writableEnded && !res.destroyed) res.end();
}

module.exports = { streamZip, crc32 };
