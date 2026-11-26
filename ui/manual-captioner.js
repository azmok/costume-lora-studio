import { THEME_KEY, parseTheme } from "./theme.mjs";
import {
  aggregateTags,
  appendCommonCaption,
  deleteTagInCaptions,
  deleteTargetText,
  findMatchingIndexes,
  insertAroundTarget,
  renameTagInCaptions,
  searchAndReplace,
  splitCaptionTags
} from "./manual-captioner-ops.mjs";

const byId = (id) => document.getElementById(id);
const native = window.__TAURI__;
const invoke = (cmd, args) => native ? native.core.invoke(cmd, args) : Promise.reject(new Error("Desktop app required for folder I/O"));
const toSlash = (v) => String(v ?? "").replaceAll("\\", "/");

// --- Live theme sync with main Costume LoRA Studio window ---
function loadTheme() {
  try { return parseTheme(localStorage.getItem(THEME_KEY)); } catch { return parseTheme(null); }
}
function applyTheme(next) {
  const theme = parseTheme(next);
  document.documentElement.dataset.style = theme.style;
  document.documentElement.dataset.mode = theme.mode;
  return theme;
}
function saveTheme(theme) {
  try { localStorage.setItem(THEME_KEY, JSON.stringify(parseTheme(theme))); } catch { /* ignore */ }
}
let currentTheme = loadTheme();
function syncThemeUI(theme) {
  currentTheme = applyTheme(theme);
  document.querySelectorAll("[data-theme-style]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.themeStyle === currentTheme.style));
  });
  document.querySelectorAll("[data-theme-mode]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.themeMode === currentTheme.mode));
  });
}
syncThemeUI(currentTheme);
document.querySelectorAll("[data-theme-style]").forEach((btn) => {
  btn.addEventListener("click", () => {
    syncThemeUI({ ...currentTheme, style: btn.dataset.themeStyle });
    saveTheme(currentTheme);
  });
});
document.querySelectorAll("[data-theme-mode]").forEach((btn) => {
  btn.addEventListener("click", () => {
    syncThemeUI({ ...currentTheme, mode: btn.dataset.themeMode });
    saveTheme(currentTheme);
  });
});
window.addEventListener("storage", (event) => {
  if (event.key === THEME_KEY) syncThemeUI(loadTheme());
});

