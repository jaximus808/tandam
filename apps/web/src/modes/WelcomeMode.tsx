import { useState } from "react";
import { ArrowUpRight, Clock, Copy, Layers, Plus } from "lucide-react";
import type { DocumentType } from "../types";
import { CAPABILITIES, STARTER_PROMPTS, type Capability } from "../lib/starterPrompts";
import { listRecent } from "../lib/recentCanvases";
import { CREATABLE_DOC_TYPES, DOC_TYPE_LABEL, DOC_TYPE_TO_MODE } from "../lib/docTypes";
import { modeTheme } from "../lib/modeTheme";

interface Props {
  canvasName: string;
  /** This canvas's code — excluded from the "recent canvases" list. */
  currentCode: string;
  /** How many documents this canvas has — drives the "Open all tabs" start. */
  docCount: number;
  onOpenConnect: () => void;
  /** Open a recent canvas by code. */
  onOpenCanvas: (code: string) => void;
  /** Quick start: create a blank document of this type and focus it. */
  onCreateDoc: (type: DocumentType) => void;
  /** Open every document on the canvas as a tab at once. */
  onOpenAll: () => void;
}

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.round(d / 7);
  return `${w}w ago`;
}

/* The zero-open-tabs start page (roadmap item 10) — a VS Code-style welcome for
   an empty worksurface. Leads with what you can ask your agent to build (each
   capability doubles as a copyable prompt) rather than one-click templates; a
   compact start strip and recently opened canvases sit alongside. Still the blank
   surface: dot grid + a selection frame around the canvas name. */
