#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { Command } from 'commander';
import { readFile, lstat, stat, mkdir, open, link, unlink, rename, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateOptions } from './options.mjs';

const coded = (code, message) => Object.assign(new Error(message), { code });
const usage = message => { throw coded('INVALID_ARGUMENT', message); };
function taskOptions(c) {
  return c.option('--json', 'Print exactly one JSON result')
    .option('--timeout <seconds>', 'Task timeout in seconds (default: 120)')
    .option('--resource-dir <path>', 'Additional resource directory (repeatable)', (v, old = []) => [...old, v])
    .option('--fbx-backend <backend>', 'native (default) or three')
    .option('--fbx-binary <path>', 'Explicit native FBX executable (no PATH fallback)')
    .option('--entry <path>', 'Model entry inside ZIP input')
    .option('--entry-formats <formats>', 'Preferred archive formats, comma-separated',
      value => value.split(',').map(format => format.trim()))
    .option('--entry-depth <levels>', 'Maximum archive entry search depth', Number)
    .option('--strict', 'Treat applicable backend warnings as errors')
    .option('--allow-network', 'Allow network resources')
    .option('--overwrite', 'Explicitly allow replacing output files');
}
function optimizationOptions(c) {
  for (const [flag, description] of [
    ['ratio', 'Simplification ratio (default: 0)'], ['error', 'Simplification error (default: 0.0001)'],
    ['textures', 'Maximum texture dimension (default: 2048)'], ['compress', 'meshopt, draco, quantize, or none (default: meshopt)'],
    ['texture-compress', 'auto, webp, avif, or none (default: auto)'],
  ]) c.option(`--${flag} <value>`, description);
  // No Commander defaults: a supplied --no-* must still count as explicit intent.
  for (const flag of ['instance', 'palette', 'flatten', 'join', 'weld', 'simplify']) {
    c.option(`--${flag}`, `Enable ${flag} (default: enabled)`).option(`--no-${flag}`, `Disable ${flag}`);
  }
  c.option('--simplify-ratio <value>', 'Alias for --ratio')
    .option('--simplify-error <value>', 'Alias for --error')
    .option('--texture-size <value>', 'Alias for --textures')
    .option('--simplify-lock-border', 'Lock mesh borders during simplification (default: false)');
  return c;
}
function explicitOptions(c) {
  const result = {};
  for (let current = c; current; current = current.parent) {
    for (const [k, v] of Object.entries(current.opts())) {
      if (current.getOptionValueSource(k) === 'cli' && result[k] === undefined) result[k] = v;
    }
  }
  return result;
}
export function outputPaths(command, input, opts) {
  if (command === 'info') return [];
  if (opts.output && opts.outputDir) usage('Use --output or --output-dir, not both');
  if (command === 'render' && opts.views !== undefined) {
    if (!opts.outputDir || opts.output) usage('Multi-view render requires --output-dir and --views');
    const stem = path.basename(input, path.extname(input));
    return opts.views.map(view => path.resolve(opts.outputDir, `${stem}-${view}.${opts.format === 'jpeg' ? 'jpg' : opts.format}`));
  }
  if (!opts.output || opts.outputDir) usage('A single output requires -o/--output');
  const ext = path.extname(opts.output).slice(1).toLowerCase();
  if (command === 'render') {
    if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) usage('Image output must have a .png, .jpg, .jpeg, or .webp extension');
    if ((ext === 'jpg' ? 'jpeg' : ext) !== opts.format) usage('Image output extension must match --format');
  } else if (ext !== 'glb') usage('Model output must have a .glb extension');
  return [path.resolve(opts.output)];
}
export async function preflightOutputs(paths, overwrite = false) {
  if (new Set(paths).size !== paths.length) throw coded('OUTPUT_WRITE', 'Output paths collide');
  for (const file of paths) {
    // Check the nearest existing ancestor without creating directories or doing API work.
    let parent = path.dirname(path.resolve(file));
    while (true) {
      try {
        if (!(await stat(parent)).isDirectory()) throw coded('OUTPUT_WRITE', `Output parent is not a directory: ${parent}`);
        break;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e.code === 'OUTPUT_WRITE' ? e : coded('OUTPUT_WRITE', `Cannot access output parent ${parent}: ${e.message}`);
        const next = path.dirname(parent);
        if (next === parent) throw coded('OUTPUT_WRITE', `Output parent does not exist: ${parent}`);
        parent = next;
      }
    }
    try {
      const stat = await lstat(file);
      if (!overwrite || !stat.isFile()) throw coded('OUTPUT_WRITE', `Output already exists or is not a regular file: ${file}`);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e.code === 'OUTPUT_WRITE' ? e : coded('OUTPUT_WRITE', `Cannot access output ${file}: ${e.message}`);
    }
  }
}
/** Exclusive link commits prevent concurrent writers from overwriting an existing file. */
export async function writeOutputs(outputs, paths, overwrite = false, signal) {
  const committed = [];
  try {
    if (!Array.isArray(outputs) || outputs.length !== paths.length) throw new Error('API output count does not match requested destinations');
    for (let i = 0; i < outputs.length; i++) {
      if (signal?.aborted) throw signal.reason ?? coded('ABORTED', 'Interrupted');
      const output = outputs[i];
      if (!(output.bytes instanceof Uint8Array)) throw new Error('API output bytes must be Uint8Array');
      const destination = path.resolve(paths[i]);
      await mkdir(path.dirname(destination), { recursive: true });
      const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(temporary, 'wx');
        await handle.writeFile(output.bytes);
        await handle.sync();
        await handle.close(); handle = undefined;
        if (signal?.aborted) throw signal.reason ?? coded('ABORTED', 'Interrupted');
        if (overwrite) await rename(temporary, destination);
        else await link(temporary, destination);
        const { bytes, ...metadata } = output;
        committed.push({ ...metadata, byteLength: bytes.byteLength, path: destination });
      } finally {
        if (handle) await handle.close().catch(() => {});
        await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; });
      }
    }
    return committed;
  } catch (cause) {
    throw Object.assign(coded(signal?.aborted ? 'ABORTED' : 'OUTPUT_WRITE', `Could not write output: ${cause.message}`), { cause, outputs: committed });
  }
}

