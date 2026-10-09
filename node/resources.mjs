import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInflate, createInflateRaw } from 'node:zlib';
import { Readable } from 'node:stream';
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

export const DEFAULT_LIMITS = Object.freeze({ maxEntries: 10000, maxEntryBytes: 256 * 1024 ** 2, maxTotalBytes: 1024 ** 3 });
export function limitsFor(options = {}) {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(limits)) {
    const value = options[key] ?? options.limits?.[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_LIMITS[key]) throw new Error(`Invalid ${key}: limits may only be lowered.`);
      limits[key] = value;
    }
  }
  return limits;
}
export function diagnostic(code, message, affectsFidelity = false, details = {}) {
  return { ...details, code, message, affectsFidelity };
}
export function resourceError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details, ...details });
}
export function normalizeName(name) {
  if (typeof name !== 'string' || name.includes('\0')) throw resourceError('INVALID_RESOURCE_PATH', 'Invalid resource path.');
  return path.posix.normalize(name.replaceAll('\\', '/').normalize('NFC')).replace(/^\.\//, '');
}
const keyOf = name => normalizeName(name).toLowerCase();
const inside = (root, file) => { const relative = path.relative(root, file); return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };
function archiveName(name) {
  const normalized = normalizeName(name);
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized === '..' || normalized.startsWith('../')) throw resourceError('ZIP_PATH_ESCAPE', `Unsafe archive path: ${name}`);
  return normalized;
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Index central directory first; inflate lazily with actual output accounting. Never extract to disk. */
export class ZipIndex {
  constructor(bytes, options = {}) {
    this.bytes = bytes; this.limits = limitsFor(options); this.entries = new Map(); this.totalBytes = 0; this.cache = new Map();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const requireRange = (offset, length) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > bytes.length) throw resourceError('INVALID_ZIP', 'Truncated ZIP structure.');
    };
    let end = -1;
    for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
      if (view.getUint32(p, true) === 0x06054b50 && p + 22 + view.getUint16(p + 20, true) === bytes.length) { end = p; break; }
    }
    if (end < 0) throw resourceError('INVALID_ZIP', 'ZIP end directory not found.');
    const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), offset = view.getUint32(end + 16, true);
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || count === 65535 || size === 0xffffffff || offset === 0xffffffff) throw resourceError('UNSUPPORTED_ZIP', 'Multi-disk and ZIP64 archives are not supported.');
    if (count > this.limits.maxEntries) throw resourceError('ZIP_ENTRY_LIMIT', 'ZIP has too many entries.');
    requireRange(offset, size);
    if (offset + size > end) throw resourceError('INVALID_ZIP', 'Overlapping ZIP directory.');
    let p = offset, declaredTotal = 0;
    const names = new Set();
    for (let i = 0; i < count; i++) {
      requireRange(p, 46);
      if (view.getUint32(p, true) !== 0x02014b50) throw resourceError('INVALID_ZIP', 'Invalid central directory signature.');
      const flags = view.getUint16(p + 8, true), method = view.getUint16(p + 10, true);
      const compressed = view.getUint32(p + 20, true), uncompressed = view.getUint32(p + 24, true);
      const length = view.getUint16(p + 28, true), extra = view.getUint16(p + 30, true), comment = view.getUint16(p + 32, true), local = view.getUint32(p + 42, true);
      requireRange(p + 46, length + extra + comment);
      if (flags & 1 || ![0, 8].includes(method) || compressed === 0xffffffff || uncompressed === 0xffffffff || local === 0xffffffff || view.getUint16(p + 34, true)) throw resourceError('UNSUPPORTED_ZIP', 'Encrypted, ZIP64, multi-disk or unsupported compressed ZIP entry.');
      const rawName = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(p + 46, p + 46 + length));
      if (!(flags & 2048) && /[^\x00-\x7f]/.test(rawName)) {
        // UTF-8 archives without the language flag are common. Invalid UTF-8 is rejected, never guessed.
      }
      const name = archiveName(rawName), nameKey = keyOf(name);
      if (names.has(nameKey)) throw resourceError('ZIP_AMBIGUOUS_PATH', `Duplicate or case-colliding ZIP entry: ${name}`);
      names.add(nameKey);
      if ((view.getUint32(p + 38, true) >>> 16 & 0xf000) === 0xa000) throw resourceError('ZIP_SYMLINK', `ZIP symlinks are not permitted: ${name}`);
      declaredTotal += uncompressed;
      if (uncompressed > this.limits.maxEntryBytes || declaredTotal > this.limits.maxTotalBytes) throw resourceError('ZIP_SIZE_LIMIT', 'ZIP declared output exceeds limits.');
      requireRange(local, 30);
      if (view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 8, true) !== method || view.getUint16(local + 6, true) !== flags) throw resourceError('INVALID_ZIP', 'Invalid local entry header.');
      const localLength = view.getUint16(local + 26, true), localExtra = view.getUint16(local + 28, true);
      requireRange(local + 30, localLength + localExtra);
      const localName = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(local + 30, local + 30 + localLength));
      if (localName !== rawName) throw resourceError('INVALID_ZIP', 'Local/central ZIP filenames differ.');
      const start = local + 30 + localLength + localExtra;
      requireRange(start, compressed);
      if (start + compressed > offset) throw resourceError('INVALID_ZIP', 'ZIP entry overlaps central directory.');
      if (!rawName.endsWith('/')) this.entries.set(name, { name, start, compressed, uncompressed, method, crc: view.getUint32(p + 16, true) });
      p += 46 + length + extra + comment;
    }
    if (p !== offset + size) throw resourceError('INVALID_ZIP', 'ZIP central directory size mismatch.');
  }
  async read(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    const entry = this.entries.get(name);
    if (!entry) throw resourceError('RESOURCE_NOT_FOUND', `Archive entry not found: ${name}`);
    const promise = this.inflate(entry);
    this.cache.set(name, promise);
    return promise;
  }
  async inflate(entry) {
    const compressed = this.bytes.subarray(entry.start, entry.start + entry.compressed);
    const stream = entry.method === 8 ? Readable.from((function* () {
      for (let p = 0; p < compressed.length; p += 65536) yield compressed.subarray(p, p + 65536);
    })()).pipe(createInflateRaw({ chunkSize: 65536 })) : Readable.from([compressed]);
    const chunks = []; let size = 0;
    try {
      for await (const chunk of stream) {
        size += chunk.length; this.totalBytes += chunk.length;
        if (size > this.limits.maxEntryBytes || this.totalBytes > this.limits.maxTotalBytes || size > entry.uncompressed) throw resourceError('ZIP_SIZE_LIMIT', `ZIP inflation limit exceeded: ${entry.name}`);
        chunks.push(chunk);
      }
    } finally { stream.destroy(); }
    const bytes = new Uint8Array(Buffer.concat(chunks, size));
    if (size !== entry.uncompressed || crc32(bytes) !== entry.crc) throw resourceError('INVALID_ZIP', `ZIP size/CRC mismatch: ${entry.name}`);
    return bytes;
  }
}

