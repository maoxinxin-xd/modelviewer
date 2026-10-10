import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, extname, resolve } from 'node:path';
import { createNodeIO, loadDocument } from './load.mjs';
import { inspectDocument } from './inspect.mjs';
import { optimizeDocument } from './optimize.mjs';
import { safeDiagnostics } from './diagnostics.mjs';

let disconnecting = false;
// If the host dies, a separate janitor can kill this group without killing itself.
process.once('disconnect', () => {
  if (disconnecting || process.platform === 'win32') return;
  const janitorPath = fileURLToPath(new URL('./orphan-cleanup.mjs', import.meta.url));
  const janitor = spawn(process.execPath, [janitorPath, String(process.pid), process.argv[2]], {
    detached: true, stdio: 'ignore',
  });
  janitor.on('error', () => {
    // Failing to spawn a janitor must not leave a running native conversion.
    try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
  });
  janitor.unref();
});

// Loader/library console output can never contaminate CLI stdout or IPC.
console.log = (...args) => console.error(...args);
process.once('message', async ({ command, source, options, directory }) => {
  const started = performance.now();
  const timings = { unit: 'ms', loadMs: null, exportMs: null, optimizationMs: null, simplifyMs: null, renderMs: null, conversionMs: null, convertAndOptimizeMs: null, workerMs: null };
  // The parent owns this directory and removes it after the whole group exits.
  let loaded;
  let response;
  try {
    const context = {
      tempDir: directory,
      log: message => {
        if (process.connected) process.send({ type: 'progress', message });
      },
    };
    const name = typeof source === 'string' ? basename(source) : source.fileName;
    if (command === 'optimize' && extname(name).toLowerCase() !== '.glb') throw Object.assign(new Error('optimize accepts GLB only. Use convert --optimize for other formats.'), { code: 'INVALID_ARGUMENT' });
    const loadStarted = performance.now();
    loaded = await loadDocument(source, options, context);
    timings.loadMs = performance.now() - loadStarted;
    timings.nativeConversionMs = loaded.nativeConversionMs ?? null;
    if (command === 'optimize' && (loaded.inputFormat ?? loaded.format) !== 'glb') throw Object.assign(new Error('optimize requires actual GLB content. Use convert --optimize for other formats.'), { code: 'INVALID_ARGUMENT' });
    let document = loaded.document;
    const before = inspectDocument(document);
    const warnings = [...(loaded.warnings || [])];
    const transformations = [...(loaded.transformations || [])];
    const outputs = [];
    if (command === 'convert' || command === 'optimize') {
      // Decode source compression once; never re-encode an existing lossy codec
      // merely because ordinary conversion wrote the document again.
      for (const extension of document.getRoot().listExtensionsUsed()) {
        if (['KHR_draco_mesh_compression', 'EXT_meshopt_compression'].includes(extension.extensionName)) {
          transformations.push(`decoded:${extension.extensionName}`);
          extension.dispose();
        }
      }
    }
    const data = {
      ...(loaded.conversion ? { conversion: loaded.conversion } : {}), timings, ...before,
      format: loaded.format, inputFormat: loaded.inputFormat ?? loaded.format,
      inputBytes: loaded.inputBytes,
    };
    if (command === 'optimize' || command === 'convert' && options.optimize) {
      const optimizationKeys = ['instance', 'instanceMin', 'palette', 'paletteMin', 'flatten', 'join', 'joinMeshes', 'joinNamed', 'weld', 'simplify', 'simplifyRatio', 'simplifyError', 'simplifyLockBorder', 'resample', 'prune', 'pruneAttributes', 'pruneSolidTextures', 'sparse', 'textureSize', 'textureCompress', 'compress', 'meshoptLevel', 'limitInputPixels'];
      const optimizationOptions = Object.fromEntries(optimizationKeys.filter(key => options[key] !== undefined).map(key => [key, options[key]]));
      const optimizationStarted = performance.now();
      const optimized = await optimizeDocument(document, optimizationOptions, context);
      timings.optimizationMs = performance.now() - optimizationStarted;
      timings.simplifyMs = optimized.stageTimingsMs.simplify ?? 0;
      document = optimized.document;
      warnings.push(...(optimized.warnings || []));
      transformations.push(...(optimized.transformations || []));
      data.optimization = { before: optimized.before, after: optimized.after, options: optimized.options, stageTimingsMs: optimized.stageTimingsMs };
    }
    if (command === 'convert' || command === 'optimize') {
      const exportStarted = performance.now();
      const io = await createNodeIO(options);
      if (document.getRoot().listBuffers().length > 1) {
        const { unpartition } = await import('@gltf-transform/functions');
        await document.transform(unpartition());
        transformations.push('unpartition');
      }
      // Preserve the converter's exact transforms when no post-processing was requested.
      const nativeUnchanged = command === 'convert' && loaded.nativeBytes &&
        !options.optimize && transformations.length === 0;
      const bytes = nativeUnchanged ? loaded.nativeBytes : await io.writeBinary(document);
      const checked = await io.readBinary(bytes);
      const after = inspectDocument(checked);
      // A generated mesh asset must not become empty, even when simplification is requested.
      if (before.meshes > 0 && after.meshes === 0 || before.triangles > 0 && after.triangles === 0) throw Object.assign(new Error('Export unexpectedly removed all model meshes.'), { code: 'EXPORT_FAILED' });
      timings.exportMs = performance.now() - exportStarted;
      if (command === 'convert') timings.conversionMs = timings.loadMs + timings.exportMs;
      if (command === 'convert' && options.optimize) timings.convertAndOptimizeMs = performance.now() - started;
      outputs.push({ name: `${basename(name, extname(name))}.glb`, format: 'glb', bytes: Buffer.from(bytes) });
      data.outputBytes = bytes.byteLength;
      data.after = after;
    } else if (command === 'render') {
      const renderStarted = performance.now();
      const { renderDocument } = await import('./render.mjs');
      const rendered = await renderDocument(document, options, context);
      timings.renderMs = performance.now() - renderStarted;
      warnings.push(...rendered.warnings);
      outputs.push(...rendered.outputs.map(output => ({ ...output, name: `${basename(name, extname(name))}-${output.view}.${output.format === 'jpeg' ? 'jpg' : output.format}` })));
      data.render = rendered.data;
    }
    if (options.strict && warnings.some(warning => warning.affectsFidelity)) throw Object.assign(new Error('Strict mode rejected fidelity warnings.'), { code: 'STRICT_FAILED', details: { warnings } });
    data.transformations = transformations;
    response = { type: 'result', ok: true, result: { schemaVersion: 1, ok: true, command, input: typeof source === 'string' ? resolve(source) : source.fileName, entry: loaded.entry, outputs, data, warnings, error: null } };
  } catch (cause) {
    if (cause.details?.stageTimingsMs?.simplify !== undefined) timings.simplifyMs = cause.details.stageTimingsMs.simplify;
    response = { type: 'result', ok: false, error: { code: cause.code === 'ENOENT' ? 'INPUT_NOT_FOUND' : cause.code || 'PROCESSING_FAILED', message: cause.message, details: { ...(cause.details || {}), ...(cause.warnings ? { warnings: cause.warnings } : {}), timings } } };
  } finally {
    try { await loaded?.dispose?.(); } catch {}

  }
  timings.workerMs = performance.now() - started;
  if (!process.connected) return;
  process.send(safeDiagnostics(response), () => {
    // Per-task native runtimes may own internal handles. Exit after the IPC flush and explicit cleanup.
    disconnecting = true;
    process.disconnect();
    process.exit(response.ok ? 0 : 1);
  });
});
