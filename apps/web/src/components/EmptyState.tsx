import { sendOp } from "../lib/ws";

interface Props {
  title: string;
  hint?: string;
}

export default function EmptyState({ title, hint }: Props) {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="bg-white rounded-xl border border-gray-200 px-6 py-5 text-center max-w-sm">
        <p className="text-sm font-medium text-gray-700">{title}</p>
        {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
        <button
          onClick={() => sendOp({ op: "mode.set", mode: "welcome" })}
          className="mt-4 text-xs text-blue-600 hover:text-blue-700 font-medium"
        >
          ← Back to templates
        </button>
      </div>
    </div>
  );
}
