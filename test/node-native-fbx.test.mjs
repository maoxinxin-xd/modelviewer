import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import sharp from 'sharp';
import { inspectModel, convertModelToGlb } from '../node/index.mjs';
import { createNodeIO } from '../node/load.mjs';
import { inspectDocument } from '../node/inspect.mjs';
import { validateOptions } from '../node/options.mjs';
import { probeFbxBinary, resolveFbxBinary } from '../node/native-fbx.mjs';

const cli = fileURLToPath(new URL('../node/cli.mjs', import.meta.url));
const vertices = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
  -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
const polygons = [0, 2, -2, 0, 3, -3, 4, 5, -7, 4, 6, -8,
  0, 1, -6, 0, 5, -5, 3, 7, -7, 3, 6, -3, 0, 4, -8, 0, 7, -4, 1, 2, -7, 1, 6, -6];

function array(name, values, indent = '\t\t') {
  const rows = [];
  for (let i = 0; i < values.length; i += 12) {
    rows.push(`${i === 0 ? `${indent}\ta: ` : ''}${values.slice(i, i + 12).join(',')}`);
  }
  return `${indent}${name}: *${values.length} {\n${rows.join(',\n')}\n${indent}}`;
}

// Synthetic cube derived from the audit fixture, with no runtime /tmp dependency or user assets.
// FBXSDK requires DefaultAttributeIndex=0 to select the connected mesh attribute.
function cube({
  texture = false, animated = false, translation = [0, 0, 0], embeddedImage,
} = {}) {
  const layers = `
\t\tLayerElementNormal: 0 {
\t\t\tVersion: 101
\t\t\tName: ""
\t\t\tMappingInformationType: "ByPolygonVertex"
\t\t\tReferenceInformationType: "Direct"
${array('Normals', Array.from({ length: 36 }, () => [0, 0, 1]).flat(), '\t\t\t')}
\t\t}${texture ? `
\t\tLayerElementUV: 0 {
\t\t\tVersion: 101
\t\t\tName: "UVMap"
\t\t\tMappingInformationType: "ByPolygonVertex"
\t\t\tReferenceInformationType: "Direct"
${array('UV', Array.from({ length: 12 }, () => [0, 0, 1, 0, 1, 1]).flat(), '\t\t\t')}
\t\t}
\t\tLayerElementMaterial: 0 {
\t\t\tVersion: 101
\t\t\tName: ""
\t\t\tMappingInformationType: "AllSame"
\t\t\tReferenceInformationType: "IndexToDirect"
${array('Materials', [0], '\t\t\t')}
\t\t}` : ''}
\t\tLayer: 0 {
\t\t\tVersion: 100
\t\t\tLayerElement:  {
\t\t\t\tType: "LayerElementNormal"
\t\t\t\tTypedIndex: 0
\t\t\t}${texture ? `
\t\t\tLayerElement:  {
\t\t\t\tType: "LayerElementUV"
\t\t\t\tTypedIndex: 0
\t\t\t}
\t\t\tLayerElement:  {
\t\t\t\tType: "LayerElementMaterial"
\t\t\t\tTypedIndex: 0
\t\t\t}
` : ''}
\t\t}`;
  const material = texture ? `
\tMaterial: 1003, "Material::Checker", "" {
\t\tVersion: 102
\t\tShadingModel: "phong"
\t\tProperties70:  {
\t\t\tP: "DiffuseColor", "Color", "", "A",1,1,1
\t\t\tP: "DiffuseFactor", "Number", "", "A",1
\t\t}
\t}
\tVideo: 1004, "Video::Checker", "Clip" {
\t\tType: "Clip"
\t\tProperties70:  {
\t\t\tP: "Path", "KString", "XRefUrl", "", "textures/checker.png"
\t\t}
\t\tFilename: "textures/checker.png"
\t\tRelativeFilename: "textures/checker.png"${embeddedImage ? `
\t\tContent: , "${Buffer.from(embeddedImage).toString('base64')}"` : ''}
\t}
\tTexture: 1005, "Texture::Checker", "" {
\t\tType: "TextureVideoClip"
\t\tVersion: 202
\t\tTextureName: "Texture::Checker"
\t\tMedia: "Video::Checker"
\t\tFileName: "textures/checker.png"
\t\tRelativeFilename: "textures/checker.png"
\t\tModelUVTranslation: 0,0
\t\tModelUVScaling: 1,1
\t\tTexture_Alpha_Source: "None"
\t\tCropping: 0,0,0,0
\t}` : '';
  const animation = animated ? `
\tAnimationStack: 2001, "AnimStack::Move", "" {
\t\tProperties70:  {
\t\t\tP: "LocalStart", "KTime", "Time", "",0
\t\t\tP: "LocalStop", "KTime", "Time", "",46186158000
\t\t\tP: "ReferenceStart", "KTime", "Time", "",0
\t\t\tP: "ReferenceStop", "KTime", "Time", "",46186158000
\t\t}
\t}
\tAnimationLayer: 2002, "AnimLayer::BaseLayer", "" {
\t}
\tAnimationCurveNode: 2003, "AnimCurveNode::T", "" {
\t\tProperties70:  {
\t\t\tP: "d|X", "Number", "", "A",${translation[0]}
\t\t\tP: "d|Y", "Number", "", "A",${translation[1]}
\t\t\tP: "d|Z", "Number", "", "A",${translation[2]}
\t\t}
\t}
\tAnimationCurve: 2004, "AnimCurve::X", "" {
\t\tDefault: ${translation[0]}
\t\tKeyVer: 4008
${array('KeyTime', [0, 46186158000])}
${array('KeyValueFloat', [translation[0], translation[0] + 1])}
${array('KeyAttrFlags', [24836])}
${array('KeyAttrDataFloat', [0, 0, 0, 0])}
${array('KeyAttrRefCount', [2])}
\t}` : '';
  return `; FBX 7.4.0 project file
FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
}
GlobalSettings:  {
\tVersion: 1000
\tProperties70:  {
\t\tP: "UpAxis", "int", "Integer", "",1
\t\tP: "UpAxisSign", "int", "Integer", "",1
\t\tP: "FrontAxis", "int", "Integer", "",2
\t\tP: "FrontAxisSign", "int", "Integer", "",-1
\t\tP: "CoordAxis", "int", "Integer", "",0
\t\tP: "CoordAxisSign", "int", "Integer", "",1
\t\tP: "UnitScaleFactor", "double", "Number", "",1
\t}
}
Definitions:  {
\tVersion: 100
\tCount: ${(texture ? 5 : 2) + (animated ? 4 : 0)}
\tObjectType: "Geometry" {
\t\tCount: 1
\t}
\tObjectType: "Model" {
\t\tCount: 1
\t}${texture ? `
\tObjectType: "Material" {
\t\tCount: 1
\t}
\tObjectType: "Texture" {
\t\tCount: 1
\t}
\tObjectType: "Video" {
\t\tCount: 1
\t}` : ''}${animated ? `
\tObjectType: "AnimationStack" {
\t\tCount: 1
\t}
\tObjectType: "AnimationLayer" {
\t\tCount: 1
\t}
\tObjectType: "AnimationCurveNode" {
\t\tCount: 1
\t}
\tObjectType: "AnimationCurve" {
\t\tCount: 1
\t}` : ''}
}
Objects:  {
\tGeometry: 1001, "Geometry::AuditCube", "Mesh" {
\t\tGeometryVersion: 124
${array('Vertices', vertices)}
${array('PolygonVertexIndex', polygons)}${layers}
\t}
\tModel: 1002, "Model::AuditCube", "Mesh" {
\t\tVersion: 232
\t\tProperties70:  {
\t\t\tP: "DefaultAttributeIndex", "int", "Integer", "",0
\t\t\tP: "Visibility", "Visibility", "", "A",1
\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",${translation.join(',')}
\t\t\tP: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0
\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1
\t\t}
\t\tShading: T
\t\tCulling: "CullingOff"
\t}${material}${animation}
}
Connections:  {
\tC: "OO",1001,1002
\tC: "OO",1002,0${texture ? `
\tC: "OO",1003,1002
\tC: "OO",1004,1005
\tC: "OP",1005,1003,"DiffuseColor"` : ''}${animated ? `
\tC: "OO",2002,2001
\tC: "OO",2003,2002
\tC: "OP",2003,1002,"Lcl Translation"
\tC: "OP",2004,2003,"d|X"` : ''}
}
`;
}

