// Unsaved mask / caption edits are kept as "drafts" so work survives image switches,
// app restarts and crashes. Backed by IndexedDB (webview profile); falls back to memory.
const DB_NAME = "costume-lora-tools";
const STORE = "drafts";

const keyOf = (root, relative) => root + "\n" + relative;

function memoryStore() {
  const map = new Map();
  return {
    async put(draft) { map.set(keyOf(draft.root, draft.relative), structuredClone(draft)); },
    async get(root, relative) { return structuredClone(map.get(keyOf(root, relative))) ?? null; },
    async remove(root, relative) { map.delete(keyOf(root, relative)); },
    async listByRoot(root) { return [...map.values()].filter((draft) => draft.root === root).map((draft) => structuredClone(draft)); }
  };
}

// Draft shape: { root, relative, mask: PNG data URL | null, caption: string | null, guidance: [] }
// mask / caption are null when that part is unchanged.
export function createDraftStore(factory = globalThis.indexedDB) {
  const memory = memoryStore();
  if (!factory) return memory;
  let opening;
  const open = () => opening ??= new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = async (mode, make) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = make(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  };
  const guarded = async (action, fallback) => {
    try { return await action(); } catch { return fallback(); }
  };
  return {
    put: (draft) => guarded(() => run("readwrite", (store) => store.put({ ...draft, key: keyOf(draft.root, draft.relative), updatedAt: Date.now() })), () => memory.put(draft)),
    get: (root, relative) => guarded(async () => (await run("readonly", (store) => store.get(keyOf(root, relative)))) ?? null, () => memory.get(root, relative)),
    remove: (root, relative) => guarded(() => run("readwrite", (store) => store.delete(keyOf(root, relative))), () => memory.remove(root, relative)),
    listByRoot: (root) => guarded(async () => (await run("readonly", (store) => store.getAll())).filter((draft) => draft.root === root), () => memory.listByRoot(root))
  };
}
