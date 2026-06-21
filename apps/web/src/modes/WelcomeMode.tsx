import { useState } from "react";
import type { CanvasMode } from "../types";
import { TEMPLATES, EXAMPLE_PROMPTS, applyTemplate, type Template } from "../lib/templates";

interface Props {
  canvasName: string;
  onOpenConnect: () => void;
  // Move this viewer into the template's mode locally after applying it.
  // Applying a template IS a shared mutation (template.apply), but the person
  // who clicked should follow into it without yanking everyone else.
  onApply?: (mode: CanvasMode) => void;
}

/* The blank-surface moment: an empty canvas is literally an empty worksurface —
   dot grid, a selection frame around the canvas name (you have it selected),
   and templates pinned to the grid as placeable objects. */
export default function WelcomeMode({ canvasName, onOpenConnect, onApply }: Props) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  function pick(t: Template) {
    applyTemplate(t);
    onApply?.(t.mode);
  }

  function copyPrompt(p: string, idx: number) {
    navigator.clipboard.writeText(p).then(() => {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500);
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
      <div className="relative mx-auto max-w-4xl space-y-12 px-6 py-14">
        <div className="tandem-mode-enter text-center">
          <div>
            <span className="inline-flex items-center gap-2 rounded-md border border-ink/15 bg-white px-3 py-1 font-code text-[10.5px] text-ink/55">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-agent opacity-70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-agent" />
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
            Pick a starting point below, or just start prompting your agent — the canvas takes
            shape as you go.
          </p>
          <p className="mt-3 font-code text-[11px] text-ink/40">
            no agent connected yet?{" "}
            <button onClick={onOpenConnect} className="font-medium text-agent hover:underline">
              open the connect dialog
            </button>{" "}
            ·{" "}
            <a
              href="/mcp"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-agent hover:underline"
            >
              MCP setup guide →
            </a>
          </p>
        </div>

        <section>
          <h2 className="mb-3 font-code text-[11px] font-medium uppercase tracking-[0.22em] text-ink/40">
            Start with a template
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                onClick={() => pick(t)}
                className="group rounded-md border border-ink/15 bg-white p-4 text-left transition-all hover:-translate-y-0.5 hover:border-ink/70 hover:shadow-[4px_4px_0_rgba(28,25,23,0.12)]"
              >
                <div className="mb-2 inline-grid h-9 w-9 place-items-center rounded-[5px] border border-ink/10 bg-paper text-xl" aria-hidden>
                  {t.emoji}
                </div>
                <div className="font-medium text-ink">{t.name}</div>
                <div className="mt-0.5 text-xs leading-relaxed text-ink/55">{t.description}</div>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 font-code text-[11px] font-medium uppercase tracking-[0.22em] text-ink/40">
            Or try asking your agent
          </h2>
          <ul className="overflow-hidden rounded-md border border-ink/15 bg-white">
            {EXAMPLE_PROMPTS.map((p, idx) => (
              <li
                key={idx}
                className={`group flex items-center justify-between px-4 py-2.5 transition-colors hover:bg-paper ${
                  idx > 0 ? "border-t border-ink/10" : ""
                }`}
              >
                <span className="mr-3 text-sm text-ink/75">
                  <span aria-hidden className="mr-2 select-none font-code text-agent">›</span>
                  {p}
                </span>
                <button
                  onClick={() => copyPrompt(p, idx)}
                  className="shrink-0 rounded-[4px] border border-ink/10 px-2 py-1 font-code text-[10px] font-medium text-ink/50 transition-colors hover:border-agent/50 hover:text-agent"
                >
                  {copiedIdx === idx ? "copied ✓" : "copy"}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <p className="pt-2 text-center font-code text-[10.5px] text-ink/35">
          you can change modes anytime from the top bar after picking a template
        </p>
      </div>
    </div>
  );
}
