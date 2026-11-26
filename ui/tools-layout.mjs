const STORAGE_KEY = "costume-tools-panel-widths";
const HEIGHT_KEY = "costume-tools-list-height";
const MIN_HEIGHT = 72;
const MAX_HEIGHT = 2200;
const DEFAULT = { left: 190, right: 310 };
const MIN = { left: 160, center: 270, right: 260 };
const DIVIDER = 16;

function preferredWidth(value, side) {
  return Number.isFinite(value) ? Math.max(MIN[side], Math.round(value)) : DEFAULT[side];
}

export function fitToolsPanels(width, preferred) {
  const sideBudget = Math.floor(width) - MIN.center - DIVIDER;
  if (sideBudget < MIN.left) return { columns: 1 };

  const leftExtra = Math.min(width, preferredWidth(preferred?.left, "left")) - MIN.left;
  const rightExtra = Math.min(width, preferredWidth(preferred?.right, "right")) - MIN.right;
  const spare = sideBudget - DIVIDER - MIN.left - MIN.right;
  if (spare < 0) {
    return { columns: 2, left: MIN.left + Math.min(leftExtra, sideBudget - MIN.left), right: 0, sideBudget };
  }
  const scale = leftExtra + rightExtra > spare ? spare / (leftExtra + rightExtra) : 1;
  const leftShare = Math.round(leftExtra * scale);
  return {
    columns: 3, sideBudget: sideBudget - DIVIDER,
    left: MIN.left + leftShare,
    right: MIN.right + Math.min(rightExtra, spare - leftShare),
  };
}

export function initToolsLayout(workspace) {
  const handles = [...workspace.querySelectorAll("[data-resize-side]")];
  const heightHandle = workspace.querySelector("#tools-list-resizer");
  const list = workspace.querySelector("#tools-files");
  let preferred = DEFAULT;
  let savedHeight = null;
  try {
    const storedHeight = Number(localStorage.getItem(HEIGHT_KEY));
    if (Number.isFinite(storedHeight) && storedHeight > 0) savedHeight = storedHeight;
    preferred = JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? DEFAULT;
  } catch { /* use defaults */ }
  let width = 0;
  let layout = { columns: 1 };
  let drag = null;

  const maxFor = (side) => layout.sideBudget - layout[side === "left" ? "right" : "left"];
  const minValue = (side) => side === "height" ? MIN_HEIGHT : MIN[side];
  const maxValue = (side) => side === "height" ? MAX_HEIGHT : maxFor(side);
  const valueOf = (side) => side === "height" ? list.offsetHeight : layout[side];
  const clamp = (side, value) => Math.max(minValue(side), Math.min(maxValue(side), Math.round(value)));
  let listHeight;

  function setListHeight(value) {
    listHeight = value === null ? null : clamp("height", value);
    if (listHeight === null) list.style.removeProperty("--tools-list-height");
    else list.style.setProperty("--tools-list-height", listHeight + "px");
  }

  setListHeight(savedHeight);
  savedHeight = listHeight;
  heightHandle.setAttribute("aria-valuemin", MIN_HEIGHT);
  heightHandle.setAttribute("aria-valuemax", MAX_HEIGHT);
  new ResizeObserver(() => {
    const pixels = list.offsetHeight;
    if (!pixels) return;
    heightHandle.setAttribute("aria-valuenow", pixels);
    heightHandle.setAttribute("aria-valuetext", pixels + " pixels");
  }).observe(list);

  function render(next) {
    layout = next;
    workspace.dataset.columns = String(layout.columns);
    for (const handle of handles) {
      const side = handle.dataset.resizeSide;
      handle.hidden = layout.columns < (side === "left" ? 2 : 3);
      if (handle.hidden) continue;
      workspace.style.setProperty("--tools-" + side, layout[side] + "px");
      handle.setAttribute("aria-valuemin", MIN[side]);
      handle.setAttribute("aria-valuemax", maxFor(side));
      handle.setAttribute("aria-valuenow", layout[side]);
      handle.setAttribute("aria-valuetext", layout[side] + " pixels");
    }
  }

  function remember(side) {
    if (side === "height") {
      savedHeight = listHeight;
      try {
        if (savedHeight === null) localStorage.removeItem(HEIGHT_KEY);
        else localStorage.setItem(HEIGHT_KEY, String(savedHeight));
      } catch { /* storage unavailable */ }
      return;
    }
    preferred = {
      left: layout.left,
      right: layout.columns === 3 ? layout.right : preferredWidth(preferred?.right, "right"),
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferred)); } catch { /* storage unavailable */ }
  }

  function resize(side, value) {
    const pixels = clamp(side, value);
    if (valueOf(side) === pixels) return;
    if (side === "height") setListHeight(pixels);
    else render({ ...layout, [side]: pixels });
  }

  function finishDrag(save) {
    if (!drag) return;
    const { handle, pointerId, side, startValue, cursorClass } = drag;
    drag = null;
    handle.classList.remove("dragging");
    document.body.classList.remove(cursorClass);
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    if (save && valueOf(side) !== startValue) remember(side);
    else if (side === "height") setListHeight(savedHeight);
    else if (!save) render(fitToolsPanels(width, preferred));
  }

  for (const handle of [...handles, heightHandle]) {
    const side = handle.dataset.resizeSide ?? "height";
    const vertical = side === "height";
    const direction = side === "right" ? -1 : 1;
    const cursorClass = vertical ? "resizing-list" : "resizing-panels";
    const coordinate = (event) => vertical ? event.pageY : event.clientX;
    handle.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0 || drag) return;
      event.preventDefault();
      handle.focus({ preventScroll: true });
      handle.setPointerCapture(event.pointerId);
      const scale = workspace.getBoundingClientRect().width / workspace.offsetWidth;
      drag = { handle, side, pointerId: event.pointerId, start: coordinate(event), startValue: valueOf(side), scale, cursorClass };
      handle.classList.add("dragging");
      document.body.classList.add(cursorClass);
    });
    const controlsDrag = (event) => drag?.handle === handle && drag.pointerId === event.pointerId;
    handle.addEventListener("pointermove", (event) => {
      if (controlsDrag(event)) resize(side, drag.startValue + direction * (coordinate(event) - drag.start) / drag.scale);
    });
    handle.addEventListener("pointerup", (event) => { if (controlsDrag(event)) finishDrag(true); });
    handle.addEventListener("pointercancel", (event) => { if (controlsDrag(event)) finishDrag(false); });
    handle.addEventListener("lostpointercapture", (event) => { if (controlsDrag(event)) finishDrag(false); });
    handle.addEventListener("dblclick", () => {
      if (vertical) setListHeight(null);
      else resize(side, DEFAULT[side]);
      remember(side);
    });
    handle.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && drag) finishDrag(false);
      else {
        if (drag || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === (vertical ? "ArrowUp" : "ArrowLeft")) resize(side, valueOf(side) - direction * 24);
        else if (event.key === (vertical ? "ArrowDown" : "ArrowRight")) resize(side, valueOf(side) + direction * 24);
        else if (event.key === "Home") resize(side, minValue(side));
        else if (event.key === "End") resize(side, maxValue(side));
        else return;
        remember(side);
      }
      event.preventDefault();
    });
  }

  const observer = new ResizeObserver(() => {
    const nextWidth = workspace.clientWidth;
    if (!nextWidth || nextWidth === width) return;
    width = nextWidth;
    const shouldFit = !drag || drag.side === "height";
    finishDrag(false);
    if (shouldFit) render(fitToolsPanels(width, preferred));
  });
  observer.observe(workspace);
}
