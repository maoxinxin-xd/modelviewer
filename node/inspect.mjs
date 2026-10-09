import { getBounds } from '@gltf-transform/functions';

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

const finite = (value) => Number.isFinite(value) ? value : null;
const MODES = ['POINTS', 'LINES', 'LINE_LOOP', 'LINE_STRIP', 'TRIANGLES', 'TRIANGLE_STRIP', 'TRIANGLE_FAN'];

function primitiveStats(primitive) {
  const positions = primitive.getAttribute('POSITION');
  const vertices = positions?.getCount() ?? 0;
  const elements = primitive.getIndices()?.getCount() ?? vertices;
  const mode = primitive.getMode();
  return {
    mode: MODES[mode] ?? String(mode),
    vertices,
    triangles: mode === 4 ? Math.floor(elements / 3) : mode === 5 || mode === 6 ? Math.max(0, elements - 2) : 0,
    indices: primitive.getIndices()?.getCount() ?? 0,
    attributes: primitive.listSemantics(),
    morphTargets: primitive.listTargets().length,
  };
}

function instanceCount(node) {
  const instance = node.getExtension('EXT_mesh_gpu_instancing');
  return instance ? instance.listAttributes()[0]?.getCount() ?? 0 : 1;
}

function emptyBounds() {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

function expand(bounds, point) {
  if (!point.every(Number.isFinite)) return;
  for (let i = 0; i < 3; i++) {
    bounds.min[i] = Math.min(bounds.min[i], point[i]);
    bounds.max[i] = Math.max(bounds.max[i], point[i]);
  }
}

function serializeBounds(bounds) {
  if (!bounds.min.every(Number.isFinite) || !bounds.max.every(Number.isFinite)) return null;
  return {
    min: [...bounds.min], max: [...bounds.max],
    size: bounds.max.map((value, i) => finite(value - bounds.min[i])),
    center: bounds.max.map((value, i) => finite(value / 2 + bounds.min[i] / 2)),
  };
}

// Upstream getBounds does not apply EXT_mesh_gpu_instancing. Apply each
// instance TRS, then its node's world matrix, without modifying the graph.
function gpuBounds(node) {
  const bounds = emptyBounds();
  const instance = node.getExtension('EXT_mesh_gpu_instancing');
  const translation = instance.getAttribute('TRANSLATION');
  const rotation = instance.getAttribute('ROTATION');
  const scale = instance.getAttribute('SCALE');
  const matrix = node.getWorldMatrix();
  for (let i = 0; i < instanceCount(node); i++) {
    const t = translation?.getElement(i, []) ?? [0, 0, 0];
    const q = rotation?.getElement(i, []) ?? [0, 0, 0, 1];
    const s = scale?.getElement(i, []) ?? [1, 1, 1];
    for (const primitive of node.getMesh().listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      if (!position) continue;
      const indices = primitive.getIndices();
      const count = indices?.getCount() ?? position.getCount();
      for (let j = 0; j < count; j++) {
        const p = position.getElement(indices ? indices.getScalar(j) : j, []);
        const x = p[0] * s[0], y = p[1] * s[1], z = p[2] * s[2];
        const [qx, qy, qz, qw] = q;
        const tx = 2 * (qy * z - qz * y);
        const ty = 2 * (qz * x - qx * z);
        const tz = 2 * (qx * y - qy * x);
        const rx = x + qw * tx + qy * tz - qz * ty + t[0];
        const ry = y + qw * ty + qz * tx - qx * tz + t[1];
        const rz = z + qw * tz + qx * ty - qy * tx + t[2];
        expand(bounds, [
          matrix[0] * rx + matrix[4] * ry + matrix[8] * rz + matrix[12],
          matrix[1] * rx + matrix[5] * ry + matrix[9] * rz + matrix[13],
          matrix[2] * rx + matrix[6] * ry + matrix[10] * rz + matrix[14],
        ]);
      }
    }
  }
  return bounds;
}

// Header-only fallback: synthetic Documents need not have passed through an
// IO instance registering image utilities. Never decode pixels during inspect.
function imageSize(texture) {
  try {
    const known = texture.getSize();
    if (known?.every((value) => Number.isSafeInteger(value) && value > 0)) return known;
  } catch { /* Continue with bounded header probing. */ }
  const bytes = texture.getImage();
  if (!bytes) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const valid = (size) => size.every((value) => Number.isSafeInteger(value) && value > 0) ? size : null;
  try {
    if (texture.getMimeType() === 'image/ktx2' && bytes.length >= 28 &&
      bytes.subarray(0, 12).every((value, i) => value === [171,75,84,88,32,50,48,187,13,10,26,10][i])) {
      return valid([view.getUint32(20, true), view.getUint32(24, true)]);
    }
    if (texture.getMimeType() === 'image/webp' && tag(0) === 'RIFF' && tag(8) === 'WEBP') {
      for (let offset = 12; offset + 8 <= bytes.length;) {
        const length = view.getUint32(offset + 4, true), data = offset + 8;
        if (data + length > bytes.length) return null;
        const type = tag(offset);
        if (type === 'VP8X' && length >= 10) {
          const u24 = (at) => bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16;
          return valid([1 + u24(data + 4), 1 + u24(data + 7)]);
        }
        if (type === 'VP8 ' && length >= 10) return valid([view.getUint16(data + 6, true) & 0x3fff, view.getUint16(data + 8, true) & 0x3fff]);
        if (type === 'VP8L' && length >= 5 && bytes[data] === 0x2f) {
          const bits = view.getUint32(data + 1, true);
          return valid([1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)]);
        }
        offset = data + length + length % 2;
      }
    }
    if (texture.getMimeType() === 'image/avif') {
      // Walk only metadata containers; skip compressed media and unknown boxes.
      const stack = [[0, bytes.length]];
      while (stack.length) {
        const [start, end] = stack.pop();
        for (let offset = start; offset + 8 <= end;) {
          let size = view.getUint32(offset), header = 8;
          if (size === 1) {
            if (offset + 16 > end) break;
            const big = view.getBigUint64(offset + 8);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
            size = Number(big); header = 16;
          } else if (size === 0) size = end - offset;
          if (size < header || offset + size > end) break;
          const type = tag(offset + 4), data = offset + header;
          if (type === 'ispe' && size >= header + 12) return valid([view.getUint32(data + 4), view.getUint32(data + 8)]);
          if (['meta', 'iprp', 'ipco'].includes(type)) stack.push([data + (type === 'meta' ? 4 : 0), offset + size]);
          offset += size;
        }
      }
    }
  } catch { /* Truncated/invalid metadata has unknown dimensions. */ }
  return null;
}

