import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { MODEL_FORMATS } from './formats.mjs';
import { convertNativeFbx } from './native-fbx.mjs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import { ResourceResolver, ZipIndex, validateFBXArrays, diagnostic, limitsFor, normalizeName, resourceError } from './resources.mjs';

const require = createRequire(import.meta.url);

let codecPromise;
const extension = file => path.extname(file).slice(1).toLowerCase();
const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const decodeText = bytes => new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
function detectInputFormat(bytes, fileName) {
  const declared = extension(fileName);
  if (bytes.length >= 4) {
    const magic = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
    if (magic === 0x46546c67) return 'glb';
    if ([0x04034b50, 0x06054b50, 0x08074b50].includes(magic)) return declared === '3mf' ? '3mf' : 'zip';
  }
  return declared;
}


/** No DOM or native canvas imports on this path; reusable full-extension NodeIO. */
export async function createNodeIO(options = {}) {
  codecPromise ??= Promise.all([
    MeshoptDecoder.ready, MeshoptEncoder.ready,
    fs.readFile(require.resolve('draco3dgltf/draco_decoder_gltf.wasm')).then(wasmBinary => draco3d.createDecoderModule({ wasmBinary })),
    fs.readFile(require.resolve('draco3dgltf/draco_encoder.wasm')).then(wasmBinary => draco3d.createEncoderModule({ wasmBinary })),
  ]).catch(error => { codecPromise = undefined; throw error; });
  const [, , decoder, encoder] = await codecPromise;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder,
    'draco3d.decoder': decoder, 'draco3d.encoder': encoder,
  });
  // The raw NodeIO never permits network reads. loadDocument supplies all resources
  // through ResourceResolver, with DNS-pinned public-network checks when requested.
  io.setAllowNetwork(false);
  if (options.logger) io.setLogger(options.logger);
  return io;
}

function enforceFidelity(warnings, options) {
  if (options.strictFidelity && warnings.some(warning => warning.affectsFidelity)) throw Object.assign(resourceError('FIDELITY_LOSS', 'Strict fidelity rejected one or more conversion losses.'), { warnings, details: { warnings } });
}
function report(warnings, context) {
  for (const warning of warnings) context.log?.(warning.message, warning);
}

