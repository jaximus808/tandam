import { useEffect, useState } from "react";
import type { CanvasMeta } from "../types";
import { listMyCanvases } from "../lib/api";
import { fetchMe, type User } from "../lib/auth";
import { modeTheme } from "../lib/modeTheme";
import TandemLogo from "../components/TandemLogo";

interface Props {
  onOpenCanvas: (code: string) => void;
  onHome: () => void;
}

type Load = { status: "loading" } | { status: "signedOut" } | { status: "error"; message: string } | { status: "ready"; canvases: CanvasMeta[] };

function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(then).toLocaleDateString();
}

export default function MyCanvases({ onOpenCanvas, onHome }: Props) {
  const [user, setUser] = useState<User | null>(null);
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const me = await fetchMe();
      if (cancelled) return;
      setUser(me);
      if (!me) {
        setLoad({ status: "signedOut" });
        return;
      }
      try {
        const canvases = await listMyCanvases();
        if (!cancelled) setLoad({ status: "ready", canvases });
      } catch (e) {
        if (!cancelled) setLoad({ status: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-paper font-brand text-gray-900">
      <header className="flex items-center gap-2 border-b border-gray-900/5 px-4 py-3">
        <button onClick={onHome} className="group flex items-center gap-1.5" title="Back to home">
          <TandemLogo size={22} animate={false} />
          <span className="hidden font-semibold tracking-tight transition-colors group-hover:text-sky-600 sm:inline">
            Tandem
          </span>
        </button>
        <span className="text-gray-200">/</span>
        <span className="font-display text-[15px] font-medium">Your canvases</span>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">
        {load.status === "loading" && <p className="text-sm text-gray-500">Loading your canvases…</p>}

        {load.status === "signedOut" && (
          <div className="rounded-2xl border border-gray-900/10 bg-white px-8 py-10 text-center">
            <p className="font-display text-lg font-medium">Sign in to see your canvases</p>
            <p className="mt-1.5 text-sm text-gray-500">
              Canvases you create while signed in are saved to your account and show up here on every device.
            </p>
            <button
              onClick={onHome}
              className="mt-5 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
            >
              Back to home
            </button>
          </div>
        )}

        {load.status === "error" && <p className="text-sm text-red-600">{load.message}</p>}

        {load.status === "ready" && (
          <>
            <div className="mb-6 flex items-end justify-between">
              <div>
                <h1 className="font-display text-2xl font-medium tracking-tight">
                  {user?.displayName ? `${user.displayName.split(" ")[0]}'s canvases` : "Your canvases"}
                </h1>
                <p className="mt-1 text-sm text-gray-500">
                  {load.canvases.length} {load.canvases.length === 1 ? "canvas" : "canvases"} saved to your account
                </p>
              </div>
            </div>

            {load.canvases.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-gray-300 bg-white/60 px-8 py-12 text-center">
                <p className="font-display text-lg font-medium">No canvases yet</p>
                <p className="mt-1.5 text-sm text-gray-500">
                  Create a canvas while signed in and it’ll live here. Already have an anonymous canvas? Open it and
                  hit <span className="font-medium">Copy to my account</span>.
                </p>
                <button
                  onClick={onHome}
                  className="mt-5 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
                >
                  Create a canvas
                </button>
              </div>
            ) : (
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {load.canvases.map((c) => {
                  const t = modeTheme((c.mode as never) ?? "welcome");
                  return (
                    <li key={c.id}>
                      <button
                        onClick={() => onOpenCanvas(c.code)}
                        className="group relative block w-full overflow-hidden rounded-2xl border border-gray-900/10 bg-white p-4 text-left transition-all hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-md"
                      >
                        <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: t.solid }} />
                        <div className="flex items-start justify-between gap-3">
                          <span className="font-display text-base font-medium leading-snug text-gray-900">
                            {c.name || "Untitled canvas"}
                          </span>
                          <span
                            className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize"
                            style={{ backgroundColor: t.soft, color: t.solid }}
                          >
                            {c.mode}
                          </span>
                        </div>
                        <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
                          <span className="font-code tracking-[0.15em]">{c.code}</span>
                          <span>{timeAgo(c.updatedAt)}</span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </main>
    </div>
  );
}
