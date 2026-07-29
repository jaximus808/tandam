import type { LucideIcon } from "lucide-react";
import { Files, SquareKanban } from "lucide-react";

/* ─────────────────────────────────────────────────────────────────────────────
   Workspace navigation registry.

   A canvas has two TOP-LEVEL SURFACES — different kinds of workspace, not
   tabs of one another:

     · Board      — the task kanban (epics + Proposed/Ready/Working/Done).
                    THE canonical home for tasks and agent work.
     · Documents  — the tabbed document worksurface (maps, docs, sheets, …).

   They're switched from the labeled left nav (WorkspaceNav). Everything
   surface-local — the document tab strip, the explorer panel — lives INSIDE
   its surface, never at this level. Settings is secondary chrome (a side
   panel), reachable from the nav's bottom slot but not a surface.
   ──────────────────────────────────────────────────────────────────────────── */

export type Surface = "board" | "documents";

export interface SurfaceItem {
  id: Surface;
  icon: LucideIcon;
  label: string;
}

export const SURFACE_ITEMS: SurfaceItem[] = [
  { id: "board", icon: SquareKanban, label: "Board" },
  { id: "documents", icon: Files, label: "Documents" },
];

// Guard a persisted string back into a valid surface (unknown → null).
export function parseSurface(v: unknown): Surface | null {
  return v === "board" || v === "documents" ? v : null;
}

/* The side panel views. "documents" is the explorer (belongs to the Documents
   surface — toggled from its tab strip); "settings" is the canvas settings
   panel (toggled from the nav's gear). The old "tasks" view is gone — the
   Board surface is the one home for tasks; parseSidebarView maps any legacy
   persisted "tasks" value to null so stale localStorage degrades gracefully. */

export type SidebarView = "documents" | "settings";

// Guard a persisted string back into a valid view (or null = collapsed).
export function parseSidebarView(v: string | null): SidebarView | null {
  return v === "documents" || v === "settings" ? v : null;
}
