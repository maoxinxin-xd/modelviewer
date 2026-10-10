import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Document, Format } from '@gltf-transform/core';
import { strToU8, zipSync } from 'fflate';
import sharp from 'sharp';
import { createNodeIO } from '../node/load.mjs';
import { convertModelToGlb, optimizeModel } from '../node/index.mjs';
import { validateOptions } from '../node/options.mjs';

// Run after the switching implementation lands: node --test test/node-switching.test.mjs
// All models, archive resources, and textures are generated locally; no renderer is invoked.
const OBJ = strToU8('o triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
const SUPPORTED = [
  'glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'dae', '3mf', '3ds',
  'wrl', 'vrml', 'step', 'stp',
];
const archive = entries => ({ fileName: 'switching.zip', bytes: zipSync(entries) });
const invalid = (command, options) => {
  assert.throws(() => validateOptions(command, options), { code: 'INVALID_ARGUMENT' });
};

function triangle() {
  const document = new Document();
  const buffer = document.createBuffer();
  const accessor = (type, array) => document.createAccessor()
    .setType(type).setArray(array).setBuffer(buffer);
  const primitive = document.createPrimitive()
    .setAttribute('POSITION', accessor('VEC3', new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ])))
    .setIndices(accessor('SCALAR', new Uint16Array([0, 1, 2])));
  const mesh = document.createMesh('triangle').addPrimitive(primitive);
  const node = document.createNode('triangle').setMesh(mesh);
  const scene = document.createScene('scene').addChild(node);
  document.getRoot().setDefaultScene(scene);
  return { document, accessor, primitive, node, scene };
}

async function triangleGLB() {
  return (await createNodeIO()).writeBinary(triangle().document);
}

async function readOutput(result) {
  assert.equal(result.ok, true);
  assert.equal(result.outputs.length, 1);
  assert.ok(result.outputs[0].bytes instanceof Uint8Array);
  // IPC Buffer views may have unaligned offsets; NodeIO reads a Uint32Array header.
  return (await createNodeIO()).readBinary(Uint8Array.from(result.outputs[0].bytes));
}

async function assertSelection(source, options, entry) {
  const result = await convertModelToGlb(source, { allowNetwork: false, ...options });
  assert.equal(result.entry, entry);
  const document = await readOutput(result);
  assert.equal(document.getRoot().listMeshes().length, 1);
  const primitive = document.getRoot().listMeshes()[0].listPrimitives()[0];
  assert.equal(primitive.getAttribute('POSITION').getCount(), 3);
}

test('ZIP entryFormats chooses OBJ instead of the default glTF entry', async () => {
  const io = await createNodeIO();
  const json = await io.writeJSON(triangle().document, { format: Format.GLTF });
  const source = archive({
    ...json.resources,
    'scene.gltf': strToU8(JSON.stringify(json.json)),
    'triangle.obj': OBJ,
  });
  await assertSelection(source, {}, 'scene.gltf');
  await assertSelection(source, { entryFormats: ['obj'] }, 'triangle.obj');
});

test('ZIP entryFormats ordering selects among candidates at the same depth', async () => {
  const source = archive({ 'a.glb': await triangleGLB(), 'z.obj': OBJ });
  await assertSelection(source, { entryFormats: ['obj', 'glb'] }, 'z.obj');
  await assertSelection(source, { entryFormats: ['glb', 'obj'] }, 'a.glb');
});

test('ZIP explicit format priority takes precedence over shallower candidates', async () => {
  const source = archive({ 'root.obj': OBJ, 'a/b/model.glb': await triangleGLB() });
  await assertSelection(source, {
    entryFormats: ['glb', 'obj'], entryDepth: 2,
  }, 'a/b/model.glb');
  await assertSelection(source, {
    entryFormats: ['glb', 'obj'], entryDepth: 1,
  }, 'root.obj');
});

