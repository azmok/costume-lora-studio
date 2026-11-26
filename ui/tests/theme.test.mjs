import test from "node:test";
import assert from "node:assert/strict";
import { clampLogWidth, DEFAULT_LOG_WIDTH, DEFAULT_THEME, MIN_LOG_WIDTH, parseTheme } from "../theme.mjs";

test("theme parser validates style and mode with safe defaults", () => {
  assert.deepEqual(parseTheme(null), DEFAULT_THEME);
  assert.deepEqual(parseTheme("bad json"), DEFAULT_THEME);
  assert.deepEqual(parseTheme({ style: "glass", mode: "dark" }), { style: "glass", mode: "dark" });
  assert.deepEqual(parseTheme(JSON.stringify({ style: "neu", mode: "dark" })), { style: "neu", mode: "dark" });
  assert.deepEqual(parseTheme({ style: "retro", mode: "dark" }), { style: "neu", mode: "dark" });
  assert.deepEqual(parseTheme({ style: "glass", mode: "sepia" }), { style: "glass", mode: "light" });
});

test("log dock width is clamped between min width and available viewport", () => {
  assert.equal(clampLogWidth("not-a-number", 1500), DEFAULT_LOG_WIDTH);
  assert.equal(clampLogWidth(100, 1500), MIN_LOG_WIDTH);
  assert.equal(clampLogWidth(560, 1500), 560);
  assert.equal(clampLogWidth(1400, 1500), 1020); // 68% of 1500
  assert.equal(clampLogWidth(900, 1200), 780); // leaves 420px for settings
});