// --- Toast & Confirm dialog ---
let toastTimer = 0;
function showToast(message, tone = "info") {
  const el = byId("mc-toast");
  el.textContent = String(message ?? "");
  el.className = "mc-toast " + tone;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function confirmAction(title, message) {
  const dialog = byId("mc-confirm-dialog");
  byId("mc-confirm-title").textContent = title;
  byId("mc-confirm-message").textContent = message;
  return new Promise((resolve) => {
    const finish = (ok) => {
      dialog.close();
      dialog.oncancel = null;
      resolve(ok);
    };
    byId("mc-confirm-cancel").onclick = () => finish(false);
    byId("mc-confirm-ok").onclick = () => finish(true);
    dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
    dialog.showModal();
  });
}

// --- Application state ---
// Each item: { id, relative, image, caption, source: "folder" | "drop", objectUrl? }
let items = [];
let loadedRoot = "";
let loadedCaptionDir = "";
let activeTag = "";
let currentMatches = [];
let currentMatchIndex = 0;
let tagCounts = new Map();
let sortedTags = [];
const thumbCache = new Map(); // image path -> data URL
const thumbQueue = [];
let thumbActive = 0;
let thumbGen = 0;

function readInitialProjectPaths() {
  try {
    const raw = JSON.parse(localStorage.getItem("costume-project") || "{}");
    return {
      root: toSlash(raw.raw_dir || raw.dataset_dir || ""),
      captionDir: toSlash(raw.caption_dir || "")
    };
  } catch {
    return { root: "", captionDir: "" };
  }
}

// --- Lazy thumbnail loader for folder mode ---
function pumpThumbs() {
  while (thumbActive < 3 && thumbQueue.length) {
    const job = thumbQueue.shift();
    if (job.gen !== thumbGen || thumbCache.has(job.item.image)) continue;
    thumbActive++;
    (async () => {
      try {
        const dataUrl = await invoke("preview_image", { path: job.item.image });
        if (job.gen === thumbGen) {
          thumbCache.set(job.item.image, dataUrl);
          applyThumb(job.item);
        }
      } catch {
        if (job.gen === thumbGen) thumbCache.set(job.item.image, "");
      } finally {
        thumbActive--;
        pumpThumbs();
      }
    })();
  }
}

function applyThumb(item) {
  const url = item.objectUrl || thumbCache.get(item.image);
  if (!url) return;
  const box = document.querySelector(`.mc-card[data-item-id="${CSS.escape(item.id)}"] .mc-image-box`);
  if (!box) return;
  let img = box.querySelector("img");
  if (!img) {
    img = document.createElement("img");
    img.alt = item.relative;
    box.replaceChildren(img);
  }
  if (img.src !== url) img.src = url;
}

const thumbObserver = new IntersectionObserver((records) => {
  for (const record of records) {
    if (!record.isIntersecting) continue;
    thumbObserver.unobserve(record.target);
    const id = record.target.dataset.itemId;
    const item = items.find((it) => it.id === id);
    if (!item || item.objectUrl || thumbCache.has(item.image)) continue;
    if (!thumbQueue.some((q) => q.item.id === item.id)) thumbQueue.push({ item, gen: thumbGen });
  }
  pumpThumbs();
}, { rootMargin: "240px" });

// --- Disk persistence ---
async function persistCaption(item, newCaption) {
  if (item.caption === newCaption) return false;
  item.caption = newCaption;
  if (item.source === "folder" && native && loadedRoot) {
    const outDir = loadedCaptionDir && loadedCaptionDir.toLowerCase() !== loadedRoot.toLowerCase() ? loadedCaptionDir : "";
    await invoke("save_manual_caption", {
      request: {
        root: loadedRoot,
        image: item.image,
        output_dir: outDir,
        content: newCaption
      }
    });
  }
  const stateEl = document.querySelector(`.mc-card[data-item-id="${CSS.escape(item.id)}"] .mc-card-state`);
  if (stateEl) {
    stateEl.textContent = item.source === "folder" ? "Saved" : "Edited";
    stateEl.classList.add("saved");
  }
  return true;
}

// --- Tag stats, progress & UI rendering ---
function recomputeTags() {
  const agg = aggregateTags(items);
  tagCounts = agg.counts;
  sortedTags = agg.sorted;
}

function updateProgress() {
  const total = items.length;
  const captioned = items.filter((item) => item.caption && item.caption.trim()).length;
  const pct = total > 0 ? (captioned / total) * 100 : 0;
  byId("mc-image-count").textContent = `${total} ${total === 1 ? "image" : "images"}`;
  byId("mc-captioned-count").textContent = `${captioned} captioned`;
  byId("mc-progress-fill").style.width = `${pct.toFixed(1)}%`;
  byId("mc-bulk-tools").hidden = total === 0;
  byId("mc-clear-btn").disabled = total === 0;
  byId("mc-reload-btn").disabled = !loadedRoot;
  byId("mc-mode-badge").textContent = loadedRoot ? "Folder mode · auto-save" : (total ? "Drop preview mode" : "Folder mode");
}

function renderCardTags(card, item, maxCount) {
  const container = card.querySelector(".mc-card-tags");
  container.replaceChildren();
  const uniqueTags = [...new Set(splitCaptionTags(item.caption))];
  for (const tag of uniqueTags) {
    const count = tagCounts.get(tag) || 0;
    const size = Math.round(16 + (count / maxCount) * 12);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mc-tag-chip";
    btn.textContent = tag;
    const bubble = document.createElement("span");
    bubble.className = "mc-tag-bubble";
    bubble.textContent = String(count);
    bubble.style.width = `${size}px`;
    bubble.style.height = `${size}px`;
    bubble.style.fontSize = `${Math.max(9, Math.round(size * 0.48))}px`;
    btn.append(bubble);
    btn.addEventListener("click", () => selectTag(tag));
    container.append(btn);
  }
}

function refreshAllCardTagChips() {
  const maxCount = Math.max(1, ...tagCounts.values());
  for (const item of items) {
    const card = document.querySelector(`.mc-card[data-item-id="${CSS.escape(item.id)}"]`);
    if (card) renderCardTags(card, item, maxCount);
  }
}

function renderGallery() {
  const gallery = byId("mc-gallery");
  const empty = byId("mc-empty");
  thumbObserver.disconnect();
  gallery.replaceChildren();
  if (!items.length) {
    gallery.hidden = true;
    empty.hidden = false;
    return;
  }
  gallery.hidden = false;
  empty.hidden = true;
  const maxCount = Math.max(1, ...tagCounts.values());

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "mc-card";
    card.dataset.itemId = item.id;

    const head = document.createElement("div");
    head.className = "mc-card-head";
    const nameEl = document.createElement("span");
    nameEl.className = "mc-card-name";
    nameEl.textContent = item.relative;
    nameEl.title = item.relative;
    const stateEl = document.createElement("span");
    stateEl.className = "mc-card-state";
    stateEl.textContent = item.source === "folder" ? "Synced" : "Local";
    head.append(nameEl, stateEl);

    const imgBox = document.createElement("div");
    imgBox.className = "mc-image-box";
    const cachedUrl = item.objectUrl || thumbCache.get(item.image);
    if (cachedUrl) {
      const img = document.createElement("img");
      img.src = cachedUrl;
      img.alt = item.relative;
      imgBox.append(img);
    } else {
      const ph = document.createElement("span");
      ph.className = "mc-thumb-placeholder";
      ph.textContent = "Loading preview…";
      imgBox.append(ph);
      thumbObserver.observe(card);
    }
    imgBox.addEventListener("click", () => openLightbox(item).catch((err) => showToast(err.message || String(err), "error")));

    const textarea = document.createElement("textarea");
    textarea.className = "mc-caption-area";
    textarea.placeholder = "Enter detailed caption for this image…";
    textarea.value = item.caption;
    textarea.setAttribute("aria-label", "Caption for " + item.relative);

    const tagsDiv = document.createElement("div");
    tagsDiv.className = "mc-card-tags";

    const actions = document.createElement("div");
    actions.className = "mc-card-actions";
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "mc-danger-btn compact";
    removeBtn.textContent = "Remove";
    removeBtn.title = "Remove this card from the current view (does not delete the image file from disk)";
    const charCount = document.createElement("span");
    charCount.className = "mc-char-count";
    charCount.textContent = `${item.caption.length} characters`;
    actions.append(removeBtn, charCount);

    textarea.addEventListener("input", () => {
      charCount.textContent = `${textarea.value.length} characters`;
    });
    textarea.addEventListener("blur", async () => {
      try {
        const changed = await persistCaption(item, textarea.value);
        if (changed) {
          recomputeTags();
          updateProgress();
          refreshAllCardTagChips();
          renderSidePanel();
        }
      } catch (err) {
        showToast(err.message || String(err), "error");
      }
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.ctrlKey) {
        event.preventDefault();
        textarea.blur();
      }
    });

    removeBtn.addEventListener("click", () => {
      items = items.filter((it) => it.id !== item.id);
      if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
      updateAll();
      showToast(`Removed "${item.relative}" from view.`, "info");
    });

    card.append(head, imgBox, textarea, tagsDiv, actions);
    renderCardTags(card, item, maxCount);
    gallery.append(card);
  }
}

