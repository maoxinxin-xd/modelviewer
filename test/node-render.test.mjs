import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '@gltf-transform/core';
import { KHRMaterialsUnlit } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { createNodeIO } from '../node/load.mjs';
import { renderModelImages } from '../node/index.mjs';

test('native render: nonaligned dimensions and straight-alpha PNG', { skip: !process.env.MIVO_TEST_RENDER }, async () => {
  const document = new Document(), buffer = document.createBuffer();
  const positions = document.createAccessor().setType('VEC3').setArray(new Float32Array([-1,-1,0, 1,-1,0, 1,1,0, -1,1,0])).setBuffer(buffer);
  const indices = document.createAccessor().setType('SCALAR').setArray(new Uint16Array([0,1,2, 2,3,0])).setBuffer(buffer);
  const material = document.createMaterial().setBaseColorFactor([1,0,0,.5]).setAlphaMode('BLEND').setExtension('KHR_materials_unlit', document.createExtension(KHRMaterialsUnlit).createUnlit());
  const primitive = document.createPrimitive().setAttribute('POSITION', positions).setIndices(indices).setMaterial(material);
  document.createScene().addChild(document.createNode().setMesh(document.createMesh().addPrimitive(primitive)));
  const source = { bytes: await (await createNodeIO()).writeBinary(document), fileName: 'red.glb' };
  const result = await renderModelImages(source, { width: 65, height: 33 });
  assert.ok(result.data.timings.renderMs > 0);
  assert.ok(result.data.timings.totalMs >= result.data.timings.renderMs);
  const image = sharp(result.outputs[0].bytes);
  const meta = await image.metadata();
  assert.equal(meta.width, 65); assert.equal(meta.height, 33);
  const { data } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const center = (16 * 65 + 32) * 4;
  assert.ok(data[center] > 200, `red channel was incorrectly premultiplied: ${data[center]}`);
  assert.ok(data[center + 3] >= 126 && data[center + 3] <= 130);
  assert.equal(data[3], 0);
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(globalThis.navigator?.gpu, undefined);
});

/** Unequal axis lengths and face colors make orientation and framing observable. */
async function coloredBox() {
  const d = new Document();
  const buffer = d.createBuffer();
  const unlit = d.createExtension(KHRMaterialsUnlit);
  const mesh = d.createMesh('axis-box');
  const faces = [
    [[1, 0, 0], [[2,-1,-.5], [2,1,-.5], [2,1,.5], [2,-1,.5]]],
    [[0, 0, 1], [[-2,-1,-.5], [-2,-1,.5], [-2,1,.5], [-2,1,-.5]]],
    [[0, 1, 0], [[-2,1,-.5], [-2,1,.5], [2,1,.5], [2,1,-.5]]],
    [[1, 0, 1], [[-2,-1,-.5], [2,-1,-.5], [2,-1,.5], [-2,-1,.5]]],
    [[1, 1, 0], [[-2,-1,.5], [2,-1,.5], [2,1,.5], [-2,1,.5]]],
    [[0, 1, 1], [[-2,-1,-.5], [-2,1,-.5], [2,1,-.5], [2,-1,-.5]]],
  ];
  for (const [color, vertices] of faces) {
    const positions = d.createAccessor().setType('VEC3').setBuffer(buffer)
      .setArray(new Float32Array(vertices.flat()));
    const indices = d.createAccessor().setType('SCALAR').setBuffer(buffer)
      .setArray(new Uint16Array([0,1,2, 0,2,3]));
    const material = d.createMaterial().setBaseColorFactor([...color, 1])
      .setDoubleSided(true).setExtension('KHR_materials_unlit', unlit.createUnlit());
    mesh.addPrimitive(d.createPrimitive().setAttribute('POSITION', positions)
      .setIndices(indices).setMaterial(material));
  }
  d.createScene().addChild(d.createNode().setMesh(mesh));
  return { bytes: await (await createNodeIO()).writeBinary(d), fileName: 'axis-box.glb' };
}