async function prepareSource(source, options, warnings) {
  const limits = limitsFor(options);
  let bytes, fileName, modelPath, resources = {};
  if (typeof source === 'string') {
    modelPath = await fs.realpath(path.resolve(source)); fileName = path.basename(modelPath);
    // The root model may be an archive up to the total cap; child resources keep
    // the entry cap. Read a bounded allocation and detect concurrent growth.
    const handle = await fs.open(modelPath, 'r');
    try {
      const stat = await handle.stat();
      const prefix = Buffer.alloc(Math.min(stat.size, 32));
      await handle.read(prefix, 0, prefix.length, 0);
      const cap = detectInputFormat(prefix, fileName) === 'zip' ? limits.maxTotalBytes : limits.maxEntryBytes;
      if (!stat.isFile() || stat.size > cap) throw resourceError('INPUT_SIZE_LIMIT', 'Model input exceeds size limit.');
      const buffer = Buffer.alloc(stat.size); let offset = 0;
      while (offset < buffer.length) { const read = await handle.read(buffer, offset, buffer.length - offset, null); if (!read.bytesRead) break; offset += read.bytesRead; }
      if ((await handle.read(Buffer.alloc(1), 0, 1, null)).bytesRead) throw resourceError('INPUT_CHANGED', 'Model grew while reading.');
      bytes = new Uint8Array(buffer.subarray(0, offset));
    } finally { await handle.close(); }
  } else {
    if (!(source?.bytes instanceof Uint8Array) || typeof source.fileName !== 'string') throw new TypeError('Source must be a path or {bytes: Uint8Array, fileName, resources?}.');
    bytes = source.bytes; fileName = source.fileName; resources = source.resources ?? {};
    if (bytes.length > (detectInputFormat(bytes, fileName) === 'zip' ? limits.maxTotalBytes : limits.maxEntryBytes)) throw resourceError('INPUT_SIZE_LIMIT', 'Model input exceeds size limit.');
  }
  const inputBytes = bytes.length;
  const declaredFormat = extension(fileName);
  const inputFormat = detectInputFormat(bytes, fileName);
  if (inputFormat !== declaredFormat) warnings.push(diagnostic('INPUT_FORMAT_MISMATCH', `Filename declares ${declaredFormat || '(no extension)'} but the input header identifies ${inputFormat}.`, false, { declaredFormat, detectedFormat: inputFormat }));
  if (options.entry !== undefined && inputFormat !== 'zip') throw resourceError('INVALID_ARGUMENT', 'entry is only valid for an actual ZIP input, regardless of its filename.');
  let zip, entry = modelPath || normalizeName(fileName), format = inputFormat;
  if (format === 'zip') {
    zip = new ZipIndex(bytes, options);
    const formats = options.entryFormats ?? MODEL_FORMATS;
    const depth = name => name.split('/').length - 1;
    const candidates = [...zip.entries.keys()].filter(name => {
      const parts = name.split('/');
      return formats.includes(extension(name)) &&
        (options.entryDepth === undefined || depth(name) <= options.entryDepth) &&
        !parts.some(part => part === '__MACOSX' || part.startsWith('._'));
    });
    candidates.sort((a, b) => {
      const formatOrder = formats.indexOf(extension(a)) - formats.indexOf(extension(b));
      const depthOrder = depth(a) - depth(b);
      // Explicit format order takes precedence; retain legacy defaults otherwise.
      return (options.entryFormats ? formatOrder || depthOrder : depthOrder || formatOrder) ||
        a.localeCompare(b, 'en');
    });
    if (options.entry !== undefined) {
      // Explicit selection is exact, not case-insensitive or a basename guess.
      if (typeof options.entry !== 'string' || !zip.entries.has(options.entry) || !MODEL_FORMATS.includes(extension(options.entry))) throw resourceError('ZIP_ENTRY_NOT_FOUND', `Exact supported ZIP entry not found: ${options.entry}`, { candidates });
      entry = options.entry;
    } else {
      if (!candidates.length) throw resourceError('ZIP_NO_MODEL', 'ZIP contains no supported model entries.');
      entry = candidates[0];
    }
    if (candidates.length > 1) warnings.push(diagnostic('ZIP_MULTIPLE_MODELS', `Archive contains ${candidates.length} models; selected ${entry}. Use entry for exact selection.`, false, { entry, candidates }));
    bytes = await zip.read(entry); format = detectInputFormat(bytes, entry);
    if (format !== extension(entry)) warnings.push(diagnostic('INPUT_FORMAT_MISMATCH', `Archive entry ${entry} has a ${format} header despite its filename.`, false, { entry, declaredFormat: extension(entry), detectedFormat: format }));
    if (format === 'zip') throw resourceError('ZIP_NESTED_ARCHIVE', 'Nested ZIP model entries are not supported; select a model directly.');
  }
  if (!MODEL_FORMATS.includes(format)) throw resourceError('UNSUPPORTED_FORMAT', `Unsupported model format: ${format || fileName}`);
  const resolver = await new ResourceResolver(options, warnings).initialize({ modelPath, resources, zip, entry });
  return { bytes, entry, format, inputFormat, inputBytes, resolver };
}

function parseGLBContainer(bytes) {
  if (bytes.length < 20) throw resourceError('INVALID_GLB', 'Truncated GLB header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length) throw resourceError('INVALID_GLB', 'Invalid glTF 2 GLB header or length.');
  let json, bin, offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw resourceError('INVALID_GLB', 'Truncated GLB chunk header.');
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    if (length % 4 || offset + 8 + length > bytes.length) throw resourceError('INVALID_GLB', 'Invalid GLB chunk length.');
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) {
      if (offset !== 12 || json) throw resourceError('INVALID_GLB', 'GLB must have one first JSON chunk.');
      json = JSON.parse(decodeText(chunk));
    } else if (type === 0x004e4942) {
      if (!json || bin) throw resourceError('INVALID_GLB', 'Invalid duplicate or out-of-order BIN chunk.');
      bin = chunk;
    }
    offset += 8 + length;
  }
  if (!json) throw resourceError('INVALID_GLB', 'Missing GLB JSON chunk.');
  return { json, resources: bin ? { '@glb.bin': bin } : {} };
}

