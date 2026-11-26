// Per-folder Caption (C) and Mask (M) locks for Tools.
// Locked items are skipped/blocked by AI auto-generation and batch overwrites,
// while manual editing and saving stay allowed.
import { rootKey } from "./training-selection.mjs";

export const TOOLS_LOCKS_KEY = "costume-tools-locks";

const MAX_ENTRIES = 200000;

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== "string" || !item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

// { "<root key>": { caption: ["a.png", ...], mask: ["b.png", ...] } }
export function parseLockStore(raw) {
  let data;
  try { data = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return {}; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const store = {};
  for (const [key, value] of Object.entries(data)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    store[key] = {
      caption: cleanList(value.caption),
      mask: cleanList(value.mask)
    };
  }
  return store;
}

export function getLocks(store, root) {
  const key = rootKey(root);
  const record = key && store && typeof store === "object" ? store[key] : null;
  return {
    caption: cleanList(record?.caption),
    mask: cleanList(record?.mask)
  };
}

export function setLocksForRoot(store, root, locks) {
  const key = rootKey(root);
  if (!key) return store ?? {};
  return {
    ...(store ?? {}),
    [key]: {
      caption: cleanList(locks?.caption),
      mask: cleanList(locks?.mask)
    }
  };
}

export function setLock(store, root, kind, relative, locked) {
  if (kind !== "caption" && kind !== "mask") throw new Error("Unknown lock kind: " + kind);
  const key = rootKey(root);
  if (!key || typeof relative !== "string" || !relative) return store ?? {};
  const current = getLocks(store, root);
  const nextSet = new Set(current[kind]);
  if (locked) nextSet.add(relative);
  else nextSet.delete(relative);
  return setLocksForRoot(store, root, { ...current, [kind]: [...nextSet] });
}

export function filterUnlocked(entries, lockedSet) {
  const unlocked = [];
  const locked = [];
  const has = lockedSet && typeof lockedSet.has === "function" ? (rel) => lockedSet.has(rel) : () => false;
  for (const entry of entries ?? []) {
    if (!entry) continue;
    if (has(entry.relative)) locked.push(entry);
    else unlocked.push(entry);
  }
  return { unlocked, locked, lockedCount: locked.length };
}

export function loadLockStore() {
  try { return parseLockStore(localStorage.getItem(TOOLS_LOCKS_KEY)); } catch { return {}; }
}

export function saveLockStore(store) {
  try { localStorage.setItem(TOOLS_LOCKS_KEY, JSON.stringify(store)); } catch { /* storage unavailable */ }
}
