export interface HotkeyBinding { modifiers: string[]; key: string; }
export const DEFAULT_HOTKEYS: Record<string, HotkeyBinding[]> = {
  "freeplane:search": [{ modifiers: ["Mod"], key: "f" }],
  "freeplane:search-next": [{ modifiers: [], key: "n" }],
  "freeplane:search-previous": [{ modifiers: ["Shift"], key: "n" }],
  "freeplane:update-panel": [{ modifiers: ["Mod"], key: "Enter" }],
  "freeplane:pan-up": [{ modifiers: ["Alt"], key: "ArrowUp" }],
  "freeplane:pan-down": [{ modifiers: ["Alt"], key: "ArrowDown" }],
  "freeplane:pan-left": [{ modifiers: ["Alt"], key: "ArrowLeft" }],
  "freeplane:pan-right": [{ modifiers: ["Alt"], key: "ArrowRight" }],
  "freeplane:zoom-in": [{ modifiers: [], key: "+" }, { modifiers: ["Shift"], key: "+" }, { modifiers: [], key: "=" }],
  "freeplane:zoom-out": [{ modifiers: [], key: "-" }],
  "freeplane:save": [{ modifiers: ["Mod"], key: "s" }],
  "freeplane:undo": [{ modifiers: ["Mod"], key: "z" }],
  "freeplane:redo": [{ modifiers: ["Mod", "Shift"], key: "z" }],
  "freeplane:center-node": [{ modifiers: [], key: "z" }],
  "freeplane:rename": [{ modifiers: ["Mod"], key: "e" }],
  "freeplane:edit-details": [{ modifiers: ["Mod"], key: "d" }],
  "freeplane:edit-note": [{ modifiers: ["Mod", "Shift"], key: "d" }],
  "freeplane:toggle-preview": [{ modifiers: ["Mod"], key: "Space" }, { modifiers: ["Shift"], key: "Space" }],
  "freeplane:fold": [{ modifiers: [], key: "Space" }],
  "freeplane:nav-up": [{ modifiers: [], key: "ArrowUp" }],
  "freeplane:nav-down": [{ modifiers: [], key: "ArrowDown" }],
  "freeplane:nav-left": [{ modifiers: [], key: "ArrowLeft" }],
  "freeplane:nav-right": [{ modifiers: [], key: "ArrowRight" }],
  "freeplane:select-up": [{ modifiers: ["Shift"], key: "ArrowUp" }],
  "freeplane:select-down": [{ modifiers: ["Shift"], key: "ArrowDown" }],
  "freeplane:select-left": [{ modifiers: ["Shift"], key: "ArrowLeft" }],
  "freeplane:select-right": [{ modifiers: ["Shift"], key: "ArrowRight" }],
  "freeplane:move-up": [{ modifiers: ["Mod"], key: "ArrowUp" }],
  "freeplane:move-down": [{ modifiers: ["Mod"], key: "ArrowDown" }],
  "freeplane:promote": [{ modifiers: ["Mod"], key: "ArrowLeft" }],
  "freeplane:demote": [{ modifiers: ["Mod"], key: "ArrowRight" }],
  "freeplane:new-sibling-below": [{ modifiers: [], key: "Enter" }],
  "freeplane:new-sibling-above": [{ modifiers: ["Shift"], key: "Enter" }],
  "freeplane:new-child": [{ modifiers: [], key: "Insert" }],
  "freeplane:delete": [{ modifiers: [], key: "Delete" }]
};
export let hotkeys: Record<string, HotkeyBinding[]> = { ...DEFAULT_HOTKEYS };
export function setHotkeys(h: Record<string, HotkeyBinding[]>) { hotkeys = { ...DEFAULT_HOTKEYS, ...h }; }
export const HOTKEYS_FILE_DEFAULT =
  '// Freeplane plugin hotkeys - same format as Obsidian hotkeys.json.\n' +
  '// Modifiers: "Mod" (Ctrl or Cmd), "Alt", "Shift".\n' +
  '// Key names: letters a-z, digits 0-9, ArrowUp/ArrowDown/ArrowLeft/ArrowRight, Enter, Space, Tab, Escape, Delete, Insert, F1-F12.\n' +
  '// Action ids include freeplane:nav-*, freeplane:select-*, freeplane:move-*, editing, creation, save, undo/redo and delete.\n' +
  '// Empty array disables an action, e.g. "freeplane:fold": []\n' +
  JSON.stringify(DEFAULT_HOTKEYS, null, 2) + "\n";
function eventMatches(e: KeyboardEvent, b: HotkeyBinding): boolean {
  const mods = new Set(b.modifiers);
  if ((mods.has("Mod") || mods.has("Ctrl")) !== (e.ctrlKey || e.metaKey)) return false;
  if (mods.has("Alt") !== e.altKey) return false;
  if (mods.has("Shift") !== e.shiftKey) return false;
  const k = b.key;
  if (k === "Space" || k === " ") return e.key === " ";
  if (/^[a-z]$/i.test(k)) return e.code === "Key" + k.toUpperCase();
  if (/^[0-9]$/.test(k)) return e.code === "Digit" + k;
  return e.key === k;
}
export function matchAction(e: KeyboardEvent): string | null {
  for (const [id, list] of Object.entries(hotkeys)) {
    if (!Array.isArray(list)) continue;
    for (const b of list) if (b && eventMatches(e, b)) return id;
  }
  return null;
}