async function pixels(output) {
  return sharp(output.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

test('native render: server-compatible axes, side alias and shared orthographic framing', {
  skip: !process.env.MIVO_TEST_RENDER,
}, async () => {
  const source = await coloredBox();
  const result = await renderModelImages(source, {
    views: ['front', 'left', 'back', 'top', 'right', 'side', 'bottom'],
    width: 129, height: 129, projection: 'orthographic', padding: 0.1,
    device: process.env.MIVO_TEST_DEVICE ?? 'auto',
  });
  const images = new Map();
  for (const output of result.outputs) images.set(output.view, await pixels(output));
  const center = (64 * 129 + 64) * 4;
  const rgba = view => [...images.get(view).data.subarray(center, center + 4)];
  assert.ok(rgba('left')[0] > 200 && rgba('left')[2] < 20);
  assert.ok(rgba('right')[2] > 200 && rgba('right')[0] < 20);
  assert.ok(rgba('top')[1] > 200 && rgba('top')[0] < 20);
  assert.ok(rgba('front')[0] > 200 && rgba('front')[1] > 200);
  assert.ok(rgba('back')[1] > 200 && rgba('back')[2] > 200);
  assert.ok(rgba('bottom')[0] > 200 && rgba('bottom')[2] > 200);
  assert.deepEqual(images.get('left').data, images.get('side').data);
  for (const { data } of images.values()) assert.equal(data[3], 0);
  const verticalSpan = view => {
    let min = 129, max = -1;
    const { data } = images.get(view);
    for (let y = 0; y < 129; y++) {
      for (let x = 0; x < 129; x++) {
        if (data[(y * 129 + x) * 4 + 3]) { min = Math.min(min, y); max = Math.max(max, y); }
      }
    }
    return max - min + 1;
  };
  assert.equal(verticalSpan('front'), verticalSpan('left'));
  assert.ok(verticalSpan('top') < verticalSpan('front'));
});

test('native render: white mode removes face colors without mutating the source', {
  skip: !process.env.MIVO_TEST_RENDER,
}, async () => {
  const source = await coloredBox();
  const original = Buffer.from(source.bytes);
  const options = {
    view: 'front', width: 65, height: 65, projection: 'orthographic',
    device: process.env.MIVO_TEST_DEVICE ?? 'auto',
  };
  const white = await renderModelImages(source, { ...options, textureMode: 'white' });
  const clay = await renderModelImages(source, { ...options, textureMode: 'clay' });
  const center = (32 * 65 + 32) * 4;
  const w = (await pixels(white.outputs[0])).data.subarray(center, center + 4);
  const c = (await pixels(clay.outputs[0])).data.subarray(center, center + 4);
  assert.ok(w[0] > c[0], `white should be brighter than clay: ${w[0]} vs ${c[0]}`);
  assert.ok(Math.abs(w[0] - w[1]) <= 1 && Math.abs(w[1] - w[2]) <= 1);
  assert.equal(w[3], 255);
  assert.deepEqual(Buffer.from(source.bytes), original);
});

test('native render: oblique orthographic output does not clip model corners', {
  skip: !process.env.MIVO_TEST_RENDER,
}, async () => {
  const result = await renderModelImages(await coloredBox(), {
    view: 'none', width: 65, height: 129, projection: 'orthographic',
    device: process.env.MIVO_TEST_DEVICE ?? 'auto',
  });
  const { data, info } = await pixels(result.outputs[0]);
  for (let y = 0; y < info.height; y++) {
    assert.equal(data[(y * info.width) * 4 + 3], 0);
    assert.equal(data[(y * info.width + info.width - 1) * 4 + 3], 0);
  }
});


test('native render: large padding in portrait perspective keeps geometry visible', {
  skip: !process.env.MIVO_TEST_RENDER,
}, async () => {
  const result = await renderModelImages(await coloredBox(), {
    view: 'front', width: 64, height: 1024, padding: 10, projection: 'perspective',
    device: process.env.MIVO_TEST_DEVICE ?? 'auto',
  });
  const { data } = await pixels(result.outputs[0]);
  assert.ok(data.some((value, index) => index % 4 === 3 && value > 0));
});