// r170 GLTFLoader capabilities, plus compression decoded by the NodeIO bridge.
// KTX2 is deliberately absent: this local adapter has no Basis transcoder.
const RENDER_EXTENSIONS = new Set([
  'KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_mesh_quantization',
  'KHR_lights_punctual', 'KHR_materials_unlit', 'KHR_materials_clearcoat',
  'KHR_materials_dispersion', 'KHR_materials_ior', 'KHR_materials_sheen',
  'KHR_materials_specular', 'KHR_materials_transmission', 'KHR_materials_iridescence',
  'KHR_materials_anisotropy', 'KHR_materials_volume', 'KHR_materials_emissive_strength',
  'KHR_texture_transform', 'EXT_materials_bump', 'EXT_texture_webp', 'EXT_texture_avif',
  'EXT_mesh_gpu_instancing',
]);
function preflightGLTF(json, options, warnings, { render = false } = {}) {
  if (json.asset?.version !== '2.0') throw resourceError('UNSUPPORTED_GLTF_VERSION', 'Only glTF 2.0 is supported.');
  const limits = limitsFor(options);
  let declaredBytes = 0;
  const boundedSize = (size, label) => {
    if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxEntryBytes) throw resourceError('GLTF_SIZE_LIMIT', `Invalid or excessive ${label}.`);
    declaredBytes += size;
    if (declaredBytes > limits.maxTotalBytes) throw resourceError('GLTF_SIZE_LIMIT', 'Declared glTF decoded data exceeds total limit.');
  };
  for (const buffer of json.buffers ?? []) boundedSize(buffer.byteLength, 'buffer size');
  for (const view of json.bufferViews ?? []) {
    const meshopt = view.extensions?.EXT_meshopt_compression;
    if (meshopt) boundedSize(meshopt.count * meshopt.byteStride, 'meshopt decoded buffer');
  }
  const componentBytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  for (const accessor of json.accessors ?? []) boundedSize(accessor.count * componentBytes[accessor.componentType] * components[accessor.type], 'accessor decoded size');
  const supported = render ? RENDER_EXTENSIONS : new Set(ALL_EXTENSIONS.map(Extension => Extension.EXTENSION_NAME));
  for (const name of json.extensionsUsed ?? []) {
    if (!supported.has(name)) warnings.push(diagnostic('UNSUPPORTED_GLTF_EXTENSION', `Unsupported glTF extension: ${name}`, true, { extension: name }));
  }
  for (const name of json.extensionsRequired ?? []) {
    if (!supported.has(name)) throw resourceError('UNSUPPORTED_REQUIRED_EXTENSION', `Required glTF extension is unsupported${render ? ' by the Node rendering bridge' : ''}: ${name}`);
  }
}

async function readGLTF(prepared, options, warnings) {
  const io = await createNodeIO();
  const jsonDoc = prepared.format === 'glb' ? parseGLBContainer(prepared.bytes) : { json: JSON.parse(decodeText(prepared.bytes)), resources: Object.create(null) };
  preflightGLTF(jsonDoc.json, options, warnings);
  // Resolve embedded data URIs too: NodeIO's own decoder is not size-bounded.
  for (const resource of [...(jsonDoc.json.buffers ?? []), ...(jsonDoc.json.images ?? [])]) {
    if (resource.uri !== undefined) {
      if (typeof resource.uri !== 'string') throw resourceError('INVALID_GLTF_URI', 'glTF resource URI must be a string.');
      jsonDoc.resources[resource.uri] = await prepared.resolver.resolve(resource.uri, prepared.entry, { strict: true });
    }
  }
  io.setLogger({ debug() {}, info() {}, warn(message) { warnings.push(diagnostic('GLTF_IO_WARNING', String(message), true)); }, error(message) { warnings.push(diagnostic('GLTF_IO_ERROR', String(message), true)); } });
  const document = await io.readJSON(jsonDoc);
  const transformations = [];
  if (options.noAnimations || options.animations === false) {
    for (const animation of document.getRoot().listAnimations()) animation.dispose();
    transformations.push(diagnostic('ANIMATIONS_REMOVED', 'Animations removed by explicit request.', true));
  }
  if (options.center === true) {
    // Use Three's accurate posed world bounds, then translate each scene through
    // a wrapper so shared root nodes keep per-scene semantics and animations.
    const loaded = await loadThreeScene(document, { ...options, center: false, strictFidelity: false }, {});
    const THREE = await import('three');
    try {
      for (let i = 0; i < document.getRoot().listScenes().length; i++) {
        const scene = document.getRoot().listScenes()[i], threeScene = loaded.scenes[i];
        threeScene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(threeScene);
        if (!box.isEmpty()) {
          const center = box.getCenter(new THREE.Vector3());
          const wrapper = document.createNode('Centered model').setTranslation([-center.x, -center.y, -center.z]);
          for (const child of scene.listChildren()) { scene.removeChild(child); wrapper.addChild(child); }
          scene.addChild(wrapper);
        }
      }
      transformations.push(diagnostic('CENTERED', 'Scene roots translated to world-bounds center by explicit request.', true));
    } finally { loaded.dispose(); }
  }
  return { document, transformations };
}

