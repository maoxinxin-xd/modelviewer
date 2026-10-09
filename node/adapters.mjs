import * as THREE from 'three';
import { diagnostic, limitsFor, resourceError } from './resources.mjs';

const ADAPTER = Symbol('node-model-adapter');
let activeAdapter = null;

class NodeFileReader {
  constructor() { this.result = null; this.error = null; this.readyState = 0; this.listeners = new Map(); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type) { const event = { type, target: this }; this[`on${type}`]?.(event); for (const listener of this.listeners.get(type) ?? []) listener(event); }
  read(blob, dataURL) {
    this.readyState = 1;
    Promise.resolve().then(async () => {
      const buffer = await blob.arrayBuffer();
      this.result = dataURL ? `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}` : buffer;
      this.readyState = 2; this.dispatch('load'); this.dispatch('loadend');
    }).catch(error => { this.error = error; this.readyState = 2; this.dispatch('error'); this.dispatch('loadend'); });
  }
  readAsArrayBuffer(blob) { this.read(blob, false); }
  readAsDataURL(blob) { this.read(blob, true); }
}

/**
 * Process-local compatibility shim. Call ONLY in the task's isolated child process.
 * Not concurrency safe: one installation per child; dispose after parse/export.
 * All resource loading uses resolver, never browser loader orchestration.
 */
