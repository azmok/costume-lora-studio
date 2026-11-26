// Pure caption/tag operations for Manual Captioner (zero DOM dependencies).

export function splitCaptionTags(caption) {
  return String(caption ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function cleanCommaArtifacts(text) {
  return String(text ?? "")
    .replace(/\s*,\s*(?:,\s*)+/g, ", ")
    .replace(/^\s*,+\s*|\s*,+\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function escapeRegExp(text) {
  return String(text ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns sorted array of { tag, count } (count descending, then alphabetical) plus Map.
export function aggregateTags(items) {
  const counts = new Map();
  for (const item of items ?? []) {
    if (!item || typeof item.caption !== "string" || !item.caption.trim()) continue;
    const seenInImage = new Set();
    for (const tag of splitCaptionTags(item.caption)) {
      if (tag.length <= 1 || seenInImage.has(tag)) continue;
      seenInImage.add(tag);
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag));
  return { counts, sorted };
}

export function findMatchingIndexes(items, tag) {
  const target = String(tag ?? "").trim();
  if (!target) return [];
  const matches = [];
  (items ?? []).forEach((item, index) => {
    if (item && splitCaptionTags(item.caption).includes(target)) matches.push(index);
  });
  return matches;
}

// Rename every occurrence of oldTag -> newTag across all captions.
// Returns [{ index, caption }] for changed items only.
export function renameTagInCaptions(items, oldTag, newTag) {
  const from = String(oldTag ?? "").trim();
  const to = String(newTag ?? "").trim();
  if (!from || !to || from === to) return [];
  const updates = [];
  (items ?? []).forEach((item, index) => {
    if (!item) return;
    const tags = splitCaptionTags(item.caption);
    let changed = false;
    const next = tags.map((tag) => {
      if (tag === from) { changed = true; return to; }
      return tag;
    });
    if (changed) updates.push({ index, caption: next.join(", ") });
  });
  return updates;
}

// Delete every occurrence of tagToDelete across all captions.
export function deleteTagInCaptions(items, tagToDelete) {
  const target = String(tagToDelete ?? "").trim();
  if (!target) return [];
  const updates = [];
  (items ?? []).forEach((item, index) => {
    if (!item) return;
    const tags = splitCaptionTags(item.caption);
    const next = tags.filter((tag) => tag !== target);
    if (next.length !== tags.length) updates.push({ index, caption: next.join(", ") });
  });
  return updates;
}

// Append common caption text to the end of every caption with clean comma separator.
export function appendCommonCaption(items, commonText) {
  const addition = String(commonText ?? "").trim();
  if (!addition) throw new Error("Enter a caption to append.");
  const updates = [];
  (items ?? []).forEach((item, index) => {
    if (!item) return;
    const existing = String(item.caption ?? "").trim();
    const separator = !existing ? "" : existing.endsWith(",") ? " " : ", ";
    const caption = existing + separator + addition;
    if (caption !== item.caption) updates.push({ index, caption });
  });
  return updates;
}

// Insert newTag right before (prepend) or after (append) the first match of target.
export function insertAroundTarget(items, { target, insertion, useRegex = false, position = "prepend" } = {}) {
  const rawTarget = String(target ?? "");
  const newTag = String(insertion ?? "").trim();
  if (!rawTarget || !newTag) throw new Error('Both "Target text" and "New tag" are required.');
  let regex = null;
  if (useRegex) {
    try { regex = new RegExp(rawTarget, "i"); }
    catch (err) { throw new Error("Invalid regular expression: " + err.message); }
  }
  const updates = [];
  (items ?? []).forEach((item, index) => {
    if (!item || typeof item.caption !== "string") return;
    const current = item.caption;
    let foundIndex = -1;
    let foundLen = 0;
    if (useRegex) {
      const match = current.match(regex);
      if (match && typeof match.index === "number") {
        foundIndex = match.index;
        foundLen = match[0].length;
      }
    } else {
      foundIndex = current.indexOf(rawTarget);
      foundLen = rawTarget.length;
    }
    if (foundIndex === -1) return;
    const caption = position === "append"
      ? current.slice(0, foundIndex + foundLen) + " " + newTag + current.slice(foundIndex + foundLen)
      : current.slice(0, foundIndex) + newTag + " " + current.slice(foundIndex);
    if (caption !== current) updates.push({ index, caption });
  });
  return updates;
}

// Delete target text (word-boundary case-insensitive when text mode, or global case-insensitive regex).
export function deleteTargetText(items, { target, useRegex = false } = {}) {
  const rawTarget = String(target ?? "");
  if (!rawTarget) throw new Error("Target text is required to delete.");
  let regex;
  try {
    regex = useRegex
      ? new RegExp(rawTarget, "gi")
      : new RegExp("\\b" + escapeRegExp(rawTarget) + "\\b", "gi");
  } catch (err) {
    throw new Error("Invalid regular expression: " + err.message);
  }
  const updates = [];
  (items ?? []).forEach((item, index) => {
    if (!item || typeof item.caption !== "string" || !item.caption) return;
    const current = item.caption;
    regex.lastIndex = 0;
    if (!regex.test(current)) return;
    regex.lastIndex = 0;
    const caption = cleanCommaArtifacts(current.replace(regex, ""));
    if (caption !== current) updates.push({ index, caption });
  });
  return updates;
}

// Search and replace across all captions. Returns { updates: [{ index, caption }], totalReplacements }.
export function searchAndReplace(items, { search, replace = "", useRegex = false, caseSensitive = false } = {}) {
  const rawSearch = String(search ?? "");
  const replaceText = String(replace ?? "");
  if (!rawSearch) throw new Error("Search text is required.");
  const flags = caseSensitive ? "g" : "gi";
  let pattern;
  try {
    pattern = new RegExp(useRegex ? rawSearch : escapeRegExp(rawSearch), flags);
  } catch (err) {
    throw new Error("Invalid regular expression: " + err.message);
  }
  const updates = [];
  let totalReplacements = 0;
  (items ?? []).forEach((item, index) => {
    if (!item || typeof item.caption !== "string" || !item.caption) return;
    const original = item.caption;
    pattern.lastIndex = 0;
    const matches = original.match(pattern);
    if (!matches || !matches.length) return;
    pattern.lastIndex = 0;
    const caption = original.replace(pattern, replaceText);
    if (caption !== original) {
      totalReplacements += matches.length;
      updates.push({ index, caption });
    }
  });
  return { updates, totalReplacements };
}
