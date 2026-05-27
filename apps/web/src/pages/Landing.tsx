import { useMemo, useState } from "react";
import { listRecent, removeRecent } from "../lib/recentCanvases";
import TandemLogo from "../components/TandemLogo";

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
    <div className="min-h-screen bg-gray-50 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-12 space-y-12">
        {/* Hero */}
        <div className="flex flex-col items-center text-center">
          <TandemLogo size={156} />
          <h1 className="mt-5 text-3xl font-bold text-gray-900">Tandem</h1>
          <p className="mt-1 text-sm text-gray-500">
            You and your agents, in tandem.
          </p>
        </div>

        {/* Action card */}
        <div className="max-w-sm mx-auto w-full space-y-4">
          <form onSubmit={handleCreate} className="space-y-2">
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setError(""); }}
              placeholder="New canvas name (e.g. Tokyo trip)"
              className="w-full px-4 py-3 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            <button
              type="submit"
              disabled={creating}
              className="w-full py-3 px-4 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create canvas"}
            </button>
          </form>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-200" />
            </div>
            <div className="relative flex justify-center text-xs text-gray-400">
              <span className="bg-gray-50 px-2">or join existing</span>
            </div>
          </div>

          <form onSubmit={handleJoinForm} className="space-y-2">
            <input
              value={code}
              onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(""); }}
              placeholder="Canvas code (e.g. TOKYO7X3K)"
              maxLength={8}
              className="w-full px-4 py-3 border border-gray-300 rounded-xl text-sm font-mono tracking-widest uppercase focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            <button
              type="submit"
              className="w-full py-3 px-4 bg-white border border-gray-300 text-gray-700 rounded-xl font-medium hover:bg-gray-50 transition-colors"
            >
              Open canvas
            </button>
          </form>

          {error && (
            <p className="text-sm text-red-600 text-center">{error}</p>
          )}
        </div>

        {/* Connect your agent CTA */}
        <button
          onClick={onOpenMCP}
          className="group max-w-md mx-auto w-full flex items-center gap-3 bg-gradient-to-r from-gray-900 to-gray-800 hover:from-gray-800 hover:to-gray-700 text-white rounded-xl px-4 py-3 text-left transition-colors"
        >
          <div className="shrink-0 w-9 h-9 rounded-lg bg-white/10 flex items-center justify-center text-lg">
            ⚡
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">Connect your agent</div>
            <div className="text-xs text-gray-300 truncate">
              Claude Code, Cursor, Codex, OpenAI Agents SDK, or your own
            </div>
          </div>
          <span className="text-gray-400 group-hover:text-white transition-colors">→</span>
        </button>

        {/* Recent canvases */}
        {hasRecents && (
          <section className="max-w-md mx-auto w-full">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Recent canvases
            </h2>
            <ul className="space-y-1.5">
              {recents.map((r) => (
                <li
                  key={r.code}
                  className="group flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2 hover:border-blue-400 transition-colors"
                >
                  <button
                    onClick={() => onJoin(r.code)}
                    className="flex-1 flex items-center gap-3 text-left min-w-0"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm text-gray-900 truncate">
                        {r.name}
                      </div>
                      <div className="text-xs text-gray-400">
                        {relativeTime(r.lastOpenedAt)}
                      </div>
                    </div>
                    <span className="font-mono text-xs text-gray-400 tracking-widest">
                      {r.code}
                    </span>
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
          </section>
        )}

        {/* What is Tandem */}
        <section className="space-y-6 pt-4 border-t border-gray-200">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">What is Tandem?</h2>
            <p className="mt-2 text-sm text-gray-600 leading-relaxed">
              Tandem is a shared canvas you and AI agents edit together in real time.
              Drop pins on a map, plan an itinerary, write docs — your agent works on
              the same canvas you do, not in a chat thread off to the side.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-gray-900">Why we built it</h2>
            <p className="mt-2 text-sm text-gray-600 leading-relaxed">
              Chat is great for code and terrible for everything else. Planning a
              trip in chat means an agent writes you a wall of text that you then
              translate into a real map yourself — in Tandem the agent drops the
              pins directly. Coordinating a project across a team means scattered
              DMs, half-written docs, and threads nobody can find a week later —
              in Tandem everyone (and every agent) is editing the same canvas
              live.
            </p>
            <p className="mt-3 text-sm text-gray-600 leading-relaxed">
              Tandem makes the canvas itself the artifact: one link, one source
              of truth, edited live by everyone — and every agent — working on
              it. Reopen it next week and the plan is still there, with
              everything the team has added since. No more screenshots pasted
              into Slack, no "wait which doc was that in," no copy-paste between
              chat and reality. The work and the deliverable are the same thing.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-gray-900">How it works</h2>
            <ol className="mt-2 space-y-2 text-sm text-gray-600 list-decimal list-inside leading-relaxed">
              <li>Create a canvas — you'll get a short shareable code.</li>
              <li>
                Connect any MCP-aware agent (
                <button
                  onClick={onOpenMCP}
                  className="text-blue-600 hover:text-blue-700 underline"
                >
                  setup guide
                </button>
                ) using that code.
              </li>
              <li>The agent reads and writes the same canvas you see.</li>
              <li>Share the code with teammates — or other agents — to collaborate live.</li>
            </ol>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-gray-900">What's in the box</h2>
            <ul className="mt-2 space-y-1.5 text-sm text-gray-600 leading-relaxed">
              <li>
                <span className="font-medium text-gray-800">Map mode</span> —
                pins with labels, notes, colors, and linked events. Pick a base map
                preset (US, world, Tokyo, Japan) or switch by prompting Claude.
              </li>
              <li>
                <span className="font-medium text-gray-800">Itinerary mode</span> —
                day-by-day schedule that auto-links to pins on the map.
              </li>
              <li>
                <span className="font-medium text-gray-800">Docs mode</span> —
                free-form markdown notes with image uploads.
              </li>
              <li>
                <span className="font-medium text-gray-800">Open MCP server</span> —
                native tools any MCP-aware agent (Claude, OpenAI, your own) can use
                to add, update, and delete entities just like you can.{" "}
                <button
                  onClick={onOpenMCP}
                  className="text-blue-600 hover:text-blue-700 underline"
                >
                  Details
                </button>
                .
              </li>
              <li>
                <span className="font-medium text-gray-800">Real-time sync</span> —
                multiple browsers and agent sessions on the same canvas all see
                edits instantly.
              </li>
            </ul>
          </div>
        </section>

        <p className="text-xs text-center text-gray-400 pb-1">
          Share the 8-character code with teammates or your agents to collaborate.
        </p>
        <p className="text-xs text-center text-gray-400 pb-4">
          Made with <span className="text-red-400">♥</span> by{" "}
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
    </div>
  );
}
