import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createModelProcessor } from '../node/index.mjs';

function fakeWorker({ failSpawn = false, stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.pid = failSpawn ? undefined : 12345;
  child.exitCode = child.signalCode = null;
  child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return !!child.pid; };
  child.send = () => queueMicrotask(() => {
    if (failSpawn) { child.emit('error', new Error('spawn EAGAIN')); child.emit('close', -1, null); return; }
    if (stderr) child.stderr.write(stderr);
    child.emit('message', { type: 'progress', message: 'working' });
    child.emit('message', { type: 'result', ok: true, result: { ok: true } });
    child.exitCode = 0;
    child.emit('exit', 0, null); child.emit('close', 0, null);
  });
  return child;
}
function replaceFork(t, implementation) {
  const original = childProcess.fork;
  childProcess.fork = implementation; syncBuiltinESMExports();
  t.after(() => { childProcess.fork = original; syncBuiltinESMExports(); });
}
test('failed fork releases queue slot for the next task', async t => {
  let calls = 0;
  replaceFork(t, () => fakeWorker({ failSpawn: ++calls === 1 }));
  const processor = createModelProcessor(); t.after(() => processor.close());
  await assert.rejects(processor.inspectModel('example.glb'), { code: 'WORKER_START_FAILED' });
  assert.equal((await processor.inspectModel('example.glb', { timeout: 1 })).ok, true);
  assert.equal(calls, 2);
});
test('throwing onProgress callback cannot escape stderr or IPC handlers', async t => {
  replaceFork(t, () => fakeWorker({ stderr: 'warning' }));
  const processor = createModelProcessor(); t.after(() => processor.close());
  assert.equal((await processor.inspectModel('example.glb', { onProgress() { throw new Error('host callback failure'); } })).ok, true);
});

test('cancellation before worker starts records zero execution and nonnegative queue time', async t => {
  replaceFork(t, () => fakeWorker());
  const processor = createModelProcessor(); t.after(() => processor.close());
  const active = processor.inspectModel('example.glb');
  const controller = new AbortController();
  const queued = processor.inspectModel('example.glb', { signal: controller.signal });
  controller.abort();
  await assert.rejects(queued, e => {
    assert.equal(e.details.timings.executionMs, 0);
    assert.equal(e.details.timings.queueMs, e.details.timings.totalMs);
    assert.ok(e.details.timings.queueMs >= 0);
    return true;
  });
  await active;
});