test('ZIP entryDepth includes root at 0 and directory depths 1 and 2', async () => {
  const glb = await triangleGLB();
  for (const depth of [0, 1, 2]) {
    const entry = `${'dir/'.repeat(depth)}model.glb`;
    const source = archive({ [entry]: glb });
    await assertSelection(source, { entryFormats: ['glb'], entryDepth: depth }, entry);
    if (depth > 0) {
      await assert.rejects(convertModelToGlb(source, {
        entryFormats: ['glb'], entryDepth: depth - 1, allowNetwork: false,
      }), { code: 'ZIP_NO_MODEL' });
    }
  }
});

test('ZIP entryDepth excludes a depth-3 GLB in favor of an eligible OBJ', async () => {
  const source = archive({
    'a/b/c/preferred.glb': await triangleGLB(),
    'a/b/eligible.obj': OBJ,
  });
  await assertSelection(source, {
    entryFormats: ['glb', 'obj'], entryDepth: 2,
  }, 'a/b/eligible.obj');
  await assert.rejects(convertModelToGlb(source, {
    entryFormats: ['glb'], entryDepth: 2, allowNetwork: false,
  }), { code: 'ZIP_NO_MODEL' });
});

test('ZIP explicit entry bypasses both format and depth automatic filters', async () => {
  const entry = 'a/b/c/explicit.glb';
  const source = archive({ [entry]: await triangleGLB(), 'root.obj': OBJ });
  await assertSelection(source, { entry, entryFormats: ['obj'], entryDepth: 0 }, entry);
  await assert.rejects(convertModelToGlb(source, {
    entry: 'missing.glb', entryFormats: ['obj'], entryDepth: 0,
  }), { code: 'ZIP_ENTRY_NOT_FOUND' });
});

async function riggedGLB() {
  const { document, accessor, primitive, node, scene } = triangle();
  primitive.setAttribute('JOINTS_0', accessor('VEC4', new Uint16Array([
    0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0,
  ])));
  primitive.setAttribute('WEIGHTS_0', accessor('VEC4', new Float32Array([
    0.75, 0.25, 0, 0, 0.25, 0.75, 0, 0, 0.5, 0.5, 0, 0,
  ])));
  primitive.addTarget(document.createPrimitiveTarget().setAttribute(
    'POSITION', accessor('VEC3', new Float32Array([
      0, 0, 0.1, 0, 0, 0.2, 0, 0, 0.3,
    ])),
  ));
  node.getMesh().setWeights([0.25]);
  primitive.setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array([
    0, 0, 1, 0, 0, 1,
  ])));
  // A non-solid texture cannot be pruned as a constant material color.
  const pixels = Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 0, 255,
  ]);
  const image = await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } })
    .png().toBuffer();
  const texture = document.createTexture('checker').setMimeType('image/png').setImage(image);
  primitive.setMaterial(document.createMaterial('textured').setBaseColorTexture(texture));
  const rootJoint = document.createNode('root-joint');
  const tipJoint = document.createNode('tip-joint').setTranslation([0, 1, 0]);
  rootJoint.addChild(tipJoint);
  scene.addChild(rootJoint);
  const matrices = new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1,
  ]);
  node.setSkin(document.createSkin('two-joint-skin').setSkeleton(rootJoint)
    .addJoint(rootJoint).addJoint(tipJoint)
    .setInverseBindMatrices(accessor('MAT4', matrices)));
  const times = accessor('SCALAR', new Float32Array([0, 0.5, 1]));
  const motion = document.createAnimationSampler().setInput(times)
    .setOutput(accessor('VEC3', new Float32Array([0, 1, 0, 0.2, 1, 0, 0, 1, 0])))
    .setInterpolation('LINEAR');
  const weights = document.createAnimationSampler().setInput(times)
    .setOutput(accessor('SCALAR', new Float32Array([0.25, 1, 0.25])))
    .setInterpolation('LINEAR');
  document.createAnimation('joint-and-morph')
    .addSampler(motion).addSampler(weights)
    .addChannel(document.createAnimationChannel().setTargetNode(tipJoint)
      .setTargetPath('translation').setSampler(motion))
    .addChannel(document.createAnimationChannel().setTargetNode(node)
      .setTargetPath('weights').setSampler(weights));
  return { fileName: 'rigged.glb', bytes: await (await createNodeIO()).writeBinary(document) };
}

