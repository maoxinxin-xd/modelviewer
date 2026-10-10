import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  ResourceResolver, diagnostic, limitsFor, resourceError, validateFBXArrays,
} from './resources.mjs';

const require = createRequire(import.meta.url);
const PACKAGE_VERSION = '0.9.7-p1';
const LOG_LIMIT = 8192;

function redact(text) {
  return text.replace(/(?:https?:\/\/|file:\/\/)[^\s"']+/gi, '[uri]')
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"']+/g, '[path]')
    .replace(/\b(token|password|secret|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, LOG_LIMIT);
}

/** No wrapper import or PATH search. arm64 Darwin uses the packaged x64 via Rosetta. */
export async function resolveFbxBinary(options = {}, runtime = {}) {
  const platform = runtime.platform ?? process.platform;
  const arch = runtime.arch ?? process.arch;
  let binaryPath, binarySource;
  if (options.fbxBinary !== undefined) {
    if (typeof options.fbxBinary !== 'string' || !options.fbxBinary.trim() ||
        options.fbxBinary.includes('\0')) {
      throw resourceError('INVALID_ARGUMENT', 'fbxBinary must be a nonempty executable path.');
    }
    binaryPath = path.resolve(options.fbxBinary);
    binarySource = 'override';
  } else {
    const supported = (platform === 'darwin' && ['x64', 'arm64'].includes(arch)) ||
      (platform === 'linux' && arch === 'x64');
    if (!supported) {
      throw resourceError('FBX_PLATFORM_UNSUPPORTED',
        'Bundled FBX backend supports Darwin and Linux x64.');
    }
    if (platform === 'linux' && process.platform === 'linux' &&
        !process.report.getReport().header.glibcVersionRuntime) {
      throw resourceError('FBX_PLATFORM_UNSUPPORTED', 'Bundled Linux FBX backend requires glibc.');
    }
    let packageFile;
    try { packageFile = require.resolve('fbx2gltf/package.json'); }
    catch { throw resourceError('FBX_BINARY_MISSING', 'Install fbx2gltf@0.9.7-p1.'); }
    const pkg = JSON.parse(await fs.readFile(packageFile, 'utf8'));
    if (!['0.9.7-p1', '0.9.7p1'].includes(pkg.version)) {
      throw resourceError('FBX_BINARY_VERSION', 'Expected fbx2gltf@0.9.7-p1.');
    }
    binaryPath = path.join(path.dirname(packageFile), 'bin',
      platform === 'darwin' ? 'Darwin' : 'Linux', 'FBX2glTF');
    binarySource = 'bundled';
  }
  try {
    if (!(await fs.stat(binaryPath)).isFile()) throw new Error('not a file');
    await fs.access(binaryPath, constants.X_OK);
  } catch {
    throw resourceError('FBX_BINARY_UNAVAILABLE', 'FBX binary is missing or not executable.');
  }
  return {
    backend: 'fbx2gltf', binaryPath, binarySource,
    packageVersion: binarySource === 'bundled' ? PACKAGE_VERSION : null, platform, arch,
    binaryArch: binarySource === 'bundled' ? 'x64' : null,
    requiresRosetta: binarySource === 'bundled' ? platform === 'darwin' && arch === 'arm64' : null,
    compatibility: binarySource === 'bundled'
      ? platform === 'darwin' && arch === 'arm64' ? 'rosetta' : 'native' : 'unknown',
  };
}

function execute(binaryPath, args, { cwd, timeout = 5000, signal, isolated = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(resourceError('ABORTED', 'FBX operation aborted.')); return;
    }
    // Inherit the worker's process group; the parent owns group kill and stage cleanup.
    const grouped = isolated && process.platform !== 'win32';
    const child = spawn(binaryPath, args, {
      cwd, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = Buffer.alloc(0), failure, missingTextures = false;
    const tails = new Map();
    const collect = (chunk, stream) => {
      const text = (tails.get(stream) ?? '') + chunk.toString('utf8');
      if (/could not find (?:an? )?image file for texture/i.test(text)) missingTextures = true;
      tails.set(stream, text.slice(-256));
      if (log.length < LOG_LIMIT) {
        log = Buffer.concat([log, chunk.subarray(0, LOG_LIMIT - log.length)]);
      }
    };
    child.stdout.on('data', chunk => collect(chunk, 'stdout'));
    child.stderr.on('data', chunk => collect(chunk, 'stderr'));
    const stop = code => {
      failure ??= resourceError(code, code === 'ABORTED' ? 'FBX operation aborted.' :
        'FBX binary deadline exceeded.');
      if (grouped && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      } else child.kill('SIGKILL');
    };
    const abort = () => stop('ABORTED');
    const timer = setTimeout(() => stop('FBX_BINARY_TIMEOUT'), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => {
      failure ??= resourceError('FBX_BINARY_EXECUTION', 'Could not execute FBX binary.');
    });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (grouped && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
      const output = redact(log.toString('utf8'));
      if (failure) reject(failure);
      else if (code !== 0) {
        reject(resourceError('FBX_CONVERSION_FAILED', 'FBX binary exited unsuccessfully.', {
          exitCode: code, signal: exitSignal, log: output,
        }));
      } else resolve({ output, missingTextures });
    });
    if (signal?.aborted) abort();
  });
}

/** Version detection is always bounded to five seconds, independent of task timeout. */
export async function probeFbxBinary(options = {}, runtime = {}) {
  let metadata;
  try {
    metadata = await resolveFbxBinary(options, runtime);
    const { output } = await execute(metadata.binaryPath, ['--version'], {
      timeout: 5000, signal: options.signal, isolated: options.isolated === true,
    });
    const version = output.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
    if (!version) throw resourceError('FBX_BINARY_VERSION', 'FBX binary returned no version.');
    return { ...metadata, ok: true, version, repairHints: [], error: null };
  } catch (error) {
    const repairHints = [];
    if (error.code === 'FBX_PLATFORM_UNSUPPORTED') {
      repairHints.push(
        'Use macOS x64, macOS arm64 with Rosetta, or Linux x64 with glibc.');
    } else if (options.fbxBinary !== undefined) {
      repairHints.push('Check the explicit --fbx-binary path and its executable permissions.');
    } else {
      repairHints.push(
        'Reinstall SDK dependencies including fbx2gltf@0.9.7-p1; check permissions.');
    }
    if (metadata?.requiresRosetta) {
      repairHints.push(
        'Check that Rosetta 2 is installed; the SDK never installs it automatically.');
    }
    if ((runtime.platform ?? process.platform) === 'linux') {
      repairHints.push('Check the binary dynamic libraries with ldd; Alpine/musl is unsupported.');
    }
    return {
      repairHints,
      platform: runtime.platform ?? process.platform, arch: runtime.arch ?? process.arch,
      binarySource: options.fbxBinary !== undefined ? 'override' : 'bundled',
      packageVersion: options.fbxBinary !== undefined ? null : PACKAGE_VERSION,
      ...metadata, backend: 'fbx2gltf', ok: false, version: null,
      error: { code: error.code ?? 'FBX_BINARY_EXECUTION', message: redact(error.message) },
    };
  }
}

// Read only file-reference string properties; preserve all other data and FBX node offsets.
function references(bytes, maxEntries) {
  const binary = Buffer.from(bytes.subarray(0, 18)).toString() === 'Kaydara FBX Binary';
  const edits = [], nodes = [];
  if (!binary) {
    const text = Buffer.from(bytes).toString('utf8');
    const scopes = []; let label;
    // Ignore braces in strings. Windows backslashes in FBX strings are literal.
    const tokens = /;[^\r\n]*|"[^"\r\n]*"|[{}]|[A-Za-z_]\w*\s*:/g;
    for (const token of text.matchAll(tokens)) {
      if (edits.length > maxEntries) {
        throw resourceError('RESOURCE_SIZE_LIMIT', 'FBX references exceed entry limit.');
      }
      if (token[0].startsWith(';')) continue;
      if (token[0] === '{') {
        const video = label === 'Video' ? { embedded: false } :
          scopes.at(-1)?.video;
        scopes.push({ name: label, video }); label = undefined;
      } else if (token[0] === '}') scopes.pop();
      else if (!token[0].startsWith('"')) {
        label = token[0].slice(0, -1).trim();
        const scope = scopes.at(-1);
        const rest = text.slice(token.index + token[0].length);
        if (label === 'Content' && scope?.video && /^\s*(?:,|"[^"\r\n]+")/.test(rest)) {
          scope.video.embedded = true;
        }
        if (['Video', 'Texture'].includes(scope?.name) &&
            ['RelativeFilename', 'FileName', 'Filename'].includes(label)) {
          const value = rest.match(/^\s*"([^"\r\n]*)"/);
          if (!value) continue;
          const index = token.index + token[0].length + value[0].indexOf('"') + 1;
          const start = Buffer.byteLength(text.slice(0, index));
          edits.push({
            start, end: start + Buffer.byteLength(value[1]), uri: value[1],
            video: scope.video,
          });
        }
      }
    }
    return { edits, nodes, wide: false };
  }
  if (bytes.length < 27) throw resourceError('INVALID_FBX', 'Truncated binary FBX header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wide = view.getUint32(23, true) >= 7500, header = wide ? 25 : 13;
  const integer = offset => wide ? Number(view.getBigUint64(offset, true)) :
    view.getUint32(offset, true);
  const visit = (offset, boundary, video, owner) => {
    if (edits.length > maxEntries) {
      throw resourceError('RESOURCE_SIZE_LIMIT', 'FBX references exceed entry limit.');
    }
    if (offset + header > boundary) return boundary;
    const end = integer(offset);
    if (!end) return offset + header;
    const propertyBytesOffset = offset + (wide ? 16 : 8);
    const size = integer(propertyBytesOffset);
    const nameLength = view.getUint8(offset + header - 1);
    const start = offset + header + nameLength, propertyEnd = start + size;
    const name = Buffer.from(bytes.subarray(offset + header, start)).toString();
    nodes.push({ offset, end, propertyBytesOffset, start, propertyEnd, size });
    if (['Video', 'Texture'].includes(name)) owner = name;
    if (name === 'Video') video = { embedded: false };
    if (name === 'Content' && video && size >= 5 && bytes[start] === 82 &&
        view.getUint32(start + 1, true) > 0) video.embedded = true;
    if (['Video', 'Texture'].includes(owner) &&
        ['FileName', 'Filename', 'RelativeFilename'].includes(name) &&
        size >= 5 && bytes[start] === 83) {
      const length = view.getUint32(start + 1, true);
      edits.push({
        start: start + 5, end: start + 5 + length, lengthOffset: start + 1,
        uri: Buffer.from(bytes.subarray(start + 5, start + 5 + length)).toString(), video,
      });
    }
    let child = propertyEnd;
    while (child < end) child = visit(child, end, video, owner);
    return end;
  };
  let offset = 27;
  while (offset + header <= bytes.length) {
    if (!integer(offset)) break;
    offset = visit(offset, bytes.length);
  }
  return { edits, nodes, wide };
}

async function stageSource(prepared, stage, options, warnings) {
  await validateFBXArrays(prepared.bytes, options);
  const limits = limitsFor(options), resolver = prepared.resolver;
  let total = prepared.bytes.length, count = 1;
  const write = async (name, bytes) => {
    total += bytes.length;
    if (++count > limits.maxEntries || bytes.length > limits.maxEntryBytes ||
        total > limits.maxTotalBytes) {
      throw resourceError('RESOURCE_SIZE_LIMIT', 'Native FBX staging exceeds resource limits.');
    }
    const file = path.resolve(stage, name);
    if (!file.startsWith(stage + path.sep)) {
      throw resourceError('RESOURCE_ACCESS_DENIED', 'Unsafe staged resource path.');
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes, { flag: 'wx' });
    return file;
  };
  // Resolve only declared references, never recursively copy a source directory.
  // ZIP bytes reach disk only through ZipIndex.read()'s limits/CRC validation.
  const archiveResolver = resolver.zip ? await new ResourceResolver({
    ...options, resourceDirs: [],
  }, warnings).initialize({
    zip: resolver.zip, resources: Object.fromEntries(resolver.virtual), entry: prepared.entry,
  }) : null;
  const { edits, nodes, wide } = references(prepared.bytes, limits.maxEntries);
  const copied = new Map();
  const embeddedNames = new Set(edits.filter(edit => edit.embedded || edit.video?.embedded)
    .map(edit => edit.uri));
  for (const edit of edits) {
    if (!edit.uri) { edit.bytes = Buffer.alloc(0); continue; }
    if (!copied.has(edit.uri)) {
      const uri = edit.uri;
      const suffix = path.extname(edit.uri.replaceAll('\\', '/'));
      const safeSuffix = /^\.[a-z0-9]{1,10}$/i.test(suffix) ? suffix : '.bin';
      if (embeddedNames.has(edit.uri)) {
        copied.set(edit.uri, path.join(stage, 'sdk', `embedded-${copied.size}${safeSuffix}`));
        edit.bytes = Buffer.from(copied.get(edit.uri));
        continue;
      }
      try {
        let data;
        if (archiveResolver) {
          try { data = await archiveResolver.resolve(uri, prepared.entry); }
          catch (error) { if (error.code !== 'RESOURCE_NOT_FOUND') throw error; }
        }
        data ??= await resolver.resolve(uri, prepared.entry);
        const file = await write(`assets/${copied.size}${safeSuffix}`, data);
        copied.set(edit.uri, file);
      } catch (error) {
        if (error.code !== 'RESOURCE_NOT_FOUND') throw error;
        warnings.push(diagnostic('FBX_RESOURCE_MISSING',
          'Referenced FBX resource is unavailable.', true));
        // Prevent the SDK from following an unresolved original absolute/relative path.
        copied.set(edit.uri, path.join(stage, 'missing', `${copied.size}.bin`));
      }
    }
    edit.bytes = Buffer.from(copied.get(edit.uri));
  }
  edits.sort((a, b) => a.start - b.start);
  const chunks = []; let cursor = 0;
  for (const edit of edits) {
    chunks.push(prepared.bytes.subarray(cursor, edit.start), edit.bytes); cursor = edit.end;
  }
  chunks.push(prepared.bytes.subarray(cursor));
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (size > limits.maxEntryBytes || total - prepared.bytes.length + size > limits.maxTotalBytes) {
    throw resourceError('FBX_SIZE_LIMIT', 'Rebased FBX exceeds resource limits.');
  }
  const output = Buffer.concat(chunks, size);
  const translate = offset => offset + edits.reduce((delta, edit) =>
    delta + (edit.end <= offset ? edit.bytes.length - (edit.end - edit.start) : 0), 0);
  const integer = (offset, value) => wide ? output.writeBigUInt64LE(BigInt(value), offset) :
    output.writeUInt32LE(value, offset);
  for (const node of nodes) {
    integer(translate(node.offset), translate(node.end));
    integer(translate(node.propertyBytesOffset),
      translate(node.propertyEnd) - translate(node.start));
  }
  for (const edit of edits) {
    if (edit.lengthOffset !== undefined) output.writeUInt32LE(edit.bytes.length,
      translate(edit.lengthOffset));
  }
  const input = path.join(stage, 'input.fbx');
  await fs.writeFile(input, output, { flag: 'wx' });
  return input;
}

/** Stage is a workspace, NOT an OS sandbox. The native SDK executes with worker privileges. */
export async function convertNativeFbx(prepared, options = {}, context = {}, warnings = []) {
  if (options.onlyVisible === true) {
    throw resourceError('UNSUPPORTED_OPERATION',
      'Native FBX does not support onlyVisible; use three.');
  }
  if (!context.tempDir) {
    throw resourceError('FBX_TEMP_DIR_REQUIRED',
      'Native FBX requires a parent-owned task tempDir.');
  }
  const probe = await probeFbxBinary({
    ...options, isolated: false, signal: context.signal ?? options.signal,
  });
  if (!probe.ok) throw resourceError(probe.error.code, probe.error.message);
  const stage = await fs.mkdtemp(path.join(await fs.realpath(context.tempDir), 'native-fbx-'));
  const sdk = path.join(stage, 'sdk'); await fs.mkdir(sdk);
  const input = await stageSource(prepared, stage, options, warnings);
  const destination = path.join(stage, 'output');
  const started = performance.now();
  const { output: log, missingTextures } = await execute(probe.binaryPath, [
    '--input', input, '--output', destination, '--binary', '--pbr-metallic-roughness',
    '--fbx-temp-dir', sdk,
  ], {
    cwd: stage, timeout: (options.timeout ?? 120) * 1000, signal: context.signal ?? options.signal,
  });
  const nativeConversionMs = performance.now() - started;
  if (log.trim()) warnings.push(diagnostic('FBX_NATIVE_LOG', log));
  if (missingTextures) {
    warnings.push(diagnostic('FBX_NATIVE_TEXTURE_MISSING',
      'Native converter could not load textures; placeholder images may be used.', true));
  }
  const file = destination + '.glb';
  const outputResolver = await new ResourceResolver(options, warnings).initialize({
    modelPath: file, entry: file,
  });
  // readDisk uses a bounded allocation and detects growth/symlink swaps.
  let bytes;
  try { bytes = await outputResolver.readDisk(file); }
  catch (error) {
    if (error.code?.startsWith('RESOURCE_')) throw error;
    throw resourceError('FBX_OUTPUT_INVALID', 'Native converter did not produce a readable GLB.');
  }
  return {
    bytes, format: 'glb', entry: file, resolver: outputResolver,
    nativeConversionMs,
    conversion: {
      backend: 'fbx2gltf', version: probe.version, binarySource: probe.binarySource,
      packageVersion: probe.packageVersion, requiresRosetta: probe.requiresRosetta,
      platform: probe.platform, arch: probe.arch, binaryArch: probe.binaryArch,
      compatibility: probe.compatibility,
    },
  };
}
