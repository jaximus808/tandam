import { useState } from "react";
import { ChevronsLeft, Trash2 } from "lucide-react";
import type { CanvasMeta } from "../types";
import { deleteCanvas } from "../lib/api";
import DeleteCanvasModal from "./DeleteCanvasModal";
import FollowStyleControl from "./FollowStyleControl";

/* SettingsPanel — the side-dock view for settings that act on THIS canvas.
   Today that's the danger zone (owner-only delete); future canvas settings and
   "extension" panels land here too. Matches the Documents/Tasks panel frame so
   switching between them is seamless. */
export default function SettingsPanel({
  canvas,
  isOwner,
  onDeleted,
  onClose,
}: {
  canvas: CanvasMeta;
  isOwner: boolean;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Delete the canvas we're currently sitting in, then hand back to the caller
  // to navigate away — the board we're rendering no longer exists, and the API
  // boots every live viewer off it.
  async function confirmDelete() {
    setDeleting(true);
    setError(null);
    try {
      await deleteCanvas(canvas.code);
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between border-b border-ink/10 px-3 py-3 pl-4">
        <span className="text-sm font-semibold text-ink">Settings</span>
        <button
          onClick={onClose}
          title="Hide settings"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-ink/35 transition-colors hover:bg-ink/5 hover:text-ink/60"
        >
          <ChevronsLeft size={16} strokeWidth={1.75} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">
            {canvas.name || "Untitled canvas"}
          </p>
          <p className="mt-0.5 font-code text-[11px] tracking-[0.14em] text-ink/40">{canvas.code}</p>
        </div>

        <div className="mt-6 border-t border-ink/10 pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink/40">
            Agent activity
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-ink/45">
            How a batch of agent changes reveals while you follow along. Cinematic glides from the
            top of the changes to the bottom; Minimal just settles it into view. Saved on this
            device, and to your account when signed in.
          </p>
          <div className="mt-3">
            <FollowStyleControl />
          </div>
        </div>

        <div className="mt-6 border-t border-ink/10 pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink/40">
            Danger zone
          </p>
          {isOwner ? (
            <>
              <p className="mt-2 text-[12px] leading-relaxed text-ink/45">
                Permanently delete this canvas and everything in it. This can’t be undone.
              </p>
              <button
                onClick={() => setConfirming(true)}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-[12px] font-medium text-red-600 transition-colors hover:bg-red-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete canvas
              </button>
            </>
          ) : (
            <p className="mt-2 text-[12px] leading-relaxed text-ink/45">
              Only the owner of this canvas can delete it.
            </p>
          )}
        </div>
      </div>

      {confirming && (
        <DeleteCanvasModal
          canvas={canvas}
          deleting={deleting}
          error={error}
          onCancel={() => {
            setConfirming(false);
            setError(null);
          }}
          onConfirm={confirmDelete}
        />
      )}
    </>
  );
}
