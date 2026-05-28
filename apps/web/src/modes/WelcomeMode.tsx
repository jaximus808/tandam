import { useState } from "react";
import { TEMPLATES, EXAMPLE_PROMPTS, applyTemplate, type Template } from "../lib/templates";

interface Props {
  canvasName: string;
  onOpenConnect: () => void;
}

export default function WelcomeMode({ canvasName, onOpenConnect }: Props) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  function pick(t: Template) {
    applyTemplate(t);
  }

  function copyPrompt(p: string, idx: number) {
    navigator.clipboard.writeText(p).then(() => {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500);
    });
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-10 space-y-10">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-semibold text-gray-900">
            Welcome to Tandem Canvas
          </h1>
          <p className="text-gray-500">
            {canvasName ? `"${canvasName}" — ` : ""}pick a starting point, or just start prompting.
          </p>
          <p className="text-xs text-gray-400">
            Haven't connected an agent yet?{" "}
            <button onClick={onOpenConnect} className="text-blue-600 hover:underline">
              Open the connect dialog
            </button>{" "}
            or{" "}
            <a
              href="/mcp"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              learn how to connect your MCP agent →
            </a>
          </p>
        </div>

        <section>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Start with a template
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                onClick={() => pick(t)}
                className="text-left bg-white rounded-xl border border-gray-200 p-4 hover:border-blue-400 hover:shadow-sm transition-all"
              >
                <div className="text-2xl mb-2" aria-hidden>{t.emoji}</div>
                <div className="font-medium text-gray-900">{t.name}</div>
                <div className="text-xs text-gray-500 mt-0.5">{t.description}</div>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Or try asking your agent
          </h2>
          <ul className="space-y-2">
            {EXAMPLE_PROMPTS.map((p, idx) => (
              <li
                key={idx}
                className="flex items-center justify-between bg-white rounded-lg border border-gray-200 px-4 py-2.5"
              >
                <span className="text-sm text-gray-700 mr-3">{p}</span>
                <button
                  onClick={() => copyPrompt(p, idx)}
                  className="shrink-0 text-xs text-blue-600 hover:text-blue-700 font-medium"
                >
                  {copiedIdx === idx ? "Copied!" : "Copy"}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <p className="text-center text-xs text-gray-400 pt-4">
          You can change modes anytime from the top bar after picking a template.
        </p>
      </div>
    </div>
  );
}
