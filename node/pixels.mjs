const linear = Float64Array.from({ length: 256 }, (_, value) => {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});
/** In-place: sRGB-encoded linear-premultiplied RGBA -> straight-alpha sRGB RGBA. */
export function unpremultiplySRGB(bytes) {
  for (let i = 0; i < bytes.length; i += 4) {
    const alpha = bytes[i + 3];
    if (alpha === 255) continue;
    if (alpha === 0) { bytes[i] = bytes[i + 1] = bytes[i + 2] = 0; continue; }
    for (let channel = 0; channel < 3; channel++) {
      const value = Math.min(1, linear[bytes[i + channel]] * 255 / alpha);
      bytes[i + channel] = Math.round(255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055));
    }
  }
  return bytes;
}