function captureThreeWarnings(warnings) {
  const original = console.warn;
  console.warn = (...args) => {
    const message = args.map(value => typeof value === 'string' ? value : String(value)).join(' ');
    warnings.push(diagnostic('THREE_LOADER_WARNING', message, true));
  };
  return () => { console.warn = original; };
}
function cleanMaterials(root, THREE, warnings) {
  const seen = new Set();
  root.traverse(object => {
    for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) {
      if (seen.has(material)) continue; seen.add(material);
      if (material.isShaderMaterial || material.isRawShaderMaterial) warnings.push(diagnostic('UNSUPPORTED_SHADER', `Custom shader ${material.name || material.type} cannot be represented faithfully as glTF PBR.`, true, { material: material.name }));
      if (material.isMeshPhongMaterial || material.isMeshLambertMaterial) warnings.push(diagnostic('MATERIAL_PBR_APPROXIMATION', `${material.type} ${material.name || ''} is approximated as glTF PBR.`, true, { material: material.name, materialType: material.type }));
      for (const key of Object.keys(material)) {
        const texture = material[key];
        if (!texture?.isTexture) continue;
        if (!texture.image || (texture.isDataTexture && (!texture.image.data || !texture.image.width || !texture.image.height)) || texture.image.userData?.nodeTextureFailed || texture.image.userData?.nodeTexturePending) {
          warnings.push(diagnostic('TEXTURE_OMITTED', `Unloaded/unsupported texture ${texture.name || key} omitted, not replaced with a fabricated image.`, true, { material: material.name, slot: key }));
          material[key] = null; texture.dispose();
        }
      }
      if (material.isMeshPhongMaterial && material.specularMap) warnings.push(diagnostic('UNSUPPORTED_MATERIAL_CHANNEL', 'Phong specular texture is not equivalent to glTF metallic/roughness.', true, { material: material.name, slot: 'specularMap' }));
    }
    if (object.geometry?.getAttribute('color') && object.material) {
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.vertexColors = true;
    }
    if (object.isLight && !['PointLight', 'DirectionalLight', 'SpotLight'].includes(object.type)) warnings.push(diagnostic('UNSUPPORTED_LIGHT', `${object.type} is not supported by KHR_lights_punctual.`, true, { node: object.name }));
  });
}

async function parseStep(bytes, options, warnings, THREE) {
  let factory;
  try { factory = (await import('occt-import-js')).default; } catch (error) { throw resourceError('STEP_DEPENDENCY_MISSING', `STEP requires local occt-import-js: ${error.message}`); }
  const modulePath = require.resolve('occt-import-js');
  const engine = await factory({ locateFile: name => path.join(path.dirname(modulePath), name) });
  const result = engine.ReadStepFile(bytes, options.stepParameters ?? null);
  if (!result.success) throw resourceError('STEP_PARSE_FAILED', 'OpenCascade failed to parse STEP.');
  warnings.push(diagnostic('STEP_TESSELLATED', 'STEP converted to triangle meshes; precise B-Rep, PMI and assembly constraints are not preserved.', true));
  const root = new THREE.Group();
  for (const data of result.meshes ?? []) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.attributes.position.array, 3));
    if (data.attributes.normal) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(data.attributes.normal.array, 3)); else geometry.computeVertexNormals();
    geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(data.index.array), 1));
    const material = new THREE.MeshStandardMaterial({ color: data.color ? new THREE.Color(...data.color) : new THREE.Color(0xb8b8b8), side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material); mesh.name = data.name || ''; root.add(mesh);
  }
  return root;
}

