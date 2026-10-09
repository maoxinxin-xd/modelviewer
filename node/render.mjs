import sharp from 'sharp';
import { createRenderer } from './gpu.mjs';
import { unpremultiplySRGB } from './pixels.mjs';
import { loadThreeScene } from './load.mjs';

export async function renderDocument(document, options = {}, context = {}) {
  const width = options.width ?? 1024;
  const height = options.height ?? width;
  const format = options.format ?? 'png';
  const gpu = await createRenderer(width, height);
  const { THREE: T, renderer } = gpu;
  let loaded;
  const warnings = [];
  const temporaryMaterials = new Set();
  const dataTextures = new Set();
  try {
    loaded = await loadThreeScene(document, options, context);
    warnings.push(...(loaded.warnings || []));
    const root = loaded.scene;
    root.updateMatrixWorld(true);
    // Dawn cannot upload a browser image; decoded RGBA DataTextures need no DOM interop.
    const converted = new Map();
    const slots = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'displacementMap', 'lightMap', 'specularMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'transmissionMap', 'thicknessMap', 'sheenColorMap', 'sheenRoughnessMap', 'iridescenceMap', 'iridescenceThicknessMap', 'specularColorMap', 'specularIntensityMap', 'anisotropyMap'];
    const pending = [];
    root.traverse(object => {
      if (!(object.isMesh || object.isPoints || object.isLine)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!material) continue;
        for (const slot of slots) {
          const texture = material[slot];
          if (!texture || texture.isDataTexture) continue;
          if (texture.isCompressedTexture) {
            warnings.push({ code: 'RENDER_TEXTURE_UNSUPPORTED', message: `Compressed texture ${texture.name || slot} cannot be decoded by the Node renderer.`, affectsFidelity: true });
            material[slot] = null;
            continue;
          }
          if (!converted.has(texture)) converted.set(texture, decodeTexture(texture, T).then(value => { dataTextures.add(value); return value; }));
          pending.push(converted.get(texture).then(value => { material[slot] = value; material.needsUpdate = true; }));
        }
      }
    });
    await Promise.all(pending);
    const mode = options.textureMode ?? 'textured';
    if (mode !== 'textured') root.traverse(object => {
      if (!object.isMesh) return;
      const replace = original => {
        let material;
        if (mode === 'normal') material = new T.MeshNormalMaterial({ side: original.side });
        else if (mode === 'albedo') material = new T.MeshBasicMaterial({ color: original.color ?? 0xffffff, map: original.map ?? null, vertexColors: original.vertexColors, side: original.side, transparent: original.transparent, opacity: original.opacity, alphaTest: original.alphaTest, alphaMap: original.alphaMap });
        else material = new T.MeshStandardMaterial({ color: 0xc7c7c7, roughness: 0.8, metalness: 0, side: original.side });
        temporaryMaterials.add(material);
        return material;
      };
      object.material = Array.isArray(object.material) ? object.material.map(replace) : replace(object.material);
    });
    const box = new T.Box3().setFromObject(root);
    if (box.isEmpty()) throw Object.assign(new Error('Model has no renderable geometry.'), { code: 'EMPTY_MODEL' });
    const sphere = box.getBoundingSphere(new T.Sphere());
    const radius = Math.max(sphere.radius, 0.0001);
    const center = sphere.center;
    const scene = new T.Scene();
    scene.add(root);
    const angle = (options.lightAngle ?? 0) * Math.PI / 180;
    const light = new T.DirectionalLight(0xffffff, options.lightIntensity ?? 2);
    light.position.copy(center).add(new T.Vector3(Math.sin(angle) * radius * 3, radius * 3, Math.cos(angle) * radius * 3));
    light.target.position.copy(center); scene.add(light, light.target);
    scene.add(new T.AmbientLight(0xffffff, options.ambientIntensity ?? 2));
    if (options.showGrid) {
      const grid = new T.GridHelper(radius * 3, 12); grid.position.set(center.x, box.min.y, center.z); scene.add(grid);
    }
    const background = options.background ?? (format === 'jpeg' ? '#ffffff' : 'transparent');
    renderer.setClearColor(background === 'transparent' ? 0 : new T.Color(background), background === 'transparent' ? 0 : 1);
    const views = options.views ?? [options.view ?? 'front'];
    const outputs = [];
    for (const view of views) {
      context.log?.(`Rendering ${view} (${width}×${height})`);
      const aspect = width / height;
      const near = Math.max(radius / 10000, 0.000001);
      const far = radius * 100 + near;
      let camera;
      let distance;
      if (options.projection === 'orthographic') {
        const span = radius * 1.15;
        camera = new T.OrthographicCamera(-span * Math.max(aspect, 1), span * Math.max(aspect, 1), span / Math.min(aspect, 1), -span / Math.min(aspect, 1), near, far);
        distance = radius * 4;
      } else {
        camera = new T.PerspectiveCamera(45, aspect, near, far);
        distance = Math.max(radius / Math.sin(Math.PI / 8), radius / Math.sin(Math.atan(Math.tan(Math.PI / 8) * aspect))) * 1.15;
      }
      const directions = { front: [0, 0, 1], back: [0, 0, -1], side: [1, 0, 0], top: [0, 1, 0], none: [1, 0.65, 1] };
      const direction = new T.Vector3(...directions[view]).normalize();
      camera.position.copy(center).add(direction.multiplyScalar(distance));
      if (view === 'top') camera.up.set(0, 0, -1);
      camera.lookAt(center); camera.updateMatrixWorld(true);
      const rgba = await gpu.render(scene, camera);
      if (background === 'transparent') unpremultiplySRGB(rgba);
      const image = sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } });
      // GPU blending is premultiplied in linear space; pixels have been converted
      // to straight alpha before Sharp encodes PNG/WebP.
      const bytes = await image.toFormat(format, format === 'png' ? {} : { quality: Math.max(1, Math.round((options.quality ?? 0.92) * 100)) }).toBuffer();
      outputs.push({ name: `model-${view}.${format === 'jpeg' ? 'jpg' : format}`, format, bytes, view, width, height });
    }
    return { outputs, warnings, data: { renderer: 'three-webgpu/dawn', backend: gpu.backend, adapter: gpu.adapter, width, height, views } };
  } finally {
    for (const material of temporaryMaterials) material.dispose();
    for (const texture of dataTextures) texture.dispose();
    loaded?.dispose?.();
    gpu.dispose();
  }
}

async function decodeTexture(texture, T) {
  const image = texture.image;
  if (!image) throw Object.assign(new Error(`Texture ${texture.name} has no decoded image.`), { code: 'TEXTURE_DECODE_FAILED' });
  let rgba, width, height;
  if (image.data && image.width && image.height) {
    ({ data: rgba, width, height } = image);
    if (rgba.length !== width * height * 4) throw new Error('Expected RGBA image.');
  } else {
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, image.width, image.height);
    rgba = pixels.data; width = pixels.width; height = pixels.height;
  }
  const result = new T.DataTexture(new Uint8Array(rgba), width, height, T.RGBAFormat, T.UnsignedByteType);
  for (const key of ['name', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'anisotropy', 'flipY', 'colorSpace', 'channel', 'rotation', 'matrixAutoUpdate', 'generateMipmaps']) result[key] = texture[key];
  result.offset.copy(texture.offset); result.repeat.copy(texture.repeat); result.center.copy(texture.center); result.matrix.copy(texture.matrix);
  result.needsUpdate = true;
  return result;
}
