import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { zipSync, strToU8 } from 'fflate';
import { parseGLBForRender } from '../node/load.mjs';
import { installNodeAdapters } from '../node/adapters.mjs';
import { ResourceResolver, ZipIndex } from '../node/resources.mjs';
import { safeText } from '../node/diagnostics.mjs';
import { inspectModel, convertModelToGlb, optimizeModel } from '../node/index.mjs';

function glb(json) {
  const text=Buffer.from(JSON.stringify(json));const padded=Buffer.alloc(Math.ceil(text.length/4)*4,0x20);text.copy(padded);
  const buffer=Buffer.alloc(20+padded.length);buffer.writeUInt32LE(0x46546c67,0);buffer.writeUInt32LE(2,4);buffer.writeUInt32LE(buffer.length,8);buffer.writeUInt32LE(padded.length,12);buffer.writeUInt32LE(0x4e4f534a,16);padded.copy(buffer,20);return buffer;
}
test('render bridge rejects sparse/zero-fill allocation bombs before parsing',async()=>{
 const bytes=glb({asset:{version:'2.0'},accessors:[{componentType:5126,count:100002,type:'VEC3'}],meshes:[{primitives:[{attributes:{POSITION:0}}]}],nodes:[{mesh:0}],scenes:[{nodes:[0]}],scene:0});
 await assert.rejects(parseGLBForRender(bytes,{maxEntryBytes:1024}),{code:'GLTF_SIZE_LIMIT'});
});
test('render bridge rejects unknown or unsupported required extensions',async()=>{
 for(const extension of ['VENDOR_required','KHR_materials_variants']){
  const bytes=glb({asset:{version:'2.0'},extensionsUsed:[extension],extensionsRequired:[extension],scenes:[]});
  await assert.rejects(parseGLBForRender(bytes),{code:'UNSUPPORTED_REQUIRED_EXTENSION'});
 }
});
test('adapter FileLoader uses bounded resolver, never native fetch for TGA',async()=>{
 const warnings=[];const resolver=await new ResourceResolver({},warnings).initialize({entry:'model.dae'});
 const original=globalThis.fetch;let requests=0;globalThis.fetch=()=>{requests++;throw new Error('fetch must not be reached');};
 let adapter;
 try{
  adapter=await installNodeAdapters({resolver,warnings});
  const failure=await new Promise(resolve=>new THREE.FileLoader(adapter.manager).setResponseType('arraybuffer').load('http://127.0.0.1/private.tga',()=>resolve(null),undefined,resolve));
  await adapter.waitForTextures();
  assert.equal(requests,0);assert.equal(failure.code,'NETWORK_DENIED');assert.equal(adapter.pending.size,0);
  assert.ok(warnings.some(w=>w.affectsFidelity));
 }finally{await adapter?.dispose();globalThis.fetch=original;}
 assert.equal(typeof globalThis.document,'undefined');
});
test('ZIP traversal and total decompression caps are rejected',()=>{
 assert.throws(()=>new ZipIndex(zipSync({'../outside.obj':strToU8('a')})),{code:'ZIP_PATH_ESCAPE'});
 assert.throws(()=>new ZipIndex(zipSync({'model.obj':strToU8('abcdef')}),{maxTotalBytes:4}),{code:'ZIP_SIZE_LIMIT'});
});
test('mislabeled ZIP is detected, but independent optimize requires actual GLB',async()=>{
 const bytes=zipSync({'model.obj':strToU8('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')});
 const source={bytes,fileName:'not-really.glb'};
 const result=await inspectModel(source,{entry:'model.obj'});
 assert.equal(result.data.inputFormat,'zip');assert.equal(result.entry,'model.obj');
 assert.ok(result.warnings.some(w=>w.code==='INPUT_FORMAT_MISMATCH'));
 await assert.rejects(optimizeModel(source),{code:'INVALID_ARGUMENT'});
});
test('entry is rejected on actual non-ZIP regardless of filename',async()=>{
 await assert.rejects(convertModelToGlb({bytes:glb({asset:{version:'2.0'},scenes:[]}),fileName:'fake.zip'},{entry:'model.glb'}),{code:'INVALID_ARGUMENT'});
});
test('diagnostics redact URL credentials, query tokens, fragments and inline payloads',()=>{
 const text=safeText('Failed https://user:password@example.com/image.png?token=secret#hash data:image/png;base64,abcdef');
 assert.ok(!/password|secret|abcdef|hash/.test(text));assert.ok(text.includes('https://example.com/image.png'));
});
