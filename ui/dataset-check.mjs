// Dataset health checks for LoRA training: pure helpers (the DOM / file loading lives in tools.js).
import { splitTags } from "./tools-captions.mjs";

export const THRESHOLDS = { minShortSide: 512, minCoverage: 0.02, maxCoverage: 0.9, blurVariance: 40, minCaptionTags: 3 };

export const ISSUE_LABELS = {
  "no-caption": "No caption",
  "no-trigger": "Trigger word is not first",
  "duplicate-tags": "Duplicate tags in caption",
  "short-caption": "Very short caption",
  "no-mask": "No mask",
  "mask-small": "Mask is almost empty",
  "mask-large": "Mask covers almost everything",
  "low-resolution": "Low resolution",
  "blurry": "Possibly blurry"
};

export function toGray(rgba, width, height) {
  const gray = new Float32Array(width * height);
  for (let index = 0; index < gray.length; index++) {
    gray[index] = 0.299 * rgba[index * 4] + 0.587 * rgba[index * 4 + 1] + 0.114 * rgba[index * 4 + 2];
  }
  return gray;
}

// Variance of the 4-neighbour Laplacian: low values mean few sharp edges (blur).
export function laplacianVariance(gray, width, height) {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const at = y * width + x;
      const value = gray[at - 1] + gray[at + 1] + gray[at - width] + gray[at + width] - 4 * gray[at];
      sum += value;
      sumSquares += value * value;
      count++;
    }
  }
  const mean = sum / count;
  return sumSquares / count - mean * mean;
}

export function analyzeCaption(caption, trigger) {
  const tokens = String(caption ?? "").split(/[,、，\n]/).map((part) => part.trim().replace(/\s+/g, " ")).filter(Boolean);
  const head = String(trigger ?? "").trim().toLowerCase();
  const seen = new Set();
  const duplicates = [];
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (seen.has(key) && !duplicates.includes(token)) duplicates.push(token);
    seen.add(key);
  }
  return {
    empty: tokens.length === 0,
    count: tokens.length,
    duplicates,
    missingTrigger: Boolean(head) && tokens.length > 0 && tokens[0].toLowerCase() !== head
  };
}

// info: { width, height, hasMask, coverage|null, blur|null, caption|null }
export function classify(info, trigger, limits = THRESHOLDS) {
  const issues = [];
  const caption = analyzeCaption(info.caption, trigger);
  if (info.caption === null || info.caption === undefined || caption.empty) issues.push("no-caption");
  else {
    if (caption.missingTrigger) issues.push("no-trigger");
    if (caption.duplicates.length) issues.push("duplicate-tags");
    if (caption.count < limits.minCaptionTags) issues.push("short-caption");
  }
  if (!info.hasMask) issues.push("no-mask");
  else if (typeof info.coverage === "number") {
    if (info.coverage < limits.minCoverage) issues.push("mask-small");
    if (info.coverage > limits.maxCoverage) issues.push("mask-large");
  }
  if (Math.min(info.width, info.height) < limits.minShortSide) issues.push("low-resolution");
  if (typeof info.blur === "number" && info.blur < limits.blurVariance) issues.push("blurry");
  return issues;
}

export function tagFrequency(captions, trigger, limit = 60) {
  const head = String(trigger ?? "").trim().toLowerCase();
  const counts = new Map();
  for (const caption of captions) {
    for (const tag of splitTags(caption)) {
      if (tag.toLowerCase() === head) continue;
      const key = tag.toLowerCase();
      counts.set(key, { tag, count: (counts.get(key)?.count ?? 0) + 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).slice(0, limit);
}
