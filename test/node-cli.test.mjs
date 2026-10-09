import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateOptions } from '../node/options.mjs';
import { runCli, outputPaths, preflightOutputs, writeOutputs } from '../node/cli.mjs';

const cli = fileURLToPath(new URL('../node/cli.mjs', import.meta.url));
const argv = (...args) => ['node', cli, ...args];
const failure = code => e => e.code === code;
async function scratch(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'model-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function invoke(args, api) {
  let out = '', err = '', loads = 0;
  const code = await runCli(argv(...args), {
    stdout: { write: s => { out += s; } }, stderr: { write: s => { err += s; } },
    loadApi: async () => { loads++; return api; },
  });
  return { code, out, err, loads };
}
function envelope(command, input, outputs = []) {
  return { schemaVersion: 1, ok: true, command, input, entry: null, outputs, data: { test: true }, warnings: [], error: null };
}
const image = (view = 'front') => ({ name: `model-${view}.png`, format: 'png', bytes: Buffer.from([1, 2, 3]), view, width: 1024, height: 1024 });

test('shared options defaults and revalidation preserve nonexplicit ratio intent', () => {
  const opts = validateOptions('optimize', { strict: true });
  assert.equal(opts.ratio, 0);
  assert.equal(opts.simplifyRatio, 0);
  assert.equal(opts.ratioExplicit, false);
  assert.equal(opts.error, 0.0001);
  assert.equal(opts.textures, 2048);
  assert.equal(opts.compress, 'meshopt');
  assert.equal(opts.textureCompress, 'auto');
  for (const key of ['instance', 'palette', 'flatten', 'join', 'weld', 'simplify']) assert.equal(opts[key], true);
  assert.equal(validateOptions('optimize', opts).ratioExplicit, false);
  assert.equal(validateOptions('optimize', { ratio: 0 }).ratioExplicit, true);
  assert.equal(validateOptions('optimize', { simplifyRatio: 0 }).ratioExplicit, true);
  assert.equal(validateOptions('info', {}).timeout, 120);
  assert.deepEqual(validateOptions('info', {}).resourceDirs, []);
});

test('render defaults, formats, aliases, multiple views and idempotence', () => {
  const opts = validateOptions('render');
  assert.equal(opts.size, 1024); assert.equal(opts.width, 1024); assert.equal(opts.height, 1024);
  assert.equal(opts.dpr, 1); assert.equal(opts.background, 'transparent'); assert.equal(opts.grid, false);
  assert.equal(opts.textureMode, 'textured'); assert.equal(opts.projection, 'perspective');
  assert.equal(opts.lightIntensity, 2); assert.equal(opts.ambientIntensity, 2); assert.equal(opts.angle, 0);
  assert.equal(opts.view, 'front'); assert.equal(opts.quality, undefined);
  assert.equal(validateOptions('render', { format: 'jpg' }).background, '#ffffff');
  assert.equal(validateOptions('render', { format: 'webp' }).quality, 0.92);
  const multi = validateOptions('render', { views: 'front,back' });
  assert.deepEqual(multi.views, ['front', 'back']);
  assert.deepEqual(validateOptions('render', multi).views, ['front', 'back']);
  assert.equal(validateOptions('render', { textureMode: 'albedo' }).textureMode, 'albedo');
});

test('validation rejects malformed numbers, modes, booleans, archives and views', () => {
  for (const [command, opts] of [
    ['info', { timeout: 'NaN' }], ['info', { timeout: 0 }], ['info', { timeout: '' }],
    ['info', { strict: 'false' }], ['info', { resourceDirs: 'foo' }],
    ['info', { entry: '', input: 'chair.obj' }],
    ['render', { size: 2.5 }], ['render', { dpr: 0 }], ['render', { width: Infinity }],
    ['render', { format: 'gif' }], ['render', { quality: 0.9 }],
    ['render', { format: 'jpeg', quality: 1.1 }], ['render', { format: 'jpeg', background: 'transparent' }],
    ['render', { views: 'front,front' }], ['render', { views: [] }], ['render', { views: 'left' }],
    ['render', { views: 'front,back', view: 'front' }], ['render', { lightIntensity: -1 }],
    ['optimize', { ratio: -1 }], ['optimize', { error: 2 }], ['optimize', { textures: 0 }],
    ['optimize', { textures: 16385 }], ['optimize', { compress: 'zip' }],
  ]) assert.throws(() => validateOptions(command, opts), failure('INVALID_ARGUMENT'));
  assert.throws(() => validateOptions('unknown'), failure('INVALID_ARGUMENT'));
  assert.equal(validateOptions('info', { input: 'archive.ZIP', entry: 'model.glb' }).entry, 'model.glb');
});