async function scratch(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'model-native-fbx-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function png() {
  return sharp({ create: { width: 2, height: 2, channels: 4, background: '#ff8000' } })
    .png().toBuffer();
}

async function checkGlb(result, { textures = 0 } = {}) {
  assert.equal(result.ok, true);
  assert.equal(result.outputs.length, 1);
  const output = result.outputs[0];
  assert.equal(output.format, 'glb');
  assert.equal(Buffer.from(output.bytes).toString('ascii', 0, 4), 'glTF');
  assert.equal(result.data.after.triangles, 12);
  assert.equal(result.data.after.textures, textures);
  const document = await (await createNodeIO()).readBinary(Uint8Array.from(output.bytes));
  assert.equal(document.getRoot().listBuffers().length, 1);
  assert.ok(document.getRoot().listMeshes().length > 0);
  for (const texture of document.getRoot().listTextures()) {
    assert.ok(texture.getImage()?.length > 0, 'Texture must be embedded in the GLB');
  }
  const roundtrip = await inspectModel({ bytes: output.bytes, fileName: 'roundtrip.glb' });
  assert.equal(roundtrip.data.triangles, 12);
  assert.equal(roundtrip.data.textures, textures);
}

function invoke(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, NO_COLOR: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return { ...result, json: JSON.parse(result.stdout) };
}