async function parseThree(prepared, options, context, warnings) {
  const THREE = await import('three');
  const { installNodeAdapters, disposeThreeScene } = await import('./adapters.mjs');
  const adapter = await installNodeAdapters({ resolver: prepared.resolver, warnings, options, context });
  const restoreWarnings = captureThreeWarnings(warnings);
  let root, animations = [], result;
  const transformations = [];
  try {
    const { bytes, format } = prepared;
    switch (format) {
      case 'fbx': { await validateFBXArrays(bytes, options); const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js'); root = new FBXLoader(adapter.manager).parse(arrayBuffer(bytes), ''); break; }
      case 'obj': {
        const [{ OBJLoader }, { MTLLoader }] = await Promise.all([import('three/addons/loaders/OBJLoader.js'), import('three/addons/loaders/MTLLoader.js')]);
        const loader = new OBJLoader(adapter.manager), text = decodeText(bytes);
        const references = [...text.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].map(match => match[1].trim());
        const merged = new MTLLoader(adapter.manager).parse('', '');
        for (const reference of references) {
          // A whole line may be a spaced filename. Prefer it; only split multiple
          // names when that exact declared resource does not exist.
          let names = [reference], materialBytes;
          try { materialBytes = await prepared.resolver.resolve(reference); }
          catch (error) {
            if (error.code !== 'RESOURCE_NOT_FOUND' || !reference.includes(' ')) { warnings.push(diagnostic(error.code || 'MTL_LOAD_FAILED', `MTL ${reference}: ${error.message}`, true, { resource: reference })); continue; }
            names = reference.split(/\s+/);
          }
          for (const name of names) {
            try {
              const content = materialBytes ?? await prepared.resolver.resolve(name);
              const base = path.posix.dirname(normalizeName(name));
              const creator = new MTLLoader(adapter.manager).parse(decodeText(content), base === '.' ? '' : `${base}/`);
              creator.preload(); Object.assign(merged.materials, creator.materials);
            } catch (error) { warnings.push(diagnostic(error.code || 'MTL_LOAD_FAILED', `MTL ${name}: ${error.message}`, true, { resource: name })); }
          }
        }
        if (references.length) { merged.create = name => {
          if (merged.materials[name]) return merged.materials[name];
          warnings.push(diagnostic('MTL_MATERIAL_NOT_FOUND', `Declared OBJ material ${name} was not found in loaded MTL files.`, true, { material: name }));
          return new THREE.MeshPhongMaterial({ name });
        }; loader.setMaterials(merged); }
        root = loader.parse(text); break;
      }
      case 'stl':
      case 'ply': {
        const module = await import(format === 'stl' ? 'three/addons/loaders/STLLoader.js' : 'three/addons/loaders/PLYLoader.js');
        const geometry = new module[format === 'stl' ? 'STLLoader' : 'PLYLoader'](adapter.manager).parse(arrayBuffer(bytes));
        if (!geometry.getAttribute('normal') && (format === 'stl' || geometry.index)) geometry.computeVertexNormals();
        const vertexColors = !!geometry.getAttribute('color');
        if (format === 'ply' && !geometry.index) {
          root = new THREE.Points(geometry, new THREE.PointsMaterial({ vertexColors, size: 1 }));
          warnings.push(diagnostic('PLY_POINT_CLOUD', 'PLY contains no faces and is retained as glTF POINTS.', false));
        } else root = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors, opacity: geometry.alpha ?? 1, transparent: (geometry.alpha ?? 1) < 1 }));
        break;
      }
      case 'dae': {
        const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
        result = new ColladaLoader(adapter.manager).parse(decodeText(bytes), ''); root = result.scene; animations = root.animations || []; break;
      }
      case '3mf': {
        // Official 3MFLoader internally unzipSyncs. Feed it a bounded validated
        // stored archive, never the untrusted compressed input.
        const index = new ZipIndex(bytes, options), resources = Object.create(null);
        for (const name of index.entries.keys()) resources[name] = await index.read(name);
        const { zipSync } = await import('fflate');
        const safeBytes = zipSync(resources, { level: 0 });
        const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js');
        root = new ThreeMFLoader(adapter.manager).parse(arrayBuffer(safeBytes)); break;
      }
      case '3ds': { const { TDSLoader } = await import('three/addons/loaders/TDSLoader.js'); root = new TDSLoader(adapter.manager).parse(arrayBuffer(bytes), ''); break; }
      case 'wrl': case 'vrml': { const { VRMLLoader } = await import('three/addons/loaders/VRMLLoader.js'); root = new VRMLLoader(adapter.manager).parse(decodeText(bytes), ''); break; }
      case 'step': case 'stp': root = await parseStep(bytes, options, warnings, THREE); break;
      default: throw resourceError('UNSUPPORTED_FORMAT', `No Three parser for ${format}.`);
    }
    if (!root?.isObject3D) throw resourceError('MODEL_PARSE_FAILED', 'Loader did not return an Object3D.');
    await adapter.waitForTextures();
    // FBX stores its clips on the root; preserve every unique descendant clip.
    const clips = new Map(animations.map(clip => [clip.uuid, clip]));
    root.traverse(object => { for (const clip of object.animations || []) clips.set(clip.uuid, clip); });
    animations = [...clips.values()].map(clip => {
      const normalized = clip.clone();
      // FBXLoader emits numeric morph indices; r170's exporter expects named
      // dictionary keys. Rename bindings, never alias the dictionary (which
      // would duplicate targetNames in the resulting GLB).
      for (const track of normalized.tracks) {
        const binding = THREE.PropertyBinding.parseTrackName(track.name);
        if (binding.propertyName !== 'morphTargetInfluences' || binding.propertyIndex === undefined || !/^\d+$/.test(binding.propertyIndex)) continue;
        const target = THREE.PropertyBinding.findNode(root, binding.nodeName);
        const index = Number(binding.propertyIndex);
        const targetName = Object.keys(target?.morphTargetDictionary || {}).find(name => target.morphTargetDictionary[name] === index);
        if (targetName === undefined) throw resourceError('INVALID_MORPH_BINDING', `Morph target ${track.name} does not exist.`);
        track.name = `${target.uuid}.morphTargetInfluences[${targetName}]`;
      }
      return normalized;
    });
    if (options.noAnimations || options.animations === false) { animations = []; transformations.push(diagnostic('ANIMATIONS_REMOVED', 'Animations removed by explicit request.', true)); }
    cleanMaterials(root, THREE, warnings);
    if (options.center === true) {
      root.updateMatrixWorld(true); const bounds = new THREE.Box3().setFromObject(root);
      if (!bounds.isEmpty()) {
        const center = bounds.getCenter(new THREE.Vector3()), wrapper = new THREE.Group();
        wrapper.name = 'Centered model'; wrapper.position.copy(center).multiplyScalar(-1); wrapper.add(root); root = wrapper;
      }
      transformations.push(diagnostic('CENTERED', 'World-bounds center translated to origin by explicit request.', true));
    }
    enforceFidelity(warnings, options);
    return { root, scene: root, animations, warnings, transformations, adapter, restoreWarnings, dispose: () => disposeThreeScene(root) };
  } catch (error) {
    await adapter.waitForTextures();
    if (root) disposeThreeScene(root);
    restoreWarnings(); await adapter.dispose();
    throw Object.assign(error, { warnings, details: { ...error.details, warnings } });
  }
}

