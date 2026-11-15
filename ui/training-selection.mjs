// Which images of a source folder are used for LoRA training. Every image is used by default; the images
// that were unchecked in Tools are stored per source folder and sent to the trainer as `excluded_sources`.
export const SELECTION_KEY = "costume-training-excluded";

export const rootKey = (root) => String(root ?? "").trim().replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

// { "<root key>": { excluded: ["a.png", ...], total: 45 } }
export function parseStore(raw) {
  let data;
  try { data = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return {}; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const store = {};
  for (const [key, value] of Object.entries(data)) {
    if (!value || !Array.isArray(value.excluded)) continue;
    store[key] = {
      excluded: value.excluded.filter((item) => typeof item === "string").slice(0, 200000),
      total: Number.isFinite(value.total) ? Math.max(0, Math.floor(value.total)) : 0
    };
  }
  return store;
}

export const getRecord = (store, root) => store[rootKey(root)] ?? { excluded: [], total: 0 };

export function setRecord(store, root, record) {
  const key = rootKey(root);
  if (!key) return store;
  return { ...store, [key]: { excluded: [...new Set(record.excluded)], total: Math.max(0, Math.floor(record.total ?? 0)) } };
}

export function selectionSummary(record, useSelection) {
  const unchecked = record.excluded.length;
  if (!useSelection) return "Every image in the dataset will be used (the Tools selection is ignored).";
  if (!unchecked) return "Every image will be used. Uncheck images in Tools (Caption & Paint) to leave them out of training.";
  const used = record.total > unchecked ? record.total - unchecked : null;
  const lead = used === null ? "Training will skip " + unchecked + (unchecked === 1 ? " image" : " images") : "Training will use " + used + " of " + record.total + " images";
  return lead + " — " + unchecked + " unchecked in Tools.";
}

export function loadSelectionStore() {
  try { return parseStore(localStorage.getItem(SELECTION_KEY)); } catch { return {}; }
}

export function saveSelectionStore(store) {
  try { localStorage.setItem(SELECTION_KEY, JSON.stringify(store)); } catch { /* storage unavailable */ }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("training-selection-change"));
}
