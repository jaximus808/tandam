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
    <div className="tandem-scroll flex-1 overflow-y-auto bg-paper">
      <div className="max-w-4xl mx-auto px-6 py-14 space-y-12">
        <div className="tandem-mode-enter text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-gray-900/10 bg-white px-3 py-1 text-xs font-medium text-gray-500 shadow-sm">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-500" />
            </span>
            A blank canvas, ready for you and your agents
          </span>
          <h1 className="mt-5 font-display text-4xl font-medium tracking-tight text-gray-900">
            {canvasName ? canvasName : "Welcome to Tandem"}
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-gray-500">
            Pick a starting point below, or just start prompting your agent — the canvas takes
            shape as you go.
          </p>
          <p className="mt-3 text-xs text-gray-400">
            Haven't connected an agent yet?{" "}
            <button onClick={onOpenConnect} className="font-medium text-sky-600 hover:underline">
              Open the connect dialog
            </button>{" "}
            or{" "}
            <a
              href="/mcp"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-sky-600 hover:underline"
            >
              learn how to connect your MCP agent →
            </a>
          </p>
        </div>

        <section>
          <h2 className="mb-3 font-code text-[11px] font-medium uppercase tracking-[0.2em] text-gray-400">
            Start with a template
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                onClick={() => pick(t)}
                className="group relative overflow-hidden text-left bg-white rounded-2xl border border-gray-900/10 p-4 transition-all hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-md"
              >
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute -right-8 -top-8 h-20 w-20 rounded-full bg-sky-400/0 blur-2xl transition-colors duration-300 group-hover:bg-sky-400/15"
                />
                <div className="text-2xl mb-2" aria-hidden>{t.emoji}</div>
                <div className="font-medium text-gray-900">{t.name}</div>
                <div className="text-xs leading-relaxed text-gray-500 mt-0.5">{t.description}</div>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 font-code text-[11px] font-medium uppercase tracking-[0.2em] text-gray-400">
            Or try asking your agent
          </h2>
          <ul className="space-y-2">
            {EXAMPLE_PROMPTS.map((p, idx) => (
              <li
                key={idx}
                className="group flex items-center justify-between bg-white rounded-xl border border-gray-900/10 px-4 py-2.5 transition-colors hover:border-gray-300"
              >
                <span className="text-sm text-gray-700 mr-3">{p}</span>
                <button
                  onClick={() => copyPrompt(p, idx)}
                  className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-sky-600 transition-colors hover:bg-sky-50 hover:text-sky-700"
                >
                  {copiedIdx === idx ? "Copied!" : "Copy"}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <p className="text-center text-xs text-gray-400 pt-2">
          You can change modes anytime from the top bar after picking a template.
        </p>
      </div>
    </div>
  );
}
