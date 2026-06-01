import { sendOp } from "../lib/ws";

interface Props {
  title: string;
  hint?: string;
}

export default function EmptyState({ title, hint }: Props) {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="tandem-mode-enter relative overflow-hidden rounded-2xl border border-gray-900/10 bg-white px-8 py-7 text-center max-w-sm shadow-sm">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-12 -top-12 h-28 w-28 rounded-full bg-sky-400/10 blur-2xl"
        />
        <p className="font-display text-lg font-medium text-gray-900">{title}</p>
        {hint && <p className="mt-1.5 text-sm leading-relaxed text-gray-500">{hint}</p>}
        <button
          onClick={() => sendOp({ op: "mode.set", mode: "welcome" })}
          className="mt-5 inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:border-sky-300 hover:text-sky-600"
        >
          ← Back to templates
        </button>
      </div>
    </div>
  );
}