function sceneStats(scene, nodeIndices) {
  let triangles = 0, vertices = 0, instances = 0;
  const bounds = emptyBounds();
  const nodes = [];
  scene.traverse((node) => {
    nodes.push(nodeIndices.get(node));
    const mesh = node.getMesh();
    if (!mesh) return;
    const count = instanceCount(node);
    instances += count;
    for (const primitive of mesh.listPrimitives()) {
      const stats = primitiveStats(primitive);
      triangles += stats.triangles * count;
      vertices += stats.vertices * count;
    }
    // Passing a node to getBounds includes its children; use it only for
    // ordinary mesh-only leaves. Other nodes are evaluated locally below.
    const localBounds = node.getExtension('EXT_mesh_gpu_instancing')
      ? gpuBounds(node) : meshBounds(node);
    expand(bounds, localBounds.min);
    expand(bounds, localBounds.max);
  });
  return { name: scene.getName(), nodes, instances, triangles, vertices, bounds: serializeBounds(bounds) };
}

function meshBounds(node) {
  if (!node.listChildren().length) return getBounds(node);
  const bounds = emptyBounds();
  const matrix = node.getWorldMatrix();
  for (const primitive of node.getMesh().listPrimitives()) {
    const position = primitive.getAttribute('POSITION');
    if (!position) continue;
    const indices = primitive.getIndices();
    const count = indices?.getCount() ?? position.getCount();
    for (let i = 0; i < count; i++) {
      const [x, y, z] = position.getElement(indices ? indices.getScalar(i) : i, []);
      expand(bounds, [
        matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
        matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
        matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
      ]);
    }
  }
  return bounds;
}

/** Synchronous, read-only, JSON-safe statistics of decoded document data.
 * Bounds describe static POSITION geometry, not evaluated skin/morph/animation
 * deformation. Instantiated totals sum all scenes, including shared nodes.
 * Geometry uniqueness is accessor identity, not expensive content hashing.
 * Byte sizes are decoded payload sizes, never claimed to be output file sizes.
 */