function publicIP(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    const block = new net.BlockList();
    block.addSubnet('2000::', 3, 'ipv6');
    const excluded = new net.BlockList();
    for (const [ip, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) excluded.addSubnet(ip, prefix, 'ipv6');
    return block.check(address, 'ipv6') && !excluded.check(address, 'ipv6');
  }
  return false;
}
/** DNS validated and pinned per request and redirect: no fetch DNS-rebinding window. */
async function networkRead(uri, limits, options, redirects = 0) {
  if (!options.allowNetwork) throw resourceError('NETWORK_DENIED', `Network resource denied: ${uri}`);
  const url = new URL(uri);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw resourceError('NETWORK_DENIED', 'Only public HTTP(S) resources on standard ports are allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicIP(address))) throw resourceError('NETWORK_PRIVATE_ADDRESS', `Non-public address blocked: ${host}`);
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      agent: false, lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy();
        if (!response.headers.location || redirects >= 5) return reject(resourceError('NETWORK_REDIRECT_LIMIT', 'Invalid or excessive redirects.'));
        networkRead(new URL(response.headers.location, url).href, limits, options, redirects + 1).then(resolve, reject); return;
      }
      if (response.statusCode !== 200) { response.destroy(); reject(resourceError('RESOURCE_HTTP_ERROR', `HTTP ${response.statusCode}: ${uri}`)); return; }
      let size = 0; const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > limits.maxEntryBytes) { response.destroy(resourceError('RESOURCE_SIZE_LIMIT', 'Network resource exceeds limit.')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks, size))));
      response.on('error', reject);
    });
    const timer = setTimeout(() => request.destroy(resourceError('NETWORK_TIMEOUT', 'Network resource deadline exceeded.')), options.networkTimeoutMs ?? 30000);
    request.on('close', () => clearTimeout(timer)); request.on('error', reject);
  });
}

