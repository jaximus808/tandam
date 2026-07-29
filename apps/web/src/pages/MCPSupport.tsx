import { useState } from "react";
import LandingNav from "../components/LandingNav";

interface Props {
  onBack: () => void;
  onOpenMCP: () => void;
  onShowCanvases: () => void;
  onShowSettings: () => void;
  onAbout: () => void;
  onWhy?: () => void;
  onOpenCanvas: (code: string) => void;
}

interface InstallMethod {
  id: string;
  label: string;
  badge?: "Recommended" | "Coming soon";
  blurb: string;
  steps: { text: string; code?: string; lang?: "bash" | "json" }[];
}

interface ClientTab {
  id: string;
  label: string;
  blurb: string;
  config: string;
}

const INSTALL_METHODS: InstallMethod[] = [
  {
    id: "npx",
    label: "npx (no install)",
    badge: "Recommended",
    blurb:
      "Don't install anything — your MCP client fetches and runs the package on demand. Works in any MCP-aware client (Claude Code, Cursor, Codex, custom).",
    steps: [
      {
        text: "Nothing to install. npx fetches and runs the package the first time your client launches it — so the whole setup is just the client config in the wiring step below.",
      },
    ],
  },
  {
    id: "global",
    label: "Global install",
    blurb:
      "Install once, get a `tandem-mcp` binary on your PATH. Slightly faster startup than npx because no per-run fetch.",
    steps: [
      {
        text: "Install:",
        lang: "bash",
        code: "npm install -g @jaximus/tandem-mcp",
      },
      {
        text: "That puts a `tandem-mcp` binary on your PATH. In the wiring step below, use `\"command\": \"tandem-mcp\"` with no `args` instead of the npx form.",
      },
    ],
  },
  {
    id: "dlx",
    label: "pnpm / yarn / bun",
    blurb:
      "If you don't use npm, your package manager's equivalent of npx works the same way.",
    steps: [
      {
        text: "pnpm:",
        lang: "json",
        code: `"command": "pnpm",
"args": ["dlx", "@jaximus/tandem-mcp"]`,
      },
      {
        text: "yarn:",
        lang: "json",
        code: `"command": "yarn",
"args": ["dlx", "@jaximus/tandem-mcp"]`,
      },
      {
        text: "bun:",
        lang: "json",
        code: `"command": "bunx",
"args": ["@jaximus/tandem-mcp"]`,
      },
    ],
  },
  {
    id: "source",
    label: "From source",
    blurb:
      "For contributors or if you want to run a local fork. Requires Node 18+ and pnpm.",
    steps: [
      {
        text: "Clone, install, build:",
        lang: "bash",
        code: `git clone https://github.com/jaximus808/tandam.git
cd tandam
pnpm install
pnpm --filter mcp-gateway build`,
      },
      {
        text: "Point your MCP client at the built file. Set API_URL to your local backend since you're running a fork:",
        lang: "json",
        code: `{
  "mcpServers": {
    "tandem": {
      "command": "node",
      "args": ["/abs/path/to/tandam/apps/mcp-gateway/dist/index.js"],
      "env": { "API_URL": "http://localhost:7891" }
    }
  }
}`,
      },
    ],
  },
  {
    id: "binary",
    label: "Standalone binary",
    badge: "Coming soon",
    blurb:
      "Single download per platform (darwin-arm64, darwin-x64, linux-x64, windows-x64). No Node runtime needed.",
    steps: [
      {
        text: "Once available, you'll be able to do:",
        lang: "bash",
        code: `curl -fsSL https://github.com/jaximus808/tandam/releases/latest/download/install.sh | sh`,
      },
    ],
  },
  {
    id: "docker",
    label: "Docker",
    badge: "Coming soon",
    blurb:
      "Sandboxed. Works in any MCP client that accepts `docker` as the command.",
    steps: [
      {
        text: "Once published to ghcr.io, your MCP config would look like:",
        lang: "json",
        code: `{
  "mcpServers": {
    "tandem": {
      "command": "docker",
      "args": ["run", "-i", "--rm",
        "ghcr.io/jaximus808/tandem-mcp:latest"]
    }
  }
}`,
      },
    ],
  },
];

