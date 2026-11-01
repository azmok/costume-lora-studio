// Whole-UI zoom steps, like a browser's Ctrl + / Ctrl - (applied through the webview).
export const PAGE_ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
export const PAGE_ZOOM_DEFAULT = 1;

const nearestIndex = (value) => {
  let best = 0;
  PAGE_ZOOM_STEPS.forEach((step, index) => {
    if (Math.abs(step - value) < Math.abs(PAGE_ZOOM_STEPS[best] - value)) best = index;
  });
  return best;
};

export function readPageZoom(raw) {
  const value = Number(raw);
  if (raw == null || raw === "" || !Number.isFinite(value) || value <= 0) return PAGE_ZOOM_DEFAULT;
  return PAGE_ZOOM_STEPS[nearestIndex(value)];
}

// direction: +1 zoom in, -1 zoom out, 0 reset.
export function stepPageZoom(current, direction) {
  if (direction === 0) return PAGE_ZOOM_DEFAULT;
  const index = Math.max(0, Math.min(PAGE_ZOOM_STEPS.length - 1, nearestIndex(current) + Math.sign(direction)));
  return PAGE_ZOOM_STEPS[index];
}
