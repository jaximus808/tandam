import { useEffect, useState } from "react";
import { ChevronsLeft, Trash2, Webhook } from "lucide-react";
import type { CanvasMeta } from "../types";
import type { GateMetrics } from "../lib/api";
import { deleteCanvas, fetchGateMetrics } from "../lib/api";
import {
  approvalPolicyLabel,
  approvalPolicySentence,
  policyIsLoose,
  policyOf,
} from "../lib/provenance";
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

  // What this canvas will do to the NEXT agent-proposed task. Absent reads as
  // the server default, 'epic'.
  const policy = policyOf(canvas.approvalPolicy);
  const loose = policyIsLoose(policy);

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

  // The gate's report card (TDM-165). Loaded when the dock opens, for everyone
  // who can open this canvas — same audience as the policy disclosure above, and
  // for the same reason: a gate's honesty is the reader's business, not just the
  // owner's. Null while loading, and null forever on failure — a metric that
  // can't load must not break the settings panel it lives in.
  const [gate, setGate] = useState<GateMetrics | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const m = await fetchGateMetrics(canvas.code);
        if (live) setGate(m);
      } catch {
        if (live) setGate(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [canvas.code]);

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

        {/* Approval gate (TDM-147) — READ-ONLY, and shown to everyone who can
            open this canvas, not just the owner.

            The control that CHANGES this lives in the Share dialog, which is
            owner-only; the consequence of it is borne by every person reading
            the board. Since peer approval landed (TDM-145) a canvas can be
            configured so agents approve each other's work, and 'auto' has always
            meant no gate at all — a board running either of those without
            saying so is exactly the failure this disclosure exists to prevent.
            So the policy is stated in words wherever a human can reach it,
            rather than living only in the database and in a dialog they may not
            be allowed to open. */}
        <div className="mt-6 border-t border-ink/10 pt-4">
          <div className="flex items-center gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink/40">
              Approval gate
            </p>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                loose ? "bg-ink/10 text-ink/70" : "bg-ink/[0.06] text-ink/50"
              }`}
            >
              {approvalPolicyLabel(policy)}
            </span>
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-ink/45">
            {approvalPolicySentence(policy)}
            {loose && " Work can reach an agent on this board without you seeing it first."}
          </p>
          {!isOwner && (
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink/35">
              Only the canvas owner can change this.
            </p>
          )}
        </div>

        {/* Is the gate real? (TDM-165)

            Sits directly under the policy because it is the policy's report
            card: the section above says what this canvas PROMISES to do with
            agent-proposed work, and this one says what it has actually done.

            DELIBERATELY UNGAMIFIED, and every visual choice here is that
            decision:
              - no progress bar, no goal line, no target number rendered as a
                thing to reach;
              - no green/red, no "good"/"bad" — every figure is plain ink, so the
                UI never congratulates you for rejecting or scolds you for
                approving;
              - the caveat is not a tooltip. It renders in full, always, from the
                server's own copy, because a rate like this is misread the
                instant it appears without one.
            A surface that pushes toward rejecting produces rejection theater,
            which is worse than rubber-stamping: it destroys good work AND fakes
            the measurement. */}
        {gate && (
          <div className="mt-6 border-t border-ink/10 pt-4">
            <div className="flex items-center gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink/40">
                Pre-work intervention
              </p>
              <span className="rounded-full bg-ink/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-ink/50">
                {gate.windowDays}d
              </span>
            </div>

            {gate.window.hasRate ? (
              <>
                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className="text-3xl font-semibold tracking-tight tabular-nums text-ink">
                    {gate.window.ratePct}
                  </span>
                  <span className="text-lg font-medium tabular-nums text-ink/35">%</span>
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-ink/45">
                  {gate.window.intervened} of {gate.window.decided} decided ticket
                  {gate.window.decided === 1 ? " was" : "s were"} rejected or rewritten before an
                  agent built {gate.window.intervened === 1 ? "it" : "them"}.
                </p>
              </>
            ) : (
              <p className="mt-2 text-[12px] leading-relaxed text-ink/45">
                Nothing decided in the last {gate.windowDays} days — no rate to report yet.
                {gate.window.pending > 0 &&
                  ` ${gate.window.pending} ticket${gate.window.pending === 1 ? " is" : "s are"} still in the gate.`}
              </p>
            )}

            {/* All-time alongside the window: a board that used to have a gate
                and one that still does are different situations, and only the
                pair distinguishes them. */}
            {gate.allTime.hasRate && (
              <p className="mt-1.5 font-code text-[11px] leading-relaxed text-ink/35">
                all time {gate.allTime.ratePct}% · {gate.allTime.rejected} rejected ·{" "}
                {gate.allTime.amended} amended · {gate.allTime.decided} decided
                {gate.allTime.rejectionsUndone > 0 &&
                  ` · ${gate.allTime.rejectionsUndone} rejection${gate.allTime.rejectionsUndone === 1 ? "" : "s"} undone`}
                {gate.allTime.postWorkBounces > 0 &&
                  ` · ${gate.allTime.postWorkBounces} sent back after the work`}
                {gate.allTime.ungatedAuto > 0 &&
                  ` · ${gate.allTime.ungatedAuto} ungated`}
              </p>
            )}

            <p className="mt-2.5 text-[12px] leading-relaxed text-ink/45">{gate.caveat}</p>

            {/* The definition, verbatim from the server. A metric whose
                definition is implicit gets misread, and this one has two edges
                people guess wrong: what counts as "materially amended", and what
                an undone rejection does to the number. */}
            <details className="mt-2 [&_summary::-webkit-details-marker]:hidden">
              <summary className="cursor-pointer list-none text-[11px] font-medium text-ink/40 transition-colors hover:text-ink/65">
                How this is counted
              </summary>
              <ul className="mt-2 space-y-1.5 border-l border-ink/10 pl-3">
                {gate.definition.map((line) => (
                  <li key={line} className="text-[11px] leading-relaxed text-ink/40">
                    {line}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}

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