export async function runCli(argv = process.argv, { stdout = process.stdout, stderr = process.stderr, loadApi = () => import('./index.mjs') } = {}) {
  const program = new Command();
  let command = null, input = null, entry = null, emitted = false, interrupted = false, deadline;
  let cliStarted = null, apiTimings = null, writeStarted = null;
  let json = argv.slice(2).includes('--json');
  const controller = new AbortController();
  const emit = result => {
    if (emitted) return;
    emitted = true;
    if (json) stdout.write(`${JSON.stringify(result)}\n`);
    else if (result.ok) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      stderr.write(`${result.error.code}: ${result.error.message}\n`);
      for (const output of result.outputs) stderr.write(`Committed before failure: ${output.path} (${output.byteLength} bytes)\n`);
    }
  };
  const sigint = () => { interrupted = true; controller.abort(coded('ABORTED', 'Interrupted')); };
  program.name('mivo-model-viewer').description('Inspect, render, convert, and optimize model files')
    .exitOverride().configureOutput({ writeOut: s => stdout.write(s), writeErr: s => stderr.write(s) });
  taskOptions(program);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  program.version(pkg.version);
  function action(name) {
    return async (source, raw, c) => {
      cliStarted = performance.now();
      command = name;
      if (!source.trim()) usage('input path is required');
      input = path.resolve(source);
      const supplied = explicitOptions(c);
      json ||= Boolean(supplied.json);
      if (name === 'render' && supplied.format === undefined && supplied.output) {
        const ext = path.extname(supplied.output).slice(1).toLowerCase();
        if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) supplied.format = ext;
      }
      if (supplied.mode !== undefined) supplied.textureMode = supplied.mode;
      const opts = validateOptions(name, { ...supplied, input });
      deadline = setTimeout(() => controller.abort(coded('TIMEOUT', 'Model task deadline exceeded')), opts.timeout * 1000);
      entry = opts.entry ?? null;
      const paths = outputPaths(name, input, opts);
      if (!opts.overwrite && paths.includes(input)) throw coded('OUTPUT_WRITE', 'Output would replace the input; use --overwrite explicitly');
      await preflightOutputs(paths, opts.overwrite);
      if (controller.signal.aborted) throw controller.signal.reason;
      const api = await loadApi();
      if (controller.signal.aborted) throw controller.signal.reason;
      const { inspectModel, renderModelImages, convertModelToGlb, optimizeModel } = api;
      const fn = { info: inspectModel, render: renderModelImages, convert: convertModelToGlb, optimize: optimizeModel }[name];
      if (typeof fn !== 'function') throw coded('API_UNAVAILABLE', `API for ${name} is unavailable`);
      const apiOpts = { ...opts, signal: controller.signal, onProgress: progress => {
        const text = typeof progress === 'string' ? progress : JSON.stringify(progress);
        stderr.write(`${text}\n`);
      } };
      delete apiOpts.input;
      const result = await fn(input, apiOpts);
      apiTimings = result?.data?.timings;
      if (controller.signal.aborted) throw controller.signal.reason;
      // Accommodate returned failure envelopes as well as the normal coded exceptions.
      if (!result?.ok) throw coded(result?.error?.code ?? 'API_ERROR', result?.error?.message ?? 'API returned an unsuccessful result');
      writeStarted = performance.now();
      const outputs = await writeOutputs(result.outputs ?? [], paths, opts.overwrite, controller.signal);
      const timings = { ...(result.data?.timings || {}), outputWriteMs: performance.now() - writeStarted, cliTotalMs: performance.now() - cliStarted };
      emit({ ...result, data: { ...result.data, timings }, outputs });
    };
  }
  taskOptions(program.command('doctor')).action(async (raw, c) => {
    command = 'doctor';
    const supplied = explicitOptions(c);
    json ||= Boolean(supplied.json);
    const opts = validateOptions('info', supplied);
    // Probe without loading the scheduler, GPU, adapters or optional webgpu package.
    const { probeFbxBinary } = await import('./native-fbx.mjs');
    const probe = await probeFbxBinary({
      ...opts, isolated: true, signal: controller.signal,
    });
    const warnings = probe.requiresRosetta ? [{
      code: 'FBX_ROSETTA_REQUIRED', affectsFidelity: false,
      message: 'Darwin arm64 uses the x64 FBX binary and requires Rosetta 2.',
    }] : [];
    emit({
      schemaVersion: 1, ok: probe.ok, command, outputs: [],
      data: { fbx: probe }, warnings, error: probe.error,
    });
    if (!probe.ok) throw coded(probe.error.code, probe.error.message);
  });
  taskOptions(program.command('info').argument('<input>', 'Input model path')).action(action('info'));
  const render = taskOptions(program.command('render').argument('<input>', 'Input model path'));
  render.option('-o, --output <path>', 'Single image destination').option('--output-dir <path>', 'Multi-view image directory')
    .option('--views <views>', 'Comma-separated unique views; requires --output-dir')
    .option('--view <view>',
      'front, back, left, right, top, bottom, none; side aliases left')
    .option('--device <device>', 'auto, software, or hardware (default: auto)')
    .option('--padding <ratio>', 'Camera framing padding (default: 0.1)', Number)
    .option('--format <format>', 'png, jpg/jpeg, or webp').option('--size <pixels>', 'Square image size (default: 1024)')
    .option('--width <pixels>', 'Image width').option('--height <pixels>', 'Image height').option('--dpr <ratio>', 'Device pixel ratio (default: 1)')
    .option('--background <color>', 'Color or transparent').option('--grid', 'Show grid').option('--no-grid', 'Hide grid')
    .option('--texture-mode <mode>', 'textured, white, clay, normal, or albedo')
    .option('--mode <mode>', 'Alias for --texture-mode')
    .option('--projection <mode>', 'perspective or orthographic')
    .option('--quality <value>', 'JPEG/WebP quality (default: 0.92)').option('--light-intensity <value>', 'Main light intensity (default: 2)')
    .option('--ambient-intensity <value>', 'Ambient intensity (default: 2)').option('--angle <degrees>', 'Light angle (default: 0)').option('--light-angle <degrees>', 'Alias for --angle')
    .action(action('render'));
  optimizationOptions(taskOptions(program.command('convert').argument('<input>', 'Input model path')))
    .option('-o, --output <path>', 'GLB destination').option('--optimize', 'Apply optimizations')
    .option('--center', 'Center converted model').option('--only-visible', 'Export only visible objects')
    .option('--animations', 'Include animations').option('--no-animations', 'Exclude animations').action(action('convert'));
  optimizationOptions(taskOptions(program.command('optimize').argument('<input>', 'Input model path')))
    .option('-o, --output <path>', 'Optimized GLB destination').action(action('optimize'));
  process.on('SIGINT', sigint);
  try {
    await program.parseAsync(argv);
    if (!emitted && !program.args.length) { program.outputHelp(); return 0; }
    return interrupted ? 130 : 0;
  } catch (e) {
    if (['commander.helpDisplayed', 'commander.version', 'commander.help'].includes(e.code)) return 0;
    if (cliStarted !== null) {
      const endedAt = performance.now();
      e.details = { ...(e.details || {}), timings: { unit: 'ms', ...(apiTimings || {}), ...(e.details?.timings || {}), outputWriteMs: null, ...(writeStarted !== null ? { outputWriteElapsedMs: endedAt - writeStarted } : {}), cliTotalMs: endedAt - cliStarted } };
    }
    const parseError = e.code?.startsWith('commander.');
    if (command === null &&
        ['info', 'render', 'convert', 'optimize', 'doctor'].includes(program.args[0])) {
      command = program.args[0];
    }
    const code = interrupted ? 'ABORTED' : parseError ? 'INVALID_ARGUMENT' : e.code ?? 'INTERNAL_ERROR';
    emit({ schemaVersion: 1, ok: false, command, input, entry, outputs: e.outputs ?? [], data: null, warnings: e.details?.warnings ?? e.warnings ?? [], error: { code, message: interrupted ? 'Interrupted' : e.message, ...(e.details ? { details: e.details } : {}) } });
    return interrupted || code === 'ABORTED' ? 130 : parseError || code === 'INVALID_ARGUMENT' ? 2 : 1;
  } finally { clearTimeout(deadline); process.removeListener('SIGINT', sigint); }
}

// npm bin shims/symlinks and macOS /tmp aliases must resolve to the same file.
const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runCli();
}
