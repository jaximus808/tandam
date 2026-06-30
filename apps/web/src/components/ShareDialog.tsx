import { useEffect, useRef, useState } from "react";
import type { CanvasMeta } from "../types";
import {
  addCanvasAccess,
  listCanvasAccess,
  removeCanvasAccess,
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
    <span className="font-code text-[10px] uppercase tracking-[0.22em] text-ink/40">{children}</span>
  );
}

// Segmented two-option toggle (visibility + role) — keeps the ink/paper look.
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
    <div className="inline-flex rounded-md border border-ink/15 bg-paper p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={[
            "rounded-[5px] px-3 py-1 text-[12px] font-medium transition-colors disabled:opacity-50",
            value === o.value ? "bg-ink text-paper" : "text-ink/55 hover:text-ink",
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
    } catch (err) {
      setVisibility(prev.visibility);
      setPublicRole(prev.publicRole);
      setPostureError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSavingPosture(false);
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
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-ink/40 p-4 font-brand backdrop-blur-sm"
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
        className="relative flex max-h-[88vh] w-full max-w-md flex-col overflow-hidden rounded-lg border-[1.5px] border-ink bg-white text-ink shadow-[10px_10px_0_rgba(28,25,23,0.12)] outline-none"
      >
        <div className="overflow-y-auto px-5 pb-5 pt-5">
          <Kicker>Share · {code}</Kicker>
          <h2 id="share-title" className="mt-1 font-display text-xl font-medium tracking-tight">
            Who can open this canvas
          </h2>

          {/* ── General access ─────────────────────────────────────────────── */}
          <div className="mt-4 rounded-md border border-ink/15 bg-paper p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
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
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-ink/10 pt-3">
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
            {postureError && <p className="mt-2 text-[12px] text-[#C75B39]">{postureError}</p>}
          </div>

          {/* ── Share with specific people ─────────────────────────────────── */}
          <div className="mt-4">
            <Kicker>People with access</Kicker>
            <form onSubmit={invite} className="mt-2 flex items-center gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@email.com"
                className="min-w-0 flex-1 rounded-md border border-ink/20 bg-white px-3 py-1.5 text-[13px] text-ink outline-none focus:border-ink/50"
              />
              <Segmented<Role>
                value={inviteRole}
                onChange={setInviteRole}
                options={[
                  { value: "read", label: "View" },
                  { value: "write", label: "Edit" },
                ]}
              />
              <button
                type="submit"
                disabled={inviting || !email.trim()}
                className="btn-press shrink-0 rounded-md bg-ink px-3 py-1.5 text-[12.5px] font-medium text-paper disabled:opacity-50"
              >
                {inviting ? "…" : "Add"}
              </button>
            </form>
            {shareError && <p className="mt-2 text-[12px] text-[#C75B39]">{shareError}</p>}

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
                    <button
                      onClick={() => revoke(m.userId)}
                      className="rounded px-1.5 py-0.5 text-[11px] text-ink/40 transition-colors hover:bg-ink/5 hover:text-[#C75B39]"
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
            className="btn-press w-full rounded-md border-[1.5px] border-ink bg-white py-2.5 font-medium text-ink shadow-[3px_3px_0_rgba(28,25,23,0.15)]"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
