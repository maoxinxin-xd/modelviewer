import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createModelProcessor } from '../node/index.mjs';

const source = {
  bytes: Buffer.from('; FBX 7.4.0 project file\nFBXHeaderExtension: {\n FBXVersion: 7400\n}\n'),
  fileName: 'cancel.fbx',
};

async function waitState(file) {
  for (let i = 0; i < 200; i++) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    await delay(25);
  }
  throw new Error('Native converter did not start');
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (cause) { if (cause.code === 'ESRCH') return false; throw cause; }
}

for (const reason of ['ABORTED', 'TIMEOUT', 'PROCESSOR_CLOSED',
  'DEADLINE', 'CONVERSION_FAILED']) {
  test(`native lifecycle: ${reason} removes converter, descendants and workspace`, {
    skip: process.platform === 'win32',
  }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mivo-lifecycle-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const stateFile = path.join(directory, 'state.json');
    const binary = path.join(directory, 'fake converter.mjs');
    await writeFile(binary, `#!${process.execPath}
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  console.log('FBX2glTF version 0.9.7');
} else {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({
    pid: process.pid, descendant: child.pid, cwd: process.cwd(),
  }));
  ${reason === 'CONVERSION_FAILED' ? 'setTimeout(() => process.exit(7), 100);' :
    'setInterval(() => {}, 1000);'}
}
`, { mode: 0o755 });
    const processor = createModelProcessor();
    t.after(() => processor.close());
    const controller = new AbortController();
    const promise = processor.convertModelToGlb(source, {
      fbxBinary: binary, signal: controller.signal, timeout: reason === 'DEADLINE' ? 2 : 20,
    });
    // Attach immediately so cancellation does not produce an unhandled rejection.
    const checked = assert.rejects(promise, cause => {
      const expected = reason === 'DEADLINE' ? 'TIMEOUT' :
        reason === 'CONVERSION_FAILED' ? 'FBX_CONVERSION_FAILED' : reason;
      assert.equal(cause.code, expected);
      assert.equal(cause.details.cleanupError, undefined);
      return true;
    });
    const state = await waitState(stateFile);
    assert.ok(isAlive(state.pid));
    assert.ok(isAlive(state.descendant));
    if (reason === 'PROCESSOR_CLOSED') await processor.close();
    else if (!['DEADLINE', 'CONVERSION_FAILED'].includes(reason)) {
      controller.abort(Object.assign(new Error('Stop task'), { code: reason }));
    }
    await checked;
    assert.equal(isAlive(state.pid), false);
    assert.equal(isAlive(state.descendant), false);
    let workspace = state.cwd;
    while (!path.basename(workspace).startsWith('mivo-model-task-')) {
      const parent = path.dirname(workspace);
      assert.notEqual(parent, workspace);
      workspace = parent;
    }
    await assert.rejects(stat(workspace), { code: 'ENOENT' });
  });
}

test('native lifecycle: killed host triggers orphan group and workspace cleanup', {
  skip: process.platform === 'win32',
}, async t => {
  const { spawn } = await import('node:child_process');
  const directory = await mkdtemp(path.join(tmpdir(), 'mivo-host-exit-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const binary = path.join(directory, 'converter.mjs');
  await writeFile(binary, `#!${process.execPath}
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  console.log('FBX2glTF version 0.9.7');
} else {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({
    pid: process.pid, descendant: child.pid, worker: process.ppid, cwd: process.cwd(),
  }));
  setInterval(() => {}, 1000);
}
`, { mode: 0o755 });
  const hostScript = path.join(directory, 'host.mjs');
  const sdkUrl = new URL('../node/index.mjs', import.meta.url).href;
  await writeFile(hostScript, `
import { createModelProcessor } from ${JSON.stringify(sdkUrl)};
const source = {
  bytes: Buffer.from(${JSON.stringify(source.bytes.toString())}), fileName: 'host.fbx',
};
createModelProcessor().convertModelToGlb(source, {
  fbxBinary: ${JSON.stringify(binary)}, timeout: 30,
}).catch(() => {});
`);
  const host = spawn(process.execPath, [hostScript], { stdio: 'ignore' });
  const closed = new Promise(resolve => host.once('close', resolve));
  t.after(() => { if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL'); });
  const state = await waitState(stateFile);
  host.kill('SIGKILL');
  await closed;
  let workspace = state.cwd;
  while (!path.basename(workspace).startsWith('mivo-model-task-')) {
    workspace = path.dirname(workspace);
  }
  let removed = false;
  for (let i = 0; i < 240; i++) {
    try { await stat(workspace); }
    catch (cause) { if (cause.code === 'ENOENT') { removed = true; break; } throw cause; }
    await delay(25);
  }
  assert.ok(removed, 'Orphan workspace was not removed');
  for (const pid of [state.pid, state.descendant, state.worker]) assert.equal(isAlive(pid), false);
});
