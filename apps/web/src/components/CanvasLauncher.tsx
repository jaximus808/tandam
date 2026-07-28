import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { createPortal } from "react-dom";
import TandemLogo from "./TandemLogo";
import posthog from "../lib/posthog";

interface Props {
  initialMode: "create" | "join";
  onJoin: (code: string) => void;
  onClose: () => void;
  onOpenMCP: () => void;
}

/* The hero used to carry both the create-canvas and join-by-code forms inline,
   which crowded it. They now live here, in one focused modal opened by the
   hero's CTA buttons. `initialMode` decides which field is autofocused. */
export default function CanvasLauncher({ initialMode, onJoin, onClose, onOpenMCP }: Props) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const t = setTimeout(() => {
      (initialMode === "join" ? codeRef : nameRef).current?.focus();
    }, 60);
    return () => clearTimeout(t);
  }, [initialMode]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give your canvas a name.");
      nameRef.current?.focus();
      return;
    }
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/canvases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Send the session cookie so a logged-in create is owned by the account.
        credentials: "same-origin",
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(res.status >= 500 ? "Server error — try again." : detail);
      }
      const canvas = (await res.json()) as { code: string };
      posthog.capture("canvas_created", { canvas_code: canvas.code });
      onJoin(canvas.code);
    } catch (err) {
      posthog.captureException(err instanceof Error ? err : new Error(String(err)));
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (clean.length !== 8) {
      setError("Canvas codes are 8 characters.");
      return;
    }
    onJoin(clean);
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="launcher-title"
        className="w-full max-w-md overflow-hidden rounded-[10px] border border-ink/10 bg-surface shadow-lg"
      >
        {/* header */}
        <div className="flex items-center gap-2 border-b border-ink/10 bg-paper px-6 py-4">
          <TandemLogo size={28} animate={false} />
          <span id="launcher-title" className="text-lg font-semibold tracking-tight text-ink">
            Open a canvas
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-ink/40 transition-colors hover:bg-ink/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X size={15} />
          </button>
        </div>

        <div className="space-y-5 p-6">
          {/* Create */}
          <form onSubmit={handleCreate} className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-ink/50">
              Start something new
            </label>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError("");
              }}
              placeholder="Name a canvas — anything at all"
              className="w-full rounded-md border border-ink/15 bg-surface px-4 py-3 text-sm focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/20"
            />
            <button
              type="submit"
              disabled={creating}
              className="w-full rounded-md bg-accent px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create canvas →"}
            </button>
          </form>

          <div className="flex items-center gap-3 text-[10px] font-medium uppercase tracking-wide text-ink/30">
            <span className="h-px flex-1 bg-ink/10" />
            or
            <span className="h-px flex-1 bg-ink/10" />
          </div>

          {/* Join */}
          <form onSubmit={handleJoin} className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-ink/50">
              Join with a code
            </label>
            <div className="flex gap-2">
              <input
                ref={codeRef}
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.toUpperCase());
                  setError("");
                }}
                placeholder="TOKYO7X3K"
                maxLength={8}
                className="flex-1 rounded-md border border-ink/15 bg-surface px-4 py-3 font-code text-sm uppercase tracking-widest focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/20"
              />
              <button
                type="submit"
                className="shrink-0 rounded-md border border-ink/15 bg-surface px-5 py-3 text-sm font-medium text-ink transition-colors hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                Open
              </button>
            </div>
          </form>

          {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}

          <button
            onClick={onOpenMCP}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-4 py-2.5 text-[12px] font-medium text-accent transition-colors hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Connecting an AI agent instead? See the guide →
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
