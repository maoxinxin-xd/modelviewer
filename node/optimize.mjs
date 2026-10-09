import { performance } from 'node:perf_hooks';
import {
  dedup, instance, palette, flatten, join, weld, simplify, resample,
  prune, sparse, textureCompress, meshopt, draco, quantize,
  INSTANCE_DEFAULTS, PALETTE_DEFAULTS, JOIN_DEFAULTS, SIMPLIFY_DEFAULTS,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { inspectDocument } from './inspect.mjs';

const DEFAULTS = Object.freeze({
  instance: true, instanceMin: INSTANCE_DEFAULTS.min,
  palette: true, paletteMin: PALETTE_DEFAULTS.min,
  flatten: true, join: true,
  joinMeshes: !JOIN_DEFAULTS.keepMeshes, joinNamed: !JOIN_DEFAULTS.keepNamed,
  weld: true, simplify: true, simplifyRatio: SIMPLIFY_DEFAULTS.ratio,
  simplifyError: SIMPLIFY_DEFAULTS.error, simplifyLockBorder: SIMPLIFY_DEFAULTS.lockBorder,
  resample: true, prune: true, pruneAttributes: true, pruneSolidTextures: true,
  sparse: true, textureSize: 2048, textureCompress: 'auto',
  compress: 'meshopt', meshoptLevel: 'high', limitInputPixels: true,
});

function failure(message, code = 'INVALID_ARGUMENT', cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('options must be an object.');
  const options = { ...DEFAULTS };
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw failure(`Unknown optimization option: ${key}.`);
    if (value !== undefined) options[key] = value;
  }
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (typeof value === 'boolean' && typeof options[key] !== 'boolean') throw failure(`${key} must be a boolean.`);
  }
  for (const key of ['simplifyRatio', 'simplifyError']) {
    if (!Number.isFinite(options[key]) || options[key] < 0 || options[key] > 1) throw failure(`${key} must be a finite number from 0 to 1.`);
  }
  for (const key of ['instanceMin', 'paletteMin', 'textureSize']) {
    if (!Number.isSafeInteger(options[key]) || options[key] < 1) throw failure(`${key} must be a positive safe integer.`);
  }
  // Bound requested image dimensions; Sharp's input pixel limit is enabled by
  // default independently of this output limit.
  if (options.textureSize > 16384) throw failure('textureSize must not exceed 16384 pixels.');
  if (!['medium', 'high'].includes(options.meshoptLevel)) throw failure('meshoptLevel must be medium or high.');
  if (![false, 'meshopt', 'draco', 'quantize'].includes(options.compress)) throw failure('compress must be meshopt, draco, quantize, or false.');
  if (![false, 'auto', 'webp', 'avif', 'ktx2'].includes(options.textureCompress)) throw failure('textureCompress must be auto, webp, avif, ktx2, or false.');
  if (options.textureCompress === 'ktx2') throw failure('KTX2 encoding requires an external encoder and is not supported by this Sharp-only module.', 'UNSUPPORTED_OPERATION');
  return options;
}

/** Apply glTF Transform v4.5.1 CLI optimize defaults and transform order.
 * Mutates the supplied decoded Document. Compression is configured here but
 * encoded only when the caller writes it through their registered IO instance.
 * context.signal is checked between transforms (not a hard CPU time limit).
 * This module does not load, write, or overwrite any model files.
 */
