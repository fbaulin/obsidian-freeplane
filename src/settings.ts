export interface FpSettings { nodeMaxWidthSymbols: number; }
export const DEFAULT_SETTINGS: FpSettings = { nodeMaxWidthSymbols: 60 };
export const settings: FpSettings = { ...DEFAULT_SETTINGS };
export function applySettings(p: Partial<FpSettings>) { Object.assign(settings, DEFAULT_SETTINGS, p); }