const CLIENT_TABS: ClientTab[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    blurb:
      "Add to your MCP config (usually `~/.config/claude-code/mcp.json` or via the Claude Code settings UI).",
    config: `{
  "mcpServers": {
    "tandem": {
      "command": "npx",
      "args": ["-y", "@jaximus/tandem-mcp"]
    }
  }
}`,
  },
  {
    id: "cursor",
    label: "Cursor / Windsurf",
    blurb:
      "Same gateway works in any MCP-aware editor. Drop this into the client's MCP settings.",
    config: `{
  "mcpServers": {
    "tandem": {
      "command": "npx",
      "args": ["-y", "@jaximus/tandem-mcp"]
    }
  }
}`,
  },
  {
    id: "codex",
    label: "Codex CLI",
    blurb:
      "Codex CLI supports MCP servers via its config file (typically `~/.codex/config.toml`).",
    config: `[mcp_servers.tandem]
command = "npx"
args = ["-y", "@jaximus/tandem-mcp"]`,
  },
  {
    id: "openai-agents",
    label: "OpenAI Agents SDK",
    blurb:
      "OpenAI's Agents SDK supports MCP servers natively. The canvas.* tools show up as agent tools.",
    config: `# Python
from agents import Agent, Runner
from agents.mcp import MCPServerStdio

tandem = MCPServerStdio(
    params={
        "command": "npx",
        "args": ["-y", "@jaximus/tandem-mcp"],
    },
)

agent = Agent(
    name="planner",
    instructions="Use canvas.connect first, then build the trip on the canvas.",
    mcp_servers=[tandem],
)

await Runner.run(agent, "Plan a 5-day Tokyo trip on canvas TOKYO7X3K")`,
  },
  {
    id: "raw-stdio",
    label: "Custom orchestrator",
    blurb:
      "Any MCP client SDK (TypeScript, Python, Go, Rust) can spawn the gateway. Useful for bespoke multi-agent pipelines.",
    config: `// TypeScript — @modelcontextprotocol/sdk
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@jaximus/tandem-mcp"],
});

const client = new Client({ name: "my-orchestrator", version: "0.1.0" });
await client.connect(transport);

await client.callTool({ name: "canvas.connect", arguments: { code: "TOKYO7X3K" } });
await client.callTool({
  name: "canvas.pin.add",
  arguments: { pinType: "marker", lat: 35.66, lng: 139.7, label: "Shibuya" },
});`,
  },
];

// Clients that can connect straight to the hosted Streamable-HTTP endpoint by
// URL — no local process, no npm package. This is the recommended path for the
// editors/agents that support remote MCP servers. Codex (stdio-only today) is
// intentionally absent; it lives in CLIENT_TABS with the local gateway.
const REMOTE_CLIENTS: ClientTab[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    blurb:
      "One command — Claude Code speaks the Streamable-HTTP transport natively.",
    config: `claude mcp add --transport http tandem https://tandemcanvas.com/api/mcp`,
  },
  {
    id: "cursor",
    label: "Cursor / Windsurf",
    blurb:
      "A remote server in the client's MCP settings is just a `url` — no command to spawn.",
    config: `{
  "mcpServers": {
    "tandem": {
      "url": "https://tandemcanvas.com/api/mcp"
    }
  }
}`,
  },
  {
    id: "openai-agents",
    label: "OpenAI Agents SDK",
    blurb:
      "Use the Streamable-HTTP server class. The canvas.* tools show up as agent tools, same as the stdio form.",
    config: `# Python
from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp

tandem = MCPServerStreamableHttp(
    params={"url": "https://tandemcanvas.com/api/mcp"},
)

agent = Agent(
    name="planner",
    instructions="Use canvas.connect first, then build the trip on the canvas.",
    mcp_servers=[tandem],
)

await Runner.run(agent, "Plan a 5-day Tokyo trip on canvas TOKYO7X3K")`,
  },
  {
    id: "raw-http",
    label: "Custom orchestrator",
    blurb:
      "Any MCP client SDK can connect to the URL with the Streamable-HTTP transport — no process to manage.",
    config: `// TypeScript — @modelcontextprotocol/sdk
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("https://tandemcanvas.com/api/mcp"),
);

const client = new Client({ name: "my-orchestrator", version: "0.1.0" });
await client.connect(transport);

await client.callTool({ name: "canvas.connect", arguments: { code: "TOKYO7X3K" } });`,
  },
];