function renderSidePanel() {
  const list = byId("mc-tag-list");
  const filter = byId("mc-tag-filter").value.trim().toLowerCase();
  list.replaceChildren();
  const visible = filter ? sortedTags.filter((t) => t.tag.toLowerCase().includes(filter)) : sortedTags;
  byId("mc-tag-total").textContent = `${sortedTags.length} ${sortedTags.length === 1 ? "tag" : "tags"}`;

  if (!visible.length) {
    const emptyLi = document.createElement("li");
    emptyLi.className = "muted";
    emptyLi.style.fontSize = "11px";
    emptyLi.textContent = items.length ? "No matching tags." : "Tags will appear here after loading images.";
    list.append(emptyLi);
    return;
  }

  for (const entry of visible) {
    const li = document.createElement("li");
    li.className = "mc-tag-item" + (entry.tag === activeTag ? " active" : "");
    li.dataset.tag = entry.tag;

    const label = document.createElement("span");
    label.className = "mc-tag-label";
    const textSpan = document.createElement("span");
    textSpan.textContent = entry.tag;
    const countSpan = document.createElement("span");
    countSpan.className = "mc-tag-count";
    countSpan.textContent = String(entry.count);
    label.append(textSpan, countSpan);

    const editInput = document.createElement("input");
    editInput.type = "text";
    editInput.className = "mc-tag-edit-input";
    editInput.hidden = true;

    const actions = document.createElement("div");
    actions.className = "mc-tag-actions";
    const modifyBtn = document.createElement("button");
    modifyBtn.type = "button";
    modifyBtn.className = "primary";
    modifyBtn.textContent = "Modify";
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "mc-danger-btn";
    deleteBtn.textContent = "Delete";
    actions.append(modifyBtn, deleteBtn);

    li.addEventListener("click", () => selectTag(entry.tag));

    modifyBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      label.hidden = true;
      actions.style.display = "none";
      editInput.hidden = false;
      editInput.value = entry.tag;
      editInput.focus();
      editInput.select();
    });

    editInput.addEventListener("click", (event) => event.stopPropagation());
    editInput.addEventListener("keydown", async (event) => {
      if (event.key === "Escape") {
        editInput.blur();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const nextTag = editInput.value.trim();
        editInput.hidden = true;
        label.hidden = false;
        actions.style.display = "";
        if (nextTag && nextTag !== entry.tag) {
          await applyBulkUpdates(renameTagInCaptions(items, entry.tag, nextTag), `Renamed "${entry.tag}" → "${nextTag}"`);
        }
      }
    });
    editInput.addEventListener("blur", () => {
      editInput.hidden = true;
      label.hidden = false;
      actions.style.display = "";
    });

    deleteBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const updates = deleteTagInCaptions(items, entry.tag);
      if (!updates.length) return;
      const ok = await confirmAction(
        "Delete tag from all captions",
        `Remove "${entry.tag}" from ${updates.length} ${updates.length === 1 ? "caption" : "captions"}? This saves immediately.`
      );
      if (!ok) return;
      await applyBulkUpdates(updates, `Deleted "${entry.tag}" from ${updates.length} ${updates.length === 1 ? "caption" : "captions"}.`);
    });

    li.append(label, editInput, actions);
    list.append(li);
  }
}