export async function installNodeAdapters({ resolver, warnings = [], options = {}, context = {} } = {}) {
  if (activeAdapter) throw resourceError('ADAPTER_ALREADY_ACTIVE', 'Node model adapters require serialized use within an isolated process.');
  const [{ createCanvas, loadImage, ImageData, Image, CanvasElement }, { default: sharp }, { DOMParser }] = await Promise.all([
    import('@napi-rs/canvas'), import('sharp'), import('linkedom'),
  ]);
  // Recheck after asynchronous imports, before installing any process-local shims.
  if (activeAdapter) throw resourceError('ADAPTER_ALREADY_ACTIVE', 'Node adapters are already installed.');
  const limits = limitsFor(options), pending = new Set(), blobs = new Map();
  const maxTexturePixels = options.maxTexturePixels ?? 64 * 1024 ** 2;
  if (!Number.isSafeInteger(maxTexturePixels) || maxTexturePixels <= 0 || maxTexturePixels > 64 * 1024 ** 2) throw resourceError('INVALID_TEXTURE_LIMIT', 'maxTexturePixels must be a positive integer no greater than 67108864.');
  const snapshots = new Map();
  const setGlobal = (name, value) => { snapshots.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); };
  const originalLoad = THREE.ImageLoader.prototype.load;
  const originalFileLoad = THREE.FileLoader.prototype.load;
  const canvasToBlob = Object.getOwnPropertyDescriptor(CanvasElement.prototype, 'toBlob');
  const manager = new THREE.LoadingManager();
  const adapter = { manager, warnings, pending };
  activeAdapter = adapter; manager[ADAPTER] = adapter;
  const objectURL = {
    createObjectURL(blob) { const uri = `blob:node-model/${blobs.size}-${Math.random().toString(36).slice(2)}`; blobs.set(uri, blob); return uri; },
    revokeObjectURL(uri) { blobs.delete(uri); },
  };
  const read = async uri => {
    if (blobs.has(uri)) {
      const blob = blobs.get(uri);
      if (blob.size > limits.maxEntryBytes) throw resourceError('RESOURCE_SIZE_LIMIT', 'Embedded image exceeds resource limit.');
      return new Uint8Array(await blob.arrayBuffer());
    }
    if (!resolver) throw resourceError('RESOURCE_NOT_FOUND', `No resolver for texture: ${uri}`);
    return resolver.resolve(uri);
  };
  adapter.readResource = read;
  let decodedPixelBytes = 0;
  const reservePixels = (width, height) => {
    const pixels = width * height;
    decodedPixelBytes += pixels * 4;
    if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > maxTexturePixels || pixels * 4 > limits.maxEntryBytes || decodedPixelBytes > limits.maxTotalBytes) throw resourceError('TEXTURE_SIZE_LIMIT', 'Decoded texture dimensions or total pixel bytes exceed limits.');
  };
  const decode = async (bytes, uri) => {
    let png;
    if (/\.tga(?:$|[?#])/i.test(uri) || /^data:image\/tga/i.test(uri)) {
      const { TGALoader } = await import('three/addons/loaders/TGALoader.js');
      // Check dimensions before the official decoder allocates the output.
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.length < 18 || view.getUint16(12, true) * view.getUint16(14, true) > maxTexturePixels) throw resourceError('TEXTURE_SIZE_LIMIT', 'TGA dimensions exceed limit.');
      reservePixels(view.getUint16(12, true), view.getUint16(14, true));
      const parsed = new TGALoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      png = await sharp(Buffer.from(parsed.data), { raw: { width: parsed.width, height: parsed.height, channels: 4 } }).png().toBuffer();
    } else {
      const decoder = sharp(Buffer.from(bytes), { limitInputPixels: maxTexturePixels, animated: false });
      const metadata = await decoder.metadata();
      reservePixels(metadata.width, metadata.height);
      png = await decoder.png().toBuffer();
    }
    return loadImage(png);
  };
  adapter.decodeImage = decode;
  THREE.ImageLoader.prototype.load = function (uri, onLoad, _onProgress, onError) {
    if (this.manager[ADAPTER] !== adapter) return originalLoad.call(this, uri, onLoad, _onProgress, onError);
    uri = this.manager.resolveURL((this.path || '') + (uri || ''));
    const canvas = createCanvas(1, 1);
    // Native CanvasElement.data() is a method, whereas Three treats any .data
    // property as DataTexture pixels. Hide it on image canvases to avoid exporting
    // an all-zero image through GLTFExporter's raw-pixel branch.
    Object.defineProperty(canvas, 'data', { configurable: true, value: undefined });
    canvas.userData = { nodeTexturePending: true, resource: uri };
    this.manager.itemStart(uri);
    const task = Promise.resolve().then(async () => {
      const image = await decode(await read(uri), uri);
      canvas.width = image.width; canvas.height = image.height;
      canvas.getContext('2d').drawImage(image, 0, 0);
      canvas.userData.nodeTexturePending = false;
      onLoad?.(canvas);
    }).catch(error => {
      canvas.userData.nodeTextureFailed = true;
      warnings.push(diagnostic(error.code || 'TEXTURE_LOAD_FAILED', `Texture failed: ${uri}: ${error.message}`, true, { resource: uri }));
      try { onError?.(error); } catch (callbackError) { context.log?.(callbackError.message); }
      this.manager.itemError(uri);
    }).finally(() => { this.manager.itemEnd(uri); pending.delete(task); });
    pending.add(task);
    return canvas;
  };
  THREE.FileLoader.prototype.load = function (uri, onLoad, onProgress, onError) {
    if (this.manager[ADAPTER] !== adapter) return originalFileLoad.call(this, uri, onLoad, onProgress, onError);
    uri = this.manager.resolveURL((this.path || '') + (uri || ''));
    const responseType = this.responseType || 'text';
    this.manager.itemStart(uri);
    const task = Promise.resolve().then(async () => {
      const bytes = await read(uri);
      if (bytes.length > limits.maxEntryBytes) throw resourceError('RESOURCE_SIZE_LIMIT', 'Binary resource exceeds limit.');
      if (/\.tga(?:$|[?#])/i.test(uri)) {
        if (bytes.length < 18) throw resourceError('INVALID_TGA', 'Truncated TGA header.');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        reservePixels(view.getUint16(12, true), view.getUint16(14, true));
      }
      let value;
      switch (responseType) {
        case 'arraybuffer': value = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); break;
        case 'blob': value = new Blob([bytes], { type: this.mimeType || 'application/octet-stream' }); break;
        case 'json': value = JSON.parse(new TextDecoder().decode(bytes)); break;
        case 'document': value = new DOMParser().parseFromString(new TextDecoder().decode(bytes), this.mimeType || 'application/xml'); break;
        case 'text': case '': value = new TextDecoder().decode(bytes); break;
        default: throw resourceError('UNSUPPORTED_RESPONSE_TYPE', `Unsupported Node FileLoader response type: ${responseType}`);
      }
      onProgress?.({ type: 'progress', lengthComputable: true, loaded: bytes.length, total: bytes.length });
      onLoad?.(value);
    }).catch(error => {
      warnings.push(diagnostic(error.code || 'RESOURCE_LOAD_FAILED', `Binary resource failed: ${uri}: ${error.message}`, true, { resource: uri }));
      try { onError?.(error); } catch (callbackError) { context.log?.(callbackError.message); }
      this.manager.itemError(uri);
    }).finally(() => { this.manager.itemEnd(uri); pending.delete(task); });
    pending.add(task);
    return undefined;
  };
  class NodeDOMImage {
    constructor() {
      const canvas = createCanvas(1, 1), listeners = new Map();
      Object.defineProperty(canvas, 'data', { configurable: true, value: undefined });
      canvas.addEventListener = (name, callback) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); };
      canvas.removeEventListener = (name, callback) => listeners.get(name)?.delete(callback);
      const dispatch = name => { const event = { type: name, target: canvas }; canvas[`on${name}`]?.(event); for (const callback of listeners.get(name) || []) callback.call(canvas, event); };
      let source = '';
      Object.defineProperty(canvas, 'src', { get: () => source, set(uri) {
        source = uri;
        Promise.resolve().then(async () => {
          const image = await decode(await read(uri), uri);
          canvas.width = image.width; canvas.height = image.height;
          canvas.getContext('2d').drawImage(image, 0, 0); dispatch('load');
        }).catch(() => { canvas.height = 0; dispatch('error'); });
      } });
      return canvas;
    }
  }
  const textureLoader = new THREE.TextureLoader(manager);
  manager.addHandler(/\.(?:tga|tiff?|bmp)(?:$|[?#])/i, textureLoader);
  const document = { createElement(tag) { if (tag.toLowerCase() === 'canvas') return createCanvas(1, 1); throw new Error(`Unsupported Node DOM element: ${tag}`); }, createElementNS(_namespace, tag) { return this.createElement(tag); } };
  Object.defineProperty(CanvasElement.prototype, 'toBlob', {
    configurable: true,
    value(callback, mime = 'image/png', quality) {
      const format = mime === 'image/jpeg' ? 'jpeg' : mime === 'image/webp' ? 'webp' : 'png';
      this.encode(format, quality === undefined ? undefined : Math.round(quality * 100)).then(bytes => callback(new Blob([bytes], { type: mime }))).catch(() => callback(null));
    },
  });
  setGlobal('FileReader', NodeFileReader); setGlobal('DOMParser', DOMParser); setGlobal('ImageData', ImageData);
  setGlobal('HTMLImageElement', Image); setGlobal('HTMLCanvasElement', CanvasElement); setGlobal('OffscreenCanvas', CanvasElement);
  setGlobal('Image', NodeDOMImage); setGlobal('document', document); setGlobal('window', { URL: objectURL }); setGlobal('self', globalThis);
  // Force GLTFLoader's ImageLoader path rather than its fetch/ImageBitmap path.
  setGlobal('createImageBitmap', undefined);
  const originalCreateURL = URL.createObjectURL, originalRevokeURL = URL.revokeObjectURL;
  URL.createObjectURL = objectURL.createObjectURL; URL.revokeObjectURL = objectURL.revokeObjectURL;
  adapter.waitForTextures = async () => { while (pending.size) await Promise.allSettled([...pending]); };
  adapter.dispose = async () => {
    await adapter.waitForTextures();
    if (activeAdapter !== adapter) return;
    THREE.ImageLoader.prototype.load = originalLoad;
    THREE.FileLoader.prototype.load = originalFileLoad;
    URL.createObjectURL = originalCreateURL; URL.revokeObjectURL = originalRevokeURL;
    if (canvasToBlob) Object.defineProperty(CanvasElement.prototype, 'toBlob', canvasToBlob); else delete CanvasElement.prototype.toBlob;
    for (const [name, descriptor] of snapshots) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
    blobs.clear(); delete manager[ADAPTER]; activeAdapter = null;
  };
  return adapter;
}

/** Convert canvas-backed textures for Dawn/Three rendering without HTML upload APIs. */
export function texturesToDataTextures(root) {
  const textures = new Map();
  root.traverse(object => {
    const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
    for (const material of materials) {
      for (const key of Object.keys(material)) {
        const texture = material[key];
        if (!texture?.isTexture || texture.isDataTexture || !texture.image?.getContext) continue;
        if (!textures.has(texture)) {
          const image = texture.image, pixels = image.getContext('2d').getImageData(0, 0, image.width, image.height);
          const replacement = new THREE.DataTexture(new Uint8Array(pixels.data), image.width, image.height, THREE.RGBAFormat, THREE.UnsignedByteType);
          // Texture.copy shares Source; keep a fresh source for the decoded RGBA pixels.
          const source = replacement.source;
          replacement.copy(texture); replacement.source = source;
          replacement.needsUpdate = true; textures.set(texture, replacement);
        }
        material[key] = textures.get(texture);
      }
    }
  });
  for (const texture of textures.keys()) texture.dispose();
  return textures;
}

/** Dispose shared geometries/materials/textures exactly once. */
export function disposeThreeScene(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
    object.skeleton?.dispose();
  });
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}