const TOOLS = [
  {
    group: "Connection",
    items: [
      ["canvas.create", "Create a new canvas and bind to it in one step. Returns a shareable URL."],
      ["canvas.connect", "Bind this session to an existing canvas by code."],
      ["canvas.state.read", "Snapshot of pins, events, notes, mode, and pending edits."],
    ],
  },
  {
    group: "Mode + map",
    items: [
      ["canvas.mode.set", "Switch view: welcome / map / itinerary / docs."],
      ["canvas.map.list", "List base-map presets (currently just the US map)."],
      ["canvas.map.set", "Pick a base map. Also switches into map mode."],
    ],
  },
  {
    group: "Pins",
    items: [
      ["canvas.pin.add", "Drop a pin at a lat/lng with label, body, color."],
      ["canvas.pin.update", "Patch an existing pin by id."],
      ["canvas.pin.delete", "Remove a pin."],
    ],
  },
  {
    group: "Events",
    items: [
      ["canvas.event.add", "Add a timed event. Optionally link to a pin."],
      ["canvas.event.update", "Patch an event by id."],
      ["canvas.event.delete", "Remove an event."],
    ],
  },
  {
    group: "Notes",
    items: [
      ["canvas.note.add", "Add a markdown note. Optionally attach to a pin or event."],
      ["canvas.note.update", "Patch a note by id."],
      ["canvas.note.delete", "Remove a note."],
    ],
  },
  {
    group: "Scoped edits",
    items: [
      ["canvas.pending_edits.read", "Read scoped edit requests posted from the browser."],
      ["canvas.pending_edits.complete", "Mark a scoped edit as done."],
    ],
  },
];

// Hosted Streamable-HTTP MCP endpoint — the zero-install path for Claude's
// own web / desktop / mobile clients (Customize → Connectors).
const CONNECTOR_URL = "https://tandemcanvas.com/api/mcp";

function StepNum({ children }: { children: string }) {
  return (
    <span className="shrink-0 grid place-items-center h-6 w-6 rounded-full bg-sky-600 text-white text-xs font-semibold font-code">
      {children}
    </span>
  );
}

