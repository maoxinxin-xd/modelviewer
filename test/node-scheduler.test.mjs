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
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === -12345) throw Object.assign(new Error('No mock group'), { code: 'ESRCH' });
    return originalKill(pid, signal);
  };
  childProcess.fork = implementation; syncBuiltinESMExports();
  t.after(() => {
    process.kill = originalKill; childProcess.fork = original; syncBuiltinESMExports();
  });
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


test('already-aborted signals preserve timeout/cancellation codes without spawning', async t => {
  let forks = 0;
  replaceFork(t, () => { forks++; return fakeWorker(); });
  const processor = createModelProcessor();
  t.after(() => processor.close());
  for (const code of ['TIMEOUT', 'ABORTED', undefined]) {
    const controller = new AbortController();
    controller.abort(code ? Object.assign(new Error('Stopped'), { code }) : undefined);
    await assert.rejects(
      processor.inspectModel('example.glb', { signal: controller.signal }),
      { code: code === 'TIMEOUT' ? 'TIMEOUT' : 'ABORTED' },
    );
  }
  assert.equal(forks, 0);
  assert.equal((await processor.inspectModel('example.glb')).ok, true);
});

test('queued timeout signals retain TIMEOUT and zero execution time', async t => {
  replaceFork(t, () => fakeWorker());
  const processor = createModelProcessor();
  t.after(() => processor.close());
  const active = processor.inspectModel('example.glb');
  const controller = new AbortController();
  const queued = processor.inspectModel('example.glb', { signal: controller.signal });
  controller.abort(Object.assign(new Error('Deadline exceeded'), { code: 'TIMEOUT' }));
  await assert.rejects(queued, e => {
    assert.equal(e.code, 'TIMEOUT');
    assert.equal(e.details.timings.executionMs, 0);
    return true;
  });
  await active;
});

test('cleanup failure quarantines the processor and rejects close', async t => {
  const { rm } = await import('node:fs/promises');
  let workspace, calls = 0;
  replaceFork(t, () => {
    calls++;
    const child = fakeWorker();
    const send = child.send;
    child.send = message => { workspace = message.directory; send(message); };
    return child;
  });
  const wrappedKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === -12345) throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
    return wrappedKill(pid, signal);
  };
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const processor = createModelProcessor();
  const active = processor.inspectModel('example.glb');
  const queued = processor.inspectModel('queued.glb');
  await Promise.all([
    assert.rejects(active, { code: 'WORKER_CLEANUP_FAILED' }),
    assert.rejects(queued, { code: 'WORKER_CLEANUP_FAILED' }),
  ]);
  assert.equal(calls, 1, 'A queued worker started despite incomplete cleanup');
  await assert.rejects(processor.inspectModel('next.glb'), { code: 'WORKER_CLEANUP_FAILED' });
  await assert.rejects(processor.close(), { code: 'WORKER_CLEANUP_FAILED' });
});

test('transient EPERM group probes wait for confirmed process-group exit', async t => {
  replaceFork(t, () => fakeWorker());
  const original = process.kill;
  let probes = 0;
  process.kill = (pid, signal) => {
    if (pid === -12345) {
      if (signal === 'SIGKILL') return true;
      if (++probes <= 2) {
        throw Object.assign(new Error('Reaping orphan'), { code: 'EPERM' });
      }
    }
    return original(pid, signal);
  };
  const processor = createModelProcessor();
  t.after(() => processor.close());
  assert.equal((await processor.inspectModel('example.glb')).ok, true);
  assert.equal(probes, 3);
  await processor.close();
});
