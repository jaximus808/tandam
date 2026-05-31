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
        className="w-full max-w-md overflow-hidden rounded-2xl bg-white font-brand shadow-2xl"
      >
        {/* header */}
        <div className="flex items-center gap-2 border-b border-gray-100 px-6 py-4">
          <TandemLogo size={22} animate={false} />
          <span id="launcher-title" className="font-display text-lg font-medium tracking-tight">
            Open a canvas
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
          >
            ✕
          </button>
        </div>

        <div className="space-y-5 p-6">
          {/* Create */}
          <form onSubmit={handleCreate} className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">
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
              className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-sky-400"
            />
            <button
              type="submit"
              disabled={creating}
              className="w-full rounded-xl bg-gray-900 px-5 py-3 font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create canvas →"}
            </button>
          </form>

          <div className="flex items-center gap-3 text-[11px] font-medium uppercase tracking-widest text-gray-300">
            <span className="h-px flex-1 bg-gray-100" />
            or
            <span className="h-px flex-1 bg-gray-100" />
          </div>

          {/* Join */}
          <form onSubmit={handleJoin} className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">
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
                className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-3 font-code text-sm uppercase tracking-widest focus:border-transparent focus:outline-none focus:ring-2 focus:ring-sky-400"
              />
              <button
                type="submit"
                className="shrink-0 rounded-xl border border-gray-300 bg-white px-5 py-3 font-medium text-gray-700 transition-colors hover:bg-gray-50"
              >
                Open
              </button>
            </div>
          </form>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            onClick={onOpenMCP}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-sky-100 bg-sky-50 px-4 py-2.5 text-sm font-medium text-sky-700 transition-colors hover:bg-sky-100"
          >
            Connecting an AI agent instead? See the guide →
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
