import type { LucideIcon } from "lucide-react";
import { Files, ClipboardList, Settings } from "lucide-react";

/* ─────────────────────────────────────────────────────────────────────────────
   The left activity-bar registry (VS Code style).

   The activity bar is a thin icon rail on the far left; clicking an icon opens
   that view in the shared side panel (and clicking the active one collapses it).
   This is the extension point: a new "extension" panel attaches by adding one
   entry here + rendering its body in App.tsx keyed on the same `id`. Nothing
   else in the shell needs to change.
   ──────────────────────────────────────────────────────────────────────────── */

export type SidebarView = "documents" | "tasks" | "settings";

export interface SidebarItem {
  id: SidebarView;
  icon: LucideIcon;
  label: string;
  /** "top" = pinned to the top group; "bottom" = pinned to the base (the gear). */
  slot: "top" | "bottom";
}

export const SIDEBAR_ITEMS: SidebarItem[] = [
  { id: "documents", icon: Files, label: "Documents", slot: "top" },
  { id: "tasks", icon: ClipboardList, label: "Agent tasks", slot: "top" },
  { id: "settings", icon: Settings, label: "Settings", slot: "bottom" },
];

// Guard a persisted string back into a valid view (or null = collapsed).
export function parseSidebarView(v: string | null): SidebarView | null {
  return v === "documents" || v === "tasks" || v === "settings" ? v : null;
}