export function inspectDocument(document) {
  if (!document || typeof document.getRoot !== 'function') throw invalid('Expected a glTF Transform Document.');
  const root = document.getRoot();
  const meshes = root.listMeshes(), nodes = root.listNodes(), materials = root.listMaterials();
  const nodeIndices = new Map(nodes.map((node, i) => [node, i]));
  const meshIndices = new Map(meshes.map((mesh, i) => [mesh, i]));
  const skinIndices = new Map(root.listSkins().map((skin, i) => [skin, i]));
  const accessorIDs = new Map(root.listAccessors().map((accessor, i) => [accessor, i]));
  const geometry = new Set(), positions = new Set();
  let triangles = 0, vertices = 0, primitiveCount = 0, morphPrimitiveCount = 0, morphTargetCount = 0;
  const meshDetails = meshes.map((mesh) => ({
    name: mesh.getName(), weights: mesh.getWeights().map(finite),
    primitives: mesh.listPrimitives().map((primitive) => {
      primitiveCount++;
      const stats = primitiveStats(primitive);
      morphTargetCount += stats.morphTargets;
      if (stats.morphTargets) morphPrimitiveCount++;
      const position = primitive.getAttribute('POSITION');
      const indices = primitive.getIndices();
      const key = `${accessorIDs.get(position) ?? 'none'}/${accessorIDs.get(indices) ?? 'none'}/${primitive.getMode()}`;
      if (!geometry.has(key)) {
        geometry.add(key);
        triangles += stats.triangles;
      }
      if (position && !positions.has(position)) {
        positions.add(position);
        vertices += stats.vertices;
      }
      return { ...stats, material: materials.indexOf(primitive.getMaterial()) < 0 ? null : materials.indexOf(primitive.getMaterial()) };
    }),
  }));
  const scenes = root.listScenes().map((scene) => sceneStats(scene, nodeIndices));
  const bounds = emptyBounds();
  for (const scene of scenes) if (scene.bounds) {
    expand(bounds, scene.bounds.min);
    expand(bounds, scene.bounds.max);
  }
  const animations = root.listAnimations().map((animation) => {
    let start = Infinity, end = -Infinity;
    const tracks = animation.listChannels().map((channel) => {
      const sampler = channel.getSampler();
      const input = sampler?.getInput();
      if (input) for (let i = 0; i < input.getCount(); i++) {
        const time = input.getScalar(i);
        if (Number.isFinite(time)) { start = Math.min(start, time); end = Math.max(end, time); }
      }
      return {
        node: nodeIndices.get(channel.getTargetNode()) ?? null,
        path: channel.getTargetPath(), interpolation: sampler?.getInterpolation() ?? null,
        keyframes: input?.getCount() ?? 0,
      };
    });
    return { name: animation.getName(), duration: finite(end - start) ?? 0,
      start: finite(start), end: finite(end), trackCount: tracks.length, tracks };
  });
  const textures = root.listTextures().map((texture) => {
    const size = imageSize(texture);
    const mimeType = texture.getMimeType();
    return { name: texture.getName(), uri: texture.getURI(), mimeType,
      format: mimeType ? mimeType.replace(/^image\//, '') : 'unknown',
      width: finite(size?.[0]) ?? null, height: finite(size?.[1]) ?? null,
      byteLength: texture.getImage()?.byteLength ?? 0 };
  });
  const skins = root.listSkins().map((skin) => ({ name: skin.getName(),
    joints: skin.listJoints().map((node) => nodeIndices.get(node) ?? null),
    jointCount: skin.listJoints().length, skeleton: nodeIndices.get(skin.getSkeleton()) ?? null,
    inverseBindMatrices: skin.getInverseBindMatrices()?.getCount() ?? 0 }));
  return {
    scenes: scenes.length, nodes: nodes.length, meshes: meshes.length,
    primitives: primitiveCount, materials: materials.length, textures: textures.length,
    triangles: scenes.reduce((sum, scene) => sum + scene.triangles, 0),
    vertices: scenes.reduce((sum, scene) => sum + scene.vertices, 0),
    uniqueGeometry: { triangles, vertices, primitives: geometry.size },
    instantiated: { triangles: scenes.reduce((sum, scene) => sum + scene.triangles, 0),
      vertices: scenes.reduce((sum, scene) => sum + scene.vertices, 0),
      instances: scenes.reduce((sum, scene) => sum + scene.instances, 0), scope: 'all-scenes' },
    bounds: serializeBounds(bounds), boundsType: 'static-geometry', units: 'unknown',
    animations, skins, morphs: { primitives: morphPrimitiveCount, targets: morphTargetCount },
    sceneDetails: scenes, meshDetails,
    nodeDetails: nodes.map((node) => ({ name: node.getName(), mesh: meshIndices.get(node.getMesh()) ?? null,
      skin: skinIndices.get(node.getSkin()) ?? null, children: node.listChildren().map((child) => nodeIndices.get(child)),
      instances: node.getMesh() ? instanceCount(node) : 0, weights: node.getWeights().map(finite) })),
    materialDetails: materials.map((material) => ({ name: material.getName() })), textureDetails: textures,
    extensions: root.listExtensionsUsed().map((extension) => extension.extensionName),
    decodedBytes: { accessors: root.listAccessors().reduce((sum, accessor) => sum + (accessor.getArray()?.byteLength ?? 0), 0),
      textures: textures.reduce((sum, texture) => sum + texture.byteLength, 0) },
  };
}