function updateAll() {
  recomputeTags();
  renderGallery();
  updateProgress();
  renderSidePanel();
}

// --- Tag selection & ▲/▼ match navigation ---
function selectTag(tag) {
  activeTag = tag;
  currentMatches = findMatchingIndexes(items, tag);
  if (!currentMatches.length) return;
  currentMatchIndex = 0;
  renderSidePanel();
  focusMatch(tag);
}

function focusMatch(tag) {
  document.querySelectorAll(".mc-card").forEach((card) => {
    card.classList.remove("highlighted");
    card.querySelector(".mc-nav-controls")?.remove();
  });
  const item = items[currentMatches[currentMatchIndex]];
  if (!item) return;
  const card = document.querySelector(`.mc-card[data-item-id="${CSS.escape(item.id)}"]`);
  if (!card) return;
  card.classList.add("highlighted");
  card.scrollIntoView({ behavior: "smooth", block: "center" });

  const textarea = card.querySelector(".mc-caption-area");
  textarea.focus();
  const idx = textarea.value.indexOf(tag);
  if (idx !== -1) textarea.setSelectionRange(idx, idx + tag.length);

  const nav = document.createElement("div");
  nav.className = "mc-nav-controls";
  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "primary";
  prevBtn.textContent = "▲";
  prevBtn.setAttribute("aria-label", "Previous match");
  const info = document.createElement("span");
  info.className = "mc-nav-info";
  info.textContent = `${currentMatchIndex + 1} / ${currentMatches.length}`;
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "primary";
  nextBtn.textContent = "▼";
  nextBtn.setAttribute("aria-label", "Next match");
  prevBtn.addEventListener("click", () => {
    currentMatchIndex = (currentMatchIndex - 1 + currentMatches.length) % currentMatches.length;
    focusMatch(tag);
  });
  nextBtn.addEventListener("click", () => {
    currentMatchIndex = (currentMatchIndex + 1) % currentMatches.length;
    focusMatch(tag);
  });
  nav.append(prevBtn, info, nextBtn);
  card.append(nav);
}