test('explicit three converts synthetic ASCII FBX independently of native', async () => {
  const source = { fileName: 'cube.fbx', bytes: strToU8(cube()) };
  const result = await convertModelToGlb(source, {
    fbxBackend: 'three', fbxBinary: '/does-not-exist/native-fbx',
  });
  assert.equal(result.data.conversion.backend, 'three');
  assert.match(result.data.conversion.version, /^r\d+$/);
  assert.equal(result.data.timings.nativeConversionMs, null);
  await checkGlb(result);
});

test('synthetic textured and animated FBX fixtures are valid under explicit three', async () => {
  const source = {
    fileName: 'cube.fbx', bytes: strToU8(cube({ texture: true, animated: true })),
    resources: { 'textures/checker.png': await png() },
  };
  const result = await convertModelToGlb(source, { fbxBackend: 'three' });
  await checkGlb(result, { textures: 1 });
  assert.equal(result.data.after.animations.length, 1);
});

test('FBX common options default to native and preserve explicit backend/binary', () => {
  for (const command of ['info', 'convert', 'render', 'optimize']) {
    assert.equal(validateOptions(command).fbxBackend, 'native');
    const binary = path.join(os.tmpdir(), '中文 空格', 'FBX2glTF');
    const options = validateOptions(command, { fbxBackend: 'three', fbxBinary: binary });
    assert.equal(options.fbxBackend, 'three');
    assert.equal(options.fbxBinary, binary);
    assert.equal(validateOptions(command, options).fbxBackend, 'three');
  }
  for (const options of [
    { fbxBackend: 'auto' }, { fbxBackend: '' }, { fbxBackend: 42 },
    { fbxBinary: '' }, { fbxBinary: 42 }, { fbxBinary: ['binary'] },
  ]) assert.throws(() => validateOptions('info', options), { code: 'INVALID_ARGUMENT' });
});

let nativeProbe;
async function native(t) {
  nativeProbe ??= probeFbxBinary();
  const probe = await nativeProbe;
  if (!probe.ok && ['FBX_PLATFORM_UNSUPPORTED', 'FBX_BINARY_MISSING',
    'FBX_BINARY_UNAVAILABLE', 'FBX_BINARY_EXECUTION'].includes(probe.error.code)) {
    t.skip(`Native FBX binary unavailable: ${JSON.stringify(probe)}`);
    return false;
  }
  assert.equal(probe.ok, true, JSON.stringify(probe));
  return probe;
}

test('native converts a standalone FBX and preserves the source and adjacent .fbm', async (t) => {
  if (!await native(t)) return;
  const directory = await scratch(t);
  const file = path.join(directory, 'cube.fbx');
  const source = strToU8(cube());
  await writeFile(file, source);
  const sidecar = path.join(directory, 'cube.fbm');
  await mkdir(sidecar);
  const sentinel = Buffer.from('User-owned sidecar data must never be removed');
  await writeFile(path.join(sidecar, 'keep.bin'), sentinel);
  const result = await convertModelToGlb(file);
  assert.equal(result.data.format, 'fbx');
  await checkGlb(result);
  assert.deepEqual(await readFile(file), Buffer.from(source));
  assert.deepEqual(await readFile(path.join(sidecar, 'keep.bin')), sentinel);
  assert.deepEqual((await readdir(directory)).sort(), ['cube.fbm', 'cube.fbx']);
});

