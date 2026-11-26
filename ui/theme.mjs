// Theme (style: neu | glass, mode: light | dark) and log-dock width clamping. Pure functions, no DOM.
export const THEME_KEY = "costume-ui-theme";
export const LOG_WIDTH_KEY = "costume-log-width";
export const STYLES = ["neu", "glass"];
export const MODES = ["light", "dark"];
export const DEFAULT_THEME = { style: "neu", mode: "light" };
export const DEFAULT_LOG_WIDTH = 400;
export const MIN_LOG_WIDTH = 260;

export function parseTheme(raw) {
  let data = raw;
  if (typeof raw === "string") {
    try { data = JSON.parse(raw); } catch { return { ...DEFAULT_THEME }; }
  }
  const style = STYLES.includes(data?.style) ? data.style : DEFAULT_THEME.style;
  const mode = MODES.includes(data?.mode) ? data.mode : DEFAULT_THEME.mode;
  return { style, mode };
}

export function clampLogWidth(width, viewportWidth = 1440) {
  const num = Number(width);
  if (!Number.isFinite(num)) return DEFAULT_LOG_WIDTH;
  const vw = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1440;
  const max = Math.max(MIN_LOG_WIDTH, Math.min(Math.round(vw * 0.68), Math.round(vw - 420)));
  return Math.round(Math.max(MIN_LOG_WIDTH, Math.min(max, num)));
}
