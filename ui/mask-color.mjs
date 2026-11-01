// The colour used to tint the mask in overlay views. One shared, persisted setting.
export const DEFAULT_MASK_COLOR = "#66e3a6";
const STORAGE_KEY = "costume-mask-color";

export const isHexColor = (value) => typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
export const readMaskColor = (raw) => (isHexColor(raw) ? raw.toLowerCase() : DEFAULT_MASK_COLOR);

export function hexToRgb(hex) {
  const value = isHexColor(hex) ? hex : DEFAULT_MASK_COLOR;
  return [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16));
}

let current = DEFAULT_MASK_COLOR;
try { current = readMaskColor(localStorage.getItem(STORAGE_KEY)); } catch { /* storage unavailable */ }

export const getMaskColor = () => current;

export function setMaskColor(hex) {
  if (!isHexColor(hex)) return;
  current = hex.toLowerCase();
  try { localStorage.setItem(STORAGE_KEY, current); } catch { /* storage unavailable */ }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("mask-color-change"));
}
