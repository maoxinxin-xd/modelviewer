import { lstat, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Internal last-resort cleanup. This runs outside the orphaned worker's process group.
const group = Number(process.argv[2]);
const directory = process.argv[3];
if (!Number.isSafeInteger(group) || group <= 1 || group === process.pid || !directory) {
  process.exit(1);
}
if (!path.basename(directory).startsWith('mivo-model-task-') ||
    (await lstat(directory)).isSymbolicLink() ||
    path.dirname(await realpath(directory)) !== await realpath(tmpdir())) {
  process.exit(1);
}
try { process.kill(-group, 'SIGKILL'); }
catch (cause) { if (cause.code !== 'ESRCH') throw cause; }
const deadline = Date.now() + 5000;
while (true) {
  try { process.kill(-group, 0); }
  catch (cause) {
    if (cause.code === 'ESRCH') break;
    if (cause.code !== 'EPERM') throw cause;
  }
  if (Date.now() >= deadline) process.exit(1);
  await delay(25);
}
await rm(directory, { recursive: true, force: true });