export default function WelcomeMode({
  canvasName,
  currentCode,
  docCount,
  onOpenConnect,
  onOpenCanvas,
  onCreateDoc,
  onOpenAll,
}: Props) {
  // Key of whatever prompt was last copied, for transient "copied ✓" feedback.
  const [copied, setCopied] = useState<string | null>(null);
  const recents = listRecent().filter((c) => c.code !== currentCode);

  function copyPrompt(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    });
  }

  return (
    <div className="tandem-scroll relative flex-1 overflow-y-auto bg-paper">
      <div
        aria-hidden="true"
        className="surface-grid pointer-events-none absolute inset-0"
        style={{
          maskImage: "radial-gradient(110% 80% at 50% 0%, black 50%, transparent 100%)",
          WebkitMaskImage: "radial-gradient(110% 80% at 50% 0%, black 50%, transparent 100%)",
        }}
      />
      <div className="relative mx-auto max-w-5xl space-y-12 px-6 py-14">
        <div className="tandem-mode-enter text-center">
          <div>
            <span className="inline-flex items-center gap-2 rounded-md border border-ink/15 bg-white px-3 py-1 font-code text-[10.5px] text-ink/55">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand" />
              </span>
              blank surface · ready for you and your agents
            </span>
          </div>

          <div className="mt-9 inline-block">
            <div className="relative text-ink">
              <span aria-hidden="true" className="pointer-events-none absolute -inset-x-4 -inset-y-3 border-[1.5px] border-current opacity-25" />
              <span aria-hidden="true" className="sel-handle" style={{ top: -15, left: -19 }} />
              <span aria-hidden="true" className="sel-handle" style={{ top: -15, right: -19 }} />
              <span aria-hidden="true" className="sel-handle" style={{ bottom: -15, left: -19 }} />
              <span aria-hidden="true" className="sel-handle" style={{ bottom: -15, right: -19 }} />
              <span className="pointer-events-none absolute -left-4 -top-3 -translate-y-[calc(100%+5px)]">
                <span className="inline-flex items-center rounded-[3px] bg-ink px-1.5 py-0.5 font-code text-[10px] font-medium leading-none text-white">
                  you
                </span>
              </span>
              <h1 className="font-display text-4xl font-medium tracking-tight">
                {canvasName ? canvasName : "Welcome to Tandem"}
              </h1>
            </div>
          </div>

          <p className="mt-7 text-[15px] leading-relaxed text-ink/55">
            Just start prompting your agent — the canvas takes shape as you go. Here's a taste
            of what it can build.
          </p>
          <p className="mt-3 font-code text-[11px] text-ink/40">
            no agent connected yet?{" "}
            <button onClick={onOpenConnect} className="font-medium text-brand hover:underline">
              open the connect dialog
            </button>{" "}
            ·{" "}
            <a
              href="/mcp"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-brand hover:underline"
            >
              MCP setup guide →
            </a>
          </p>
        </div>

        {/* Front-and-center start: a big "Open all tabs" hero (when the canvas
            has content) so it's the first thing you see, with the blank-tab
            options tucked underneath it. */}
        <div className="flex flex-col items-center gap-5">
          {docCount > 0 && (
            <button
              onClick={onOpenAll}
              className="group inline-flex items-center gap-3.5 rounded-2xl bg-[#14A090] px-8 py-5 text-white transition-colors hover:bg-brand"
            >
              <Layers size={24} className="opacity-90" />
              <span className="text-xl font-semibold tracking-tight">Open all tabs</span>
              <span className="rounded-full bg-white/15 px-2.5 py-0.5 font-code text-[11px] font-medium text-white/85">
                {docCount} doc{docCount === 1 ? "" : "s"}
              </span>
            </button>
          )}

          <div className="flex flex-wrap items-center justify-center gap-2">
            <span className="mr-1 font-code text-[11px] text-ink/35">
              {docCount > 0 ? "or start a blank tab:" : "start a blank tab:"}
            </span>
            {CREATABLE_DOC_TYPES.map((type) => {
              const t = modeTheme(DOC_TYPE_TO_MODE[type]);
              return (
                <button
                  key={type}
                  onClick={() => onCreateDoc(type)}
                  className="group inline-flex items-center gap-1.5 rounded-md border border-ink/15 bg-white px-2.5 py-1.5 text-[13px] font-medium text-ink/75 transition-colors hover:border-ink/50 hover:text-ink"
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: t.solid }} />
                  {DOC_TYPE_LABEL[type]}
                  <Plus size={12} className="text-ink/30 transition-colors group-hover:text-ink/60" />
                </button>
              );
            })}
          </div>
        </div>

        {/* What the agent can build — each card is a copyable prompt to try it. */}
        <section>
          <h2 className="mb-3 font-code text-[11px] font-medium uppercase tracking-[0.22em] text-ink/40">
            Things to try
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {CAPABILITIES.map((c) => (
              <CapabilityCard
                key={c.title}
                cap={c}
                copied={copied === `cap:${c.title}`}
                onCopy={() => copyPrompt(c.prompt, `cap:${c.title}`)}
              />
            ))}
          </div>
        </section>

        {/* A few cross-cutting prompts + recently opened canvases side by side. */}
        <div className="grid gap-x-10 gap-y-10 lg:grid-cols-5">
          <section className="lg:col-span-3">
            <h2 className="mb-3 font-code text-[11px] font-medium uppercase tracking-[0.22em] text-ink/40">
              More prompts to start
            </h2>
            <ul className="overflow-hidden rounded-md border border-ink/15 bg-white">
              {STARTER_PROMPTS.map((p, idx) => (
                <li
                  key={idx}
                  className={`group flex items-center justify-between px-4 py-2.5 transition-colors hover:bg-paper ${
                    idx > 0 ? "border-t border-ink/10" : ""
                  }`}
                >
                  <span className="mr-3 text-sm text-ink/75">
                    <span aria-hidden className="mr-2 select-none font-code text-brand">›</span>
                    {p}
                  </span>
                  <button
                    onClick={() => copyPrompt(p, `prompt:${idx}`)}
                    className="shrink-0 rounded-[4px] border border-ink/10 px-2 py-1 font-code text-[10px] font-medium text-ink/50 transition-colors hover:border-brand/50 hover:text-brand"
                  >
                    {copied === `prompt:${idx}` ? "copied ✓" : "copy"}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="lg:col-span-2">
            <h2 className="mb-3 font-code text-[11px] font-medium uppercase tracking-[0.22em] text-ink/40">
              Recent canvases
            </h2>
            {recents.length === 0 ? (
              <div className="rounded-md border border-dashed border-ink/15 bg-white/50 px-4 py-6 text-center">
                <Clock size={16} className="mx-auto mb-2 text-ink/25" />
                <p className="text-[12px] leading-relaxed text-ink/45">
                  Canvases you open show up here for quick re-entry.
                </p>
              </div>
            ) : (
              <ul className="overflow-hidden rounded-md border border-ink/15 bg-white">
                {recents.map((c, idx) => (
                  <li key={c.code} className={idx > 0 ? "border-t border-ink/10" : ""}>
                    <button
                      onClick={() => onOpenCanvas(c.code)}
                      className="group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-paper"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-ink group-hover:text-brand">
                          {c.name || "Untitled canvas"}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 font-code text-[10px] text-ink/40">
                          <span className="tracking-[0.14em]">{c.code}</span>
                          <span aria-hidden>·</span>
                          <span>{relativeTime(c.lastOpenedAt)}</span>
                        </div>
                      </div>
                      <ArrowUpRight
                        size={14}
                        className="shrink-0 text-ink/25 transition-colors group-hover:text-brand"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <p className="pt-2 text-center font-code text-[10.5px] text-ink/35">
          tabs open as your agent builds · the “+” in the strip above starts a new document
        </p>
      </div>
    </div>
  );
}

function CapabilityCard({
  cap,
  copied,
  onCopy,
}: {
  cap: Capability;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <button
      onClick={onCopy}
      title="Copy this prompt"
      className="group relative flex flex-col rounded-md border border-ink/15 bg-white p-4 text-left transition-all hover:-translate-y-0.5 hover:border-ink/70 hover:shadow-[4px_4px_0_rgba(28,25,23,0.12)]"
    >
      <div className="flex items-center gap-2.5">
        <div className="inline-grid h-9 w-9 place-items-center rounded-[5px] border border-ink/10 bg-paper text-xl" aria-hidden>
          {cap.emoji}
        </div>
        <div className="font-medium text-ink">{cap.title}</div>
      </div>
      <div className="mt-2 text-xs leading-relaxed text-ink/55">{cap.blurb}</div>
      <div className="mt-3 flex items-start gap-2 rounded-[5px] border border-ink/10 bg-paper/60 px-2.5 py-2">
        <span aria-hidden className="mt-px select-none font-code text-[13px] leading-none text-brand">›</span>
        <span className="text-[12px] leading-relaxed text-ink/70">{cap.prompt}</span>
      </div>
      <span
        className={`absolute right-3 top-3 inline-flex items-center gap-1 font-code text-[10px] font-medium transition-colors ${
          copied ? "text-brand" : "text-ink/30 group-hover:text-ink/55"
        }`}
      >
        {copied ? "copied ✓" : <Copy size={12} />}
      </span>
    </button>
  );
}