async function assertRigged(document, textureFormats = ['image/png']) {
  const root = document.getRoot();
  const skinned = root.listNodes().find(node => node.getSkin() && node.getMesh());
  assert.ok(skinned, 'a mesh node must still reference its skin');
  const skin = skinned.getSkin();
  const joints = skin.listJoints();
  assert.equal(joints.length, 2);
  assert.deepEqual(new Set(joints.map(joint => joint.getName())),
    new Set(['root-joint', 'tip-joint']));
  assert.equal(skin.getSkeleton(), joints[0]);
  assert.ok(joints[0].listChildren().includes(joints[1]));
  assert.equal(skin.getInverseBindMatrices().getType(), 'MAT4');
  assert.equal(skin.getInverseBindMatrices().getCount(), 2);
  const primitive = skinned.getMesh().listPrimitives()[0];
  for (const semantic of ['JOINTS_0', 'WEIGHTS_0']) {
    assert.equal(primitive.getAttribute(semantic).getCount(), 3, semantic);
    assert.equal(primitive.getAttribute(semantic).getType(), 'VEC4', semantic);
  }
  assert.ok(primitive.getAttribute('JOINTS_0').getArray().includes(1));
  assert.ok(primitive.getAttribute('WEIGHTS_0').getArray().some(value => value > 0));
  assert.equal(primitive.listTargets().length, 1);
  const delta = primitive.listTargets()[0].getAttribute('POSITION');
  assert.equal(delta.getCount(), 3);
  assert.ok(delta.getArray().some(value => value > 0));
  assert.equal(skinned.getMesh().getWeights().length, 1);
  assert.equal(root.listAnimations().length, 1);
  const channels = root.listAnimations()[0].listChannels();
  assert.equal(channels.length, 2);
  assert.deepEqual(new Set(channels.map(channel => channel.getTargetPath())),
    new Set(['translation', 'weights']));
  for (const channel of channels) {
    assert.equal(channel.getTargetNode(), channel.getTargetPath() === 'weights'
      ? skinned : joints[1]);
    const sampler = channel.getSampler();
    assert.ok(sampler.getInput().getCount() >= 2);
    assert.ok(sampler.getOutput().getCount() >= 2);
    assert.ok([...sampler.getOutput().getArray()].every(Number.isFinite));
  }
  assert.equal(root.listTextures().length, 1);
  const texture = primitive.getMaterial().getBaseColorTexture();
  assert.ok(root.listTextures().includes(texture), 'texture must remain bound to the material');
  assert.ok(textureFormats.includes(texture.getMimeType()), texture.getMimeType());
  assert.ok(texture.getImage().byteLength > 0);
  const metadata = await sharp(texture.getImage()).metadata();
  assert.equal(metadata.width, 2);
  assert.equal(metadata.height, 2);
  assert.equal(primitive.getAttribute('TEXCOORD_0').getCount(), 3);
}

for (const command of ['convert', 'optimize']) {
  test(`${command} round-trip retains two joints, skin, morph, animation and texture`, async () => {
    const source = await riggedGLB();
    // Verify fixture as well as output; a missing source feature must never false-pass.
    await assertRigged(await (await createNodeIO()).readBinary(source.bytes));
    const result = command === 'convert'
      ? await convertModelToGlb(source, { allowNetwork: false })
      : await optimizeModel(source, {
        allowNetwork: false, simplify: false, compress: false, textureCompress: false,
      });
    await assertRigged(await readOutput(result));
  });
}

