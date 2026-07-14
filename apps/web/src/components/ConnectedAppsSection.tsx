import { useEffect, useState } from "react";
import { Plug, Unplug } from "lucide-react";
import { listConnections, revokeConnection, type Connection } from "../lib/oauth";

function shortDate(iso?: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ConnectedAppsSection lists the apps the user has authorized over the hosted MCP
// connector (OAuth) and lets them disconnect one — the user-facing revocation for
// the OAuth flow, the counterpart to Access tokens (which cover the stdio path).
// Renders nothing while empty so it stays out of the way until there's something
// to show.
export default function ConnectedAppsSection() {
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listConnections()
      .then((c) => !cancelled && setConns(c))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleRevoke(clientId: string) {
    const prev = conns;
    setConns((c) => (c ?? []).filter((x) => x.clientId !== clientId));
    try {
      await revokeConnection(clientId);
    } catch (e) {
      setConns(prev); // revert
      setError(e instanceof Error ? e.message : "Failed to disconnect");
    }
  }

  // Nothing authorized yet (and no error) → don't render the section at all.
  if (!error && (conns === null || conns.length === 0)) return null;

  return (
    <section className="mt-6 rounded-2xl border border-ink/10 bg-surface p-5 sm:p-6">
      <div className="flex items-start gap-3.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ink/[0.04] text-ink/45">
          <Plug className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink">Connected apps</div>
          <div className="text-xs text-ink/50">
            Apps you’ve authorized to act as you over MCP. Disconnect to revoke access immediately.
          </div>
        </div>
      </div>

      {error && <div className="mt-3 text-xs text-red-600">{error}</div>}

      {conns && conns.length > 0 && (
        <ul className="mt-4 divide-y divide-ink/[0.07] overflow-hidden rounded-xl border border-ink/10">
          {conns.map((c) => (
            <li key={c.clientId} className="flex items-center gap-3 bg-paper/40 px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-ink">
                  {c.clientName || "Unnamed app"}
                </div>
                <div className="font-code text-[11px] text-ink/40">
                  connected {shortDate(c.createdAt)}
                  {c.lastUsedAt ? ` · last used ${shortDate(c.lastUsedAt)}` : " · never used"}
                </div>
              </div>
              <button
                onClick={() => handleRevoke(c.clientId)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ink/15 px-2.5 py-1.5 text-xs font-medium text-ink/60 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"
                title="Disconnect this app"
              >
                <Unplug className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Disconnect</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
