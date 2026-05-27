import { useEffect, useRef, useState } from "react";

interface Props {
  code: string;
  apiUrl: string;
  version: number;
  onClose: () => void;
  onSwitchCanvas: () => void;
}

function dismissalKey(code: string) {
  return `tandem.connected.${code}`;
}

export function hasDismissedConnect(code: string): boolean {
  try {
    return localStorage.getItem(dismissalKey(code)) === "1";
  } catch {
    return false;
  }
}

export function markConnectDismissed(code: string) {
  try {
    localStorage.setItem(dismissalKey(code), "1");
  } catch {
    // ignore
  }
}

export default function ConnectModal({ code, apiUrl, version, onClose, onSwitchCanvas }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<"code" | "snippet" | null>(null);

  const snippet = `CANVAS_CODE=${code}\nAPI_URL=${apiUrl}`;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function copy(text: string, which: "code" | "snippet") {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(which);
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
    });
  }

  function imConnected() {
    markConnectDismissed(code);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-title"
        className="w-full max-w-md bg-white rounded-2xl shadow-xl p-6 outline-none"
      >
        <h2 id="connect-title" className="text-lg font-semibold text-gray-900">
          Connect Claude to this canvas
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          Share this code with Claude so it can read and write the same canvas.
        </p>

        <div className="mt-5">
          <label className="text-xs font-medium text-gray-700">Canvas code</label>
          <div className="mt-1 flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2.5">
            <span className="font-mono text-xl tracking-widest text-gray-900 flex-1">{code}</span>
            <button
              onClick={() => copy(code, "code")}
              className="text-xs text-blue-600 hover:text-blue-700 font-medium"
            >
              {copied === "code" ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>

        <div className="mt-4">
          <label className="text-xs font-medium text-gray-700">MCP gateway env</label>
          <div className="mt-1 relative">
            <pre className="bg-gray-900 text-gray-100 text-xs rounded-lg px-3 py-2.5 overflow-x-auto whitespace-pre">
{snippet}
            </pre>
            <button
              onClick={() => copy(snippet, "snippet")}
              className="absolute top-1.5 right-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-gray-100 px-2 py-1 rounded"
            >
              {copied === "snippet" ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>

        <ol className="mt-4 text-sm text-gray-600 space-y-1 list-decimal list-inside">
          <li>Paste the snippet into your MCP gateway's env.</li>
          <li>Restart Claude Code so it picks up the new env.</li>
          <li>Click "I'm connected" below.</li>
        </ol>

        <div className="mt-6 flex items-center gap-2">
          <button
            onClick={imConnected}
            className="flex-1 py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
          >
            I'm connected
          </button>
          <button
            onClick={onClose}
            className="px-3 py-2.5 text-sm text-gray-500 hover:text-gray-700"
          >
            Later
          </button>
        </div>

        <div className="mt-4 flex items-center justify-between text-xs text-gray-400">
          <button onClick={onSwitchCanvas} className="hover:text-gray-600">
            ← Switch canvas
          </button>
          <span>v{version}</span>
        </div>
      </div>
    </div>
  );
}