// --- Apply bulk updates to items + DOM + disk ---
async function applyBulkUpdates(updates, successMessage) {
  if (!updates.length) {
    showToast("No captions matched.", "info");
    return;
  }
  let saved = 0;
  const failed = [];
  for (const upd of updates) {
    const item = items[upd.index];
    if (!item) continue;
    try {
      await persistCaption(item, upd.caption);
      const card = document.querySelector(`.mc-card[data-item-id="${CSS.escape(item.id)}"]`);
      if (card) {
        const ta = card.querySelector(".mc-caption-area");
        if (ta) ta.value = upd.caption;
        const cc = card.querySelector(".mc-char-count");
        if (cc) cc.textContent = `${upd.caption.length} characters`;
      }
      saved++;
    } catch {
      failed.push(item.relative);
    }
  }
  recomputeTags();
  updateProgress();
  refreshAllCardTagChips();
  renderSidePanel();
  if (failed.length) {
    showToast(`Updated ${saved}, failed ${failed.length}: ${failed.slice(0, 3).join(", ")}`, "error");
  } else {
    showToast(successMessage, "success");
  }
}

// --- Lightbox ---
async function openLightbox(item) {
  const url = item.objectUrl || thumbCache.get(item.image) || await invoke("preview_image", { path: item.image });
  if (!item.objectUrl && url) thumbCache.set(item.image, url);
  byId("mc-lightbox-img").src = url;
  byId("mc-lightbox-name").textContent = item.relative;
  byId("mc-lightbox").hidden = false;
}

function closeLightbox() {
  byId("mc-lightbox").hidden = true;
  byId("mc-lightbox-img").src = "";
}

byId("mc-lightbox").addEventListener("click", (event) => {
  if (event.target === byId("mc-lightbox")) closeLightbox();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !byId("mc-lightbox").hidden) closeLightbox();
});

// --- Folder loading & Drag-and-drop ---
function revokeObjectUrls() {
  for (const item of items) {
    if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
  }
}

async function loadFolder(root, captionDir) {
  const cleanRoot = String(root ?? "").trim();
  if (!cleanRoot) {
    showToast("Choose a source images folder first.", "error");
    return;
  }
  try {
    const loaded = await invoke("load_caption_entries", { root: cleanRoot, captionDir: String(captionDir ?? "").trim() });
    revokeObjectUrls();
    thumbCache.clear();
    thumbQueue.length = 0;
    thumbGen++;
    loadedRoot = toSlash(cleanRoot);
    loadedCaptionDir = toSlash(String(captionDir ?? "").trim());
    activeTag = "";
    currentMatches = [];
    items = loaded.map((entry, idx) => ({
      id: `f-${idx}-${entry.relative}`,
      relative: entry.relative,
      image: entry.image,
      caption: entry.caption ?? "",
      source: "folder"
    }));
    updateAll();
    showToast(`Loaded ${items.length} ${items.length === 1 ? "image" : "images"} from folder.`, "success");
  } catch (err) {
    showToast(err.message || String(err), "error");
  }
}

