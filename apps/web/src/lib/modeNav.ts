import { createContext, useContext } from "react";
import type { CanvasMode } from "../types";

// Local, per-viewer tab navigation. Calling this changes only what THIS browser
// shows — it is never broadcast to the canvas or other viewers (like switching
// tabs in a Google Doc). App provides the setter; deep components (e.g.
// EmptyState's "back to templates") consume it instead of sending a mode.set op.
export const ModeNavContext = createContext<(mode: CanvasMode) => void>(() => {});

export function useModeNav(): (mode: CanvasMode) => void {
  return useContext(ModeNavContext);
}