test('native converts byte FBX to a self-contained GLB', async (t) => {
  if (!await native(t)) return;
  const result = await convertModelToGlb({ bytes: strToU8(cube()), fileName: 'bytes.fbx' });
  assert.equal(result.data.inputFormat, 'fbx');
  await checkGlb(result);
});

test('native supports Chinese and space-containing input and binary paths', async (t) => {
  const probe = await native(t);
  if (!probe) return;
  const directory = await scratch(t);
  const nested = path.join(directory, '中文 模型');
  await mkdir(nested);
  const file = path.join(nested, '立方体 测试.fbx');
  await writeFile(file, cube());
  const binary = path.join(directory, '转换器 中文 空格');
  await symlink(probe.binaryPath, binary);
  await checkGlb(await convertModelToGlb(file, { fbxBinary: binary }));
  assert.deepEqual(await readdir(nested), ['立方体 测试.fbx']);
});

test('native ZIP conversion selects nested FBX and embeds relative texture', async (t) => {
  if (!await native(t)) return;
  const entry = '中文 目录/nested/cube.fbx';
  const source = {
    fileName: 'archive.zip',
    bytes: zipSync({
      [entry]: strToU8(cube({ texture: true })),
      '中文 目录/nested/textures/checker.png': await png(),
      'other.obj': strToU8('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'),
    }),
  };
  const result = await convertModelToGlb(source, { entry });
  assert.equal(result.entry, entry);
  assert.equal(result.data.inputFormat, 'zip');
  assert.equal(result.data.format, 'fbx');
  await checkGlb(result, { textures: 1 });
});

test('native embeds byte and disk textures without touching sources', async (t) => {
  if (!await native(t)) return;
  const image = await png();
  const text = cube({ texture: true });
  const source = {
    fileName: 'cube.fbx', bytes: strToU8(text), resources: { 'textures/checker.png': image },
  };
  await checkGlb(await convertModelToGlb(source), { textures: 1 });
  const directory = await scratch(t);
  await mkdir(path.join(directory, 'textures'));
  const file = path.join(directory, 'cube.fbx');
  const texture = path.join(directory, 'textures/checker.png');
  await writeFile(file, text);
  await writeFile(texture, image);
  await checkGlb(await convertModelToGlb(file), { textures: 1 });
  assert.equal(await readFile(file, 'utf8'), text);
  assert.deepEqual(await readFile(texture), image);
});

test('native center and no-animations options operate on converted FBX', async (t) => {
  if (!await native(t)) return;
  const source = {
    fileName: 'animated.fbx', bytes: strToU8(cube({ animated: true, translation: [10, 20, 30] })),
  };
  const original = await convertModelToGlb(source);
  assert.ok(original.data.after.animations.length > 0, 'Fixture must contain native animation');
  assert.ok(original.data.after.bounds.center.some(value => Math.abs(value) > 0.01));
  for (const animationOption of [{ animations: false }, { noAnimations: true }]) {
    const centered = await convertModelToGlb(source, { center: true, ...animationOption });
    await checkGlb(centered);
    assert.equal(centered.data.after.animations.length, 0);
    for (const value of centered.data.after.bounds.center) assert.ok(Math.abs(value) < 1e-6);
  }
});

test('native rejects onlyVisible instead of silently applying unsupported semantics', async (t) => {
  if (!await native(t)) return;
  await assert.rejects(
    convertModelToGlb({ fileName: 'cube.fbx', bytes: strToU8(cube()) }, { onlyVisible: true }),
    error => error.code === 'UNSUPPORTED_OPERATION' && /only.?visible/i.test(error.message),
  );
});

