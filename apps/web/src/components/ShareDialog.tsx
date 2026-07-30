import { useEffect, useRef, useState } from "react";
import type { ApprovalPolicy, CanvasMeta } from "../types";
import posthog from "../lib/posthog";
import {
  addCanvasAccess,
  listCanvasAccess,
  removeCanvasAccess,
  setCanvasApprovalPolicy,
  setCanvasVisibility,
  type CanvasAccessEntry,
} from "../lib/api";

interface Props {
  code: string;
  canvas: CanvasMeta;
  onClose: () => void;
}

type Visibility = "public" | "private";
type Role = "read" | "write";

function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs font-medium uppercase tracking-wide text-ink/50">{children}</span>
  );
}

// Segmented toggle (visibility + public role + approval policy) — keeps the
// ink/paper look.
//
// Below sm it goes FULL WIDTH with equal segments on its own line. Sat beside
// its label in a 390px dialog it was a shrinkable flex item, so the three-way
// approval control ("Strict / Epic / Auto") squeezed its own labels while the
// sentence next to it collapsed to one word per line. Above sm it is the
// unchanged inline control.
function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex w-full shrink-0 rounded-md border border-ink/15 bg-paper p-0.5 sm:inline-flex sm:w-auto">
      {options.map((o) => (
        <button
          key={o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={[
            "tandem-tap flex flex-1 items-center justify-center rounded-[5px] px-3 py-1 text-[12px] font-medium transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:flex-none",
            value === o.value ? "bg-accent text-white" : "text-ink/55 hover:text-ink",
          ].join(" ")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function ShareDialog({ code, canvas, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

  const [visibility, setVisibility] = useState<Visibility>(canvas.visibility ?? "public");
  const [publicRole, setPublicRole] = useState<Role>(canvas.publicRole ?? "write");
  const [savingPosture, setSavingPosture] = useState(false);
  const [postureError, setPostureError] = useState<string | null>(null);

  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>(
    canvas.approvalPolicy ?? "epic",
  );
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);

  const [access, setAccess] = useState<CanvasAccessEntry[] | null>(null);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("read");
  const [inviting, setInviting] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Load the member list once.
  useEffect(() => {
    let live = true;
    listCanvasAccess(code)
      .then((rows) => live && setAccess(rows))
      .catch(() => live && setAccess([]));
    return () => {
      live = false;
    };
  }, [code]);

  // Persist a visibility/role change, optimistically reflecting it.
  async function persistPosture(next: { visibility: Visibility; publicRole: Role }) {
    setSavingPosture(true);
    setPostureError(null);
    const prev = { visibility, publicRole };
    setVisibility(next.visibility);
    setPublicRole(next.publicRole);
    try {
      await setCanvasVisibility(code, next.visibility, next.publicRole);
      posthog.capture("canvas_visibility_changed", { canvas_code: code, visibility: next.visibility, public_role: next.publicRole });
    } catch (err) {
      setVisibility(prev.visibility);
      setPublicRole(prev.publicRole);
      setPostureError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSavingPosture(false);
    }
  }

  // Persist an approval-policy change, optimistically reflecting it.
  async function persistPolicy(next: ApprovalPolicy) {
    setSavingPolicy(true);
    setPolicyError(null);
    const prev = approvalPolicy;
    setApprovalPolicy(next);
    try {
      await setCanvasApprovalPolicy(code, next);
      posthog.capture("canvas_approval_policy_changed", { canvas_code: code, approval_policy: next });
    } catch (err) {
      setApprovalPolicy(prev);
      setPolicyError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSavingPolicy(false);
    }
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    const addr = email.trim();
    if (!addr || inviting) return;
    setInviting(true);
    setShareError(null);
    try {
      const entry = await addCanvasAccess(code, addr, inviteRole);
      posthog.capture("canvas_shared", { canvas_code: code, role: inviteRole });
      setAccess((rows) => {
        const others = (rows ?? []).filter((r) => r.userId !== entry.userId);
        return [...others, entry];
      });
      setEmail("");
    } catch (err) {
      setShareError(err instanceof Error ? err.message : "Could not share");
    } finally {
      setInviting(false);
    }
  }

  async function revoke(userId: string) {
    const prev = access;
    setAccess((rows) => (rows ?? []).filter((r) => r.userId !== userId));
    try {
      await removeCanvasAccess(code, userId);
    } catch {
      setAccess(prev ?? null); // restore on failure
    }
  }

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        // dvh, not vh: on mobile Safari 88vh measures against the viewport
        // WITHOUT the URL bar, so the dialog can be taller than what's visible
        // and the pinned "Done" footer ends up below the fold with no way to
        // scroll to it (the scroller is the body above the footer, not this box).
        className="relative flex max-h-[88dvh] w-full max-w-md flex-col overflow-hidden rounded-[10px] border border-ink/10 bg-surface text-ink shadow-lg outline-none"
      >
        <div className="overflow-y-auto px-5 pb-5 pt-5">
          <Kicker>Share · {code}</Kicker>
          <h2 id="share-title" className="mt-1 text-xl font-semibold tracking-tight">
            Who can open this canvas
          </h2>

          {/* ── General access ─────────────────────────────────────────────── */}
          <div className="mt-4 rounded-md border border-ink/15 bg-paper p-3">
            {/* Label above the control below sm, beside it above — the setting
                and its explanation both get the full 390px column. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-ink">General access</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-ink/55">
                  {visibility === "public"
                    ? "Anyone with the code can open it."
                    : "Only you and people you add below."}
                </p>
              </div>
              <Segmented<Visibility>
                value={visibility}
                disabled={savingPosture}
                onChange={(v) => persistPosture({ visibility: v, publicRole })}
                options={[
                  { value: "public", label: "Public" },
                  { value: "private", label: "Private" },
                ]}
              />
            </div>

            {visibility === "public" && (
              <div className="mt-3 flex flex-col gap-2 border-t border-ink/10 pt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <p className="text-[12px] text-ink/60">People with the code can</p>
                <Segmented<Role>
                  value={publicRole}
                  disabled={savingPosture}
                  onChange={(r) => persistPosture({ visibility, publicRole: r })}
                  options={[
                    { value: "read", label: "View" },
                    { value: "write", label: "Edit" },
                  ]}
                />
              </div>
            )}
            {postureError && <p className="mt-2 text-[12px] text-rose-600 dark:text-rose-400">{postureError}</p>}
          </div>

          {/* ── Agent task approval policy (migration 0033) ────────────────── */}
          <div className="mt-4 rounded-md border border-ink/15 bg-paper p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-ink">Agent task approval</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-ink/55">
                  {approvalPolicy === "strict"
                    ? "Every agent-proposed task waits for your approval."
                    : approvalPolicy === "auto"
                      ? "Agent tasks are ready immediately — no approval gate."
                      : "Approve an epic once; its tasks flow without per-task approval."}
                </p>
              </div>
              <Segmented<ApprovalPolicy>
                value={approvalPolicy}
                disabled={savingPolicy}
                onChange={(p) => persistPolicy(p)}
                options={[
                  { value: "strict", label: "Strict" },
                  { value: "epic", label: "Epic" },
                  { value: "auto", label: "Auto" },
                ]}
              />
            </div>
            {policyError && <p className="mt-2 text-[12px] text-rose-600 dark:text-rose-400">{policyError}</p>}
          </div>

          {/* ── Share with specific people ─────────────────────────────────── */}
          <div className="mt-4">
            <Kicker>People with access</Kicker>
            {/* Three controls in one row is a desktop row. Below sm the email
                field takes its own line (it is the field you type a whole
                address into) and the role + Add pair sits under it. */}
            <form onSubmit={invite} className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@email.com"
                className="tandem-tap min-w-0 flex-1 rounded-md border border-ink/15 bg-surface px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
              />
              <div className="flex min-w-0 items-center gap-2 sm:shrink-0">
                {/* Segmented is w-full below sm (it is a stacked control in the
                    rows above), so it needs a shrinking box of its own here or
                    it claims the whole line and pushes Add off the edge. */}
                <div className="min-w-0 flex-1 sm:flex-none">
                  <Segmented<Role>
                    value={inviteRole}
                    onChange={setInviteRole}
                    options={[
                      { value: "read", label: "View" },
                      { value: "write", label: "Edit" },
                    ]}
                  />
                </div>
                <button
                  type="submit"
                  disabled={inviting || !email.trim()}
                  className="tandem-tap flex shrink-0 items-center justify-center rounded-md bg-accent px-4 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
                >
                  {inviting ? "…" : "Add"}
                </button>
              </div>
            </form>
            {shareError && <p className="mt-2 text-[12px] text-rose-600 dark:text-rose-400">{shareError}</p>}

            <ul className="mt-3 space-y-1.5">
              {/* Owner — always first, can't be removed. */}
              <li className="flex items-center gap-2.5 rounded-md px-1 py-1">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ink/10 text-[11px] font-medium text-ink/70">
                  {(canvas.name?.[0] ?? "?").toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">You (owner)</span>
                <span className="font-code text-[11px] text-ink/40">Owner</span>
              </li>

              {access === null ? (
                <li className="px-1 py-1 text-[12px] text-ink/40">Loading…</li>
              ) : access.length === 0 ? (
                <li className="px-1 py-1 text-[12px] text-ink/40">
                  No one else yet. Add someone by email above.
                </li>
              ) : (
                access.map((m) => (
                  <li key={m.userId} className="flex items-center gap-2.5 rounded-md px-1 py-1">
                    {m.avatarUrl ? (
                      <img src={m.avatarUrl} alt="" className="h-7 w-7 shrink-0 rounded-full" />
                    ) : (
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ink/10 text-[11px] font-medium text-ink/70">
                        {(m.displayName?.[0] ?? m.email?.[0] ?? "?").toUpperCase()}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                      {m.displayName || m.email}
                    </span>
                    <span className="font-code text-[11px] text-ink/45">
                      {m.role === "write" ? "Edit" : "View"}
                    </span>
                    {/* Was an 18px-tall text link — the smallest target in the
                        dialog, and the destructive one. */}
                    <button
                      onClick={() => revoke(m.userId)}
                      className="tandem-tap flex shrink-0 items-center justify-center rounded px-2 py-0.5 text-[11px] text-ink/40 transition-colors hover:bg-ink/5 hover:text-rose-600 dark:hover:text-rose-400"
                      title="Remove access"
                    >
                      Remove
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>

        <div className="border-t border-ink/10 px-5 py-3.5">
          <button
            onClick={onClose}
            className="tandem-tap flex w-full items-center justify-center rounded-md border border-ink/15 bg-surface py-2.5 text-[13px] font-medium text-ink transition-colors hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