test('default optimize retains valid triangle, skin, morph, animation and texture', async () => {
  const source = await riggedGLB();
  await assertRigged(await (await createNodeIO()).readBinary(source.bytes));
  // Deliberately use the public API defaults, including simplification and compression.
  const result = await optimizeModel(source);
  assert.equal(result.data.optimization.options.simplify, true);
  assert.equal(result.data.optimization.options.compress, 'meshopt');
  assert.equal(result.data.optimization.options.textureCompress, 'auto');
  for (const stage of ['simplify', 'textureCompress', 'meshopt']) {
    assert.ok(result.data.transformations.includes(stage), `${stage} must run by default`);
  }
  const document = await readOutput(result);
  // Texture transcoding is valid; require a supported, decodable embedded image instead of PNG.
  await assertRigged(document, ['image/png', 'image/jpeg', 'image/webp', 'image/avif']);
  const skinned = document.getRoot().listNodes().find(node => node.getSkin() && node.getMesh());
  const primitive = skinned.getMesh().listPrimitives()[0];
  assert.equal(primitive.getMode(), 4, 'geometry must still be triangles');
  const indices = primitive.getIndices();
  assert.equal(indices.getCount(), 3, 'the single source triangle must survive');
  const positions = primitive.getAttribute('POSITION');
  const vertices = [...indices.getArray()].map(index => {
    assert.ok(Number.isInteger(index) && index >= 0 && index < positions.getCount());
    return positions.getElement(index, []);
  });
  assert.ok(vertices.flat().every(Number.isFinite));
  const u = vertices[1].map((value, axis) => value - vertices[0][axis]);
  const v = vertices[2].map((value, axis) => value - vertices[0][axis]);
  const cross = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  assert.ok(Math.hypot(...cross) > 0, 'the surviving triangle must not be degenerate');
  const joints = primitive.getAttribute('JOINTS_0');
  const weights = primitive.getAttribute('WEIGHTS_0');
  for (let index = 0; index < positions.getCount(); index++) {
    const jointValues = joints.getElement(index, []);
    assert.ok(jointValues.every(joint => Number.isInteger(joint) && joint >= 0 && joint < 2));
    const weightValues = weights.getElement(index, []);
    assert.ok(weightValues.every(weight => Number.isFinite(weight) && weight >= 0));
    const sum = weightValues.reduce((total, weight) => total + weight, 0);
    assert.ok(Math.abs(sum - 1) < 0.01, 'skin weights must remain normalized');
  }
  for (const channel of document.getRoot().listAnimations()[0].listChannels()) {
    const sampler = channel.getSampler();
    const times = [...sampler.getInput().getArray()];
    assert.ok(times.every((time, index) => Number.isFinite(time) &&
      (index === 0 || time > times[index - 1])), 'animation times must increase');
    const output = sampler.getOutput();
    assert.equal(output.getCount(), times.length);
    assert.equal(output.getType(), channel.getTargetPath() === 'weights' ? 'SCALAR' : 'VEC3');
    const frames = times.map((_, index) => JSON.stringify(output.getElement(index, [])));
    assert.ok(new Set(frames).size > 1, 'animation keyframes must not become constant');
  }
});

test('validator accepts supported entryFormats and depths for every command', () => {
  for (const command of ['info', 'convert', 'optimize', 'render']) {
    for (const entryDepth of [0, 1, 2]) {
      const options = validateOptions(command, { entryFormats: SUPPORTED, entryDepth });
      assert.deepEqual(options.entryFormats, SUPPORTED);
      assert.equal(options.entryDepth, entryDepth);
    }
  }
});

test('validator rejects empty, duplicate, non-array and unsupported entryFormats', () => {
  for (const command of ['info', 'convert', 'optimize', 'render']) {
    for (const entryFormats of [
      [], ['glb', 'glb'], ['obj', 'obj'], ['zip'], ['unknown'], ['glb', 1],
      [''], [' glb '], 'glb,obj', null, {},
    ]) invalid(command, { entryFormats });
  }
});

test('validator rejects negative, fractional, unsafe and nonfinite entryDepth', () => {
  for (const entryDepth of [
    -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, null, true, '',
  ]) {
    invalid('convert', { entryDepth });
  }
});

