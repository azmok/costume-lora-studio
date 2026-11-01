// Zoom / pan for a <canvas> inside a scrolling container.
// "fit" lets CSS size the canvas; any other zoom is CSS px per canvas px.
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 32; // 3200%, like Photoshop: single pixels become 32 px squares
export const PIXEL_ZOOM = 3; // from here on pixels are drawn crisp instead of smoothed

export const clampZoom = (value, min = ZOOM_MIN, max = ZOOM_MAX) => Math.max(min, Math.min(max, value));
export const wheelFactor = (deltaY) => Math.exp(-Math.max(-100, Math.min(100, deltaY)) * 0.002);

export function createImageZoom({ canvas, scroller, onChange = () => {}, min = ZOOM_MIN, max = ZOOM_MAX }) {
  let zoom = "fit";
  const hasImage = () => !canvas.hidden && canvas.width > 0 && canvas.height > 0;
  const hovered = () => scroller.matches(":hover") && hasImage();

  function displayedScale() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return 1;
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    return zoom === "fit" && getComputedStyle(canvas).objectFit === "scale-down" ? Math.min(scale, 1) : scale;
  }
  // Rectangle of the picture itself (the canvas box can be larger when letterboxed in fit mode).
  function contentRect() {
    const rect = canvas.getBoundingClientRect();
    if (zoom !== "fit") return rect;
    const scale = displayedScale();
    const width = canvas.width * scale;
    const height = canvas.height * scale;
    return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height };
  }
  function applySize() {
    canvas.classList.toggle("zoomed", zoom !== "fit");
    canvas.classList.toggle("pixelated", zoom !== "fit" && zoom >= PIXEL_ZOOM);
    canvas.style.width = zoom === "fit" ? "" : Math.round(canvas.width * zoom) + "px";
    canvas.style.height = zoom === "fit" ? "" : Math.round(canvas.height * zoom) + "px";
  }
  function set(next, anchor) {
    if (!hasImage()) return;
    if (next !== "fit") next = clampZoom(next, min, max);
    const frame = scroller.getBoundingClientRect();
    const point = anchor ?? { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2 };
    const before = contentRect();
    zoom = next;
    applySize();
    if (next === "fit") { scroller.scrollLeft = 0; scroller.scrollTop = 0; }
    else if (before.width && before.height) {
      const fx = Math.max(0, Math.min(1, (point.x - before.left) / before.width));
      const fy = Math.max(0, Math.min(1, (point.y - before.top) / before.height));
      const after = canvas.getBoundingClientRect();
      scroller.scrollLeft += after.left + fx * after.width - point.x;
      scroller.scrollTop += after.top + fy * after.height - point.y;
    }
    onChange(zoom);
  }
  function step(factor, anchor) {
    if (!hasImage()) return;
    set((zoom === "fit" ? displayedScale() : zoom) * factor, anchor);
  }
  const reset = () => set("fit");
  // Call after the canvas pixel size changed (new image) so the explicit CSS size follows it.
  const refresh = () => { if (zoom !== "fit") applySize(); };

  scroller.addEventListener("wheel", (event) => {
    // Alt + wheel zooms the picture. Ctrl + wheel is left alone so it zooms the whole UI (app.js).
    if (!event.altKey || event.ctrlKey || event.metaKey || !hasImage()) return;
    event.preventDefault();
    step(wheelFactor(event.deltaY), { x: event.clientX, y: event.clientY });
  }, { passive: false });
  // Releasing Alt on its own would activate the Windows window menu: swallow it over the picture.
  for (const type of ["keydown", "keyup"]) {
    document.addEventListener(type, (event) => { if (event.key === "Alt" && hovered()) event.preventDefault(); });
  }
  scroller.addEventListener("dblclick", (event) => {
    if (event.target !== canvas || !hasImage()) return;
    if (zoom === "fit") set(1, { x: event.clientX, y: event.clientY }); else reset();
  });
  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || !hovered() || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
    if (event.key === "+" || event.key === "=") step(1.25);
    else if (event.key === "-" || event.key === "_") step(1 / 1.25);
    else if (event.key === "0") reset();
    else return;
    event.preventDefault();
  });

  // Drag to pan while zoomed in.
  let pan = null;
  scroller.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || zoom === "fit" || event.target !== canvas || !hasImage()) return;
    pan = { x: event.clientX, y: event.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
    scroller.setPointerCapture(event.pointerId);
    scroller.classList.add("panning");
  });
  scroller.addEventListener("pointermove", (event) => {
    if (!pan) return;
    scroller.scrollLeft = pan.left - (event.clientX - pan.x);
    scroller.scrollTop = pan.top - (event.clientY - pan.y);
  });
  const endPan = () => { pan = null; scroller.classList.remove("panning"); };
  scroller.addEventListener("pointerup", endPan);
  scroller.addEventListener("pointercancel", endPan);

  return { set, step, reset, refresh, get zoom() { return zoom; }, displayedScale, hovered };
}
