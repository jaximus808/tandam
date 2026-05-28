import { useMemo, useState } from "react";
import { listRecent, removeRecent } from "../lib/recentCanvases";
import TandemLogo from "../components/TandemLogo";
import HeroCanvasDemo from "../components/HeroCanvasDemo";

interface Props {
  onJoin: (code: string) => void;
  onOpenMCP: () => void;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

type ModeKind = "map" | "itinerary" | "docs" | "sheets" | "roadmap";

function ModeIcon({ kind }: { kind: ModeKind }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "map":
      return (
        <svg {...common}>
          <path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z" />
          <circle cx="12" cy="11" r="2" />
        </svg>
      );
    case "itinerary":
      return (
        <svg {...common}>
          <rect x="3" y="4.5" width="18" height="16" rx="2" />
          <path d="M3 9h18M8 3v3M16 3v3M7.5 13h3M7.5 16.5h6" />
        </svg>
      );
    case "docs":
      return (
        <svg {...common}>
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v4h4M9 12h6M9 15.5h6M9 8.5h2" />
        </svg>
      );
    case "sheets":
      return (
        <svg {...common}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="M3.5 9.5h17M3.5 14.5h17M9 4.5v15M15 4.5v15" />
        </svg>
      );
    case "roadmap":
      return (
        <svg {...common}>
          <path d="M5 6h12M8 12h11M11 18h8" />
          <circle cx="3.5" cy="6" r="1.4" />
          <circle cx="6.5" cy="12" r="1.4" />
          <circle cx="9.5" cy="18" r="1.4" />
        </svg>
      );
  }
}

const MODE_DOCS: {
  kind: ModeKind;
  name: string;
  tint: string;
  desc: string;
}[] = [
  {
    kind: "map",
    name: "Map",
    tint: "text-sky-600 bg-sky-50",
    desc: "Pins with labels, notes, and colors on a real map. Pick a base map — US, world, Tokyo, Japan — or just ask your agent to switch it.",
  },
  {
    kind: "itinerary",
    name: "Itinerary",
    tint: "text-amber-600 bg-amber-50",
    desc: "A day-by-day schedule. Events link back to their pins on the map, so the plan and the place stay in sync.",
  },
  {
    kind: "docs",
    name: "Docs",
    tint: "text-violet-600 bg-violet-50",
    desc: "Free-form markdown notes with image uploads — briefs, research, checklists, anything that doesn't belong on the map.",
  },
  {
    kind: "sheets",
    name: "Sheets",
    tint: "text-emerald-600 bg-emerald-50",
    desc: "Structured tables with typed columns and drag-to-reorder rows. Good for budgets, comparisons, and tracking.",
  },
  {
    kind: "roadmap",
    name: "Roadmap",
    tint: "text-rose-600 bg-rose-50",
    desc: "Nested, draggable items with status — todo, in progress, done, blocked. Plan a project and track it in one place.",
  },
];

const STEPS: { title: string; body: string }[] = [
  {
    title: "Create a canvas",
    body: "Name it and you get a short, shareable 8-character code.",
  },
  {
    title: "Connect an agent",
    body: "Point any MCP-aware agent at the code — Claude, Codex, Cursor, or your own.",
  },
  {
    title: "Collaborate live",
    body: "You, your team, and your agents all edit the same canvas in real time.",
  },
];