test('convert optimization arguments require opt-in, including false and zero', () => {
  for (const opts of [{ ratio: 0 }, { simplify: false }, { weld: false }, { textureCompress: 'auto' }, { simplifyError: 0.0001 }]) {
    assert.throws(() => validateOptions('convert', opts), failure('INVALID_ARGUMENT'));
  }
  const plain = validateOptions('convert');
  assert.equal(plain.optimize, false); assert.equal(plain.ratio, undefined); assert.equal(plain.animations, true);
  const optimized = validateOptions('convert', { optimize: true, simplify: false, ratio: '0.5', center: true, onlyVisible: true, animations: false });
  assert.equal(optimized.simplify, false); assert.equal(optimized.ratio, 0.5); assert.equal(optimized.animations, false);
  assert.equal(validateOptions('convert', optimized).ratioExplicit, true);
});

test('executable help/version never load the unfinished API', () => {
  for (const args of [['--help'], ['render', '--help'], ['optimize', '--help'], ['--version']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.ok(result.stdout.trim()); assert.equal(result.stderr, '');
  }
});

test('parse errors produce one JSON envelope and exit 2', async () => {
  for (const args of [['--json', 'not-a-command'], ['render', '--json'], ['info', 'x.glb', '--json', '--bogus'], ['--json', 'info', 'x.glb', '--timeout']]) {
    const r = await invoke(args, {});
    assert.equal(r.code, 2, r.err); assert.equal(r.loads, 0);
    assert.equal(r.out.trim().split('\n').length, 1);
    const parsed = JSON.parse(r.out); assert.equal(parsed.ok, false); assert.equal(parsed.error.code, 'INVALID_ARGUMENT');
  }
});

test('output requirements and explicit convert flag rejection happen before API work', async () => {
  for (const args of [
    ['render', 'x.glb'], ['render', 'x.glb', '--views', 'front,back', '-o', 'out.png'],
    ['render', 'x.glb', '--output-dir', 'out'], ['convert', 'x.glb'], ['optimize', 'x.glb'],
    ['convert', 'x.glb', '-o', 'out.glb', '--no-weld'], ['convert', 'x.glb', '-o', 'out.glb', '--ratio', '0'],
  ]) {
    const r = await invoke([...args, '--json'], {});
    assert.equal(r.code, 2, r.err); assert.equal(r.loads, 0); assert.equal(JSON.parse(r.out).error.code, 'INVALID_ARGUMENT');
  }
});

test('info forwards normalized global options and logs only to stderr', async () => {
  const r = await invoke(['--json', '--timeout', '45', 'info', '模型.zip', '--resource-dir', 'textures', '--resource-dir', 'more', '--entry', 'model.obj', '--strict', '--allow-network'], {
    inspectModel: async (input, opts) => {
      assert.equal(input, path.resolve('模型.zip')); assert.equal(opts.timeout, 45);
      assert.deepEqual(opts.resourceDirs, [path.resolve('textures'), path.resolve('more')]);
      assert.equal(opts.strict, true); assert.equal(opts.allowNetwork, true); assert.equal(opts.entry, 'model.obj');
      assert.ok(opts.signal instanceof AbortSignal); opts.onProgress('loading');
      return envelope('info', input);
    },
  });
  assert.equal(r.code, 0); assert.equal(r.err, 'loading\n'); assert.equal(r.out.trim().split('\n').length, 1);
  assert.equal(JSON.parse(r.out).command, 'info');
});

test('single render writes Buffer bytes, infers JPEG and prints byte counts and absolute paths', async t => {
  const dir = await scratch(t), dest = path.join(dir, 'nested', 'result.jpg');
  const r = await invoke(['render', 'model.glb', '-o', dest, '--json'], {
    renderModelImages: async (input, opts) => {
      assert.equal(opts.format, 'jpeg'); assert.equal(opts.background, '#ffffff');
      return envelope('render', input, [{ ...image(), format: 'jpeg' }]);
    },
  });
  assert.equal(r.code, 0, r.err);
  const result = JSON.parse(r.out);
  assert.equal(result.outputs[0].bytes, undefined); assert.equal(result.outputs[0].byteLength, 3);
  assert.equal(result.outputs[0].path, dest); assert.deepEqual(await readFile(dest), Buffer.from([1, 2, 3]));
  assert.deepEqual(await readdir(path.dirname(dest)), ['result.jpg']);
});

test('convert without explicit optimization flags remains allowed; optimize supports --no-*', async t => {
  const dir = await scratch(t);
  const plain = await invoke(['convert', 'model.obj', '-o', path.join(dir, 'plain.glb'), '--no-animations', '--center', '--only-visible', '--json'], {
    convertModelToGlb: async (input, opts) => {
      assert.equal(opts.optimize, false); assert.equal(opts.ratio, undefined); assert.equal(opts.animations, false);
      assert.equal(opts.center, true); assert.equal(opts.onlyVisible, true);
      return envelope('convert', input, [{ name: 'model.glb', format: 'glb', bytes: new Uint8Array([4]) }]);
    },
  });
  assert.equal(plain.code, 0, plain.err);
  const opt = await invoke(['optimize', 'model.glb', '-o', path.join(dir, 'optimized.glb'), '--no-simplify', '--no-palette', '--json'], {
    optimizeModel: async (input, opts) => {
      assert.equal(opts.simplify, false); assert.equal(opts.palette, false); assert.equal(opts.weld, true);
      assert.equal(opts.ratioExplicit, false);
      return envelope('optimize', input, [{ name: 'model.glb', format: 'glb', bytes: new Uint8Array([5]) }]);
    },
  });
  assert.equal(opt.code, 0, opt.err);
});

test('multi-view collision preflight avoids loading API and leaves originals unchanged', async t => {
  const dir = await scratch(t);
  const opts = validateOptions('render', { outputDir: dir, views: 'front,back' });
  const destinations = outputPaths('render', '/tmp/chair.glb', opts);
  await writeFile(destinations[1], 'original');
  const r = await invoke(['render', '/tmp/chair.glb', '--output-dir', dir, '--views', 'front,back', '--json'], {});
  assert.equal(r.code, 1); assert.equal(r.loads, 0); assert.equal(JSON.parse(r.out).error.code, 'OUTPUT_WRITE');
  assert.equal(await readFile(destinations[1], 'utf8'), 'original'); assert.deepEqual(await readdir(dir), ['chair-back.png']);
});

test('multi-view render writes deterministic destinations', async t => {
  const dir = await scratch(t);
  const r = await invoke(['render', '/tmp/chair.glb', '--output-dir', dir, '--views', 'front,back', '--json'], {
    renderModelImages: async (input, opts) => {
      assert.deepEqual(opts.views, ['front', 'back']);
      return envelope('render', input, [image('front'), image('back')]);
    },
  });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out).outputs.map(o => o.path), [path.join(dir, 'chair-front.png'), path.join(dir, 'chair-back.png')]);
});

