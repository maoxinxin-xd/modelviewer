import { performance } from 'node:perf_hooks';
import { fork } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { validateOptions } from './options.mjs';
import { safeText } from './diagnostics.mjs';
export { resolveFbxBinary, probeFbxBinary } from './native-fbx.mjs';

const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const error = (code, message, details) => Object.assign(new Error(message), { code, ...(details ? { details } : {}) });

function abortError(signal) {
  return signal?.reason?.code === 'TIMEOUT'
    ? error('TIMEOUT', 'Model task deadline exceeded.')
    : error('ABORTED', 'Model task was cancelled.');
}

/** Stop the task's private POSIX group, including the native converter. */
function terminate(task) {
  const child = task.child;
  if (!child?.pid) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (cause) { if (cause.code !== 'ESRCH') throw cause; }
  } else if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
}

async function release(task) {
  terminate(task);
  if (task.childClosed) await task.childClosed;
  if (task.child?.pid && process.platform !== 'win32') {
    const deadline = performance.now() + 5000;
    while (true) {
      try { process.kill(-task.child.pid, 0); }
      catch (cause) {
        if (cause.code === 'ESRCH') break;
        // macOS can transiently return EPERM while orphaned zombies are reaped.
        // Keep waiting for ESRCH; never treat EPERM as successful cleanup.
        if (cause.code !== 'EPERM') throw cause;
      }
      if (performance.now() >= deadline) {
        throw error('WORKER_CLEANUP_FAILED', 'Task process group did not exit.');
      }
      await delay(25);
    }
  }
  if (task.directory) await rm(task.directory, { recursive: true, force: true });
}

/** Isolated per-task processes: native resources and compatibility globals never reach the host. */
export function createModelProcessor({ concurrency = 1, maxQueue = 32 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(maxQueue) || maxQueue < 0) throw error('INVALID_ARGUMENT', 'concurrency must be a positive integer and maxQueue a non-negative integer.');
  let closed = false;
  let closing;
  let broken;
  const queue = [];
  const running = new Set();
  function pump() {
    while (!closed && !broken && running.size < concurrency && queue.length) {
      const task = queue.shift();
      if (task.done) continue;
      running.add(task);
      task.startedAt = performance.now();
      let stderr = '';
      let result;
      let child;
      try {
        task.directory = mkdtempSync(join(tmpdir(), 'mivo-model-task-'));
        child = fork(workerPath, [task.directory], {
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          serialization: 'advanced', execArgv: ['--max-old-space-size=2048'],
        });
        task.child = child;
        task.childClosed = new Promise(resolve => child.once('close', resolve));
        child.stderr.on('data', chunk => {
          stderr = (stderr + safeText(chunk.toString())).slice(-16384);
          try { task.onProgress?.(safeText(chunk.toString().trim())); } catch {}
        });
        child.on('error', cause => task.finish(error('WORKER_START_FAILED', cause.message)));
        child.on('message', message => {
          if (message.type === 'progress') { try { task.onProgress?.(safeText(message.message)); } catch {} }
          if (message.type === 'result') result = message;
        });
        // Resolve only after the worker has released resources and exited.
        child.on('exit', (code, signal) => {
          if (task.done) return;
          if (result?.ok && code === 0) task.finish(null, result.result);
          else if (result?.error) task.finish(error(result.error.code || 'PROCESSING_FAILED', result.error.message, result.error.details));
          else task.finish(error('WORKER_CRASHED', `Model worker exited (${signal || code}).`, { stderr }));
        });
        child.send({
          command: task.command, source: task.source, options: task.options,
          directory: task.directory,
        }, cause => { if (cause) task.finish(error('WORKER_START_FAILED', cause.message)); });
      } catch (cause) { task.finish(cause); }
    }
  }
  function submit(command, source, options = {}) {
    return new Promise((resolve, reject) => {
      if (closed) return reject(error('PROCESSOR_CLOSED', 'Model processor has been closed.'));
      if (broken) return reject(error('WORKER_CLEANUP_FAILED', 'Processor cleanup failed.'));
      if (running.size >= concurrency && queue.length >= maxQueue) return reject(error('QUEUE_FULL', 'Model processing queue is full.'));
      if (options.signal?.aborted) return reject(abortError(options.signal));
      let normalized;
      try { normalized = validateOptions(command, options); }
      catch (cause) { return reject(cause); }
      if (!(typeof source === 'string' || source && source.bytes instanceof Uint8Array && typeof source.fileName === 'string')) return reject(error('INVALID_ARGUMENT', 'source must be a file path or { bytes: Uint8Array, fileName: string }.'));
      const { signal, onProgress, ...serializable } = normalized;
      // The public callback and AbortSignal stay in the parent even if the validator removes them.
      const task = { command, source, options: serializable, onProgress: options.onProgress, child: null, done: false, submittedAt: performance.now(), startedAt: null };
      let timer;
      const abort = () => task.finish(abortError(options.signal));
      task.finish = (cause, value) => {
        if (task.done) return task.completion;
        task.done = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        const index = queue.indexOf(task);
        if (index !== -1) queue.splice(index, 1);
        task.completion = (async () => {
          try { await release(task); }
          catch (cleanupError) {
            task.cleanupError = cleanupError;
            broken = cleanupError;
            for (const queued of [...queue]) {
              queued.finish(error('WORKER_CLEANUP_FAILED', 'Processor cleanup failed.'));
            }
            if (cause) {
              cause.details = {
                ...(cause.details || {}),
                cleanupError: safeText(cleanupError.message),
              };
            } else cause = error('WORKER_CLEANUP_FAILED', safeText(cleanupError.message));
          }
          if (!task.cleanupError) running.delete(task);
          queueMicrotask(pump);
          const endedAt = performance.now();
          const totalMs = endedAt - task.submittedAt;
          const queueMs = (task.startedAt ?? endedAt) - task.submittedAt;
          const timing = { totalMs, queueMs, executionMs: totalMs - queueMs };
          if (cause) {
            cause.details = {
              ...(cause.details || {}),
              timings: { unit: 'ms', ...(cause.details?.timings || {}), ...timing },
            };
            reject(cause);
          } else {
            value.data ??= {};
            value.data.timings = { ...(value.data.timings || {}), ...timing };
            resolve(value);
          }
        })();
        return task.completion;
      };
      timer = setTimeout(() => task.finish(error('TIMEOUT', 'Model task deadline exceeded (including queue time).')), (normalized.timeout ?? 120) * 1000);
      options.signal?.addEventListener('abort', abort, { once: true });
      queue.push(task);
      pump();
    });
  }
  return {
    inspectModel: (source, options) => submit('info', source, options),
    renderModelImages: (source, options) => submit('render', source, options),
    convertModelToGlb: (source, options) => submit('convert', source, options),
    optimizeModel: (source, options) => submit('optimize', source, options),
    close() {
      if (closed) return closing;
      closed = true;
      closing = Promise.all([...queue, ...running].map(task =>
        task.finish(error('PROCESSOR_CLOSED', 'Model processor was closed.'))
      )).then(() => {
        if (broken) throw error('WORKER_CLEANUP_FAILED', safeText(broken.message));
      });
      return closing;
    }
  };
}
let defaultProcessor;
const processor = () => defaultProcessor ??= createModelProcessor();
export const inspectModel = (source, options) => processor().inspectModel(source, options);
export const renderModelImages = (source, options) => processor().renderModelImages(source, options);
export const convertModelToGlb = (source, options) => processor().convertModelToGlb(source, options);
export const optimizeModel = (source, options) => processor().optimizeModel(source, options);