/** Public conversion entry. Never edits input files or creates browser state. */
export async function loadDocument(source, options = {}, context = {}) {
  const warnings = [];
  const prepared = await prepareSource(source, options, warnings);
  if (prepared.format === 'fbx' && options.fbxBackend !== 'three') {
    try {
      const native = await convertNativeFbx(prepared, options, context, warnings);
      const loaded = await readGLTF(native, options, warnings);
      const renderable = loaded.document.getRoot().listMeshes().some(mesh =>
        mesh.listPrimitives().some(primitive => {
          const position = primitive.getAttribute('POSITION');
          const count = primitive.getIndices()?.getCount() ?? position?.getCount() ?? 0;
          const mode = primitive.getMode();
          return position?.getCount() > 0 && count >= (mode === 0 ? 1 : mode <= 3 ? 2 : 3);
        }));
      if (!renderable) {
        throw resourceError('FBX_OUTPUT_INVALID', 'Native FBX output has no renderable geometry.');
      }

      enforceFidelity(warnings, options); report(warnings, context);
      return {
        ...loaded, warnings, entry: prepared.entry, format: prepared.format,
        inputFormat: prepared.inputFormat, entryFormat: prepared.format,
        inputBytes: prepared.inputBytes, conversion: native.conversion,
        nativeConversionMs: native.nativeConversionMs, nativeBytes: native.bytes,
      };
    } catch (error) {
      throw Object.assign(error, { warnings, details: { ...error.details, warnings } });
    }
  }
  if (prepared.format === 'glb' || prepared.format === 'gltf') {
    try {
      const loaded = await readGLTF(prepared, options, warnings);
      enforceFidelity(warnings, options); report(warnings, context);
      return { ...loaded, entry: prepared.entry, format: prepared.format, inputFormat: prepared.inputFormat, entryFormat: prepared.format, inputBytes: prepared.inputBytes, warnings };
    } catch (error) { throw Object.assign(error, { warnings, details: { ...error.details, warnings } }); }
  }
  const loaded = await parseThree(prepared, options, context, warnings);
  try {
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const exported = await new GLTFExporter().parseAsync(loaded.root, {
      binary: true, onlyVisible: options.onlyVisible ?? false, animations: loaded.animations,
      maxTextureSize: options.maxTextureSize ?? Infinity,
    });
    const bytes = new Uint8Array(exported);
    if (bytes.length > limitsFor(options).maxTotalBytes) throw resourceError('OUTPUT_SIZE_LIMIT', 'Converted GLB exceeds total size limit.');
    if (options.maxTextureSize !== undefined) loaded.transformations.push(diagnostic('TEXTURE_SIZE_CAP', `Explicit texture size cap: ${options.maxTextureSize}`, true));
    const io = await createNodeIO();
    const document = await io.readBinary(bytes);
    loaded.transformations.unshift(diagnostic('CONVERTED_TO_GLTF', `${prepared.format} parsed with its official loader and exported to glTF 2.0.`, false, { from: prepared.format, to: 'glb' }));
    enforceFidelity(warnings, options); report(warnings, context);
    const conversion = prepared.format === 'fbx'
      ? { backend: 'three', version: `r${(await import('three')).REVISION}` } : undefined;
    return {
      document, entry: prepared.entry, format: prepared.format,
      inputFormat: prepared.inputFormat, entryFormat: prepared.format,
      inputBytes: prepared.inputBytes, warnings, transformations: loaded.transformations,
      ...(conversion ? { conversion } : {}),
    };
  } catch (error) { throw Object.assign(error, { warnings, details: { ...error.details, warnings } }); }
  finally { loaded.dispose(); loaded.restoreWarnings(); await loaded.adapter.dispose(); }
}