test('FBX and nested ZIP byte limits reject inputs before native conversion', async () => {
  const bytes = strToU8(cube());
  const missing = path.join(os.tmpdir(), 'definitely-missing-fbx-converter');
  await assert.rejects(
    convertModelToGlb({ fileName: 'cube.fbx', bytes }, {
      fbxBinary: missing, maxEntryBytes: bytes.length - 1,
    }),
    { code: 'INPUT_SIZE_LIMIT' },
  );
  const archive = zipSync({ 'nested/cube.fbx': bytes });
  await assert.rejects(
    convertModelToGlb({ fileName: 'model.zip', bytes: archive }, {
      entry: 'nested/cube.fbx', fbxBinary: missing, maxTotalBytes: bytes.length - 1,
    }),
    { code: 'ZIP_SIZE_LIMIT' },
  );
});

test('bundled binary selection rejects unsupported platforms and architectures', async () => {
  for (const runtime of [
    { platform: 'win32', arch: 'x64' }, { platform: 'linux', arch: 'arm64' },
    { platform: 'darwin', arch: 'ia32' }, { platform: 'freebsd', arch: 'x64' },
  ]) {
    await assert.rejects(resolveFbxBinary({}, runtime), { code: 'FBX_PLATFORM_UNSUPPORTED' });
    const probe = await probeFbxBinary({}, runtime);
    assert.equal(probe.ok, false);
    assert.equal(probe.error.code, 'FBX_PLATFORM_UNSUPPORTED');
  }
});

test('explicit missing or directory binary fails without bundled or PATH fallback', async (t) => {
  const directory = await scratch(t);
  const missing = path.join(directory, 'missing converter');
  for (const fbxBinary of [missing, directory]) {
    await assert.rejects(resolveFbxBinary({ fbxBinary }), { code: 'FBX_BINARY_UNAVAILABLE' });
    const probe = await probeFbxBinary({ fbxBinary });
    assert.equal(probe.ok, false);
    assert.equal(probe.error.code, 'FBX_BINARY_UNAVAILABLE');
    await assert.rejects(
      convertModelToGlb({ fileName: 'cube.fbx', bytes: strToU8(cube()) }, { fbxBinary }),
      { code: 'FBX_BINARY_UNAVAILABLE' },
    );
  }
});

test('doctor reports execution failure and repair hints without a fallback', async t => {
  const directory = await scratch(t);
  const binary = path.join(directory, 'broken-executable');
  await writeFile(binary, '#!/does-not-exist/mivo-fbx-interpreter\n', { mode: 0o755 });
  const result = invoke('doctor', '--json', '--fbx-binary', binary);
  assert.equal(result.status, 1);
  assert.equal(result.json.error.code, 'FBX_BINARY_EXECUTION');
  assert.equal(result.json.data.fbx.binarySource, 'override');
  assert.ok(result.json.data.fbx.repairHints.length > 0);
  assert.equal(result.stdout.trim().split('\n').length, 1);
});

test('bundled native resolver pins package and never consults a PATH converter', async (t) => {
  const probe = await native(t);
  if (!probe) return;
  const result = await resolveFbxBinary();
  assert.equal(result.binarySource, 'bundled');
  assert.equal(result.packageVersion, '0.9.7-p1');
  assert.match(result.binaryPath, /fbx2gltf[/\\]bin[/\\](?:Darwin|Linux)[/\\]FBX2glTF$/);
  assert.equal(result.requiresRosetta, process.platform === 'darwin' && process.arch === 'arm64');
  assert.equal(result.compatibility, result.requiresRosetta ? 'rosetta' : 'native');
});

test('doctor --json reports a missing explicit binary in a single JSON envelope', async (t) => {
  const directory = await scratch(t);
  const missing = path.join(directory, '不存在 converter');
  const result = invoke('doctor', '--json', '--fbx-binary', missing);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.equal(result.json.schemaVersion, 1);
  assert.equal(result.json.command, 'doctor');
  assert.equal(result.json.ok, false);
  assert.deepEqual(result.json.outputs, []);
  assert.equal(result.json.error.code, 'FBX_BINARY_UNAVAILABLE');
  assert.equal(result.json.data.fbx.ok, false);
  assert.equal(result.json.data.fbx.error.code, 'FBX_BINARY_UNAVAILABLE');
  assert.ok(result.json.data.fbx.repairHints.length > 0);
  assert.match(result.json.data.fbx.repairHints[0], /explicit --fbx-binary/);
});

