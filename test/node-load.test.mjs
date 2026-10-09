import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Document, Format } from '@gltf-transform/core';
import { zipSync, strToU8 } from 'fflate';
import sharp from 'sharp';
import { createNodeIO } from '../node/load.mjs';
import { inspectModel, convertModelToGlb, optimizeModel } from '../node/index.mjs';

const obj='mtllib materials/model.mtl\no triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl red\nf 1/1 2/2 3/3\n';
const mtl='newmtl red\nKd 1 0 0\nmap_Kd ../textures/red.png\n';
async function texture(){return sharp({create:{width:2,height:2,channels:4,background:{r:255,g:0,b:0,alpha:1}}}).png().toBuffer();}

test('OBJ MTL resolves relative to MTL directory, embeds a real texture',async()=>{
 const source={bytes:strToU8(obj),fileName:'model.obj',resources:{'materials/model.mtl':strToU8(mtl),'textures/red.png':await texture()}};
 const result=await convertModelToGlb(source);
 assert.equal(result.data.after.textures,1);
 assert.ok(!result.warnings.some(w=>/NOT_FOUND|TEXTURE_OMITTED|TEXTURE_LOAD/.test(w.code)),JSON.stringify(result.warnings));
 const roundtrip=await inspectModel({bytes:result.outputs[0].bytes,fileName:'output.glb'});
 assert.equal(roundtrip.data.triangles,1);
 assert.equal(roundtrip.data.textures,1);
});
test('ZIP MTL and resource paths, and explicit entry selection',async()=>{
 const source={bytes:zipSync({'nested/model.obj':strToU8(obj),'nested/materials/model.mtl':strToU8(mtl),'nested/textures/red.png':await texture()}),fileName:'pack.zip'};
 const result=await convertModelToGlb(source,{entry:'nested/model.obj'});
 assert.equal(result.entry,'nested/model.obj');assert.equal(result.data.after.textures,1);
});
test('STL and PLY are converted without a browser',async()=>{
 const samples=[['triangle.stl','solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t'],['triangle.ply','ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0 255 0 0\n1 0 0 255 0 0\n0 1 0 255 0 0\n3 0 1 2\n']];
 for(const[fileName,text]of samples){const result=await convertModelToGlb({fileName,bytes:strToU8(text)});assert.equal(result.data.after.triangles,1);if(fileName.endsWith('ply'))assert.ok(result.data.after.meshDetails[0].primitives[0].attributes.includes('COLOR_0'));}
});
test('valid multi-buffer glTF converts to a self-contained GLB',async()=>{
 const doc=new Document(),a=doc.createBuffer('a'),b=doc.createBuffer('b');
 const pos=doc.createAccessor().setType('VEC3').setArray(new Float32Array([0,0,0,1,0,0,0,1,0])).setBuffer(a);
 const idx=doc.createAccessor().setType('SCALAR').setArray(new Uint16Array([0,1,2])).setBuffer(b);
 doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION',pos).setIndices(idx))));
 const json=await(await createNodeIO()).writeJSON(doc,{format:Format.GLTF});
 const result=await convertModelToGlb({fileName:'test.gltf',bytes:strToU8(JSON.stringify(json.json)),resources:json.resources});
 assert.equal(result.data.after.triangles,1);
 assert.equal((await(await createNodeIO()).readBinary(result.outputs[0].bytes)).getRoot().listBuffers().length,1);
});
test('explicit no-compression removes existing meshopt rather than recompressing',async()=>{
 const result=await convertModelToGlb({fileName:'triangle.stl',bytes:strToU8('solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t')},{optimize:true,simplify:false});
 assert.ok(result.data.after.extensions.includes('EXT_meshopt_compression'));
 const uncompressed=await optimizeModel({fileName:'compressed.glb',bytes:result.outputs[0].bytes},{simplify:false,compress:false,textureCompress:false});
 assert.ok(!uncompressed.data.after.extensions.includes('EXT_meshopt_compression'));
});
test('strict conversion rejects missing resources with actionable warnings',async()=>{
 const source={fileName:'model.obj',bytes:strToU8(obj),resources:{'materials/model.mtl':strToU8(mtl)}};
 await assert.rejects(convertModelToGlb(source,{strict:true}),error=>error.code==='STRICT_FAILED'&&error.details.warnings.some(w=>w.affectsFidelity));
});
