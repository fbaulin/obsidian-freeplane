export interface FpSettings {
  nodeMaxWidthSymbols: number;
  touchpadPanSpeed: number;
  touchpadZoomSpeed: number;
  touchscreenPanSpeed: number;
  touchscreenZoomSpeed: number;
}
export const DEFAULT_SETTINGS: FpSettings = {
  nodeMaxWidthSymbols: 60,
  touchpadPanSpeed: 1,
  touchpadZoomSpeed: 1,
  touchscreenPanSpeed: 1,
  touchscreenZoomSpeed: 1
};
export const settings: FpSettings = { ...DEFAULT_SETTINGS };
export function applySettings(p: Partial<FpSettings>) { Object.assign(settings, DEFAULT_SETTINGS, p); }
