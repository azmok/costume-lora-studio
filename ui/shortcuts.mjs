// Keyboard shortcut reference shown by "?" (kept as data so it stays in sync and testable).
// The paint keys follow Photoshop where there is an equivalent.
export const SHORTCUT_SECTIONS = [
  {
    title: "Mask paint (Tools)",
    items: [
      ["B", "Paint brush"], ["E", "Erase brush"], ["X", "Swap paint / erase"], ["M", "Box"], ["L", "Lasso"],
      ["Alt + drag", "Temporary eraser: flips paint ↔ erase while Alt is held (also Box / Lasso)"],
      ["[  ]", "Brush size − / +"],
      ["0 – 9", "Brush opacity: 1 = 10% … 0 = 100%; two digits quickly = exact % (45)"],
      ["Right-drag", "← smaller · → larger brush"], ["Alt + right-drag", "← → size · ↑ denser · ↓ lighter opacity"],
      ["Space + drag", "Pan the image"], ["\\ (hold)", "Peek at the original image"],
      ["Ctrl + Z / Ctrl + Shift + Z", "Undo / redo"], ["Ctrl + I", "Invert mask"]
    ]
  },
  {
    title: "Views and navigation (Tools)",
    items: [
      ["Q", "Toggle the mask overlay (Overlay ↔ Original)"], ["Shift + Q", "Cycle Original / Overlay / Mask / Split"],
      ["F", "Full screen"], ["Esc", "Exit full screen"], ["Tab (full screen)", "Hide / show the floating toolbox"],
      ["PageUp  PageDown", "Previous / next image"], ["N", "Next unreviewed image"], ["R", "Mark reviewed"], ["T", "Use / skip this image for LoRA training"],
      ["Ctrl + S", "Save all changes"]
    ]
  },
  {
    title: "Zoom",
    items: [
      ["Alt + wheel", "Zoom the image (Tools and Mask Creation)"], ["Ctrl + wheel", "Zoom the whole UI (everywhere)"],
      ["Ctrl + +  /  Ctrl + −", "Same, from the keyboard (image when hovering it)"],
      ["Ctrl + 0", "Fit image / reset UI zoom"], ["Ctrl + ↑  ↓", "Zoom the editor image"], ["Double-click", "100% / fit"]
    ]
  },
  {
    title: "Mask Creation preview",
    items: [
      ["Q", "Toggle the mask overlay"], ["Shift + Q", "Cycle Original / Overlay / Mask / Split"], ["F", "Full screen"],
      ["PageUp  PageDown", "Previous / next image"], ["← →", "Previous / next image (full screen)"], ["Esc", "Exit full screen"]
    ]
  },
  {
    title: "General",
    items: [["?", "Show this list"]]
  }
];
