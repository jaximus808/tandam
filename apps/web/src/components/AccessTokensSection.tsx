import { useEffect, useState } from "react";
import { KeyRound, Plus, Trash2, Copy, Check, X, AlertTriangle } from "lucide-react";
import {
  listTokens,
  createToken,
  revokeToken,
  type AccessToken,
  type MintedToken,
} from "../lib/tokens";

function shortDate(iso?: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// AccessTokensSection is the /me control for MCP personal access tokens. A token
// lets Claude act as you on your private / shared canvases — you mint one here,
// then set it as the TANDEM_TOKEN env var in your MCP client config. The plaintext
// is shown exactly once, right after minting; after that only its last 4 chars are
// ever visible, so we surface a copy-now callout on creation.
export default function AccessTokensSection() {
  const [tokens, setTokens] = useState<AccessToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // The just-minted token (plaintext) — held in memory only until dismissed.
  const [minted, setMinted] = useState<MintedToken | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listTokens()
      .then((t) => !cancelled && setTokens(t))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const tok = await createToken(name.trim() || "Untitled token");
      setMinted(tok);
      setTokens((prev) => [
        { id: tok.id, name: tok.name, lastFour: tok.lastFour, createdAt: tok.createdAt },
        ...(prev ?? []),
      ]);
      setName("");
      setCreating(false);
      setCopied(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create token");
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(id: string) {
    const prev = tokens;
    setTokens((t) => (t ?? []).filter((x) => x.id !== id));
    try {
      await revokeToken(id);
      // If we're revoking the one we just minted, clear its callout too.
      setMinted((m) => (m?.id === id ? null : m));
    } catch (e) {
      setTokens(prev); // revert
      setError(e instanceof Error ? e.message : "Failed to revoke token");
    }
  }

  async function copySecret() {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the user can still select the text manually */
    }
  }

  return (
    <section className="mt-6 rounded-2xl border border-ink/10 bg-surface p-5 sm:p-6">
      <div className="flex items-start gap-3.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ink/[0.04] text-ink/45">
          <KeyRound className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink">Access tokens (MCP)</div>
          <div className="text-xs text-ink/50">
            Let Claude act as you on your private and shared canvases. Mint a token, then set it as the{" "}
            <code className="rounded bg-ink/[0.06] px-1 py-0.5 font-code text-[11px]">TANDEM_TOKEN</code>{" "}
            env var in your MCP client config.
          </div>
        </div>
        {!creating && (
          <button
            onClick={() => {
              setCreating(true);
              setError(null);
            }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ink/15 px-3 py-1.5 text-sm font-medium text-ink/70 transition-colors hover:border-ink/40 hover:bg-paper"
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">New token</span>
          </button>
        )}
      </div>

      {/* One-time plaintext callout — the only moment the secret is visible. */}
      {minted && (
        <div className="mt-4 rounded-xl border border-amber-300/70 bg-amber-50 p-4 dark:border-amber-400/30 dark:bg-amber-500/10">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4" />
            Copy your token now — it won’t be shown again.
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-amber-300/60 bg-paper px-3 py-2 font-code text-xs text-ink">
              {minted.token}
            </code>
            <button
              onClick={copySecret}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-ink px-3 py-2 text-xs font-medium text-paper hover:opacity-90"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              onClick={() => setMinted(null)}
              className="inline-flex shrink-0 items-center justify-center rounded-lg border border-ink/15 p-2 text-ink/50 hover:bg-paper"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Create form. */}
      {creating && (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
              if (e.key === "Escape") setCreating(false);
            }}
            placeholder="Token name (e.g. Claude Desktop)"
            maxLength={80}
            className="min-w-0 flex-1 rounded-lg border border-ink/15 bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-ink/40"
          />
          <div className="flex shrink-0 gap-2">
            <button
              onClick={handleCreate}
              disabled={busy}
              className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Creating…" : "Create"}
            </button>
            <button
              onClick={() => {
                setCreating(false);
                setName("");
              }}
              className="rounded-lg border border-ink/15 px-3 py-2 text-sm font-medium text-ink/60 hover:bg-paper"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <div className="mt-3 text-xs text-red-600">{error}</div>}

      {/* Token list. */}
      <div className="mt-4">
        {tokens === null && !error && (
          <div className="h-10 animate-pulse rounded-lg bg-ink/[0.04]" />
        )}
        {tokens && tokens.length === 0 && !creating && (
          <p className="text-xs text-ink/45">No tokens yet. Create one to connect an MCP client as you.</p>
        )}
        {tokens && tokens.length > 0 && (
          <ul className="divide-y divide-ink/[0.07] overflow-hidden rounded-xl border border-ink/10">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center gap-3 bg-paper/40 px-3.5 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{t.name}</div>
                  <div className="font-code text-[11px] text-ink/40">
                    tdm_pat_…{t.lastFour} · created {shortDate(t.createdAt)}
                    {t.lastUsedAt ? ` · last used ${shortDate(t.lastUsedAt)}` : " · never used"}
                  </div>
                </div>
                <button
                  onClick={() => handleRevoke(t.id)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ink/15 px-2.5 py-1.5 text-xs font-medium text-ink/60 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"
                  title="Revoke token"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Revoke</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
