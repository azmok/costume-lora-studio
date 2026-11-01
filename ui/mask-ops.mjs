// Binary mask operations on Uint8Array alpha masks (0..255, white = train). Pure and fast (O(n)).
const THRESHOLD = 128;

export function binarize(mask) {
  const result = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index++) result[index] = mask[index] >= THRESHOLD ? 255 : 0;
  return result;
}

export function invertMask(mask) {
  const result = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index++) result[index] = mask[index] >= THRESHOLD ? 0 : 255;
  return result;
}

export function coverage(mask) {
  let white = 0;
  for (let index = 0; index < mask.length; index++) if (mask[index] >= THRESHOLD) white++;
  return mask.length ? white / mask.length : 0;
}

// One dilation pass along a line: a pixel becomes set if a set pixel lies within `radius`.
function dilateLine(source, target, start, stride, length, radius) {
  const near = new Int32Array(length);
  let last = -1e9;
  for (let step = 0; step < length; step++) {
    if (source[start + step * stride]) last = step;
    near[step] = step - last;
  }
  let next = 1e9;
  for (let step = length - 1; step >= 0; step--) {
    if (source[start + step * stride]) next = step;
    const distance = Math.min(near[step], next - step);
    target[start + step * stride] = distance <= radius ? 255 : 0;
  }
}

// Square structuring element of (2r+1) px: horizontal pass then vertical pass.
export function growMask(mask, width, height, radius) {
  const r = Math.max(0, Math.floor(radius));
  const binary = binarize(mask);
  if (r === 0) return binary;
  const horizontal = new Uint8Array(binary.length);
  for (let y = 0; y < height; y++) dilateLine(binary, horizontal, y * width, 1, width, r);
  const result = new Uint8Array(binary.length);
  for (let x = 0; x < width; x++) dilateLine(horizontal, result, x, width, height, r);
  return result;
}

// Erosion = dilation of the background. The image border does not erode the mask.
export function shrinkMask(mask, width, height, radius) {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) return binarize(mask);
  const inverted = growMask(invertMask(mask), width, height, r);
  return invertMask(inverted);
}

function components(mask, width, height, value) {
  const labels = new Int32Array(mask.length).fill(-1);
  const sizes = [];
  const stack = new Int32Array(mask.length);
  for (let seed = 0; seed < mask.length; seed++) {
    if (labels[seed] !== -1 || (mask[seed] >= THRESHOLD ? 255 : 0) !== value) continue;
    const id = sizes.length;
    let top = 0;
    let size = 0;
    stack[top++] = seed;
    labels[seed] = id;
    while (top) {
      const at = stack[--top];
      size++;
      const x = at % width;
      const y = (at - x) / width;
      if (x > 0) { const n = at - 1; if (labels[n] === -1 && (mask[n] >= THRESHOLD ? 255 : 0) === value) { labels[n] = id; stack[top++] = n; } }
      if (x < width - 1) { const n = at + 1; if (labels[n] === -1 && (mask[n] >= THRESHOLD ? 255 : 0) === value) { labels[n] = id; stack[top++] = n; } }
      if (y > 0) { const n = at - width; if (labels[n] === -1 && (mask[n] >= THRESHOLD ? 255 : 0) === value) { labels[n] = id; stack[top++] = n; } }
      if (y < height - 1) { const n = at + width; if (labels[n] === -1 && (mask[n] >= THRESHOLD ? 255 : 0) === value) { labels[n] = id; stack[top++] = n; } }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

// Black regions that do not touch the image border become white.
export function fillHoles(mask, width, height) {
  const binary = binarize(mask);
  const { labels, sizes } = components(binary, width, height, 0);
  const outside = new Set();
  for (let x = 0; x < width; x++) { outside.add(labels[x]); outside.add(labels[(height - 1) * width + x]); }
  for (let y = 0; y < height; y++) { outside.add(labels[y * width]); outside.add(labels[y * width + width - 1]); }
  for (let index = 0; index < binary.length; index++) {
    if (binary[index] === 0 && !outside.has(labels[index]) && sizes[labels[index]] > 0) binary[index] = 255;
  }
  return binary;
}

// White regions smaller than `minArea` pixels are removed.
export function removeSpecks(mask, width, height, minArea) {
  const binary = binarize(mask);
  const { labels, sizes } = components(binary, width, height, 255);
  for (let index = 0; index < binary.length; index++) {
    if (binary[index] === 255 && sizes[labels[index]] < minArea) binary[index] = 0;
  }
  return binary;
}