/** Direct Three parse for isolated rendering tasks. Adapters restored before return. */
export async function loadThreeModel(source, options = {}, context = {}) {
  const warnings = [], prepared = await prepareSource(source, options, warnings);
  if (['glb', 'gltf'].includes(prepared.format)) {
    const { document } = await readGLTF(prepared, options, warnings);
    const result = await loadThreeScene(document, options, context);
    result.warnings.unshift(...warnings);
    return { ...result, root: result.scene, entry: prepared.entry, format: prepared.format, inputFormat: prepared.inputFormat, entryFormat: prepared.format, inputBytes: prepared.inputBytes };
  }
  const loaded = await parseThree(prepared, options, context, warnings);
  loaded.restoreWarnings(); await loaded.adapter.dispose();
  const { texturesToDataTextures } = await import('./adapters.mjs');
  try { texturesToDataTextures(loaded.root); } catch (error) { loaded.dispose(); throw error; }
  const { adapter, restoreWarnings, ...result } = loaded;
  report(warnings, context);
  return { ...result, entry: prepared.entry, format: prepared.format, inputFormat: prepared.inputFormat, entryFormat: prepared.format, inputBytes: prepared.inputBytes };
}

/**
 * Renderer bridge: clone decoded Document, remove compression extensions only on
 * that clone, and parse a fresh GLB. No compression workers/CDNs or mutation of
 * the caller's Document. Canvas textures become RGBA DataTextures for Dawn.
 */