test('doctor --json probes bundled and Chinese/space explicit binary paths', async (t) => {
  const probe = await native(t);
  if (!probe) return;
  const directory = await scratch(t);
  const binary = path.join(directory, '中文 转换器 空格');
  await symlink(probe.binaryPath, binary);
  for (const args of [[], ['--fbx-binary', binary]]) {
    const result = invoke('doctor', '--json', ...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.command, 'doctor');
    assert.equal(result.json.error, null);
    assert.equal(result.json.data.fbx.ok, true);
    assert.equal(result.json.data.fbx.version, probe.version);
    assert.equal(result.json.data.fbx.binarySource, args.length ? 'override' : 'bundled');
    if (args.length) assert.equal(result.json.data.fbx.binaryPath, binary);
  }
});

test('native rejects invalid FBX instead of emitting an empty successful GLB', async (t) => {
  if (!await native(t)) return;
  const directory = await scratch(t);
  const file = path.join(directory, 'invalid.fbx');
  const bytes = strToU8('; FBX 7.4.0 project file\nThis is not an FBX scene.\n');
  await writeFile(file, bytes);
  await assert.rejects(convertModelToGlb(file), error =>
    ['FBX_OUTPUT_INVALID', 'FBX_CONVERSION_FAILED'].includes(error.code));
  assert.deepEqual(await readFile(file), Buffer.from(bytes));
  assert.deepEqual(await readdir(directory), ['invalid.fbx']);
});

test('synthetic ASCII passes packaged FBX2glTF baseline without loader bridge', async (t) => {
  const probe = await native(t);
  if (!probe) return;
  const directory = await scratch(t);
  await mkdir(path.join(directory, 'textures'));
  await writeFile(path.join(directory, 'textures/checker.png'), await png());
  for (const textured of [false, true]) {
    const name = textured ? 'textured-animated' : 'plain';
    const file = path.join(directory, `${name}.fbx`);
    const destination = path.join(directory, name);
    const sdk = path.join(directory, `${name}-sdk`);
    await mkdir(sdk);
    await writeFile(file, cube({ texture: textured, animated: textured }));
    const baseline = spawnSync(probe.binaryPath, [
      '--input', file, '--output', destination, '--binary', '--pbr-metallic-roughness',
      '--fbx-temp-dir', sdk,
    ], { cwd: directory, encoding: 'utf8', timeout: 30000 });
    assert.ifError(baseline.error);
    assert.equal(baseline.signal, null, baseline.stderr);
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    const bytes = Uint8Array.from(await readFile(`${destination}.glb`));
    const document = await (await createNodeIO()).readBinary(bytes);
    const stats = inspectDocument(document);
    assert.equal(stats.triangles, 12, 'Native baseline must contain the entire synthetic cube');
    assert.equal(stats.textures, textured ? 1 : 0);
    assert.equal(stats.animations.length, textured ? 1 : 0);
    for (const texture of document.getRoot().listTextures()) {
      assert.ok(texture.getImage()?.length > 0);
    }
  }
});


test('native preserves embedded Video.Content PNG bytes without external resources in strict mode',
  async (t) => {
    if (!await native(t)) return;
    const image = await png();
    const fixture = cube({ texture: true, embeddedImage: image });
    assert.ok(fixture.includes(`Content: , "${image.toString('base64')}"`));
    const result = await convertModelToGlb({
      fileName: 'embedded.fbx', bytes: strToU8(fixture),
    }, { strict: true });
    await checkGlb(result, { textures: 1 });
    assert.ok(!result.warnings.some(warning => /MISSING|NOT_FOUND/.test(warning.code)),
      JSON.stringify(result.warnings));
    assert.ok(!result.warnings.some(warning => warning.affectsFidelity),
      JSON.stringify(result.warnings));
    const bytes = Uint8Array.from(result.outputs[0].bytes);
    const document = await (await createNodeIO()).readBinary(bytes);
    const textures = document.getRoot().listTextures();
    assert.equal(textures.length, 1);
    assert.equal(textures[0].getMimeType(), 'image/png');
    const embedded = textures[0].getImage();
    assert.ok(embedded?.length > 0, 'Embedded Content must not become a missing texture');
    const sha256 = value => createHash('sha256').update(value).digest('hex');
    assert.equal(sha256(embedded), sha256(image), 'Embedded PNG bytes must remain unchanged');
  });