test('render validator accepts dimension and total-pixel boundaries without GPU', () => {
  for (const [width, height] of [[1, 1], [8192, 1], [1, 8192], [4096, 4096]]) {
    const options = validateOptions('render', { width, height });
    assert.equal(options.width, width);
    assert.equal(options.height, height);
  }
  assert.equal(validateOptions('render', { size: 1 }).width, 1);
  assert.equal(validateOptions('render', { width: '1024', height: '512' }).height, 512);
  for (const dimension of ['width', 'height', 'size']) {
    for (const value of [0, -1, 1.5, NaN, Infinity, '', null, true]) {
      invalid('render', { [dimension]: value });
    }
  }
  invalid('render', { width: 8193, height: 1 });
  invalid('render', { width: 1, height: 8193 });
  invalid('render', { width: 4096, height: 4097 });
  invalid('render', { size: 8193 });
});

test('render validator accepts left/right/bottom, white, software and padding', () => {
  for (const view of ['left', 'right', 'bottom']) {
    const options = validateOptions('render', {
      view, textureMode: 'white', device: 'software', padding: 0.1,
    });
    assert.equal(options.view, view);
    assert.equal(options.textureMode, 'white');
    assert.equal(options.device, 'software');
    assert.equal(options.padding, 0.1);
    assert.equal(validateOptions('render', { presetView: view }).view, view);
  }
  const views = ['left', 'right', 'bottom'];
  assert.deepEqual(validateOptions('render', { views }).views, views);
  assert.deepEqual(validateOptions('render', { views: 'left,right,bottom' }).views, views);
  for (const device of ['auto', 'software', 'hardware']) {
    assert.equal(validateOptions('render', { device }).device, device);
  }
  for (const padding of [0, 10]) {
    assert.equal(validateOptions('render', { padding }).padding, padding);
  }
});

test('render validator rejects invalid views, modes, devices and padding', () => {
  for (const view of ['diagonal', 'LEFT', '', 1]) invalid('render', { view });
  for (const views of [[], ['left', 'left'], ['bottom', 'diagonal'], '', 1]) {
    invalid('render', { views });
  }
  invalid('render', { view: 'left', views: ['right'] });
  for (const textureMode of ['WHITE', 'unknown', '', 1]) {
    invalid('render', { textureMode });
  }
  for (const device of ['cpu', 'gpu', '', 1, true]) invalid('render', { device });
  for (const padding of [-0.01, 10.01, NaN, Infinity, -Infinity, '', null, true]) {
    invalid('render', { padding });
  }
});

test('validator enforces optimization, timeout, quality and boolean parameter boundaries', () => {
  for (const value of [0, 1]) {
    const options = validateOptions('optimize', { ratio: value, error: value });
    assert.equal(options.ratio, value);
    assert.equal(options.error, value);
    assert.equal(validateOptions('render', { format: 'webp', quality: value }).quality, value);
  }
  for (const textures of [1, 16384]) {
    assert.equal(validateOptions('optimize', { textures }).textures, textures);
  }
  for (const timeout of [0.001, 86400]) {
    assert.equal(validateOptions('info', { timeout }).timeout, timeout);
  }
  for (const key of ['ratio', 'error']) {
    for (const value of [-0.01, 1.01, NaN, Infinity]) invalid('optimize', { [key]: value });
  }
  for (const textures of [0, 16385, 1.5, Infinity]) invalid('optimize', { textures });
  for (const timeout of [0, -1, 86401, NaN, Infinity]) invalid('info', { timeout });
  for (const quality of [-0.01, 1.01, NaN]) invalid('render', { format: 'webp', quality });
  invalid('render', { format: 'png', quality: 0.5 });
  invalid('render', { format: 'jpeg', background: 'transparent' });
  invalid('convert', { simplify: false });
  for (const key of ['onlyVisible', 'animations', 'center', 'optimize', 'allowNetwork']) {
    invalid('convert', { [key]: 'true' });
  }
  assert.equal(validateOptions('convert', { onlyVisible: true }).onlyVisible, true);
  assert.equal(validateOptions('convert', { onlyVisible: false }).onlyVisible, false);
});
