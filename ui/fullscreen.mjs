// Full-screen view for an image panel: the panel is pinned over the whole window (CSS .fullscreen),
// a centered hint explains how to leave, and Esc exits.
let hintTimer = 0;

export function showEscHint() {
  const hint = document.getElementById("fs-hint");
  if (!hint) return;
  hint.hidden = true;
  void hint.offsetWidth; // restart the fade animation
  hint.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { hint.hidden = true; }, 2800);
}

export function createFullscreen({ panel, button, onChange = () => {} }) {
  let active = false;
  function set(on) {
    if (on === active) return;
    active = on;
    panel.classList.toggle("fullscreen", on);
    document.body.classList.toggle("fullscreen-open", on);
    button.setAttribute("aria-label", on ? "Exit full screen (Esc)" : "Full screen");
    button.title = on ? "Exit full screen (Esc)" : "Full screen";
    if (on) showEscHint();
    else { const hint = document.getElementById("fs-hint"); if (hint) hint.hidden = true; }
    onChange(on);
  }
  // Blur after the click: otherwise Space would "press" this button again and leave full screen.
  button.addEventListener("click", () => { set(!active); button.blur(); });
  document.addEventListener("keydown", (event) => {
    if (!active || event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
    event.preventDefault();
    set(false);
  });
  return { set, get active() { return active; } };
}
