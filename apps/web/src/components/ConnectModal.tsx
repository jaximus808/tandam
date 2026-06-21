import { useEffect, useRef, useState } from "react";
import type { PresentAgent } from "../lib/useAgentActivity";

interface Props {
  code: string;
  version: number;
  /** Live agents currently on this canvas — drives the connection detection. */
  agents: PresentAgent[];
  onClose: () => void;
  onSwitchCanvas: () => void;
}

// Hosted Streamable-HTTP MCP endpoint — the zero-install path for Claude's own
// web / desktop / mobile clients (Customize → Connectors).
const CONNECTOR_URL = "https://tandemcanvas.com/api/mcp";

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

/* ── inline icon set (no dep — same approach as the landing worksurface) ─────── */
function Icon({ name, className = "" }: { name: string; className?: string }) {
  const c = {
    className,
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "spark":
      return (
        <svg {...c} fill="currentColor" stroke="none">
          <path d="M12 2l1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7z" />
        </svg>
      );
    case "check":
      return (
        <svg {...c}>
          <path d="M20 6L9 17l-5-5" />
        </svg>
      );
    case "copy":
      return (
        <svg {...c}>
          <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
          <path d="M5.5 15.5H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8.5a2 2 0 0 1 2 2v.5" />
        </svg>
      );
    case "arrow":
      return (
        <svg {...c}>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      );
    case "external":
      return (
        <svg {...c}>
          <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
        </svg>
      );
    case "chevron":
      return (
        <svg {...c}>
          <path d="M9 6l6 6-6 6" />
        </svg>
      );
    default:
      return null;
  }
}

/** Mono system label — matches SysLabel on the landing surface. */
function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-code text-[10px] uppercase tracking-[0.22em] text-ink/40">
      {children}
    </span>
  );
}