async function handleDroppedFiles(fileList) {
  const all = [...fileList];
  const imgFiles = all.filter((f) => f.type.startsWith("image/"));
  const txtFiles = all.filter((f) => f.name.toLowerCase().endsWith(".txt"));
  if (!imgFiles.length) {
    showToast("No image files found in selection.", "error");
    return;
  }
  const capMap = new Map();
  await Promise.all(txtFiles.map(async (f) => {
    const base = f.name.replace(/\.txt$/i, "").toLowerCase();
    capMap.set(base, (await f.text()).trim());
  }));
  revokeObjectUrls();
  loadedRoot = "";
  loadedCaptionDir = "";
  activeTag = "";
  currentMatches = [];
  items = imgFiles
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((file, idx) => {
      const base = file.name.replace(/\.[^.]+$/, "").toLowerCase();
      return {
        id: `d-${idx}-${file.name}`,
        relative: file.name,
        image: file.name,
        caption: capMap.get(base) || "",
        source: "drop",
        objectUrl: URL.createObjectURL(file)
      };
    });
  updateAll();
  showToast(`Loaded ${items.length} dropped ${items.length === 1 ? "image" : "images"} (preview mode).`, "success");
}

// --- Event wiring ---
byId("mc-browse-root").addEventListener("click", async () => {
  try {
    const picked = await invoke("choose_path", { directory: true });
    if (picked) {
      byId("mc-root").value = toSlash(picked);
      await loadFolder(byId("mc-root").value, byId("mc-caption-dir").value);
    }
  } catch (err) { showToast(err.message || String(err), "error"); }
});
byId("mc-browse-caption").addEventListener("click", async () => {
  try {
    const picked = await invoke("choose_path", { directory: true });
    if (picked) byId("mc-caption-dir").value = toSlash(picked);
  } catch (err) { showToast(err.message || String(err), "error"); }
});
byId("mc-load-btn").addEventListener("click", () => loadFolder(byId("mc-root").value, byId("mc-caption-dir").value));
byId("mc-reload-btn").addEventListener("click", () => loadFolder(loadedRoot || byId("mc-root").value, loadedCaptionDir));
byId("mc-clear-btn").addEventListener("click", async () => {
  if (!items.length) return;
  const ok = await confirmAction("Clear gallery view", "Clear all cards from this view? Saved files on disk are NOT deleted.");
  if (!ok) return;
  revokeObjectUrls();
  items = [];
  activeTag = "";
  currentMatches = [];
  updateAll();
  showToast("Cleared gallery view.", "info");
});

const uploadArea = byId("mc-upload-area");
const fileInput = byId("mc-file-input");
uploadArea.addEventListener("click", () => fileInput.click());
uploadArea.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener("change", () => { if (fileInput.files?.length) handleDroppedFiles(fileInput.files); fileInput.value = ""; });
uploadArea.addEventListener("dragover", (e) => { e.preventDefault(); uploadArea.classList.add("dragover"); });
uploadArea.addEventListener("dragleave", () => uploadArea.classList.remove("dragover"));
uploadArea.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadArea.classList.remove("dragover");
  if (e.dataTransfer?.files?.length) handleDroppedFiles(e.dataTransfer.files);
});

byId("mc-tag-filter").addEventListener("input", () => renderSidePanel());

// Bulk Tool 1: Search and Replace
byId("mc-sr-btn").addEventListener("click", async () => {
  try {
    const search = byId("mc-sr-search").value;
    const replace = byId("mc-sr-replace").value;
    const useRegex = byId("mc-sr-regex").checked;
    const caseSensitive = byId("mc-sr-case").checked;
    const { updates, totalReplacements } = searchAndReplace(items, { search, replace, useRegex, caseSensitive });
    if (!updates.length) { showToast("No captions found containing the search text.", "info"); return; }
    const ok = await confirmAction(
      "Search and Replace",
      `Replace "${search.slice(0, 50)}" with "${replace.slice(0, 50)}" (${totalReplacements} matches across ${updates.length} ${updates.length === 1 ? "caption" : "captions"})?`
    );
    if (!ok) return;
    await applyBulkUpdates(updates, `Replaced ${totalReplacements} occurrence${totalReplacements === 1 ? "" : "s"} in ${updates.length} caption${updates.length === 1 ? "" : "s"}.`);
    byId("mc-sr-search").value = "";
    byId("mc-sr-replace").value = "";
  } catch (err) { showToast(err.message || String(err), "error"); }
});

