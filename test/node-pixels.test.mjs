import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unpremultiplySRGB } from '../node/pixels.mjs';
import { validateOptions } from '../node/options.mjs';
test('sRGB readback is unpremultiplied in linear color space', () => {
  const bytes = Uint8Array.from([188,0,0,128, 10,20,30,255, 22,33,44,0]);
  unpremultiplySRGB(bytes);
  assert.deepEqual([...bytes], [255,0,0,128, 10,20,30,255, 0,0,0,0]);
});
test('CLI string width/height alone are square; bounds and DPR are enforced', () => {
  assert.equal(validateOptions('render', { width: '65' }).height, 65);
  assert.equal(validateOptions('render', { height: '65' }).width, 65);
  assert.throws(() => validateOptions('render', { width: 8192, height: 8192 }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => validateOptions('render', { dpr: 2 }), { code: 'INVALID_ARGUMENT' });
});