export async function loadThreeScene(document, options = {}, context = {}) {
  const { cloneDocument, unpartition } = await import('@gltf-transform/functions');
  const warnings = [], io = await createNodeIO(), clone = cloneDocument(document);
  for (const ext of clone.getRoot().listExtensionsRequired()) {
    if (!RENDER_EXTENSIONS.has(ext.extensionName)) throw resourceError('UNSUPPORTED_REQUIRED_EXTENSION', `Required extension ${ext.extensionName} is unsupported by the Node rendering bridge.`);
  }
  if (clone.getRoot().listBuffers().length > 1) await clone.transform(unpartition());
  for (const ext of clone.getRoot().listExtensionsUsed()) {
    if (['KHR_draco_mesh_compression', 'EXT_meshopt_compression'].includes(ext.extensionName)) ext.dispose();
  }
  for (const texture of clone.getRoot().listTextures()) {
    if (texture.getMimeType() === 'image/ktx2') {
      warnings.push(diagnostic('RENDER_TEXTURE_UNSUPPORTED', `KTX2 texture ${texture.getName() || texture.getURI() || '(unnamed)'} cannot be decoded by the local image adapter; omitted only from the rendering clone.`, true));
      texture.dispose();
    }
  }
  for (const ext of clone.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === 'KHR_texture_basisu') ext.dispose();
  }
  enforceFidelity(warnings, options);
  const bytes = await io.writeBinary(clone);
  const result = await parseGLBForRender(bytes, options, context);
  result.warnings.unshift(...warnings); return result;
}

/** GLB bytes bridge, also accepting compressed GLB via the bounded NodeIO path. */
export async function parseGLBForRender(bytes, options = {}, context = {}) {
  const warnings = [];
  if (!(bytes instanceof Uint8Array)) throw new TypeError('GLB bytes must be Uint8Array.');
  if (bytes.length > limitsFor(options).maxTotalBytes) throw resourceError('INPUT_SIZE_LIMIT', 'Render GLB exceeds limit.');
  const jsonDoc = parseGLBContainer(bytes);
  preflightGLTF(jsonDoc.json, options, warnings, { render: true });
  const names = jsonDoc.json.extensionsUsed ?? [];
  const embeddedResolver = await new ResourceResolver(options, warnings).initialize({ entry: 'render.glb' });
  for (const resource of [...(jsonDoc.json.buffers ?? []), ...(jsonDoc.json.images ?? [])]) {
    if (resource.uri?.startsWith('data:')) await embeddedResolver.resolve(resource.uri);
  }
  if (names.some(name => ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(name))) {
    const loaded = await loadDocument({ bytes, fileName: 'render.glb' }, options, context);
    const result = await loadThreeScene(loaded.document, options, context); result.warnings.unshift(...loaded.warnings); return result;
  }
  // Never let GLTFLoader's FileLoader fetch an external buffer from the network.
  // Resolve and embed all external resources before giving it the GLB.
  if ([...(jsonDoc.json.buffers ?? []), ...(jsonDoc.json.images ?? [])].some(resource => resource.uri && !resource.uri.startsWith('data:'))) {
    const loaded = await loadDocument({ bytes, fileName: options.fileName || 'render.glb', resources: options.resources }, options, context);
    return loadThreeScene(loaded.document, options, context);
  }
  const { installNodeAdapters, texturesToDataTextures, disposeThreeScene } = await import('./adapters.mjs');
  const resolver = await new ResourceResolver(options, warnings).initialize({ entry: 'render.glb' });
  const adapter = await installNodeAdapters({ resolver, options, context, warnings });
  const restoreWarnings = captureThreeWarnings(warnings);
  let result;
  try {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    result = await new GLTFLoader(adapter.manager).setMeshoptDecoder(MeshoptDecoder).parseAsync(arrayBuffer(bytes), '');
    await adapter.waitForTextures();
    for (const scene of result.scenes) texturesToDataTextures(scene);
    enforceFidelity(warnings, options);
    let disposed = false;
    return {
      scene: result.scene, scenes: result.scenes, animations: options.noAnimations || options.animations === false ? [] : result.animations,
      warnings, dispose() { if (!disposed) { disposed = true; for (const scene of result.scenes) disposeThreeScene(scene); } },
    };
  } catch (error) { if (result) for (const scene of result.scenes) disposeThreeScene(scene); throw Object.assign(error, { warnings, details: { ...error.details, warnings } }); }
  finally { restoreWarnings(); await adapter.dispose(); }
}