// Bulk Tool 2: Add Common Caption
byId("mc-bulk-common-btn").addEventListener("click", async () => {
  try {
    const text = byId("mc-bulk-common").value;
    const updates = appendCommonCaption(items, text);
    if (!updates.length) { showToast("No images to update.", "info"); return; }
    const ok = await confirmAction(
      "Add Common Caption",
      `Append "${text.trim().slice(0, 60)}" to all ${updates.length} captions?`
    );
    if (!ok) return;
    await applyBulkUpdates(updates, `Appended caption to ${updates.length} ${updates.length === 1 ? "image" : "images"}.`);
    byId("mc-bulk-common").value = "";
  } catch (err) { showToast(err.message || String(err), "error"); }
});

// Bulk Tool 3: Append / Prepend Text
byId("mc-ap-btn").addEventListener("click", async () => {
  try {
    const target = byId("mc-ap-target").value;
    const insertion = byId("mc-ap-new").value;
    const useRegex = byId("mc-ap-regex").checked;
    const position = byId("mc-ap-append").checked ? "append" : "prepend";
    const updates = insertAroundTarget(items, { target, insertion, useRegex, position });
    if (!updates.length) { showToast("No captions matched the target text/pattern.", "info"); return; }
    const ok = await confirmAction(
      "Append / Prepend Text",
      `${position === "append" ? "Append" : "Prepend"} "${insertion.trim()}" around "${target}" in ${updates.length} ${updates.length === 1 ? "caption" : "captions"}?`
    );
    if (!ok) return;
    await applyBulkUpdates(updates, `Modified ${updates.length} ${updates.length === 1 ? "caption" : "captions"}.`);
  } catch (err) { showToast(err.message || String(err), "error"); }
});

// Bulk Tool 4: Delete Text
byId("mc-del-btn").addEventListener("click", async () => {
  try {
    const target = byId("mc-del-target").value;
    const useRegex = byId("mc-del-regex").checked;
    const updates = deleteTargetText(items, { target, useRegex });
    if (!updates.length) { showToast("No captions matched the target text/pattern.", "info"); return; }
    const ok = await confirmAction(
      "Delete Text",
      `Delete "${target}" from ${updates.length} ${updates.length === 1 ? "caption" : "captions"}?`
    );
    if (!ok) return;
    await applyBulkUpdates(updates, `Deleted target text from ${updates.length} ${updates.length === 1 ? "caption" : "captions"}.`);
    byId("mc-del-target").value = "";
  } catch (err) { showToast(err.message || String(err), "error"); }
});

// --- Resizable right side panel (drag handle + double-click reset) ---
{
  const panel = byId("mc-side-panel");
  const handle = byId("mc-side-handle");
  const WIDTH_KEY = "costume-mc-side-width";
  const clampWidth = (w) => Math.max(240, Math.min(560, Math.round(w)));
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= 240) panel.style.width = clampWidth(saved) + "px";
  } catch { /* ignore */ }
  let dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true;
    handle.classList.add("dragging");
    document.body.style.userSelect = "none";
  });
  window.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const next = clampWidth(panel.getBoundingClientRect().right - e.clientX);
    panel.style.width = next + "px";
  });
  window.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.userSelect = "";
    try { localStorage.setItem(WIDTH_KEY, String(Math.round(panel.getBoundingClientRect().width))); } catch { /* ignore */ }
  });
  handle.addEventListener("dblclick", () => {
    panel.style.width = "";
    try { localStorage.removeItem(WIDTH_KEY); } catch { /* ignore */ }
  });
}

// --- Auto-fill & auto-load active project folder on startup ---
{
  const init = readInitialProjectPaths();
  byId("mc-root").value = init.root;
  byId("mc-caption-dir").value = init.captionDir;
  updateProgress();
  renderSidePanel();
  if (native && init.root) {
    loadFolder(init.root, init.captionDir);
  }
}
