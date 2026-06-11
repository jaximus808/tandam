import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import TandemLogo from "./TandemLogo";

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
      onJoin(canvas.code);
    } catch (err) {
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
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-gray-900/40 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="launcher-title"
        className="w-full max-w-md overflow-hidden rounded-lg border-[1.5px] border-ink bg-white font-brand shadow-[8px_8px_0_rgba(28,25,23,0.35)]"
      >
        {/* header */}
        <div className="flex items-center gap-2 border-b border-ink/10 bg-paper px-6 py-4">
          <TandemLogo size={22} animate={false} />
          <span id="launcher-title" className="font-display text-lg font-medium tracking-tight text-ink">
            Open a canvas
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-ink/40 transition-colors hover:bg-ink/5 hover:text-ink"
          >
            ✕
          </button>
        </div>

        <div className="space-y-5 p-6">
          {/* Create */}
          <form onSubmit={handleCreate} className="space-y-2">
            <label className="font-code text-[10.5px] font-medium uppercase tracking-[0.18em] text-ink/45">
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
              className="w-full rounded-md border border-ink/20 bg-white px-4 py-3 text-sm focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink"
            />
            <button
              type="submit"
              disabled={creating}
              className="btn-press w-full rounded-md bg-ink px-5 py-3 font-medium text-paper shadow-[3px_3px_0_#C75B39] disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create canvas →"}
            </button>
          </form>

          <div className="flex items-center gap-3 font-code text-[10px] font-medium uppercase tracking-[0.22em] text-ink/30">
            <span className="h-px flex-1 bg-ink/10" />
            or
            <span className="h-px flex-1 bg-ink/10" />
          </div>

          {/* Join */}
          <form onSubmit={handleJoin} className="space-y-2">
            <label className="font-code text-[10.5px] font-medium uppercase tracking-[0.18em] text-ink/45">
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
                className="flex-1 rounded-md border border-ink/20 bg-white px-4 py-3 font-code text-sm uppercase tracking-[0.2em] focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink"
              />
              <button
                type="submit"
                className="btn-press shrink-0 rounded-md border-[1.5px] border-ink bg-white px-5 py-3 font-medium text-ink shadow-[3px_3px_0_rgba(28,25,23,0.15)]"
              >
                Open
              </button>
            </div>
          </form>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            onClick={onOpenMCP}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-agent/30 bg-agent/10 px-4 py-2.5 font-code text-[11.5px] font-medium text-agent transition-colors hover:bg-agent/15"
          >
            connecting an AI agent instead? see the guide →
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
