import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareDevice, checkDevice } from '../node/gpu-device.mjs';

test('software Vulkan selection is isolated from the host environment', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mivo-device-test-'));
  const env = { MIVO_GPU_BACKEND: 'metal', MIVO_GPU_ADAPTER: 'hardware' };
  const environmentKeys = ['VK_DRIVER_FILES', 'VK_ICD_FILENAMES', 'MIVO_GPU_BACKEND'];
  const before = environmentKeys.map(key => process.env[key]);
  try {
    const icd = path.join(directory, 'lvp_icd.x86_64.json');
    await writeFile(icd, '{}');
    const selected = await prepareDevice('software', {
      platform: 'linux', env, icdDirs: [directory],
    });
    assert.deepEqual(selected, { backend: 'vulkan' });
    assert.equal(env.VK_DRIVER_FILES, icd);
    assert.equal(env.VK_ICD_FILENAMES, icd);
    assert.deepEqual(environmentKeys.map(key => process.env[key]), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('software selection reports unavailable dependencies or platforms', async () => {
  await assert.rejects(prepareDevice('software', {
    platform: 'linux', env: {}, icdDirs: ['/path-that-does-not-exist'],
  }), { code: 'RENDER_DEVICE_UNAVAILABLE' });
  await assert.rejects(prepareDevice('software', {
    platform: 'darwin', env: {}, icdDirs: [],
  }), { code: 'RENDER_DEVICE_UNAVAILABLE' });
});

test('device requests never silently select the other device class', () => {
  const software = { info: { description: 'llvmpipe Mesa software renderer' } };
  const hardware = { info: { description: 'NVIDIA hardware' } };
  assert.equal(checkDevice('software', software), 'software');
  assert.equal(checkDevice('hardware', hardware), 'hardware');
  assert.throws(() => checkDevice('software', hardware), { code: 'RENDER_DEVICE_UNAVAILABLE' });
  assert.throws(() => checkDevice('hardware', software), { code: 'RENDER_DEVICE_UNAVAILABLE' });
  assert.equal(checkDevice('auto', software), 'software');
});
