import { useEffect, useState } from "react";
import { ChevronsLeft, Trash2, Webhook } from "lucide-react";
import type { CanvasMeta } from "../types";
import { deleteCanvas } from "../lib/api";
import { listWebhookDeliveries, listWebhooks } from "../lib/webhooks";
import DeleteCanvasModal from "./DeleteCanvasModal";
import FollowStyleControl from "./FollowStyleControl";
import WebhooksModal from "./WebhooksModal";

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

  // Webhooks. The dock only ever shows a one-line summary — the management UI is
  // a modal, because a URL, three event names and an error message don't fit in
  // a 300px column. `summary` is null until loaded; the fetch is owner-only and
  // the failed-delivery count is only asked for when there's an endpoint that
  // could have produced one, so a canvas with no webhooks costs one small GET.
  const [webhooksOpen, setWebhooksOpen] = useState(false);
  const [summary, setSummary] = useState<{ count: number; failed: number } | null>(null);
  // Bumped when the modal closes, so the summary reflects what was just changed.
  const [summaryNonce, setSummaryNonce] = useState(0);

  useEffect(() => {
    if (!isOwner) return;
    let live = true;
    (async () => {
      try {
        const { webhooks } = await listWebhooks(canvas.code);
        if (!live) return;
        if (webhooks.length === 0) {
          setSummary({ count: 0, failed: 0 });
          return;
        }
        const dead = await listWebhookDeliveries(canvas.code, { status: "dead", limit: 50 });
        if (!live) return;
        setSummary({ count: webhooks.length, failed: dead.length });
      } catch {
        // A summary that can't load shouldn't break the settings panel; the
        // section still opens and the modal reports the real error.
        if (live) setSummary(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [canvas.code, isOwner, summaryNonce]);

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

        {/* Webhooks — owner-only, and only ever rendered for the owner. A
            read-only viewer, a member, or anyone signed out sees nothing here:
            the API refuses them anyway, so offering the control would only
            promise something it can't deliver. Agents never render this UI at
            all — they have no browser session, which is exactly what these
            routes require. */}
        {isOwner && (
          <div className="mt-6 border-t border-ink/10 pt-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink/40">
              Webhooks
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-ink/45">
              Post a signed JSON body to your own server when a task on this board is approved,
              finishes, or has its claim released.
            </p>
            <button
              onClick={() => setWebhooksOpen(true)}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-ink/15 px-3 py-1.5 text-[12px] font-medium text-ink/70 transition-colors hover:border-ink/40 hover:bg-paper"
            >
              <Webhook className="h-3.5 w-3.5" />
              {summary && summary.count > 0
                ? `Manage ${summary.count} endpoint${summary.count === 1 ? "" : "s"}`
                : "Add an endpoint"}
              {summary && summary.failed > 0 && (
                <span className="ml-0.5 rounded-full bg-rose-500/15 px-1.5 py-0.5 font-code text-[10px] leading-none text-rose-600 dark:text-rose-400">
                  {summary.failed} failed
                </span>
              )}
            </button>
          </div>
        )}

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

      {webhooksOpen && isOwner && (
        <WebhooksModal
          code={canvas.code}
          onClose={() => {
            setWebhooksOpen(false);
            setSummaryNonce((n) => n + 1);
          }}
        />
      )}

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