test('no-overwrite commit is race-safe; explicit overwrite replaces', async t => {
  const dir = await scratch(t), dest = path.join(dir, 'out.png');
  await preflightOutputs([dest]);
  await writeFile(dest, 'concurrent');
  await assert.rejects(writeOutputs([image()], [dest]), failure('OUTPUT_WRITE'));
  assert.equal(await readFile(dest, 'utf8'), 'concurrent');
  await writeOutputs([image()], [dest], true);
  assert.deepEqual(await readFile(dest), Buffer.from([1, 2, 3])); assert.deepEqual(await readdir(dir), ['out.png']);
});

test('partial write failure reports already committed outputs and removes temporary siblings', async t => {
  const dir = await scratch(t), first = path.join(dir, 'first.png'), second = path.join(dir, 'second.png');
  await mkdir(second);
  let error;
  try { await writeOutputs([image(), image('back')], [first, second]); } catch (e) { error = e; }
  assert.equal(error.code, 'OUTPUT_WRITE'); assert.equal(error.outputs.length, 1); assert.equal(error.outputs[0].path, first);
  assert.equal(error.outputs[0].byteLength, 3); assert.deepEqual((await readdir(dir)).sort(), ['first.png', 'second.png']);
});

test('API errors retain stable codes with exit 1 or 2', async () => {
  for (const [code, exit] of [['MODEL_LOAD', 1], ['INVALID_ARGUMENT', 2]]) {
    const r = await invoke(['info', 'missing.glb', '--json'], {
      inspectModel: async () => { throw Object.assign(new Error('fake error'), { code }); },
    });
    assert.equal(r.code, exit); assert.equal(JSON.parse(r.out).error.code, code); assert.deepEqual(JSON.parse(r.out).outputs, []);
  }
});