export async function optimizeDocument(document, options = {}, context = {}) {
  if (!document || typeof document.transform !== 'function' || typeof document.getRoot !== 'function') throw failure('Expected a glTF Transform Document.');
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw failure('context must be an object.');
  const normalized = validate(options);
  if (context.signal !== undefined && (!context.signal || typeof context.signal.aborted !== 'boolean')) throw failure('context.signal must be an AbortSignal.');
  const checkAbort = () => {
    if (context.signal?.aborted) throw failure('Optimization aborted.', 'ABORTED');
  };
  checkAbort();
  // ratio=0 removes all POINTS: require an intentional positive ratio instead.
  if (normalized.simplify && normalized.simplifyRatio === 0 && document.getRoot().listMeshes().some((mesh) =>
    mesh.listPrimitives().some((primitive) => primitive.getMode() === 0))) {
    throw failure('POINTS cannot be simplified with simplifyRatio=0. Set an explicit positive simplifyRatio or simplify=false.');
  }
  const before = inspectDocument(document);
  const warnings = [], transformations = [];
  const stageTimingsMs = {};
  const originalLogger = document.getLogger();
  const warningKeys = new Set();
  // Unknown upstream warnings may indicate lost fidelity; only explicitly
  // classified retention/configuration diagnostics are marked non-fidelity.
  const warn = (message, code = 'OPTIMIZATION_WARNING', affectsFidelity = true) => {
    if (code === 'OPTIMIZATION_WARNING' && /Instancing is not currently supported for animated models/.test(String(message))) { code = 'OPTIMIZATION_SKIPPED'; affectsFidelity = false; }
    const warning = { code, message: String(message), affectsFidelity };
    const key = JSON.stringify(warning);
    if (!warningKeys.has(key)) {
      warningKeys.add(key);
      warnings.push(warning);
    }
    originalLogger.warn(warning.message);
  };
  document.setLogger({
    debug: (message) => originalLogger.debug(message), info: (message) => originalLogger.info(message),
    warn, error: (message) => originalLogger.error(message),
  });
  try {
    if (normalized.simplify) await MeshoptSimplifier.ready;
    if (normalized.compress === 'meshopt') await MeshoptEncoder.ready;
    const steps = [['dedup', dedup()]];
    if (normalized.instance) steps.push(['instance', instance({ min: normalized.instanceMin })]);
    if (normalized.palette) steps.push(['palette', palette({ min: normalized.paletteMin })]);
    if (normalized.flatten) steps.push(['flatten', flatten()]);
    if (normalized.join) steps.push(['join', join({ keepNamed: !normalized.joinNamed, keepMeshes: !normalized.joinMeshes })]);
    if (normalized.weld) steps.push(['weld', weld()]);
    if (normalized.simplify) steps.push(['simplify', simplify({ simplifier: MeshoptSimplifier,
      ratio: normalized.simplifyRatio, error: normalized.simplifyError, lockBorder: normalized.simplifyLockBorder })]);
    // The installed library bundles keyframe-resample's JS implementation with
    // the same tolerance/cleanup defaults as the CLI's optional WASM backend.
    if (normalized.resample) steps.push(['resample', resample()]);
    if (normalized.prune) steps.push(['prune', prune({ keepAttributes: !normalized.pruneAttributes,
      keepIndices: false, keepLeaves: false, keepSolidTextures: !normalized.pruneSolidTextures })]);
    if (normalized.sparse) steps.push(['sparse', sparse()]);
    if (normalized.textureCompress !== false) steps.push(['textureCompress', textureCompress({
      encoder: sharp, resize: [normalized.textureSize, normalized.textureSize],
      targetFormat: normalized.textureCompress === 'auto' ? undefined : normalized.textureCompress,
      limitInputPixels: normalized.limitInputPixels,
    })]);
    if (normalized.compress === 'meshopt') steps.push(['meshopt', meshopt({ encoder: MeshoptEncoder, level: normalized.meshoptLevel })]);
    else if (normalized.compress === 'draco') {
      if (!normalized.weld) warn('Ignoring weld=false, required for Draco compression.', 'DRACO_REQUIRES_WELD', false);
      steps.push(['draco', draco()]);
    } else if (normalized.compress === 'quantize') steps.push(['quantize', quantize()]);
    for (const [name, transform] of steps) {
      checkAbort();
      if (name === 'textureCompress') {
        for (const texture of document.getRoot().listTextures()) {
          if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(texture.getMimeType())) {
            warn(`Preserving unsupported texture ${JSON.stringify(texture.getName() || texture.getURI())} (${texture.getMimeType() || 'unknown format'}); Sharp compression is skipped.`, 'UNSUPPORTED_TEXTURE_PRESERVED', false);
          }
        }
      }
      const stageStarted = performance.now();
      await document.transform(transform);
      stageTimingsMs[name] = performance.now() - stageStarted;
      transformations.push(name);
    }
    checkAbort();
    return { document, before, after: inspectDocument(document), transformations,
      warnings, options: normalized, stageTimingsMs };
  } catch (error) {
    const cause = error?.code ? error : failure(error?.message ?? 'Optimization failed.', 'OPTIMIZATION_FAILED', error);
    cause.details = { ...(cause.details || {}), stageTimingsMs: { ...stageTimingsMs } };
    throw cause;
  } finally {
    document.setLogger(originalLogger);
  }
}