export class ResourceResolver {
  constructor(options = {}, warnings = []) {
    this.options = options; this.warnings = warnings; this.limits = limitsFor(options);
    this.virtual = new Map(); this.roots = []; this.cache = new Map(); this.totalBytes = 0; this.entry = '';
  }
  async initialize({ modelPath, resources = {}, zip, entry }) {
    this.zip = zip; this.entry = entry || modelPath || '';
    if (modelPath) { this.modelDir = await fs.realpath(path.dirname(modelPath)); this.roots.push(this.modelDir); }
    for (const dir of this.options.resourceDirs ?? []) this.roots.push(await fs.realpath(path.resolve(dir)));
    this.roots = [...new Set(this.roots)];
    let total = 0;
    for (const [name, bytes] of Object.entries(resources)) {
      if (!(bytes instanceof Uint8Array)) throw new TypeError(`Resource ${name} must be Uint8Array.`);
      const normalized = archiveName(name);
      if ([...this.virtual.keys()].some(existing => keyOf(existing) === keyOf(normalized))) throw resourceError('AMBIGUOUS_RESOURCE', `Duplicate resource: ${name}`);
      total += bytes.length;
      if (bytes.length > this.limits.maxEntryBytes || total > this.limits.maxTotalBytes || this.virtual.size >= this.limits.maxEntries) throw resourceError('RESOURCE_SIZE_LIMIT', 'Supplied resources exceed limits.');
      this.virtual.set(normalized, bytes);
    }
    return this;
  }
  async diskPath(file) {
    let real;
    try { real = await fs.realpath(file); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
    if (!this.roots.some(root => inside(root, real))) throw resourceError('RESOURCE_ACCESS_DENIED', `Resource outside authorized directories: ${file}`);
    return (await fs.stat(real)).isFile() ? real : null;
  }
  async diskIndex() {
    if (this.index) return this.index;
    const files = new Set(); let count = 0;
    const walk = async (dir, depth) => {
      if (depth > 64) throw resourceError('RESOURCE_INDEX_LIMIT', 'Resource directory nesting exceeds limit.');
      for await (const item of await fs.opendir(dir)) {
        if (++count > this.limits.maxEntries) throw resourceError('RESOURCE_INDEX_LIMIT', 'Resource directory scan exceeds entry limit.');
        const file = path.join(dir, item.name);
        if (item.isDirectory()) await walk(file, depth + 1);
        else if (item.isFile()) files.add(file);
      }
    };
    for (const root of this.roots) await walk(root, 0);
    this.index = [...files]; return this.index;
  }
  async readDisk(file) {
    const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    try {
      const actualPath = await fs.realpath(file);
      if (!this.roots.some(root => inside(root, actualPath))) throw resourceError('RESOURCE_ACCESS_DENIED', `Resource moved outside authorized directories: ${file}`);
      const stat = await handle.stat(), pathStat = await fs.stat(actualPath);
      if (stat.ino !== pathStat.ino || stat.dev !== pathStat.dev) throw resourceError('RESOURCE_CHANGED', `Resource changed while opening: ${file}`);
      if (stat.size + this.totalBytes > this.limits.maxTotalBytes) throw resourceError('RESOURCE_SIZE_LIMIT', 'Total resource bytes exceed limit.');
      if (!stat.isFile() || stat.size > this.limits.maxEntryBytes) throw resourceError('RESOURCE_SIZE_LIMIT', `Resource exceeds size limit: ${file}`);
      // Read a fixed bounded allocation; detect growth rather than using unbounded readFile.
      const bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, null); if (!read.bytesRead) break; offset += read.bytesRead; }
      const tail = Buffer.alloc(1);
      if ((await handle.read(tail, 0, 1, null)).bytesRead) throw resourceError('RESOURCE_CHANGED', `Resource grew while reading: ${file}`);
      return new Uint8Array(bytes.subarray(0, offset));
    } finally { await handle.close(); }
  }
  ambiguous(uri, candidates) {
    const issue = diagnostic('AMBIGUOUS_RESOURCE', `Ambiguous resource ${uri}; no arbitrary match selected.`, true, { resource: uri, candidates });
    this.warnings.push(issue); throw resourceError(issue.code, issue.message, { candidates });
  }
  async resolve(uri, base = this.entry, { strict = false } = {}) {
    if (typeof uri !== 'string') throw new TypeError('Resource URI must be a string.');
    const cacheKey = `${base}\0${strict}\0${uri}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    // Serialize reads, not texture decoding: concurrent loaders cannot allocate
    // thousands of entry-sized resources before aggregate accounting catches up.
    const promise = (this.queue || Promise.resolve()).then(() => this.resolveUncached(uri, base, strict)).then(bytes => {
      this.totalBytes += bytes.length;
      if (this.totalBytes > this.limits.maxTotalBytes) throw resourceError('RESOURCE_SIZE_LIMIT', 'Total resource bytes exceed limit.');
      return bytes;
    });
    this.queue = promise.then(() => {}, () => {});
    this.cache.set(cacheKey, promise); return promise;
  }
  async resolveUncached(uri, base, strict) {
    if (uri.startsWith('data:')) {
      const comma = uri.indexOf(',');
      if (comma < 0 || uri.length > this.limits.maxEntryBytes * 4 + 1024) throw resourceError('RESOURCE_SIZE_LIMIT', 'Invalid or oversized data URI.');
      const header = uri.slice(0, comma), payload = uri.slice(comma + 1);
      if (/;base64$/i.test(header) && payload.length > Math.ceil(this.limits.maxEntryBytes / 3) * 4 + 4) throw resourceError('RESOURCE_SIZE_LIMIT', 'Base64 resource exceeds encoded size limit.');
      const bytes = /;base64$/i.test(header) ? new Uint8Array(Buffer.from(payload, 'base64')) : new Uint8Array(Buffer.from(decodeURIComponent(payload)));
      if (bytes.length > this.limits.maxEntryBytes) throw resourceError('RESOURCE_SIZE_LIMIT', 'Data URI exceeds limit.');
      return bytes;
    }
    if (/^https?:\/\//i.test(uri)) return networkRead(uri, { ...this.limits, maxEntryBytes: Math.min(this.limits.maxEntryBytes, this.limits.maxTotalBytes - this.totalBytes) }, this.options);
    if (/^blob:/i.test(uri)) throw resourceError('RESOURCE_ACCESS_DENIED', 'Blob resource must be handled by local adapters.');
    if (/^file:/i.test(uri)) uri = fileURLToPath(uri);
    else if (/^[a-z][a-z0-9+.-]*:/i.test(uri) && !/^[a-z]:[\\/]/i.test(uri)) throw resourceError('RESOURCE_ACCESS_DENIED', `Unsupported resource scheme: ${uri}`);
    let name;
    try { name = normalizeName(decodeURIComponent(uri)); } catch { throw resourceError('INVALID_RESOURCE_PATH', `Invalid escaped resource URI: ${uri}`); }
    const virtualNames = [...(this.zip?.entries.keys() ?? []), ...this.virtual.keys()];
    const readVirtual = match => {
      const size = this.virtual.has(match) ? this.virtual.get(match).length : this.zip.entries.get(match).uncompressed;
      if (size + this.totalBytes > this.limits.maxTotalBytes) throw resourceError('RESOURCE_SIZE_LIMIT', 'Total resource bytes exceed limit.');
      return this.virtual.has(match) ? this.virtual.get(match) : this.zip.read(match);
    };
    const selectVirtual = candidate => {
      const matches = virtualNames.filter(n => keyOf(n) === keyOf(candidate));
      if (matches.length > 1) this.ambiguous(uri, matches);
      return matches[0];
    };
    if (virtualNames.length) {
      const relative = normalizeName(path.posix.join(path.posix.dirname(normalizeName(base)), name));
      for (const candidate of [relative, name]) {
        if (candidate.startsWith('../') || candidate.startsWith('/')) continue;
        const match = selectVirtual(candidate);
        if (match !== undefined) return readVirtual(match);
      }
    }
    if (strict && /^[a-z]:\//i.test(name)) throw resourceError('RESOURCE_ACCESS_DENIED', `Non-local drive path denied: ${uri}`);
    const nativeAbsolute = path.isAbsolute(name);
    if (nativeAbsolute) {
      if (strict && !this.roots.some(root => inside(root, path.resolve(name)))) throw resourceError('RESOURCE_ACCESS_DENIED', `Absolute resource outside authorized directories: ${uri}`);
      if (this.roots.some(root => inside(root, path.resolve(name)))) { const found = await this.diskPath(name); if (found) return this.readDisk(found); }
    } else if (this.roots.length && !/^[a-z]:\//i.test(name)) {
      const baseDir = path.isAbsolute(base) ? path.dirname(base) : this.modelDir;
      const precise = baseDir ? path.resolve(baseDir, name) : null;
      if (strict && precise && !this.roots.some(root => inside(root, precise))) throw resourceError('RESOURCE_ACCESS_DENIED', `Resource traversal outside authorized directories: ${uri}`);
      if (precise && this.roots.some(root => inside(root, precise))) {
        const found = await this.diskPath(precise); if (found) return this.readDisk(found);
      }
      const directoryMatches = new Set();
      for (const candidate of this.roots.map(root => path.resolve(root, name))) {
        if (!this.roots.some(root => inside(root, candidate))) continue;
        const found = await this.diskPath(candidate); if (found) directoryMatches.add(found);
      }
      if (directoryMatches.size > 1) this.ambiguous(uri, [...directoryMatches]);
      if (directoryMatches.size === 1) return this.readDisk([...directoryMatches][0]);
    }
    if (strict && (name === '..' || name.startsWith('../')) && !this.roots.length) throw resourceError('RESOURCE_ACCESS_DENIED', `Archive traversal denied: ${uri}`);
    const disk = this.roots.length ? await this.diskIndex() : [];
    const all = [...virtualNames.map(n => ({ name: n, virtual: true })), ...disk.map(n => ({ name: n, virtual: false }))];
    const baseDir = normalizeName(path.posix.dirname(normalizeName(base)));
    const preciseNames = [normalizeName(path.posix.join(baseDir, name)), name, ...this.roots.map(root => normalizeName(path.join(root, name)))];
    let matches = all.filter(item => preciseNames.some(n => keyOf(item.name) === keyOf(n)));
    const basename = path.posix.basename(name).toLowerCase();
    if (!matches.length) {
      const conventional = ['textures', 'texture', 'maps', 'images', 'materials'];
      matches = all.filter(item => path.posix.basename(normalizeName(item.name)).toLowerCase() === basename && conventional.includes(path.posix.basename(path.posix.dirname(normalizeName(item.name))).toLowerCase()));
    }
    if (!matches.length) matches = all.filter(item => path.posix.basename(normalizeName(item.name)).toLowerCase() === basename);
    if (matches.length > 1) this.ambiguous(uri, matches.map(item => item.name));
    if (!matches.length) throw resourceError('RESOURCE_NOT_FOUND', `Resource not found: ${uri}`, { resource: uri });
    this.warnings.push(diagnostic('RESOURCE_FALLBACK', `Resolved ${uri} to ${matches[0].name}.`, true, { resource: uri, resolved: matches[0].name }));
    if (matches[0].virtual) return readVirtual(matches[0].name);
    const resolved = await this.diskPath(matches[0].name);
    if (!resolved) throw resourceError('RESOURCE_NOT_FOUND', `Resource disappeared: ${matches[0].name}`);
    return this.readDisk(resolved);
  }
}

/** Validate binary FBX arrays before the official loader's synchronous inflate. */
export async function validateFBXArrays(bytes, options = {}) {
  if (bytes.length < 27 || new TextDecoder().decode(bytes.subarray(0, 18)) !== 'Kaydara FBX Binary') return;
  const limits = limitsFor(options), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(23, true), wide = version >= 7500, header = wide ? 25 : 13;
  let decodedTotal = 0, nodes = 0, properties = 0;
  const range = (offset, size, end = bytes.length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > end) throw resourceError('INVALID_FBX', 'Truncated or invalid binary FBX structure.');
  };
  const integer = offset => {
    const number = wide ? Number(view.getBigUint64(offset, true)) : view.getUint32(offset, true);
    if (!Number.isSafeInteger(number)) throw resourceError('INVALID_FBX', 'FBX offset exceeds safe integer range.');
    return number;
  };
  const sizes = { Y: 2, C: 1, I: 4, F: 4, D: 8, L: 8 };
  const arraySizes = { f: 4, d: 8, l: 8, i: 4, b: 1, c: 1 };
  const node = async (offset, parentEnd, depth) => {
    if (++nodes > 1000000 || depth > 128) throw resourceError('FBX_STRUCTURE_LIMIT', 'FBX node count or nesting exceeds limit.');
    range(offset, header, parentEnd);
    const end = integer(offset), count = integer(offset + (wide ? 8 : 4)), propertyBytes = integer(offset + (wide ? 16 : 8));
    if (end === 0) return offset + header;
    if (end <= offset + header || end > parentEnd) throw resourceError('INVALID_FBX', 'Invalid FBX node end offset.');
    const nameLength = view.getUint8(offset + header - 1);
    let p = offset + header + nameLength;
    range(offset + header, nameLength, end); range(p, propertyBytes, end);
    const propertyEnd = p + propertyBytes;
    properties += count;
    if (properties > 10000000) throw resourceError('FBX_STRUCTURE_LIMIT', 'FBX property count exceeds limit.');
    for (let i = 0; i < count; i++) {
      range(p, 1, propertyEnd);
      const type = String.fromCharCode(view.getUint8(p++));
      if (sizes[type]) { range(p, sizes[type], propertyEnd); p += sizes[type]; continue; }
      if (type === 'S' || type === 'R') {
        range(p, 4, propertyEnd); const length = view.getUint32(p, true); p += 4;
        range(p, length, propertyEnd); p += length;
        if (length > limits.maxEntryBytes) throw resourceError('FBX_SIZE_LIMIT', 'FBX string/raw property exceeds limit.');
      } else if (arraySizes[type]) {
        range(p, 12, propertyEnd);
        const count = view.getUint32(p, true), encoding = view.getUint32(p + 4, true), compressedLength = view.getUint32(p + 8, true);
        const expected = count * arraySizes[type]; p += 12;
        decodedTotal += expected;
        if (expected > limits.maxEntryBytes || decodedTotal > limits.maxTotalBytes) throw resourceError('FBX_SIZE_LIMIT', 'FBX decoded arrays exceed limits.');
        if (encoding === 0) { range(p, expected, propertyEnd); p += expected; }
        else if (encoding === 1) {
          range(p, compressedLength, propertyEnd);
          const input = bytes.subarray(p, p + compressedLength);
          const stream = Readable.from((function* () { for (let n = 0; n < input.length; n += 65536) yield input.subarray(n, n + 65536); })()).pipe(createInflate({ chunkSize: 65536 }));
          let actual = 0;
          try {
            for await (const chunk of stream) {
              actual += chunk.length;
              if (actual > expected || actual > limits.maxEntryBytes) throw resourceError('FBX_SIZE_LIMIT', 'FBX inflate output exceeds declared size or limit.');
            }
          } finally { stream.destroy(); }
          if (actual !== expected) throw resourceError('INVALID_FBX', 'FBX array inflate size mismatch.');
          p += compressedLength;
        } else throw resourceError('INVALID_FBX', 'Unsupported FBX array encoding.');
      } else throw resourceError('INVALID_FBX', `Unknown FBX property type: ${type}`);
    }
    if (p !== propertyEnd) throw resourceError('INVALID_FBX', 'FBX property list length mismatch.');
    while (p < end) p = await node(p, end, depth + 1);
    return end;
  };
  let p = 27;
  // Mirror the official loader's footer boundary, including null records. A
  // malicious null record must not hide compressed nodes later in the stream.
  while (p + header <= bytes.length && (bytes.length % 16 === 0 ? ((p + 176) & ~15) < bytes.length : p + 176 < bytes.length)) {
    p = await node(p, bytes.length, 0);
  }
}
