import { useEffect, useRef, useState } from "react";

interface Props {
  code: string;
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

export default function ConnectModal({ code, version, onClose, onSwitchCanvas }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<"code" | "prompt" | null>(null);

  const prompt = `Connect to Tandem canvas ${code}`;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function copy(text: string, which: "code" | "prompt") {
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
          Connect your agent to this canvas
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          Anyone with the Tandem MCP server connected can read and write this
          canvas — just tell your agent to join.
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

        <div className="mt-5 rounded-xl border-2 border-blue-200 bg-blue-50/60 p-4">
          <div className="flex items-center gap-2 text-blue-700">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
            <span className="text-sm font-semibold">In your AI agent's chat, paste this:</span>
          </div>

          <div className="mt-2.5 flex items-center gap-2 bg-white border border-blue-200 rounded-lg pl-3 pr-1.5 py-3 shadow-sm">
            <span className="font-mono text-sm font-medium text-gray-900 flex-1 min-w-0 break-words">
              {prompt}
            </span>
            <button
              onClick={() => copy(prompt, "prompt")}
              className="shrink-0 text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-md font-medium"
            >
              {copied === "prompt" ? "Copied!" : "Copy"}
            </button>
          </div>

          <p className="mt-2.5 text-xs text-blue-900/70">
            Your agent reads the code and calls <span className="font-mono">canvas.connect</span> —
            it'll be editing this canvas in seconds.
          </p>
        </div>

        <div className="mt-4 rounded-lg bg-sky-50 border border-sky-100 px-3 py-2.5">
          <p className="text-xs text-sky-900">
            First time? You'll need the Tandem MCP server connected to your agent.{" "}
            <a
              href="/mcp"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium underline hover:text-sky-700"
            >
              Learn how to connect your MCP agent here →
            </a>
          </p>
        </div>

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
