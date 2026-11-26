export function imagePoint(rect, width, height, clientX, clientY) {
  const raw = imagePointUnclamped(rect, width, height, clientX, clientY);
  return {
    x: Math.max(0, Math.min(width - 1, raw.x)),
    y: Math.max(0, Math.min(height - 1, raw.y))
  };
}

export function imagePointUnclamped(rect, width, height, clientX, clientY) {
  if (!rect.width || !rect.height || width < 1 || height < 1) throw new Error("Invalid image display size");
  return {
    x: (clientX - rect.left) * width / rect.width,
    y: (clientY - rect.top) * height / rect.height
  };
}

export class MaskHistory {
  constructor() { this.states = []; this.extras = []; this.index = -1; }
  get extra() { return this.extras[this.index] ?? []; }
  reset(mask, extra = []) { this.states = [mask.slice()]; this.extras = [structuredClone(extra)]; this.index = 0; }
  commit(mask, extra = []) {
    this.states = this.states.slice(0, this.index + 1);
    this.extras = this.extras.slice(0, this.index + 1);
    this.states.push(mask.slice());
    this.extras.push(structuredClone(extra));
    const limit = Math.max(2, Math.min(20, Math.floor(64 * 1024 * 1024 / Math.max(1, mask.length))));
    if (this.states.length > limit) { this.states.shift(); this.extras.shift(); }
    this.index = this.states.length - 1;
  }
  undo() { if (this.index <= 0) return null; return this.states[--this.index].slice(); }
  redo() { if (this.index >= this.states.length - 1) return null; return this.states[++this.index].slice(); }
}