test('SIGINT aborts backend signal and returns JSON exit 130', async () => {
  const before = process.listenerCount('SIGINT');
  const r = await invoke(['info', 'model.glb', '--json'], {
    inspectModel: async (input, opts) => {
      process.emit('SIGINT'); assert.equal(opts.signal.aborted, true); throw opts.signal.reason;
    },
  });
  assert.equal(r.code, 130); assert.equal(JSON.parse(r.out).error.code, 'ABORTED');
  assert.equal(process.listenerCount('SIGINT'), before);
});

test('output bytes and output count are validated without leaking binary data', async t => {
  const dir = await scratch(t), dest = path.join(dir, 'bad.png');
  await assert.rejects(writeOutputs([image()], []), failure('OUTPUT_WRITE'));
  await assert.rejects(writeOutputs([{ name: 'bad.png', bytes: [1, 2] }], [dest]), failure('OUTPUT_WRITE'));
  assert.deepEqual(await readdir(dir), []);
});

test('SIGINT during output handling preserves committed files in the failure envelope', async t => {
  const dir = await scratch(t), controller = new AbortController();
  const second = image('back');
  Object.defineProperty(second, 'bytes', { enumerable: true, get() {
    controller.abort(Object.assign(new Error('Interrupted'), { code: 'ABORTED' }));
    return Buffer.from([2]);
  } });
  let error;
  try { await writeOutputs([image(), second], [path.join(dir, 'first.png'), path.join(dir, 'second.png')], false, controller.signal); } catch (e) { error = e; }
  assert.equal(error.code, 'ABORTED'); assert.equal(error.outputs.length, 1);
  assert.deepEqual(await readdir(dir), ['first.png']); assert.equal(error.outputs[0].bytes, undefined);
});

test('output parent collisions are caught before API processing', async t => {
  const dir = await scratch(t), parent = path.join(dir, 'file');
  await writeFile(parent, 'immutable');
  const r = await invoke(['convert', 'model.obj', '-o', path.join(parent, 'out.glb'), '--json'], {});
  assert.equal(r.loads, 0); assert.equal(r.code, 1); assert.equal(JSON.parse(r.out).error.code, 'OUTPUT_WRITE');
  assert.equal(await readFile(parent, 'utf8'), 'immutable');
});

test('optimization aliases and disabled compression normalize to backend types', () => {
  const opts = validateOptions('optimize', { simplifyRatio: '0.5', simplifyError: '0.01', textureSize: '512', compress: 'none', textureCompress: 'false' });
  assert.equal(opts.simplifyRatio, 0.5); assert.equal(opts.simplifyError, 0.01); assert.equal(opts.textureSize, 512);
  assert.equal(opts.compress, false); assert.equal(opts.textureCompress, false);
});

test('CLI retains API timings and adds file write / command elapsed durations', async t => {
  const dir = await scratch(t);
  const result = await invoke(['render', 'model.glb', '-o', path.join(dir, 'preview.png'), '--json'], {
    renderModelImages: async input => ({ ...envelope('render', input, [image()]), data: { timings: { unit: 'ms', totalMs: 12, renderMs: 8 } } }),
  });
  assert.equal(result.code, 0);
  const timings = JSON.parse(result.out).data.timings;
  assert.equal(timings.totalMs, 12); assert.equal(timings.renderMs, 8);
  assert.ok(timings.outputWriteMs >= 0);
  assert.ok(timings.cliTotalMs >= timings.outputWriteMs);
});

test('CLI output failure preserves API timings and reports incomplete write elapsed time', async t => {
  const dir = await scratch(t);
  const destination = path.join(dir, 'preview.png');
  const result = await invoke(['render', 'model.glb', '-o', destination, '--json'], {
    renderModelImages: async input => {
      // Simulate another writer winning after preflight, before commit.
      await writeFile(destination, 'existing');
      return { ...envelope('render', input, [image()]), data: { timings: { unit: 'ms', totalMs: 12, renderMs: 8 } } };
    },
  });
  assert.equal(result.code, 1);
  const e = JSON.parse(result.out).error;
  assert.equal(e.code, 'OUTPUT_WRITE');
  assert.equal(e.details.timings.totalMs, 12);
  assert.equal(e.details.timings.outputWriteMs, null);
  assert.ok(e.details.timings.outputWriteElapsedMs >= 0);
});
