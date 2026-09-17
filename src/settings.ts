export interface FpSettings {
  nodeMaxWidthSymbols: number;
  touchpadPanSpeed: number;
  touchpadZoomSpeed: number;
  touchscreenPanSpeed: number;
  touchscreenZoomSpeed: number;
  editingPanelButtonSize: number;
  detailsFontSize: number;
}
export const DEFAULT_SETTINGS: FpSettings = {
  nodeMaxWidthSymbols: 60,
  touchpadPanSpeed: 1,
  touchpadZoomSpeed: 1,
  touchscreenPanSpeed: 1,
  touchscreenZoomSpeed: 1,
  editingPanelButtonSize: 33,
  detailsFontSize: 12
};
export const settings: FpSettings = { ...DEFAULT_SETTINGS };
export const SETTING_FIELDS: { key: keyof FpSettings; name: string; min: number; max: number; step: number; desc: string }[] = [
  { key: "nodeMaxWidthSymbols", name: "Node wrap width", min: 8, max: 300, step: 1, desc: "Maximum characters per wrapped line." },
  { key: "detailsFontSize", name: "Details font size", min: 6, max: 32, step: 0.5, desc: "Pixels at 100% zoom, for viewing and editing. Node text is 13 px." },
  { key: "editingPanelButtonSize", name: "Editing panel button size", min: 16, max: 96, step: 1, desc: "Button width and height in pixels." },
  ...(["touchpad", "touchscreen"] as const).flatMap(device => (["Pan", "Zoom"] as const).map(action => ({
    key: `${device}${action}Speed` as keyof FpSettings,
    name: `${device === "touchpad" ? "Touchpad" : "Touchscreen"} ${action.toLowerCase()} speed`,
    min: 0.1, max: 10, step: 0.1, desc: "Speed multiplier; 1 is the default."
  })))
];
export function applySettings(p: Partial<FpSettings>) {
  Object.assign(settings, DEFAULT_SETTINGS);
  for (const field of SETTING_FIELDS) {
    const value = Number(p[field.key]);
    if (p[field.key] != null && Number.isFinite(value)) settings[field.key] = Math.max(field.min, Math.min(field.max, value));
  }
}
