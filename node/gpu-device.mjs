import { readdir, access } from 'node:fs/promises';
import path from 'node:path';

const deviceError = message => Object.assign(new Error(message), {
  code: 'RENDER_DEVICE_UNAVAILABLE',
});

/** Select software Vulkan only in the isolated worker, never in the SDK host. */
export async function prepareDevice(mode = 'auto', {
  platform = process.platform,
  env = process.env,
  icdDirs = ['/usr/share/vulkan/icd.d', '/etc/vulkan/icd.d'],
} = {}) {
  const backend = env.MIVO_GPU_BACKEND || (
    platform === 'linux' ? 'vulkan' : platform === 'darwin' ? 'metal' : 'd3d12'
  );
  if (mode !== 'software') return { backend, adapter: env.MIVO_GPU_ADAPTER };
  if (platform !== 'linux') {
    throw deviceError('Explicit software rendering currently requires Linux Vulkan.');
  }
  const configured = env.VK_DRIVER_FILES || env.VK_ICD_FILENAMES || '';
  const candidates = configured.split(path.delimiter).filter(file => /lvp.*\.json$/i.test(file));
  for (const directory of icdDirs) {
    try {
      const names = (await readdir(directory)).filter(name => /^lvp.*\.json$/i.test(name));
      candidates.push(...names.sort().map(name => path.join(directory, name)));
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  for (const file of candidates) {
    try {
      await access(file);
      env.VK_DRIVER_FILES = file;
      env.VK_ICD_FILENAMES = file;
      return { backend: 'vulkan' };
    } catch { /* Try the next installed Lavapipe ICD. */ }
  }
  throw deviceError('Software rendering requires Mesa Lavapipe (mesa-vulkan-drivers).');
}

/** Refuse an unexpected device instead of silently using production GPU resources. */
export function checkDevice(mode, adapter) {
  const description = adapter.info?.description || '';
  const software = Boolean(adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter) ||
    /llvmpipe|lavapipe|swiftshader|software|\bcpu\b/i.test(description);
  if (mode === 'software' && !software) {
    throw deviceError('A software adapter was requested, but Vulkan selected a hardware device.');
  }
  if (mode === 'hardware' && software) {
    throw deviceError('A hardware adapter was requested, but only a software device is available.');
  }
  return software ? 'software' : 'hardware';
}