export default function Landing({ onJoin, onOpenMCP }: Props) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [recents, setRecents] = useState(() => listRecent());

  const hasRecents = useMemo(() => recents.length > 0, [recents]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give your canvas a name.");
      return;
    }
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/canvases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(res.status >= 500 ? "Server error — try again." : detail);
      }
      const canvas = (await res.json()) as { code: string };
      onJoin(canvas.code);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  function handleJoinForm(e: React.FormEvent) {
    e.preventDefault();
    const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (clean.length !== 8) {
      setError("Canvas codes are 8 characters.");
      return;
    }
    onJoin(clean);
  }

  function handleForgetRecent(c: string) {
    removeRecent(c);
    setRecents(listRecent());
  }

  return (
    <div className="min-h-screen bg-white text-gray-900 overflow-y-auto scroll-smooth">
      {/* Nav */}
      <header className="sticky top-0 z-20 bg-white/80 backdrop-blur border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center gap-3">
          <div className="flex items-center gap-2 font-bold">
            <TandemLogo size={24} />
            <span>Tandem</span>
          </div>
          <nav className="ml-auto flex items-center gap-1 sm:gap-2 text-sm">
            <a
              href="#modes"
              className="hidden sm:inline px-3 py-1.5 rounded-lg text-gray-600 hover:text-gray-900 hover:bg-gray-50 transition-colors"
            >
              Modes
            </a>
            <a
              href="https://github.com/jaximus808/tandam"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:inline px-3 py-1.5 rounded-lg text-gray-600 hover:text-gray-900 hover:bg-gray-50 transition-colors"
            >
              GitHub
            </a>
            <button
              onClick={onOpenMCP}
              className="px-3 py-1.5 rounded-lg font-medium text-gray-700 hover:bg-gray-100 transition-colors"
            >
              Connect an agent
            </button>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="absolute inset-x-0 -top-32 h-[28rem] bg-gradient-to-b from-sky-50 via-blue-50/40 to-transparent"
        />
        <div className="relative max-w-6xl mx-auto px-6 pt-14 pb-16 lg:pt-20 lg:pb-24 grid lg:grid-cols-2 gap-12 lg:gap-10 items-center">
          {/* Left: copy + actions */}
          <div className="max-w-xl">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-100 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-700">
              <span className="w-1.5 h-1.5 rounded-full bg-sky-500" />
              Works with any agent — Claude, Codex, Cursor, or your own
            </span>

            <h1 className="mt-5 text-4xl sm:text-5xl font-bold tracking-tight text-gray-900">
              Plan it in <span className="text-sky-500">Tandem</span>.
            </h1>
            <p className="mt-4 text-lg text-gray-600 leading-relaxed">
              You and your agents, on one live canvas. Drop a name, get a link —
              your agent edits the same map, itinerary, and docs you see, in real
              time. No more copy-pasting plans out of a chat window.
            </p>

            {/* Create */}
            <form onSubmit={handleCreate} className="mt-7 flex flex-col sm:flex-row gap-2">
              <input
                value={name}
                onChange={(e) => { setName(e.target.value); setError(""); }}
                placeholder="Name your canvas (e.g. Tokyo trip)"
                className="flex-1 px-4 py-3 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-sky-400 focus:border-transparent"
              />
              <button
                type="submit"
                disabled={creating}
                className="shrink-0 py-3 px-5 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {creating ? "Creating…" : "Create canvas →"}
              </button>
            </form>

            {/* Join */}
            <form onSubmit={handleJoinForm} className="mt-2 flex flex-col sm:flex-row gap-2">
              <input
                value={code}
                onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(""); }}
                placeholder="…or join with a code (e.g. TOKYO7X3K)"
                maxLength={8}
                className="flex-1 px-4 py-3 border border-gray-200 rounded-xl text-sm font-mono tracking-widest uppercase focus:outline-none focus:ring-2 focus:ring-sky-400 focus:border-transparent"
              />
              <button
                type="submit"
                className="shrink-0 py-3 px-5 bg-white border border-gray-300 text-gray-700 rounded-xl font-medium hover:bg-gray-50 transition-colors"
              >
                Open
              </button>
            </form>

            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

            <p className="mt-4 text-xs text-gray-400">
              No sign-up. Share one link with teammates — or other agents — to
              collaborate live.
            </p>
          </div>

          {/* Right: animated demo */}
          <div className="lg:pl-4">
            <HeroCanvasDemo />
          </div>
        </div>
      </section>

      {/* Recent canvases */}
      {hasRecents && (
        <section className="max-w-6xl mx-auto px-6 -mt-6 pb-4">
          <div className="max-w-md">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Recent canvases
            </h2>
            <ul className="space-y-1.5">
              {recents.map((r) => (
                <li
                  key={r.code}
                  className="group flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2 hover:border-sky-400 transition-colors"
                >
                  <button
                    onClick={() => onJoin(r.code)}
                    className="flex-1 flex items-center gap-3 text-left min-w-0"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm text-gray-900 truncate">{r.name}</div>
                      <div className="text-xs text-gray-400">{relativeTime(r.lastOpenedAt)}</div>
                    </div>
                    <span className="font-mono text-xs text-gray-400 tracking-widest">{r.code}</span>
                  </button>
                  <button
                    onClick={() => handleForgetRecent(r.code)}
                    aria-label={`Remove ${r.name} from recents`}
                    className="text-gray-300 hover:text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Remove from recents"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* How it works */}
      <section className="max-w-6xl mx-auto px-6 py-16 border-t border-gray-100">
        <div className="grid sm:grid-cols-3 gap-8">
          {STEPS.map((step, i) => (
            <div key={step.title}>
              <div className="flex items-center gap-2.5">
                <span className="flex items-center justify-center w-7 h-7 rounded-full bg-blue-600 text-white text-sm font-semibold">
                  {i + 1}
                </span>
                <h3 className="font-semibold text-gray-900">{step.title}</h3>
              </div>
              <p className="mt-2 text-sm text-gray-600 leading-relaxed">
                {step.body}
                {i === 1 && (
                  <>
                    {" "}
                    <button
                      onClick={onOpenMCP}
                      className="text-blue-600 hover:text-blue-700 underline"
                    >
                      Setup guide
                    </button>
                    .
                  </>
                )}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Modes */}
      <section id="modes" className="bg-gray-50 border-y border-gray-100">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <div className="max-w-2xl">
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-gray-900">
              One canvas, five ways to work
            </h2>
            <p className="mt-3 text-gray-600 leading-relaxed">
              Switch modes from the top of any canvas. Every mode is fully editable
              by you and your agents alike — they read and write the same entities
              you do.
            </p>
          </div>

          <div className="mt-10 grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {MODE_DOCS.map((m) => (
              <div
                key={m.kind}
                className="rounded-2xl bg-white border border-gray-200 p-5 hover:border-gray-300 hover:shadow-sm transition-all"
              >
                <div className={`inline-flex items-center justify-center w-10 h-10 rounded-xl ${m.tint}`}>
                  <ModeIcon kind={m.kind} />
                </div>
                <h3 className="mt-3 font-semibold text-gray-900">{m.name}</h3>
                <p className="mt-1.5 text-sm text-gray-600 leading-relaxed">{m.desc}</p>
              </div>
            ))}

            {/* Bring-your-own-agent card */}
            <div className="rounded-2xl bg-gradient-to-br from-gray-900 to-gray-800 text-white p-5 flex flex-col">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-white/10 text-sky-300">
                <TandemLogo size={22} animate={false} />
              </div>
              <h3 className="mt-3 font-semibold">Bring your own agent</h3>
              <p className="mt-1.5 text-sm text-gray-300 leading-relaxed">
                Tandem speaks the Model Context Protocol — it isn't locked to any one
                assistant. Connect Claude, Codex, Cursor, the OpenAI Agents SDK, or an
                orchestrator you wrote yourself.
              </p>
              <code className="mt-3 block rounded-lg bg-black/40 px-3 py-2 text-xs font-mono text-sky-200 overflow-x-auto">
                npx -y @jaximus/tandem-mcp
              </code>
              <button
                onClick={onOpenMCP}
                className="mt-3 text-sm font-medium text-sky-300 hover:text-sky-200 text-left"
              >
                Read the setup guide →
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Why */}
      <section className="max-w-3xl mx-auto px-6 py-16">
        <h2 className="text-2xl font-bold tracking-tight text-gray-900">Why Tandem?</h2>
        <p className="mt-4 text-gray-600 leading-relaxed">
          Chat is great for code and terrible for everything else. Planning in chat
          means an agent writes you a wall of text that you then turn into a real
          map or schedule yourself. Tandem makes the canvas the artifact: one link,
          one source of truth, edited live by everyone — and every agent — working
          on it.
        </p>
        <p className="mt-4 text-gray-600 leading-relaxed">
          Reopen it next week and the plan is still there, with everything the team
          has added since. No screenshots pasted into Slack, no “wait, which doc was
          that in,” no copy-paste between chat and reality. The work and the
          deliverable are the same thing.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <a
            href="#top"
            onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}
            className="py-2.5 px-5 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors"
          >
            Start a canvas
          </a>
          <button
            onClick={onOpenMCP}
            className="py-2.5 px-5 bg-white border border-gray-300 text-gray-700 rounded-xl font-medium hover:bg-gray-50 transition-colors"
          >
            Connect an agent
          </button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-100">
        <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-gray-400">
          <div className="flex items-center gap-2">
            <TandemLogo size={18} animate={false} />
            <span>Tandem — you and your agents, in tandem.</span>
          </div>
          <p>
            Made with <span className="text-rose-400">♥</span> by{" "}
            <a
              href="https://www.jaxonp.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-gray-600 transition-colors"
            >
              Jaxon
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
