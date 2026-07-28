import { createPortal } from "react-dom";
import { AlertTriangle, Trash2 } from "lucide-react";
import type { CanvasMeta } from "../types";

/* A destructive-action confirm for permanently deleting an owned canvas. Shared
   by the dashboard (kebab menu on owned cards/rows) and the in-canvas settings
   panel. Plain confirm (not type-to-confirm) — both callers scope it to canvases
   the user owns, and the copy spells out that it's irreversible.

   Portalled to <body>: the settings panel renders inside SidePanel's aside,
   where ancestor filter/transform effects can make it the containing block for
   fixed descendants — an in-tree `fixed inset-0` could size to the sidebar,
   not the viewport. */
export default function DeleteCanvasModal({
  canvas,
  deleting,
  error,
  onCancel,
  onConfirm,
}: {
  canvas: CanvasMeta;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return createPortal(
    <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4">
      <button
        aria-label="Cancel"
        onClick={onCancel}
        className="absolute inset-0 bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-canvas-title"
        className="relative w-full max-w-md rounded-[10px] border border-ink/10 bg-surface p-6 shadow-lg"
      >
        <div className="flex items-start gap-3.5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 id="delete-canvas-title" className="text-lg font-semibold tracking-tight">
              Delete this canvas?
            </h2>
            <p className="mt-1.5 text-sm text-ink/60">
              <span className="font-medium text-ink">{canvas.name || "Untitled canvas"}</span>{" "}
              <span className="font-code text-xs text-ink/40">{canvas.code}</span>{" "}
              and everything in it will be permanently deleted. This can’t be undone, and anyone
              you’ve shared it with will lose access.
            </p>
          </div>
        </div>

        {error && (
          <p className="mt-4 rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-400">
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={deleting}
            className="rounded-md border border-ink/15 bg-surface px-4 py-2 text-sm font-medium text-ink/70 transition-colors hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={deleting}
            className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Trash2 className="h-4 w-4" />
            {deleting ? "Deleting…" : "Delete canvas"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
