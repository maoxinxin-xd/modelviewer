import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Document } from '@gltf-transform/core';
import { createNodeIO } from '../node/load.mjs';
import { convertModelToGlb } from '../node/index.mjs';

test('strict detects missing textures after log truncation and across chunks', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mivo-native-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const primitive = document.createPrimitive().setAttribute('POSITION', position);
  const mesh = document.createMesh().addPrimitive(primitive);
  document.createScene().addChild(document.createNode().setMesh(mesh));
  const glb = await (await createNodeIO()).writeBinary(document);
  const binary = path.join(directory, 'converter.mjs');
  const encoded = Buffer.from(glb).toString('base64');
  await writeFile(binary, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  console.log('FBX2glTF version 0.9.7');
} else {
  const destination = process.argv[process.argv.indexOf('--output') + 1];
  writeFileSync(destination + '.glb', Buffer.from(${JSON.stringify(encoded)},
    'base64'));
  process.stdout.write('x'.repeat(9000));
  process.stdout.write('Could not fi');
  setTimeout(() => process.stdout.write('nd a image file for texture: missing.png'), 20);
}
`, { mode: 0o755 });
  const source = { bytes: Buffer.from('; FBX 7.4.0 project file\n'), fileName: 'log.fbx' };
  const result = await convertModelToGlb(source, { fbxBinary: binary });
  assert.ok(result.warnings.some(warning =>
    warning.code === 'FBX_NATIVE_TEXTURE_MISSING' && warning.affectsFidelity));
  const log = result.warnings.find(warning => warning.code === 'FBX_NATIVE_LOG');
  assert.ok(log.message.length <= 8192);
  await assert.rejects(convertModelToGlb(source, { fbxBinary: binary, strict: true }), {
    code: 'STRICT_FAILED',
  });
});
