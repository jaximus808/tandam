/* ─────────────────────────────────────────────────────────────────────────────
   QuickstartSection — "Two minutes to your first shared queue." Three
   copy-paste blocks, each a dark terminal card with a copy button:
     1. the Claude Code MCP one-liner (verified against README §Quickstart),
     2. a compact ~10-line CLAUDE.md loop (full version lives in the README),
     3. the hosted Streamable-HTTP endpoint for claude.ai / Cursor.

   Usage (TDM-6 assembly — self-contained, no props):

     import QuickstartSection from "../components/landing/QuickstartSection";
     …
     <QuickstartSection />
   ──────────────────────────────────────────────────────────────────────────── */

import { useState, type ReactNode } from "react";

const MCP_ADD_CMD = "claude mcp add tandem -- npx -y @jaximus/tandem-mcp";

// Compact loop — a distilled version of the README's CLAUDE.md block. Keep the
// tool names and the claimed:false semantics exactly in sync with the README.
const CLAUDE_MD_SNIPPET = `## Tandem task queue

Shared work queue for this repo: Tandem canvas \`AB3XK9QZ\`.

1. \`canvas_connect\` with code \`AB3XK9QZ\` (once per session).
2. \`context_get\` for the current briefing. If it comes back \`stale\`,
   say so before acting on it.
3. \`queue_next\` for the next approved task, then \`task_claim\` to take it.
   If the claim returns \`{ claimed: false }\`, another agent won — take
   the next task instead.
4. Do the work. Start commit messages with the ticket id (\`TDM-7: …\`).
5. \`task_complete\` with a result — always include the commit hash.`;

const HOSTED_ENDPOINT = "https://tandemcanvas.com/api/mcp";

function CopyIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={() => {
        const flash = () => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        };
        // navigator.clipboard exists only in secure contexts (https/localhost)
        // — an http self-host or LAN demo gets the execCommand fallback so the
        // page's primary conversion path never fails silently.
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(flash, () => {});
        } else {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          try {
            if (document.execCommand("copy")) flash();
          } finally {
            document.body.removeChild(ta);
          }
        }
      }}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded border px-2 py-1 font-code text-[10px] transition-colors ${
        copied
          ? "border-emerald-400/40 text-emerald-400"
          : "border-white/15 text-zinc-500 hover:border-white/30 hover:text-zinc-200"
      }`}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? "copied" : "copy"}
    </button>
  );
}

/** A dark terminal card: title bar (traffic dots · mono label · copy) + body.
    Explicit dark ground so it reads the same in both themes. */
function TerminalBlock({
  label,
  copyText,
  children,
}: {
  label: string;
  copyText: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-[#101014] text-zinc-200 shadow-sm">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
        <span className="h-2 w-2 rounded-full bg-white/15" />
        <span className="h-2 w-2 rounded-full bg-white/15" />
        <span className="truncate font-code text-[10px] text-zinc-500">{label}</span>
        <span className="ml-auto">
          <CopyButton text={copyText} label={label} />
        </span>
      </div>
      <div className="overflow-x-auto px-4 py-3.5 font-code text-[11.5px] leading-relaxed">
        {children}
      </div>
    </div>
  );
}

export default function QuickstartSection() {
  return (
    <section className="relative overflow-hidden border-y border-ink/10 bg-surface">
      <div className="relative mx-auto max-w-6xl px-6 py-24">
        <div className="max-w-2xl">
          <span className="text-xs font-medium uppercase tracking-wide text-ink/50">
            Quickstart
          </span>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-[2rem]">
            Two minutes to your first shared queue.
          </h2>
          <p className="mt-3 leading-relaxed text-ink/65">
            One command to register the MCP server, one paste to teach your agents the loop.
            Create a canvas at tandemcanvas.com, then point every machine you run agents on at the
            same code.
          </p>
        </div>

        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          {/* Left column: install + hosted endpoint */}
          <div className="flex flex-col gap-6">
            <div>
              <p className="mb-2.5 text-xs font-medium text-ink/60">
                <span className="text-accent">1</span> · add the MCP server (Claude Code)
              </p>
              <TerminalBlock label="terminal" copyText={MCP_ADD_CMD}>
                <div className="whitespace-nowrap">
                  <span className="text-indigo-400">$</span>{" "}
                  <span className="text-zinc-300">{MCP_ADD_CMD}</span>
                </div>
                <div className="mt-1 whitespace-nowrap text-emerald-400/90">
                  ✓ tandem: npx -y @jaximus/tandem-mcp — Connected
                </div>
              </TerminalBlock>
              <p className="mt-2 text-xs leading-relaxed text-ink/50">
                Defaults to the hosted backend — no env vars, no account, no token for public
                canvases.
              </p>
            </div>

            <div>
              <p className="mb-2.5 text-xs font-medium text-ink/60">
                <span className="text-accent">3</span> · on claude.ai or Cursor instead
              </p>
              <TerminalBlock label="hosted endpoint · streamable-http" copyText={HOSTED_ENDPOINT}>
                <div className="whitespace-nowrap text-zinc-300">{HOSTED_ENDPOINT}</div>
              </TerminalBlock>
              <p className="mt-2 text-xs leading-relaxed text-ink/50">
                Vendor-neutral by design: anything that speaks MCP joins the same queue.
              </p>
            </div>
          </div>

          {/* Right column: the CLAUDE.md loop */}
          <div>
            <p className="mb-2.5 text-xs font-medium text-ink/60">
              <span className="text-accent">2</span> · teach your sessions the loop — paste into
              CLAUDE.md
            </p>
            <TerminalBlock label="CLAUDE.md" copyText={CLAUDE_MD_SNIPPET}>
              <pre className="whitespace-pre font-code text-[11px] leading-[1.7] text-zinc-400">
                {CLAUDE_MD_SNIPPET}
              </pre>
            </TerminalBlock>
            <p className="mt-2 text-xs leading-relaxed text-ink/50">
              Compact version — the full block (epic planning, spec-drift checks, deviation
              gating) is in the README.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
