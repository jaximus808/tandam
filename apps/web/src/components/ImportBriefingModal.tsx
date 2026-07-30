import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { importBriefing } from "../lib/api";

/* TDM-30 — the import entry point for a repo's AGENTS.md / CLAUDE.md.

   A canvas's BRIEFING is the document every agent is handed on connect
   (GET /api/canvas/context). Until now the only way to designate one was to
   write the column by hand, so the capability existed and nobody could reach
   it. This modal is that reach: paste the file, or give us its URL, and one
   call creates the document, writes the file into it, and designates it.

   Deliberately two fields and a toggle. It is a file-shaped thing going into a
   file-shaped slot — anything more (folder pickers, sync toggles, shelf-life
   sliders) would be inventing choices the user doesn't have yet. v1 is a
   one-shot copy; there is no file watching, and the modal says so rather than
   letting anyone assume it. E1.5 owns the freshness UI that follows.

   Styled off ConnectModal (kicker, tab pills, rounded-[10px] surface card) and
   DeleteAccountModal (portal, error strip), so it reads as the same app. */

type Source = "paste" | "url";

const DEFAULT_DOC_NAME = "Briefing";

export default function ImportBriefingModal({
  code,
  onClose,
  onImported,
}: {
  code: string;
  onClose: () => void;
  /** Fires with the briefing document's id so the caller can open its tab. */
  onImported: (docId: string) => void;
}) {
  const [source, setSource] = useState<Source>("paste");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  const ready = (source === "paste" ? content : url).trim().length > 0;
  const docName = name.trim() || DEFAULT_DOC_NAME;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // Put the caret in the field the chosen source actually uses — switching tabs
  // should land you ready to type, not hunting for the input.
  useEffect(() => {
    if (source === "paste") textareaRef.current?.focus();
    else urlRef.current?.focus();
  }, [source]);

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await importBriefing(code, {
        content: source === "paste" ? content : undefined,
        sourceUrl: source === "url" ? url.trim() : undefined,
        name: name.trim() || undefined,
      });
      onImported(res.briefingDocId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not import the briefing");
      setBusy(false);
    }
  }

  // ⌘/Ctrl+Enter submits from anywhere in the form — the expected shortcut for a
  // box you've just pasted a page of text into.
  function onFormKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  }

  function tabPill(active: boolean) {
    return [
      "rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
      active
        ? "border-accent bg-accent text-white"
        : "border-ink/15 bg-surface text-ink/50 hover:border-ink/35 hover:text-ink",
    ].join(" ");
  }

  const fieldClass =
    "mt-1.5 w-full rounded-md border border-ink/15 bg-paper px-3 py-2 text-ink placeholder:text-ink/25 " +
    "focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/20 " +
    "disabled:cursor-not-allowed disabled:opacity-60";

  return createPortal(
    <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4">
      <button
        aria-label="Cancel"
        onClick={() => {
          if (!busy) onClose();
        }}
        className="absolute inset-0 bg-black/40"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-briefing-title"
        onKeyDown={onFormKeyDown}
        className="relative flex max-h-[88dvh] w-full max-w-lg flex-col overflow-hidden rounded-[10px] border border-ink/10 bg-surface text-ink shadow-lg"
      >
        <div className="tandem-scroll overflow-y-auto px-5 pb-5 pt-5">
          <span className="text-xs font-medium uppercase tracking-wide text-ink/50">
            Briefing · this canvas
          </span>
          <h2 id="import-briefing-title" className="mt-1 text-xl font-semibold tracking-tight">
            Import AGENTS.md
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-ink/60">
            Bring in your repo's AGENTS.md or CLAUDE.md. It becomes this canvas's briefing — the
            read-me-first every agent gets the moment it connects.
          </p>

          <div className="mt-4 flex gap-1.5">
            <button
              type="button"
              onClick={() => setSource("paste")}
              className={tabPill(source === "paste")}
              aria-pressed={source === "paste"}
            >
              Paste the file
            </button>
            <button
              type="button"
              onClick={() => setSource("url")}
              className={tabPill(source === "url")}
              aria-pressed={source === "url"}
            >
              Fetch a URL
            </button>
          </div>

          {source === "paste" ? (
            <label className="mt-3 block">
              <span className="text-xs font-medium text-ink/60">File contents</span>
              <textarea
                ref={textareaRef}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                disabled={busy}
                autoFocus
                spellCheck={false}
                rows={10}
                placeholder={"# AGENTS.md\n\nHow agents should work in this repo…"}
                className={`${fieldClass} tandem-scroll resize-y font-code text-[12.5px] leading-relaxed`}
              />
            </label>
          ) : (
            <label className="mt-3 block">
              <span className="text-xs font-medium text-ink/60">File URL</span>
              <input
                ref={urlRef}
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                placeholder="https://github.com/you/repo/blob/main/AGENTS.md"
                className={`${fieldClass} font-code text-[12.5px]`}
              />
              <span className="mt-1.5 block text-[11px] leading-relaxed text-ink/45">
                A GitHub file link works as-is — we fetch the raw file over https. Public URLs only.
              </span>
            </label>
          )}

          <label className="mt-3 block">
            <span className="text-xs font-medium text-ink/60">Document name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              autoComplete="off"
              placeholder={DEFAULT_DOC_NAME}
              className={`${fieldClass} text-sm`}
            />
          </label>

          {/* What the button will actually do, in the app's own nouns. Importing
              is also a verification — saying so here is where the freshness
              model is easiest to learn. */}
          <p className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-ink/45">
            <span>Lands in a notes document called</span>
            <span className="rounded border border-ink/10 bg-paper px-1.5 py-0.5 font-code text-[10.5px] text-ink/70">
              {docName}
            </span>
            <span>and is marked verified today. Re-import to refresh it — no file sync.</span>
          </p>

          {error && (
            <p className="mt-4 flex items-start gap-2 rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </p>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-md border border-ink/15 bg-surface px-4 py-2 text-sm font-medium text-ink/70 transition-colors hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!ready || busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy && <LoaderCircle className="h-4 w-4 animate-spin" />}
              {busy ? "Importing…" : "Import briefing"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
