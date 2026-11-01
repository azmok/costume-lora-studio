// Named projects with autosave. A project is a snapshot of the form state (paths, parameters, tool settings).
export const PROJECTS_KEY = "costume-projects";
export const MAX_PROJECTS = 100;
const MAX_BYTES = 400_000;

const makeId = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export function cleanProjectName(name) {
  const value = String(name ?? "").trim().replace(/\s+/g, " ");
  if (value.length > 60) throw new Error("Project name must be 60 characters or fewer");
  return value;
}

export function uniqueName(projects, base) {
  const root = cleanProjectName(base) || "Project";
  const taken = new Set(projects.map((project) => project.name.toLowerCase()));
  if (!taken.has(root.toLowerCase())) return root;
  for (let number = 2; ; number++) {
    const candidate = root + " " + number;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function cleanData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const text = JSON.stringify(data);
  if (text.length > MAX_BYTES) throw new Error("Project data is too large");
  return JSON.parse(text);
}

export function readStore(raw) {
  let data;
  try { data = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
  if (data?.version !== 1 || !Array.isArray(data.projects)) return null;
  const projects = [];
  for (const item of data.projects) {
    if (!item || typeof item.id !== "string" || typeof item.name !== "string" || projects.some((p) => p.id === item.id)) continue;
    try {
      projects.push({
        id: item.id, name: cleanProjectName(item.name) || "Project",
        createdAt: Number(item.createdAt) || 0, updatedAt: Number(item.updatedAt) || 0, data: cleanData(item.data)
      });
    } catch { /* skip a corrupted project */ }
  }
  if (!projects.length) return null;
  const activeId = projects.some((project) => project.id === data.activeId) ? data.activeId : projects[0].id;
  return { version: 1, activeId, projects };
}

export function createProject(store, name, data = {}, now = Date.now()) {
  if (store.projects.length >= MAX_PROJECTS) throw new Error("Too many projects");
  const project = { id: makeId(), name: uniqueName(store.projects, name), createdAt: now, updatedAt: now, data: cleanData(data) };
  return { store: { ...store, activeId: project.id, projects: [...store.projects, project] }, project };
}

export function newStore(name, data = {}, now = Date.now()) {
  return createProject({ version: 1, activeId: "", projects: [] }, name, data, now).store;
}

export function updateProjectData(store, id, data, now = Date.now()) {
  return { ...store, projects: store.projects.map((project) => (project.id === id ? { ...project, data: cleanData(data), updatedAt: now } : project)) };
}

export function renameProject(store, id, name) {
  const others = store.projects.filter((project) => project.id !== id);
  const clean = cleanProjectName(name);
  if (!clean) throw new Error("Enter a project name");
  if (others.some((project) => project.name.toLowerCase() === clean.toLowerCase())) throw new Error("A project with that name already exists");
  return { ...store, projects: store.projects.map((project) => (project.id === id ? { ...project, name: clean } : project)) };
}

export function deleteProject(store, id) {
  if (store.projects.length <= 1) throw new Error("The last project cannot be deleted");
  const projects = store.projects.filter((project) => project.id !== id);
  return { ...store, projects, activeId: store.activeId === id ? projects[0].id : store.activeId };
}

export function setActive(store, id) {
  if (!store.projects.some((project) => project.id === id)) throw new Error("Project not found");
  return { ...store, activeId: id };
}
