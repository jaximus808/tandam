import { useState } from "react";
import TandemLogo from "../components/TandemLogo";

interface Props {
  onBack: () => void;
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
        text: "Paste this into your MCP client config. That's it — npx fetches the package the first time it runs.",
        lang: "json",
        code: `{
  "mcpServers": {
    "tandem": {
      "command": "npx",
      "args": ["-y", "@tandem/mcp-gateway"],
      "env": { "API_URL": "https://your-tandem-host" }
    }
  }
}`,
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
        code: "npm install -g @tandem/mcp-gateway",
      },
      {
        text: "Then in your MCP client config:",
        lang: "json",
        code: `{
  "mcpServers": {
    "tandem": {
      "command": "tandem-mcp",
      "env": { "API_URL": "https://your-tandem-host" }
    }
  }
}`,
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
"args": ["dlx", "@tandem/mcp-gateway"]`,
      },
      {
        text: "yarn:",
        lang: "json",
        code: `"command": "yarn",
"args": ["dlx", "@tandem/mcp-gateway"]`,
      },
      {
        text: "bun:",
        lang: "json",
        code: `"command": "bunx",
"args": ["@tandem/mcp-gateway"]`,
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
        text: "Point your MCP client at the built file:",
        lang: "json",
        code: `{
  "mcpServers": {
    "tandem": {
      "command": "node",
      "args": ["/abs/path/to/tandam/apps/mcp-gateway/dist/index.js"],
      "env": { "API_URL": "https://your-tandem-host" }
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
        "-e", "API_URL=https://your-tandem-host",
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
      "args": ["-y", "@tandem/mcp-gateway"],
      "env": { "API_URL": "https://your-tandem-host" }
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
      "args": ["-y", "@tandem/mcp-gateway"],
      "env": { "API_URL": "https://your-tandem-host" }
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
args = ["-y", "@tandem/mcp-gateway"]
env = { API_URL = "https://your-tandem-host" }`,
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
        "args": ["-y", "@tandem/mcp-gateway"],
        "env": {"API_URL": "https://your-tandem-host"},
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
  args: ["-y", "@tandem/mcp-gateway"],
  env: { API_URL: "https://your-tandem-host" },
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

const TOOLS = [
  {
    group: "Connection",
    items: [
      ["canvas.connect", "Bind this session to a canvas. Required before anything else."],
      ["canvas.state.read", "Snapshot of pins, events, notes, mode, and pending edits."],
    ],
  },
  {
    group: "Mode + map",
    items: [
      ["canvas.mode.set", "Switch view: welcome / map / itinerary / docs."],
      ["canvas.map.list", "List base-map presets (world, us, tokyo, japan, …)."],
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
      <pre className="bg-gray-900 text-gray-100 text-xs rounded-lg px-4 py-3 overflow-x-auto whitespace-pre">
{code}
      </pre>
      <button
        onClick={() => onCopy(code, copyKey)}
        className="absolute top-2 right-2 text-xs bg-gray-800 hover:bg-gray-700 text-gray-100 px-2 py-1 rounded"
      >
        {copied === copyKey ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

export default function MCPSupport({ onBack }: Props) {
  const [installTab, setInstallTab] = useState<string>(INSTALL_METHODS[0].id);
  const [clientTab, setClientTab] = useState<string>(CLIENT_TABS[0].id);
  const [copied, setCopied] = useState<string | null>(null);

  const activeInstall = INSTALL_METHODS.find((m) => m.id === installTab) ?? INSTALL_METHODS[0];
  const activeClient = CLIENT_TABS.find((t) => t.id === clientTab) ?? CLIENT_TABS[0];

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    });
  }

  return (
    <div className="min-h-screen bg-gray-50 overflow-y-auto">
      <header className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-6 py-3 flex items-center gap-3">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 font-bold text-gray-900 text-sm hover:text-blue-600 transition-colors"
            title="Back to home"
          >
            <TandemLogo size={20} />
            <span>Tandem</span>
          </button>
          <div className="w-px h-4 bg-gray-200" />
          <span className="text-sm font-medium text-gray-500">MCP support</span>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-6 py-10 space-y-12">
        {/* Hero */}
        <section className="space-y-3">
          <h1 className="text-3xl font-bold text-gray-900">
            Any agent, same canvas.
          </h1>
          <p className="text-base text-gray-600 leading-relaxed">
            Tandem's gateway is a standard{" "}
            <a
              href="https://modelcontextprotocol.io"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 underline hover:text-blue-700"
            >
              Model Context Protocol
            </a>{" "}
            stdio server. It isn't Claude-specific. Any MCP-aware client — editor,
            agent framework, or a bespoke orchestrator you wrote yourself — can
            spawn the gateway, call <span className="font-mono text-sm">canvas.connect</span> with a
            canvas code, and start reading and writing the same canvas a human is
            looking at in the browser.
          </p>
          <p className="text-base text-gray-600 leading-relaxed">
            Multiple agents can connect to the same canvas at the same time. The
            canvas is the shared workspace — every <span className="font-mono text-sm">pin.add</span>,{" "}
            <span className="font-mono text-sm">event.add</span>, or <span className="font-mono text-sm">note.add</span> is
            broadcast over the WebSocket to every browser and every other agent
            subscribed to that code.
          </p>
        </section>

        {/* Install */}
        <section className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">1. Install the gateway</h2>
            <p className="mt-1 text-sm text-gray-500">
              Pick whichever fits your setup. The npx form is the easiest and
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
                    ? "bg-blue-600 text-white"
                    : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50",
                ].join(" ")}
              >
                <span>{m.label}</span>
                {m.badge && (
                  <span
                    className={[
                      "text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded",
                      m.badge === "Recommended"
                        ? installTab === m.id
                          ? "bg-blue-500 text-blue-50"
                          : "bg-blue-100 text-blue-700"
                        : installTab === m.id
                          ? "bg-gray-700 text-gray-200"
                          : "bg-gray-100 text-gray-500",
                    ].join(" ")}
                  >
                    {m.badge}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
            <p className="text-sm text-gray-600">{activeInstall.blurb}</p>
            {activeInstall.steps.map((step, i) => (
              <div key={i} className="space-y-2">
                <p className="text-sm text-gray-700">{step.text}</p>
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
            <p className="text-xs text-gray-400 pt-2 border-t border-gray-100">
              <span className="font-medium text-gray-500">API_URL</span> defaults to{" "}
              <span className="font-mono">http://localhost:7891</span>. Set it to wherever
              the Tandem API is reachable from the machine running the agent.
            </p>
          </div>
        </section>

        {/* Client setup */}
        <section className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">2. Wire it into your client</h2>
            <p className="mt-1 text-sm text-gray-500">
              These snippets all use the npx form. Swap to <span className="font-mono text-xs">tandem-mcp</span>{" "}
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
                    ? "bg-blue-600 text-white"
                    : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50",
                ].join(" ")}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
            <p className="text-sm text-gray-600">{activeClient.blurb}</p>
            <CodeBlock
              code={activeClient.config}
              copyKey={`client-${activeClient.id}`}
              copied={copied}
              onCopy={copy}
            />
          </div>
        </section>

        {/* Connect step */}
        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-gray-900">3. Connect to a canvas</h2>
          <p className="text-sm text-gray-600 leading-relaxed">
            Create a canvas in your browser (it'll give you an 8-character code
            like <span className="font-mono text-xs">TOKYO7X3K</span>), then tell your
            agent the code. The agent calls <span className="font-mono text-xs">canvas.connect</span>{" "}
            once with that code; from then on every other tool operates on that
            canvas with no ID to pass around.
          </p>
        </section>

        {/* Tool surface */}
        <section className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">The tool surface</h2>
            <p className="mt-1 text-sm text-gray-500">
              Every tool operates on whatever canvas this session connected to.
              No IDs to pass around — the JWT held in the gateway pins the
              session to one canvas.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            {TOOLS.map((group) => (
              <div
                key={group.group}
                className="bg-white border border-gray-200 rounded-xl p-4"
              >
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  {group.group}
                </div>
                <ul className="space-y-2">
                  {group.items.map(([name, desc]) => (
                    <li key={name} className="text-sm">
                      <span className="font-mono text-xs text-blue-700">{name}</span>
                      <span className="text-gray-600"> — {desc}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* Multi-agent example */}
        <section className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">
              Multi-agent flow: research → report
            </h2>
            <p className="mt-1 text-sm text-gray-500 leading-relaxed">
              Because the canvas is the shared artifact, you can split work
              across specialized agents instead of stuffing everything into one
              prompt. Each agent connects to the same canvas code; their
              outputs land on the same map / itinerary / docs in real time, and
              the user can watch (or interrupt) from the browser.
            </p>
          </div>

          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <ol className="space-y-4 text-sm text-gray-700">
              <li>
                <div className="font-semibold text-gray-900">1. Scout agent — fills the map</div>
                <p className="text-gray-600 mt-1 leading-relaxed">
                  Web-searching agent gathers candidate venues, calls{" "}
                  <span className="font-mono text-xs">canvas.connect</span> with the user's
                  code, then drops <span className="font-mono text-xs">canvas.pin.add</span> for
                  each location with lat/lng, label, and a short note.
                </p>
              </li>
              <li>
                <div className="font-semibold text-gray-900">2. Planner agent — builds the itinerary</div>
                <p className="text-gray-600 mt-1 leading-relaxed">
                  Reads <span className="font-mono text-xs">canvas.state.read</span> to see what
                  the scout dropped, then emits <span className="font-mono text-xs">canvas.event.add</span>{" "}
                  for each day, linking back to pins via <span className="font-mono text-xs">pinId</span>.
                </p>
              </li>
              <li>
                <div className="font-semibold text-gray-900">3. Reporter agent — writes the brief</div>
                <p className="text-gray-600 mt-1 leading-relaxed">
                  Walks the final state and emits a markdown summary via{" "}
                  <span className="font-mono text-xs">canvas.note.add</span>. Attaches
                  per-stop reasoning to each pin with{" "}
                  <span className="font-mono text-xs">parentKind: "pin"</span>.
                </p>
              </li>
              <li>
                <div className="font-semibold text-gray-900">4. Human in the loop</div>
                <p className="text-gray-600 mt-1 leading-relaxed">
                  Throughout, the user is watching the canvas update live in
                  their browser. They can reject pins, edit events directly, or
                  post scoped edit requests that come back through{" "}
                  <span className="font-mono text-xs">canvas.pending_edits.read</span> for the
                  agents to pick up.
                </p>
              </li>
            </ol>
          </div>

          <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-900 leading-relaxed">
            <span className="font-semibold">The pattern:</span> the canvas is the
            blackboard. Each agent only needs the code, an MCP client, and a
            narrow role. Hand-offs happen through canvas state, not through a
            shared prompt — which means you can mix vendors (Claude here, GPT
            there, a local open-weights model for the cheap step) without
            rewriting the orchestration.
          </div>
        </section>

        {/* Authoring your own */}
        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-gray-900">Build your own integration</h2>
          <p className="text-sm text-gray-600 leading-relaxed">
            The gateway is intentionally thin: it owns a JWT and forwards
            tool calls to the Tandem HTTP API. If you'd rather skip the gateway
            and talk to the API directly from your agent runtime, the same
            endpoints are documented under <span className="font-mono text-xs">/api/canvas/*</span>.
            The MCP gateway exists so MCP-aware clients get a zero-config
            experience; it isn't a required layer.
          </p>
          <p className="text-sm text-gray-600 leading-relaxed">
            Source lives in{" "}
            <a
              href="https://github.com/jaximus808/tandam/tree/main/apps/mcp-gateway"
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs text-blue-600 underline hover:text-blue-700"
            >
              apps/mcp-gateway/
            </a>{" "}
            — small enough to fork.
          </p>
        </section>

        <div className="pt-4 border-t border-gray-200">
          <button
            onClick={onBack}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            ← Back to home
          </button>
        </div>
      </div>
    </div>
  );
}