function CodeBlock({
  code,
  copyKey,
  copied,
  onCopy,
}: {
  code: string;
  copyKey: string;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
}) {
  return (
    <div className="relative">
      {/* Dark terminal block — bg-ink/text-paper invert with the theme, matching
          the ConnectModal <pre> idiom (dark slab in light mode, light slab in dark). */}
      <pre className="bg-ink text-paper text-xs rounded-lg px-4 py-3 overflow-x-auto whitespace-pre">
{code}
      </pre>
      <button
        onClick={() => onCopy(code, copyKey)}
        className="absolute top-2 right-2 text-xs bg-paper/10 hover:bg-paper/20 text-paper px-2 py-1 rounded"
      >
        {copied === copyKey ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

// Primary path toggle pill. Slightly larger than the install/client sub-tabs
// since it's the top-level choice.
function pathPill(active: boolean): string {
  return [
    "px-4 py-2 rounded-lg text-sm font-semibold transition-colors",
    active
      ? "bg-ink text-paper"
      : "bg-surface border border-ink/15 text-ink/60 hover:bg-ink/5",
  ].join(" ");
}

export default function MCPSupport({
  onBack,
  onOpenMCP,
  onShowCanvases,
  onShowSettings,
  onAbout,
  onWhy,
  onOpenCanvas,
}: Props) {
  const [pathTab, setPathTab] = useState<"connector" | "gateway">("connector");
  const [installTab, setInstallTab] = useState<string>(INSTALL_METHODS[0].id);
  const [clientTab, setClientTab] = useState<string>(CLIENT_TABS[0].id);
  const [remoteTab, setRemoteTab] = useState<string>(REMOTE_CLIENTS[0].id);
  const [copied, setCopied] = useState<string | null>(null);

  const activeInstall = INSTALL_METHODS.find((m) => m.id === installTab) ?? INSTALL_METHODS[0];
  const activeClient = CLIENT_TABS.find((t) => t.id === clientTab) ?? CLIENT_TABS[0];
  const activeRemote = REMOTE_CLIENTS.find((t) => t.id === remoteTab) ?? REMOTE_CLIENTS[0];

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    });
  }

  return (
    // Page follows the global theme via paper/surface/ink tokens (light + dark).
    <div className="min-h-screen bg-paper text-ink antialiased overflow-y-auto scroll-smooth">
      <LandingNav
        onHome={onBack}
        onJoin={onOpenCanvas}
        onOpenMCP={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        onShowCanvases={onShowCanvases}
        onShowSettings={onShowSettings}
        onAbout={onAbout}
        onWhy={onWhy}
      />

      <div className="max-w-4xl mx-auto px-6 py-12 space-y-14">
        {/* Hero */}
        <section className="space-y-3">
          <span className="text-xs font-medium uppercase tracking-wide text-ink/50">
            Bring your own agent
          </span>
          {/* Keeps the original cadence but spends the h1 — the page's strongest
              on-page signal — on the words people search ("MCP", "agent sessions")
              rather than on brand voice alone. */}
          <h1 className="text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            Any MCP agent, one shared state layer.
          </h1>
          <p className="text-base text-ink/60 leading-relaxed">
            Tandem's gateway is a standard{" "}
            <a
              href="https://modelcontextprotocol.io"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-600 underline hover:text-sky-700"
            >
              Model Context Protocol
            </a>{" "}
            stdio server. It isn't Claude-specific. Any MCP-aware client — editor,
            agent framework, or a bespoke orchestrator you wrote yourself — can
            spawn the gateway, call <span className="font-code text-sm">canvas.connect</span> with a
            canvas code, and start reading and writing the same canvas a human is
            looking at in the browser.
          </p>
          <p className="text-base text-ink/60 leading-relaxed">
            Multiple agents can connect to the same canvas at the same time. The
            canvas is the shared workspace — every <span className="font-code text-sm">pin.add</span>,{" "}
            <span className="font-code text-sm">event.add</span>, or <span className="font-code text-sm">note.add</span> is
            broadcast over the WebSocket to every browser and every other agent
            subscribed to that code.
          </p>
        </section>

        {/* ── Setup (tabbed: Claude.ai connector vs MCP gateway) ───────────── */}
        <section className="space-y-6">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setPathTab("connector")}
              className={pathPill(pathTab === "connector")}
            >
              Claude.ai — connector
            </button>
            <button
              onClick={() => setPathTab("gateway")}
              className={pathPill(pathTab === "gateway")}
            >
              MCP setup (editors & agents)
            </button>
          </div>

          {pathTab === "connector" && (
          <div className="space-y-4">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-ink">
                Set up Tandem as a Claude connector
              </h2>
              <p className="mt-1 text-sm text-ink/50">
                For Claude on web, desktop, or mobile. A hosted MCP endpoint —
                connect with a URL. No Node, no config file, nothing to install.
              </p>
            </div>

          {/* Card body follows the theme (via/to-surface); the sky-50 corner and
              the blur glow below stay a fixed soft-sky accent in both modes. */}
          <div className="relative overflow-hidden rounded-2xl border border-sky-200/70 bg-gradient-to-br from-sky-50 via-surface to-surface p-6 sm:p-8">
            {/* soft accent glow, decorative */}
            <div
              aria-hidden
              className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-sky-200/40 blur-2xl"
            />
            <ol className="relative space-y-4">
              <li className="flex gap-3">
                <StepNum>1</StepNum>
                <div className="pt-0.5 text-sm text-ink/70 leading-relaxed">
                  In Claude, open{" "}
                  <span className="font-medium text-ink">
                    Customize → Connectors
                  </span>{" "}
                  and click{" "}
                  <span className="font-medium text-ink">
                    Add custom connector
                  </span>
                  .
                </div>
              </li>
              <li className="flex gap-3">
                <StepNum>2</StepNum>
                <div className="flex-1 space-y-2 pt-0.5">
                  <p className="text-sm text-ink/70 leading-relaxed">
                    Paste this URL — leave the OAuth fields blank — and hit{" "}
                    <span className="font-medium text-ink">Add</span>:
                  </p>
                  <div className="flex items-center gap-2 rounded-lg border border-sky-200 bg-surface py-1.5 pl-3 pr-1.5">
                    <span className="flex-1 truncate font-code text-sm text-ink">
                      {CONNECTOR_URL}
                    </span>
                    <button
                      onClick={() => copy(CONNECTOR_URL, "connector-url")}
                      className="shrink-0 rounded-md bg-ink px-2.5 py-1.5 text-xs font-medium text-paper transition-colors hover:bg-ink/80"
                    >
                      {copied === "connector-url" ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>
              </li>
              <li className="flex gap-3">
                <StepNum>3</StepNum>
                <div className="pt-0.5 text-sm text-ink/70 leading-relaxed">
                  Enable Tandem in a chat from the{" "}
                  <span className="font-medium text-ink">+</span> menu, then
                  tell Claude{" "}
                  <span className="font-code text-xs text-sky-700">
                    connect to canvas TOKYO7X3K
                  </span>
                  . It binds to that canvas and edits it live — same as any other
                  agent.
                </div>
              </li>
            </ol>
          </div>

          {/* Auth explainer — the OAuth step-up model. Fixed-sky "tip" island,
              same idiom as the multi-agent callout below. */}
          <div className="rounded-xl border border-sky-100 bg-sky-50 p-4 text-sm leading-relaxed text-sky-900">
            <span className="font-semibold">Signing in is only asked for when it's needed.</span>{" "}
            Public canvases connect with no sign-in at all — leaving the OAuth
            fields blank in step 2 is correct. The first time you point Claude at
            a <span className="font-semibold">private or shared</span> canvas, it
            opens a Tandem sign-in (Google) and asks you to authorize the
            connector — from then on the agent acts as{" "}
            <span className="font-semibold">you</span>, with your access to that
            canvas. It's a one-time authorization; you can review or revoke it any
            time under{" "}
            <button
              onClick={onShowSettings}
              className="font-semibold underline underline-offset-2 hover:text-sky-700"
            >
              Settings → Connected apps
            </button>
            . Revoke it and the next connect will prompt you to sign in again.
          </div>
          </div>
          )}

          {pathTab === "gateway" && (
          <div className="space-y-8">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-ink">
                Wire Tandem into your editor or agent
              </h2>
              <p className="mt-1 text-sm text-ink/50">
                Two ways in, same tool surface: point your client straight at the
                hosted URL (nothing to install), or run the gateway as a local
                process. Prefer the URL if your client supports it.
              </p>
            </div>

          {/* ── A. Remote URL (recommended) ─────────────────────────────────── */}
          <div className="space-y-4">
          <div>
            <h3 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-ink">
              Connect by URL
              <span className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-sky-100 text-sky-700">
                Recommended
              </span>
            </h3>
            <p className="mt-1 text-sm text-ink/50">
              For clients that support remote MCP servers. Point them at the
              hosted Streamable-HTTP endpoint — no Node, no npx, nothing to
              install.
            </p>
          </div>

          <div className="flex items-center gap-2 rounded-lg border border-sky-200 bg-surface py-1.5 pl-3 pr-1.5">
            <span className="flex-1 truncate font-code text-sm text-ink">
              {CONNECTOR_URL}
            </span>
            <button
              onClick={() => copy(CONNECTOR_URL, "gateway-url")}
              className="shrink-0 rounded-md bg-ink px-2.5 py-1.5 text-xs font-medium text-paper transition-colors hover:bg-ink/80"
            >
              {copied === "gateway-url" ? "Copied!" : "Copy"}
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {REMOTE_CLIENTS.map((t) => (
              <button
                key={t.id}
                onClick={() => setRemoteTab(t.id)}
                className={[
                  "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                  remoteTab === t.id
                    ? "bg-ink text-paper"
                    : "bg-surface border border-ink/15 text-ink/60 hover:bg-ink/5",
                ].join(" ")}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="bg-surface border border-ink/15 rounded-xl p-4 space-y-3">
            <p className="text-sm text-ink/60">{activeRemote.blurb}</p>
            <CodeBlock
              code={activeRemote.config}
              copyKey={`remote-${activeRemote.id}`}
              copied={copied}
              onCopy={copy}
            />
          </div>
          <p className="text-xs text-ink/40">
            Client not listed, stdio-only (e.g. Codex), or pointing at a
            self-hosted backend? Use the local gateway below.
          </p>

          {/* Auth note for the remote path — same OAuth step-up as the connector. */}
          <div className="rounded-lg border border-ink/10 bg-ink/[0.03] p-3 text-xs leading-relaxed text-ink/60">
            <span className="font-semibold text-ink/70">Auth:</span> same as the
            Claude connector — public canvases connect anonymously, and the first
            time you connect to a private or shared canvas the client runs the
            OAuth flow (Claude Code opens your browser to sign in with Google).
            The token is stored by your client; revoke access any time under{" "}
            <button
              onClick={onShowSettings}
              className="font-semibold text-ink/70 underline underline-offset-2 hover:text-ink"
            >
              Settings → Connected apps
            </button>
            .
          </div>
          </div>

          {/* ── B. Local stdio gateway (fallback) ───────────────────────────── */}
          <div className="space-y-8 border-t border-ink/15 pt-8">
            <div>
              <h3 className="text-xl font-semibold tracking-tight text-ink">
                Or run the local stdio gateway
              </h3>
              <p className="mt-1 text-sm text-ink/50">
                A stdio server you run locally — for clients that only speak
                stdio, or when you want to point at a self-hosted{" "}
                <span className="font-medium text-ink/50">API_URL</span>.
              </p>
            </div>

            {/* Auth note for stdio — this path does NOT use OAuth. */}
            <div className="rounded-lg border border-ink/10 bg-ink/[0.03] p-3 text-xs leading-relaxed text-ink/60">
              <span className="font-semibold text-ink/70">Auth is different here:</span>{" "}
              the local gateway doesn't do the OAuth browser flow. Without a
              credential it can only reach public canvases. To let the agent act
              as you on your private / shared canvases, mint a personal access
              token at{" "}
              <button
                onClick={onShowSettings}
                className="font-semibold text-ink/70 underline underline-offset-2 hover:text-ink"
              >
                Settings → Access tokens
              </button>{" "}
              and pass it as the <span className="font-code">TANDEM_TOKEN</span>{" "}
              env var:
              <pre className="mt-2 overflow-x-auto whitespace-pre rounded-md bg-ink px-3 py-2 text-paper">
{`"env": { "TANDEM_TOKEN": "tdm_pat_…" }`}
              </pre>
            </div>

          {/* Install */}
          <div className="space-y-4">
          <div>
            <h4 className="text-lg font-semibold tracking-tight text-ink">Install the gateway</h4>
            <p className="mt-1 text-sm text-ink/50">
              Pick whichever fits your setup — the npx form is the easiest and
              works for almost everyone.
            </p>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {INSTALL_METHODS.map((m) => (
              <button
                key={m.id}
                onClick={() => setInstallTab(m.id)}
                className={[
                  "px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5",
                  installTab === m.id
                    ? "bg-ink text-paper"
                    : "bg-surface border border-ink/15 text-ink/60 hover:bg-ink/5",
                ].join(" ")}
              >
                <span>{m.label}</span>
                {m.badge && (
                  <span
                    className={[
                      "text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded",
                      m.badge === "Recommended"
                        ? installTab === m.id
                          ? "bg-paper/15 text-paper"
                          : "bg-sky-100 text-sky-700"
                        : installTab === m.id
                          ? "bg-paper/15 text-paper/90"
                          : "bg-ink/10 text-ink/50",
                    ].join(" ")}
                  >
                    {m.badge}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="bg-surface border border-ink/15 rounded-xl p-4 space-y-4">
            <p className="text-sm text-ink/60">{activeInstall.blurb}</p>
            {activeInstall.steps.map((step, i) => (
              <div key={i} className="space-y-2">
                <p className="text-sm text-ink/70">{step.text}</p>
                {step.code && (
                  <CodeBlock
                    code={step.code}
                    copyKey={`${activeInstall.id}-${i}`}
                    copied={copied}
                    onCopy={copy}
                  />
                )}
              </div>
            ))}
            <p className="text-xs text-ink/40 pt-2 border-t border-ink/10">
              No config needed — the gateway connects to the hosted backend at{" "}
              <span className="font-code">https://tandemcanvas.com</span> by default. Only set{" "}
              <span className="font-medium text-ink/50">API_URL</span> if you're pointing at a
              local or self-hosted instance.
            </p>
          </div>
          </div>

          {/* Wire */}
          <div id="wire" className="space-y-4 scroll-mt-20">
          <div>
            <h4 className="text-lg font-semibold tracking-tight text-ink">Wire it into your client</h4>
            <p className="mt-1 text-sm text-ink/50">
              These snippets all use the npx form. Swap to <span className="font-code text-xs">tandem-mcp</span>{" "}
              if you installed globally, or to a full path if you built from source.
            </p>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {CLIENT_TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setClientTab(t.id)}
                className={[
                  "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                  clientTab === t.id
                    ? "bg-ink text-paper"
                    : "bg-surface border border-ink/15 text-ink/60 hover:bg-ink/5",
                ].join(" ")}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="bg-surface border border-ink/15 rounded-xl p-4 space-y-3">
            <p className="text-sm text-ink/60">{activeClient.blurb}</p>
            <CodeBlock
              code={activeClient.config}
              copyKey={`client-${activeClient.id}`}
              copied={copied}
              onCopy={copy}
            />
          </div>
          </div>
          </div>

          {/* Connect — shared by both paths */}
          <div id="connect" className="space-y-3 scroll-mt-20">
          <h2 className="text-2xl font-semibold tracking-tight text-ink">Connect to a canvas</h2>
          <p className="text-sm text-ink/60 leading-relaxed">
            Create a canvas in your browser (it'll give you an 8-character code
            like <span className="font-code text-xs">TOKYO7X3K</span>), then tell your
            agent the code. The agent calls <span className="font-code text-xs">canvas.connect</span>{" "}
            once with that code; from then on every other tool operates on that
            canvas with no ID to pass around.
          </p>
          </div>
          </div>
          )}
        </section>

        {/* Tool surface */}
        <section id="tools" className="space-y-4 scroll-mt-20">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-ink">The tool surface</h2>
            <p className="mt-1 text-sm text-ink/50">
              Every tool operates on whatever canvas this session connected to.
              No IDs to pass around — the JWT held in the gateway pins the
              session to one canvas.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            {TOOLS.map((group) => (
              <div
                key={group.group}
                className="bg-surface border border-ink/15 rounded-xl p-4"
              >
                <div className="text-xs font-semibold text-ink/50 uppercase tracking-wide mb-2">
                  {group.group}
                </div>
                <ul className="space-y-2">
                  {group.items.map(([name, desc]) => (
                    <li key={name} className="text-sm">
                      <span className="font-code text-xs text-sky-700">{name}</span>
                      <span className="text-ink/60"> — {desc}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* Multi-agent example */}
        <section id="multi-agent" className="space-y-4 scroll-mt-20">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-ink">
              Multi-agent flow: research → report
            </h2>
            <p className="mt-1 text-sm text-ink/50 leading-relaxed">
              Because the canvas is the shared artifact, you can split work
              across specialized agents instead of stuffing everything into one
              prompt. Each agent connects to the same canvas code; their
              outputs land on the same map / itinerary / docs in real time, and
              the user can watch (or interrupt) from the browser.
            </p>
          </div>

          <div className="bg-surface border border-ink/15 rounded-xl p-5">
            <ol className="space-y-4 text-sm text-ink/70">
              <li>
                <div className="font-semibold text-ink">1. Scout agent — fills the map</div>
                <p className="text-ink/60 mt-1 leading-relaxed">
                  Web-searching agent gathers candidate venues, calls{" "}
                  <span className="font-code text-xs">canvas.connect</span> with the user's
                  code, then drops <span className="font-code text-xs">canvas.pin.add</span> for
                  each location with lat/lng, label, and a short note.
                </p>
              </li>
              <li>
                <div className="font-semibold text-ink">2. Planner agent — builds the itinerary</div>
                <p className="text-ink/60 mt-1 leading-relaxed">
                  Reads <span className="font-code text-xs">canvas.state.read</span> to see what
                  the scout dropped, then emits <span className="font-code text-xs">canvas.event.add</span>{" "}
                  for each day, linking back to pins via <span className="font-code text-xs">pinId</span>.
                </p>
              </li>
              <li>
                <div className="font-semibold text-ink">3. Reporter agent — writes the brief</div>
                <p className="text-ink/60 mt-1 leading-relaxed">
                  Walks the final state and emits a markdown summary via{" "}
                  <span className="font-code text-xs">canvas.note.add</span>. Attaches
                  per-stop reasoning to each pin with{" "}
                  <span className="font-code text-xs">parentKind: "pin"</span>.
                </p>
              </li>
              <li>
                <div className="font-semibold text-ink">4. Human in the loop</div>
                <p className="text-ink/60 mt-1 leading-relaxed">
                  Throughout, the user is watching the canvas update live in
                  their browser. They can reject pins, edit events directly, or
                  post scoped edit requests that come back through{" "}
                  <span className="font-code text-xs">canvas.pending_edits.read</span> for the
                  agents to pick up.
                </p>
              </li>
            </ol>
          </div>

          {/* Deliberate fixed-sky accent callout (a highlighted "tip" island) —
              stays light-sky in both themes, like the accent chips above. */}
          <div className="bg-sky-50 border border-sky-100 rounded-xl p-4 text-sm text-sky-900 leading-relaxed">
            <span className="font-semibold">The pattern:</span> the canvas is the
            blackboard. Each agent only needs the code, an MCP client, and a
            narrow role. Hand-offs happen through canvas state, not through a
            shared prompt — which means you can mix vendors (Claude here, GPT
            there, a local open-weights model for the cheap step) without
            rewriting the orchestration.
          </div>
        </section>

        {/* Authoring your own */}
        <section id="build" className="space-y-3 scroll-mt-20">
          <h2 className="text-2xl font-semibold tracking-tight text-ink">Build your own integration</h2>
          <p className="text-sm text-ink/60 leading-relaxed">
            The gateway is intentionally thin: it owns a JWT and forwards
            tool calls to the Tandem HTTP API. If you'd rather skip the gateway
            and talk to the API directly from your agent runtime, the same
            endpoints are documented under <span className="font-code text-xs">/api/canvas/*</span>.
            The MCP gateway exists so MCP-aware clients get a zero-config
            experience; it isn't a required layer.
          </p>
          <p className="text-sm text-ink/60 leading-relaxed">
            Source lives in{" "}
            <a
              href="https://github.com/jaximus808/tandam/tree/main/apps/mcp-gateway"
              target="_blank"
              rel="noopener noreferrer"
              className="font-code text-xs text-sky-600 underline hover:text-sky-700"
            >
              apps/mcp-gateway/
            </a>{" "}
            — small enough to fork.
          </p>
        </section>

        <div className="pt-4 border-t border-ink/15">
          <button
            onClick={onBack}
            className="text-sm text-ink/50 hover:text-ink/70"
          >
            ← Back to home
          </button>
        </div>
      </div>
    </div>
  );
}
