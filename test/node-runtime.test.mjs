import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '@gltf-transform/core';
import { createNodeIO } from '../node/load.mjs';
import { createModelProcessor, inspectModel, convertModelToGlb, optimizeModel } from '../node/index.mjs';

async function fixture() {
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document.createAccessor().setType('VEC3').setArray(new Float32Array([0,0,0, 1,0,0, 0,1,0])).setBuffer(buffer);
  const indices = document.createAccessor().setType('SCALAR').setArray(new Uint16Array([0,1,2])).setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute('POSITION', position).setIndices(indices);
  const mesh = document.createMesh('triangle').addPrimitive(primitive);
  const node = document.createNode('triangle').setMesh(mesh);
  document.createScene('scene').addChild(node);
  return { bytes: await (await createNodeIO()).writeBinary(document), fileName: 'triangle.glb' };
}

test('Node API imports without browser globals or initializing GPU', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(globalThis.navigator?.gpu, undefined);
});
test('input bytes: info and conversion return isolated structured results', async () => {
  const source = await fixture();
  const info = await inspectModel(source);
  assert.equal(info.ok, true); assert.equal(info.command, 'info'); assert.equal(info.data.meshes, 1);
  assert.equal(info.outputs.length, 0);
  const output = await convertModelToGlb(source);
  assert.equal(output.outputs.length, 1);
  assert.ok(output.outputs[0].bytes instanceof Uint8Array);
  assert.equal(Buffer.from(output.outputs[0].bytes).subarray(0,4).toString(), 'glTF');
  assert.equal(typeof globalThis.document, 'undefined');
});
test('optimization without simplification preserves geometry and returns effective options', async () => {
  const result = await optimizeModel(await fixture(), { simplify: false, textureCompress: false, compress: false });
  assert.equal(result.ok, true); assert.ok(result.data.optimization);
  assert.equal(result.data.after.meshes, 1);
});
test('already aborted task does not fork', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(inspectModel(await fixture(), { signal: controller.signal }), { code: 'ABORTED' });
});
test('closed processor rejects further tasks', async () => {
  const processor = createModelProcessor(); processor.close();
  await assert.rejects(processor.inspectModel(await fixture()), { code: 'PROCESSOR_CLOSED' });
});
test('queue overflow, cancellation, invalid concurrency', async () => {
  assert.throws(() => createModelProcessor({ concurrency: 0 }), { code: 'INVALID_ARGUMENT' });
  const processor = createModelProcessor({ concurrency: 1, maxQueue: 0 });
  const controller = new AbortController();
  const first = processor.inspectModel(await fixture(), { signal: controller.signal });
  const rejected = assert.rejects(first, { code: 'ABORTED' });
  await assert.rejects(processor.inspectModel(await fixture()), { code: 'QUEUE_FULL' });
  controller.abort(); await rejected; processor.close();
});

test('timings distinguish conversion, simplification, optimization and end-to-end execution', async () => {
  const source = await fixture();
  const converted = await convertModelToGlb(source);
  const t = converted.data.timings;
  assert.equal(t.unit, 'ms');
  for (const key of ['loadMs', 'exportMs', 'conversionMs', 'workerMs', 'queueMs', 'executionMs', 'totalMs']) assert.ok(Number.isFinite(t[key]) && t[key] >= 0, key);
  assert.equal(t.conversionMs, t.loadMs + t.exportMs);
  assert.equal(t.optimizationMs, null); assert.equal(t.simplifyMs, null); assert.equal(t.renderMs, null);
  assert.ok(t.totalMs >= t.workerMs);
  const combined = await convertModelToGlb(source, { optimize: true, simplifyRatio: 1, textureCompress: false, compress: false });
  const c = combined.data.timings;
  assert.ok(c.convertAndOptimizeMs >= c.optimizationMs);
  assert.ok(c.optimizationMs >= c.simplifyMs);
  assert.equal(c.simplifyMs, combined.data.optimization.stageTimingsMs.simplify);
  const skipped = await optimizeModel(source, { simplify: false, textureCompress: false, compress: false });
  assert.equal(skipped.data.timings.simplifyMs, 0);
  assert.equal(skipped.data.timings.conversionMs, null);
});

test('worker errors carry elapsed timings without claiming unfinished stages completed', async () => {
  await assert.rejects(inspectModel('/not-a-real-model.glb'), error => {
    assert.equal(error.code, 'INPUT_NOT_FOUND');
    assert.ok(error.details.timings.totalMs >= error.details.timings.workerMs);
    assert.equal(error.details.timings.loadMs, null);
    return true;
  });
});

test('optimization failure retains timing of completed simplify stage', async () => {
  const { optimizeDocument } = await import('../node/optimize.mjs');
  const d = await (await createNodeIO()).readBinary((await fixture()).bytes);
  const transform = d.transform.bind(d);
  d.transform = async (...args) => {
    if (args.some(fn => fn.name === 'resample')) throw new Error('simulated failure after simplify');
    return transform(...args);
  };
  await assert.rejects(optimizeDocument(d, { simplifyRatio: 1, textureCompress: false, compress: false }), e => {
    assert.equal(e.code, 'OPTIMIZATION_FAILED');
    assert.ok(e.details.stageTimingsMs.simplify >= 0);
    assert.equal(e.details.stageTimingsMs.resample, undefined);
    return true;
  });
});
