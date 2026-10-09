import path from 'node:path';

export const OPTIMIZATION_KEYS = Object.freeze(['ratio', 'error', 'textures', 'compress', 'textureCompress', 'instance', 'palette', 'flatten', 'join', 'weld', 'simplify', 'simplifyRatio', 'simplifyError', 'simplifyLockBorder', 'textureSize']);
const views = ['front', 'back', 'side', 'top', 'none'];
function invalid(message) { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); }
function number(value, fallback, key, min, max = Infinity, integer = false) {
  const selected = value === undefined ? fallback : value;
  const n = typeof selected === 'number' ? selected : typeof selected === 'string' && selected.trim() ? Number(selected) : NaN;
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isSafeInteger(n))) invalid(`${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  return n;
}
function choice(value, fallback, key, allowed) {
  const result = value ?? fallback;
  if (!allowed.includes(result)) invalid(`${key} must be one of: ${allowed.join(', ')}`);
  return result;
}
function boolean(value, fallback, key) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') invalid(`${key} must be a boolean`);
  return value;
}

/** Shared API/CLI validation. CLI-only destination requirements live in cli.mjs.
 * ratioExplicit survives repeated normalization so the default ratio is not user intent.
 */
export function validateOptions(command, opts = {}) {
  if (!['info', 'render', 'convert', 'optimize'].includes(command)) invalid(`Unknown command: ${command}`);
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) invalid('Options must be an object');
  const o = { ...opts };
  o.timeout = number(opts.timeout, 120, 'timeout', Number.MIN_VALUE, 86400);
  o.strict = boolean(opts.strict, false, 'strict');
  o.allowNetwork = boolean(opts.allowNetwork, false, 'allowNetwork');
  o.overwrite = boolean(opts.overwrite, false, 'overwrite');
  const dirs = opts.resourceDirs ?? opts.resourceDir ?? [];
  if (!Array.isArray(dirs) || dirs.some(d => typeof d !== 'string' || !d.trim())) invalid('resourceDirs must be an array of paths');
  o.resourceDirs = dirs.map(d => path.resolve(d));
  delete o.resourceDir;
  if (opts.entry !== undefined && (typeof opts.entry !== 'string' || !opts.entry.trim())) invalid('entry must be a nonempty archive entry');
  if (opts.input !== undefined) {
    if (typeof opts.input !== 'string' || !opts.input.trim()) invalid('input must be a nonempty path');
    o.input = path.resolve(opts.input);
  }
  if (opts.onProgress !== undefined && typeof opts.onProgress !== 'function') invalid('onProgress must be a function');
  const optimizationRequested = OPTIMIZATION_KEYS.some(k => opts[k] !== undefined);
  if (command === 'convert') {
    o.optimize = boolean(opts.optimize, false, 'optimize');
    if (!o.optimize && optimizationRequested) invalid('Optimization options require --optimize for convert');
    o.center = boolean(opts.center, false, 'center');
    o.onlyVisible = boolean(opts.onlyVisible, false, 'onlyVisible');
    o.animations = boolean(opts.animations, true, 'animations');
  }
  if (command === 'optimize' || (command === 'convert' && o.optimize)) {
    o.ratioExplicit = boolean(opts.ratioExplicit, opts.ratio !== undefined || opts.simplifyRatio !== undefined, 'ratioExplicit');
    o.ratio = number(opts.ratio ?? opts.simplifyRatio, 0, 'ratio', 0, 1);
    o.error = number(opts.error ?? opts.simplifyError, 0.0001, 'error', 0, 1);
    o.textures = number(opts.textures ?? opts.textureSize, 2048, 'textures', 1, 16384, true);
    o.compress = choice(['none', 'false'].includes(opts.compress) ? false : opts.compress, 'meshopt', 'compress', ['meshopt', 'draco', 'quantize', false]);
    o.textureCompress = choice(['none', 'false'].includes(opts.textureCompress) ? false : opts.textureCompress, 'auto', 'textureCompress', ['auto', 'webp', 'avif', false]);
    o.simplifyRatio = o.ratio;
    o.simplifyError = o.error;
    o.simplifyLockBorder = boolean(opts.simplifyLockBorder, false, 'simplifyLockBorder');
    o.textureSize = o.textures;
    for (const k of ['instance', 'palette', 'flatten', 'join', 'weld', 'simplify']) o[k] = boolean(opts[k], true, k);
  }
  if (command === 'render') {
    o.format = choice(opts.format === 'jpg' ? 'jpeg' : opts.format, 'png', 'format', ['png', 'jpeg', 'webp']);
    o.size = number(opts.size, 1024, 'size', 1, Infinity, true);
    o.width = number(opts.width, opts.height ?? o.size, 'width', 1, 8192, true);
    o.height = number(opts.height, opts.width ?? o.size, 'height', 1, 8192, true);
    if (o.width * o.height > 16777216) invalid('Total image pixels must not exceed 16777216');
    o.dpr = number(opts.dpr, 1, 'dpr', 1, 1);
    o.viewExplicit = boolean(opts.viewExplicit, opts.view !== undefined || opts.presetView !== undefined, 'viewExplicit');
    o.view = choice(opts.view ?? opts.presetView, 'front', 'view', views);
    o.presetView = o.view;
    if (opts.views !== undefined) {
      o.views = typeof opts.views === 'string' ? opts.views.split(',').map(v => v.trim()) : opts.views;
      if (!Array.isArray(o.views) || !o.views.length || o.views.some(v => !views.includes(v)) || new Set(o.views).size !== o.views.length) invalid('views must be a nonempty list of unique front/back/side/top/none values');
      if (o.viewExplicit) invalid('Use view or views, not both');
    }
    o.background = opts.background ?? (o.format === 'jpeg' ? '#ffffff' : 'transparent');
    if (typeof o.background !== 'string' || !o.background.trim()) invalid('background must be a nonempty color or transparent');
    if (o.format === 'jpeg' && o.background === 'transparent') invalid('JPEG does not support a transparent background');
    o.grid = boolean(opts.grid ?? opts.showGrid, false, 'grid');
    o.showGrid = o.grid;
    o.textureMode = choice(opts.textureMode, 'textured', 'textureMode', ['textured', 'clay', 'normal', 'albedo']);
    o.projection = choice(opts.projection, 'perspective', 'projection', ['perspective', 'orthographic']);
    if (opts.quality !== undefined && o.format === 'png') invalid('quality is only supported for JPEG/WebP');
    if (o.format !== 'png') o.quality = number(opts.quality, 0.92, 'quality', 0, 1);
    o.lightIntensity = number(opts.lightIntensity, 2, 'lightIntensity', 0);
    o.ambientIntensity = number(opts.ambientIntensity, 2, 'ambientIntensity', 0);
    o.angle = number(opts.angle ?? opts.lightAngle, 0, 'angle', -Infinity);
    o.lightAngle = o.angle;
  }
  return o;
}