/** A copy-target field: mono value + a press-able copy button. */
function CopyField({
  value,
  copied,
  onCopy,
  accent = false,
}: {
  value: string;
  copied: boolean;
  onCopy: () => void;
  accent?: boolean;
}) {
  return (
    <div
      className={[
        "flex items-center gap-2 rounded-md border bg-white py-1.5 pl-3 pr-1.5",
        accent ? "border-agent/35" : "border-ink/15",
      ].join(" ")}
    >
      <span className="min-w-0 flex-1 break-all font-code text-[12.5px] text-ink">{value}</span>
      <button
        onClick={onCopy}
        className={[
          "btn-press inline-flex shrink-0 items-center gap-1 rounded-[5px] px-2.5 py-1.5 font-code text-[11px] font-medium text-paper",
          accent ? "bg-agent" : "bg-ink",
        ].join(" ")}
      >
        <Icon name={copied ? "check" : "copy"} className="h-3 w-3" />
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

type CopyKey = "code" | "prompt" | "connector" | "config";

export default function ConnectModal({ code, version, agents, onClose, onSwitchCanvas }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<CopyKey | null>(null);
  // Most people land here with Tandem already wired into their agent, so the
  // default is the one thing they need — the code. The one-time server setup is
  // tucked behind a disclosure for genuine first-timers.
  const [showSetup, setShowSetup] = useState(false);
  const [setupTab, setSetupTab] = useState<"claude" | "editor">("claude");

  const prompt = `Connect to Tandem canvas ${code}`;
  const config = `{
  "mcpServers": {
    "tandem": {
      "command": "npx",
      "args": ["-y", "@jaximus/tandem-mcp"]
    }
  }
}`;

  // The whole point of the live strip: an agent on this canvas means it worked.
  const connectedAgent = agents[0] ?? null;
  const connected = Boolean(connectedAgent);

  // Once an agent actually joins, never auto-nag about this canvas again.
  useEffect(() => {
    if (connected) markConnectDismissed(code);
  }, [connected, code]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function copy(text: string, which: CopyKey) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(which);
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
    });
  }

  function done() {
    markConnectDismissed(code);
    onClose();
  }

  function tabPill(active: boolean) {
    return [
      "rounded-md border px-2.5 py-1 font-code text-[11px] font-medium transition-colors",
      active
        ? "border-ink bg-ink text-paper"
        : "border-ink/15 bg-white text-ink/50 hover:border-ink/35 hover:text-ink",
    ].join(" ");
  }

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-ink/40 p-4 font-brand backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-title"
        className="relative flex max-h-[88vh] w-full max-w-md flex-col overflow-hidden rounded-lg border-[1.5px] border-ink bg-white text-ink shadow-[10px_10px_0_rgba(28,25,23,0.12)] outline-none"
      >
        <div className="overflow-y-auto px-5 pb-5 pt-5">
          {/* ── Header ─────────────────────────────────────────────────────── */}
          <Kicker>Connect · this canvas</Kicker>
          <h2 id="connect-title" className="mt-1 font-display text-xl font-medium tracking-tight">
            {connected ? "Your agent is in." : "Bring an agent onto this canvas"}
          </h2>

          {connected ? (
            <>
              {/* ── Confirmation strip — shown only once an agent has joined ── */}
              <div className="mt-3 flex items-center gap-2.5 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2">
                <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-emerald-500 text-white">
                  <Icon name="check" className="h-2.5 w-2.5" />
                </span>
                <span className="font-code text-[11.5px] font-medium text-emerald-700">
                  {connectedAgent?.name ?? "An agent"} joined this canvas
                </span>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-ink/60">
                It can read and write everything here, live — alongside you and anyone else on the
                code.
              </p>
            </>
          ) : (
            <>
              {/* ── Primary: tell the agent to join ──────────────────────── */}
              <div className="mt-4">
                <div className="flex items-center gap-1.5 text-agent">
                  <Icon name="spark" className="h-3.5 w-3.5" />
                  <span className="font-code text-[11px] font-medium uppercase tracking-[0.12em]">
                    Paste into your agent's chat
                  </span>
                </div>
                <div className="mt-2">
                  <CopyField
                    value={prompt}
                    copied={copied === "prompt"}
                    onCopy={() => copy(prompt, "prompt")}
                    accent
                  />
                </div>
                <p className="mt-2 font-code text-[10.5px] leading-relaxed text-ink/45">
                  Your agent calls canvas.connect with the code and starts editing in seconds.
                </p>
              </div>

              {/* ── Optional: one-time server setup for first-timers ───────── */}
              <div className="mt-4">
                <button
                  onClick={() => setShowSetup((s) => !s)}
                  className="flex w-full items-center gap-2 rounded-md border border-ink/15 bg-paper px-3 py-2 text-left transition-colors hover:border-ink/30"
                  aria-expanded={showSetup}
                >
                  <Icon
                    name="chevron"
                    className={`h-3.5 w-3.5 text-ink/40 transition-transform ${showSetup ? "rotate-90" : ""}`}
                  />
                  <span className="text-[12.5px] font-medium text-ink/75">
                    First time? Add Tandem to your agent
                  </span>
                  <span className="ml-auto font-code text-[10px] uppercase tracking-[0.14em] text-ink/35">
                    one-time
                  </span>
                </button>

                {showSetup && (
                  <div className="mt-2 rounded-md border border-ink/15 bg-paper p-3">
                    <div className="flex gap-1.5">
                      <button onClick={() => setSetupTab("claude")} className={tabPill(setupTab === "claude")}>
                        Claude · web / desktop
                      </button>
                      <button onClick={() => setSetupTab("editor")} className={tabPill(setupTab === "editor")}>
                        Editor / CLI
                      </button>
                    </div>

                    {setupTab === "claude" ? (
                      <div className="mt-2.5">
                        <p className="text-[12px] leading-relaxed text-ink/65">
                          In Claude, open{" "}
                          <span className="font-medium text-ink">
                            Customize → Connectors → Add custom connector
                          </span>{" "}
                          and paste this URL (leave OAuth blank):
                        </p>
                        <div className="mt-2">
                          <CopyField
                            value={CONNECTOR_URL}
                            copied={copied === "connector"}
                            onCopy={() => copy(CONNECTOR_URL, "connector")}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2.5">
                        <p className="text-[12px] leading-relaxed text-ink/65">
                          Add this to your MCP config — Claude Code, Cursor, Codex, any MCP client:
                        </p>
                        <div className="relative mt-2">
                          <pre className="overflow-x-auto rounded-md border border-ink/15 bg-ink px-3 py-2.5 font-code text-[11px] leading-relaxed text-paper">
{config}
                          </pre>
                          <button
                            onClick={() => copy(config, "config")}
                            className="btn-press absolute right-2 top-2 inline-flex items-center gap-1 rounded-[5px] bg-white/15 px-2 py-1 font-code text-[10.5px] font-medium text-paper hover:bg-white/25"
                          >
                            <Icon name={copied === "config" ? "check" : "copy"} className="h-3 w-3" />
                            {copied === "config" ? "Copied" : "Copy"}
                          </button>
                        </div>
                      </div>
                    )}

                    <a
                      href="/mcp"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2.5 inline-flex items-center gap-1.5 font-code text-[11px] font-medium text-agent transition-colors hover:text-ink"
                    >
                      Full setup guide — every client
                      <Icon name="external" className="h-3 w-3" />
                    </a>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Footer (pinned) ─────────────────────────────────────────────── */}
        <div className="border-t border-ink/10 px-5 py-3.5">
          {connected ? (
            <button
              onClick={done}
              className="btn-press inline-flex w-full items-center justify-center gap-2 rounded-md bg-ink px-6 py-2.5 font-medium text-paper shadow-[4px_4px_0_#C75B39]"
            >
              Start working
              <Icon name="arrow" className="h-4 w-4" />
            </button>
          ) : (
            <div className="flex items-center gap-3">
              <button
                onClick={done}
                className="btn-press flex-1 rounded-md border-[1.5px] border-ink bg-white py-2.5 font-medium text-ink shadow-[3px_3px_0_rgba(28,25,23,0.15)]"
              >
                Done
              </button>
              <button onClick={onClose} className="px-2 py-2.5 text-sm text-ink/45 hover:text-ink/70">
                Later
              </button>
            </div>
          )}
          <div className="mt-3 flex items-center justify-between font-code text-[10.5px] text-ink/35">
            <button onClick={onSwitchCanvas} className="transition-colors hover:text-ink/60">
              ← Switch canvas
            </button>
            <span>v{version}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
