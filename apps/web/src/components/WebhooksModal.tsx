import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  Copy,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Trash2,
  X,
} from "lucide-react";
import {
  createWebhook,
  deleteWebhook,
  EVENT_LABELS,
  listWebhookDeliveries,
  listWebhooks,
  retryWebhookDelivery,
  rotateWebhookSecret,
  updateWebhook,
  type MintedWebhook,
  type Webhook,
  type WebhookDelivery,
} from "../lib/webhooks";

/* WebhooksModal — the owner's control for sending this canvas's task events to
   their own server.

   WHY A MODAL AND NOT A PANEL VIEW. The settings dock is 300px wide by default.
   A webhook row has to show a URL, three event names, a secret hint and four
   controls, and the failed-delivery list underneath it has to show an error
   message you can actually read. None of that survives 300px, so the dock keeps
   a one-line summary (see SettingsPanel) and the work happens here at max-w-2xl.

   Portalled to <body>, like DeleteCanvasModal: it opens from inside SidePanel's
   <aside>, where an ancestor transform/filter would otherwise make `fixed
   inset-0` size to the sidebar rather than the viewport.

   TWO REGIONS, NOT TABS. Endpoints on top, failed deliveries below. Tabs would
   hide the thing you opened this for — if a delivery is dead-lettered you need
   to see that on arrival, not discover it behind a second click. */

interface Props {
  code: string;
  onClose: () => void;
}

// ── Small shared pieces ──────────────────────────────────────────────────────

function Kicker({ children }: { children: React.ReactNode }) {
  return <span className="text-xs font-medium uppercase tracking-wide text-ink/50">{children}</span>;
}

const fieldClass =
  "mt-1.5 w-full rounded-md border border-ink/15 bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink/25 " +
  "focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/20 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

function ErrorStrip({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 flex items-start gap-2 rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[13px] text-rose-600 dark:text-rose-400">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/* EventChips renders ALL known events, every time, with the ones this endpoint
   is subscribed to filled in and the rest ghosted. Showing only the subscribed
   set would answer "what does this send" but not "why didn't I get X", which is
   the question someone actually arrives with. The chip label is the literal wire
   value — the same string the receiver reads off the Tandem-Event header — so
   there is nothing to translate between this screen and their code. */
function EventChips({ known, selected }: { known: string[]; selected: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {known.map((e) => {
        const on = selected.includes(e);
        return (
          <span
            key={e}
            title={on ? EVENT_LABELS[e] : `Not sent — ${EVENT_LABELS[e] ?? e}`}
            className={[
              "rounded border px-1.5 py-0.5 font-code text-[10.5px] leading-none",
              on
                ? "border-accent/25 bg-accent/[0.08] text-ink/75"
                : "border-ink/10 text-ink/25 line-through decoration-ink/20",
            ].join(" ")}
          >
            {e}
          </span>
        );
      })}
    </div>
  );
}

/* The one-time secret callout. Same amber treatment as the PAT mint in
   AccessTokensSection, because it is the same promise: this is the only time
   you will see this value. */
function SecretCallout({ minted, onDismiss }: { minted: MintedWebhook; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(minted.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the value is selectable */
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-amber-300/70 bg-amber-50 p-4 dark:border-amber-400/30 dark:bg-amber-500/10">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-300">
        <AlertTriangle className="h-4 w-4" />
        Copy this signing secret now — it won’t be shown again.
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-amber-300/60 bg-paper px-3 py-2 font-code text-xs text-ink">
          {minted.secret}
        </code>
        <button
          onClick={copy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-ink px-3 py-2 text-xs font-medium text-paper hover:opacity-90"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          onClick={onDismiss}
          title="Dismiss"
          className="inline-flex shrink-0 items-center justify-center rounded-lg border border-ink/15 p-2 text-ink/50 hover:bg-paper"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-amber-800/80 dark:text-amber-300/70">
        Your server verifies each delivery with it: HMAC-SHA256 over{" "}
        <code className="font-code">&lt;Tandem-Timestamp&gt;.&lt;raw body&gt;</code>, compared to the{" "}
        <code className="font-code">Tandem-Signature</code> header.
      </p>
    </div>
  );
}

// ── The add / edit form ──────────────────────────────────────────────────────

/* One form for both creating and editing, so the two never drift. `existing` is
   null when adding. */
function EndpointForm({
  known,
  existing,
  busy,
  onCancel,
  onSubmit,
}: {
  known: string[];
  existing: Webhook | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: { url: string; name: string; events: string[] }) => void;
}) {
  const [url, setUrl] = useState(existing?.url ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [events, setEvents] = useState<string[]>(existing?.events ?? known);
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    urlRef.current?.focus();
  }, []);

  const ready = url.trim().length > 0 && events.length > 0 && !busy;

  function toggle(e: string) {
    setEvents((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));
  }

  return (
    <div className="mt-3 rounded-md border border-ink/15 bg-paper p-3.5">
      <label className="block">
        <span className="text-xs font-medium text-ink/60">Endpoint URL</span>
        <input
          ref={urlRef}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ready) onSubmit({ url, name, events });
          }}
          placeholder="https://example.com/tandem-hook"
          maxLength={2000}
          spellCheck={false}
          autoComplete="off"
          className={`${fieldClass} font-code text-[12.5px]`}
        />
      </label>

      <label className="mt-3 block">
        <span className="text-xs font-medium text-ink/60">Label (optional)</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ready) onSubmit({ url, name, events });
          }}
          placeholder="Deploy pipeline"
          maxLength={80}
          className={fieldClass}
        />
      </label>

      <fieldset className="mt-3.5">
        <legend className="text-xs font-medium text-ink/60">Send when</legend>
        <div className="mt-1.5 space-y-1.5">
          {known.map((e) => (
            <label key={e} className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={events.includes(e)}
                onChange={() => toggle(e)}
                className="mt-[3px] h-3.5 w-3.5 shrink-0 accent-accent"
              />
              <span className="min-w-0">
                <span className="font-code text-[11.5px] text-ink/80">{e}</span>
                <span className="block text-[11.5px] leading-snug text-ink/45">
                  {EVENT_LABELS[e] ?? ""}
                </span>
              </span>
            </label>
          ))}
        </div>
        {events.length === 0 && (
          <p className="mt-2 text-[11.5px] text-ink/45">
            Pick at least one event. To stop deliveries without deleting the endpoint, turn it off
            instead.
          </p>
        )}
      </fieldset>

      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md border border-ink/15 bg-surface px-3 py-1.5 text-[13px] font-medium text-ink/70 transition-colors hover:bg-ink/5"
        >
          Cancel
        </button>
        <button
          disabled={!ready}
          onClick={() => onSubmit({ url, name, events })}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
        >
          {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
          {existing ? "Save changes" : "Add endpoint"}
        </button>
      </div>
    </div>
  );
}

// ── Time formatting ──────────────────────────────────────────────────────────

function relativeTime(iso?: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const secs = Math.round((Date.now() - t) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── The modal ────────────────────────────────────────────────────────────────

export default function WebhooksModal({ code, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [known, setKnown] = useState<string[]>([]);
  const [max, setMax] = useState(5);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [dead, setDead] = useState<WebhookDelivery[] | null>(null);
  const [requeued, setRequeued] = useState(0);
  const [retrying, setRetrying] = useState<string | null>(null);

  // The plaintext secret from the last create/rotate — memory only, never
  // persisted, cleared when dismissed or when the modal closes.
  const [minted, setMinted] = useState<MintedWebhook | null>(null);

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const reloadDead = useCallback(async () => {
    try {
      setDead(await listWebhookDeliveries(code, { status: "dead", limit: 50 }));
    } catch {
      setDead([]); // the endpoint list is the primary content; don't block on this
    }
  }, [code]);

  useEffect(() => {
    let live = true;
    listWebhooks(code)
      .then((res) => {
        if (!live) return;
        setHooks(res.webhooks ?? []);
        setKnown(res.knownEvents ?? []);
        setMax(res.maxWebhooks ?? 5);
      })
      .catch((e) => {
        if (!live) return;
        setHooks([]);
        setLoadError(e instanceof Error ? e.message : "Could not load webhooks");
      });
    void reloadDead();
    return () => {
      live = false;
    };
  }, [code, reloadDead]);

  const atCap = (hooks?.length ?? 0) >= max;

  async function handleCreate(input: { url: string; name: string; events: string[] }) {
    setBusy(true);
    setError(null);
    try {
      const created = await createWebhook(code, {
        url: input.url.trim(),
        name: input.name.trim(),
        events: input.events,
      });
      setHooks((prev) => [...(prev ?? []), created]);
      setMinted(created);
      setAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the endpoint");
    } finally {
      setBusy(false);
    }
  }

  async function handleSave(id: string, input: { url: string; name: string; events: string[] }) {
    setBusy(true);
    setError(null);
    try {
      const saved = await updateWebhook(code, id, {
        url: input.url.trim(),
        name: input.name.trim(),
        events: input.events,
      });
      setHooks((prev) => (prev ?? []).map((h) => (h.id === id ? saved : h)));
      setEditingId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the endpoint");
    } finally {
      setBusy(false);
    }
  }

  // Optimistic: the switch moves under the cursor and reverts if the save fails.
  async function handleToggle(hook: Webhook) {
    const next = !hook.enabled;
    setError(null);
    setHooks((prev) => (prev ?? []).map((h) => (h.id === hook.id ? { ...h, enabled: next } : h)));
    try {
      await updateWebhook(code, hook.id, { enabled: next });
    } catch (e) {
      setHooks((prev) =>
        (prev ?? []).map((h) => (h.id === hook.id ? { ...h, enabled: hook.enabled } : h)),
      );
      setError(e instanceof Error ? e.message : "Could not save the endpoint");
    }
  }

  async function handleRotate(id: string) {
    setBusy(true);
    setError(null);
    try {
      const rotated = await rotateWebhookSecret(code, id);
      setHooks((prev) => (prev ?? []).map((h) => (h.id === id ? rotated : h)));
      setMinted(rotated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rotate the secret");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    const prev = hooks;
    setConfirmingDelete(null);
    setError(null);
    setHooks((rows) => (rows ?? []).filter((h) => h.id !== id));
    setMinted((m) => (m?.id === id ? null : m));
    try {
      await deleteWebhook(code, id);
      // Its dead letters cascaded away with it.
      void reloadDead();
    } catch (e) {
      setHooks(prev ?? null);
      setError(e instanceof Error ? e.message : "Could not delete the endpoint");
    }
  }

  async function handleRetry(deliveryId: string) {
    setRetrying(deliveryId);
    setError(null);
    try {
      await retryWebhookDelivery(code, deliveryId);
      setDead((rows) => (rows ?? []).filter((d) => d.id !== deliveryId));
      setRequeued((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not retry the delivery");
    } finally {
      setRetrying(null);
    }
  }

  function urlOf(webhookId: string): string {
    return (hooks ?? []).find((h) => h.id === webhookId)?.url ?? "deleted endpoint";
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="webhooks-title"
        className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-[10px] border border-ink/10 bg-surface text-ink shadow-lg outline-none"
      >
        <div className="tandem-scroll overflow-y-auto px-5 pb-5 pt-5">
          <Kicker>Webhooks · {code}</Kicker>
          <h2 id="webhooks-title" className="mt-1 text-xl font-semibold tracking-tight">
            Send task events to your own server
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-ink/60">
            Tandem posts a signed JSON body to each endpoint when this canvas’s queue moves. Only
            you can change this — endpoints are set here, never by an agent.
          </p>

          {loadError && <ErrorStrip>{loadError}</ErrorStrip>}
          {error && <ErrorStrip>{error}</ErrorStrip>}
          {minted && <SecretCallout minted={minted} onDismiss={() => setMinted(null)} />}

          {/* ── Endpoints ────────────────────────────────────────────────── */}
          <div className="mt-5 flex items-center justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <h3 className="text-[13px] font-semibold text-ink">Endpoints</h3>
              {hooks && (
                <span className="font-code text-[11px] text-ink/35">
                  {hooks.length} of {max}
                </span>
              )}
            </div>
            {!adding && (
              <button
                onClick={() => {
                  setAdding(true);
                  setEditingId(null);
                  setError(null);
                }}
                disabled={atCap}
                title={
                  atCap
                    ? `This canvas is at its limit of ${max} endpoints. Delete one to add another.`
                    : undefined
                }
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-ink/15 px-2.5 py-1.5 text-[13px] font-medium text-ink/70 transition-colors hover:border-ink/40 hover:bg-paper disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-ink/15 disabled:hover:bg-transparent"
              >
                <Plus className="h-3.5 w-3.5" />
                Add endpoint
              </button>
            )}
          </div>

          {adding && (
            <EndpointForm
              known={known}
              existing={null}
              busy={busy}
              onCancel={() => setAdding(false)}
              onSubmit={handleCreate}
            />
          )}

          <div className="mt-3">
            {hooks === null && !loadError && (
              <div className="h-16 animate-pulse rounded-md border border-ink/10 bg-ink/[0.03]" />
            )}

            {hooks && hooks.length === 0 && !adding && (
              <p className="rounded-md border border-dashed border-ink/15 px-3.5 py-4 text-[12.5px] leading-relaxed text-ink/45">
                No endpoints yet. Add one to get a POST on your server every time a task is approved,
                finishes, or has its claim released.
              </p>
            )}

            {hooks && hooks.length > 0 && (
              <ul className="divide-y divide-ink/[0.07] overflow-hidden rounded-md border border-ink/10">
                {hooks.map((h) =>
                  editingId === h.id ? (
                    <li key={h.id} className="bg-paper/40 px-3.5 pb-3.5 pt-1">
                      <EndpointForm
                        known={known}
                        existing={h}
                        busy={busy}
                        onCancel={() => setEditingId(null)}
                        onSubmit={(input) => handleSave(h.id, input)}
                      />
                    </li>
                  ) : (
                    <li key={h.id} className="bg-paper/40 px-3.5 py-3">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              aria-hidden
                              className={[
                                "h-1.5 w-1.5 shrink-0 rounded-full",
                                h.enabled ? "bg-emerald-500" : "bg-ink/20",
                              ].join(" ")}
                            />
                            <span className="truncate text-[13px] font-medium text-ink">
                              {h.name || "Untitled endpoint"}
                            </span>
                            {!h.enabled && (
                              <span className="shrink-0 rounded-full border border-ink/10 bg-ink/[0.03] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink/40">
                                Off
                              </span>
                            )}
                          </div>
                          <div className="mt-1 truncate font-code text-[11.5px] text-ink/50" title={h.url}>
                            {h.url}
                          </div>
                          <div className="mt-2">
                            <EventChips known={known} selected={h.events} />
                          </div>
                          <div className="mt-1.5 font-code text-[10.5px] text-ink/35">
                            whsec_…{h.secretLastFour || "????"}
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-col items-end gap-1.5">
                          {/* Two explicit choices rather than one flip-toggle:
                              the same shape as ShareDialog's Segmented, so
                              clicking the state you're already in does nothing
                              instead of turning the endpoint off by surprise. */}
                          <div
                            role="group"
                            aria-label="Endpoint delivery"
                            className="inline-flex rounded-md border border-ink/15 bg-paper p-0.5"
                          >
                            {([true, false] as const).map((on) => (
                              <button
                                key={String(on)}
                                aria-pressed={h.enabled === on}
                                onClick={() => h.enabled !== on && handleToggle(h)}
                                className={[
                                  "rounded-[5px] px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                                  h.enabled === on
                                    ? on
                                      ? "bg-accent text-white"
                                      : "bg-ink/70 text-paper"
                                    : "text-ink/45 hover:text-ink",
                                ].join(" ")}
                              >
                                {on ? "On" : "Off"}
                              </button>
                            ))}
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => {
                                setEditingId(h.id);
                                setAdding(false);
                                setError(null);
                              }}
                              title="Edit URL and events"
                              className="rounded-md border border-ink/15 p-1.5 text-ink/50 transition-colors hover:border-ink/35 hover:text-ink"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => handleRotate(h.id)}
                              disabled={busy}
                              title="Replace the signing secret. Deliveries use the new one immediately."
                              className="rounded-md border border-ink/15 p-1.5 text-ink/50 transition-colors hover:border-ink/35 hover:text-ink disabled:opacity-50"
                            >
                              <RotateCw className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => setConfirmingDelete(h.id)}
                              title="Delete endpoint"
                              className="rounded-md border border-ink/15 p-1.5 text-ink/50 transition-colors hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>

                      {confirmingDelete === h.id && (
                        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-md border border-rose-500/20 bg-rose-500/[0.07] px-3 py-2">
                          <span className="text-[12px] text-ink/70">
                            Delete this endpoint? Its delivery history goes too.
                          </span>
                          <div className="flex gap-2">
                            <button
                              onClick={() => setConfirmingDelete(null)}
                              className="rounded-md border border-ink/15 bg-surface px-2.5 py-1 text-[12px] font-medium text-ink/70 hover:bg-ink/5"
                            >
                              Keep it
                            </button>
                            <button
                              onClick={() => handleDelete(h.id)}
                              className="rounded-md bg-rose-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-rose-500"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  ),
                )}
              </ul>
            )}
          </div>

          {/* ── Failed deliveries ────────────────────────────────────────── */}
          <div className="mt-7 border-t border-ink/10 pt-4">
            <div className="flex items-baseline justify-between gap-3">
              <div className="flex items-baseline gap-2">
                <h3 className="text-[13px] font-semibold text-ink">Failed deliveries</h3>
                {dead && dead.length > 0 && (
                  <span className="font-code text-[11px] text-rose-600 dark:text-rose-400">
                    {dead.length}
                  </span>
                )}
              </div>
              {requeued > 0 && (
                <span className="text-[11.5px] text-ink/45">
                  {requeued} re-queued — the next delivery run will pick {requeued === 1 ? "it" : "them"} up.
                </span>
              )}
            </div>

            <div className="mt-2.5">
              {dead === null && (
                <div className="h-12 animate-pulse rounded-md border border-ink/10 bg-ink/[0.03]" />
              )}

              {dead && dead.length === 0 && (
                <p className="text-[12.5px] leading-relaxed text-ink/45">
                  Nothing failed. A delivery lands here after five attempts fail; retrying puts it
                  back in the queue with the same delivery id, so a receiver that already handled it
                  can ignore the repeat.
                </p>
              )}

              {dead && dead.length > 0 && (
                <ul className="divide-y divide-ink/[0.07] overflow-hidden rounded-md border border-rose-500/20">
                  {dead.map((d) => (
                    <li key={d.id} className="flex items-start gap-3 bg-rose-500/[0.04] px-3.5 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="rounded border border-ink/10 bg-ink/[0.04] px-1.5 py-0.5 font-code text-[10.5px] leading-none text-ink/70">
                            {d.eventType}
                          </span>
                          <span className="font-code text-[11px] text-ink/35">
                            {d.attemptCount} {d.attemptCount === 1 ? "attempt" : "attempts"} ·{" "}
                            {relativeTime(d.createdAt)}
                          </span>
                        </div>
                        <div
                          className="mt-1 truncate font-code text-[11.5px] text-ink/50"
                          title={urlOf(d.webhookId)}
                        >
                          {urlOf(d.webhookId)}
                        </div>
                        <div className="mt-1 line-clamp-2 font-code text-[11px] leading-snug text-rose-600 dark:text-rose-400">
                          {d.responseStatus ? `HTTP ${d.responseStatus}` : "No response"}
                          {d.error ? ` — ${d.error}` : ""}
                          {d.responseBody ? ` — ${d.responseBody}` : ""}
                        </div>
                      </div>
                      <button
                        onClick={() => handleRetry(d.id)}
                        disabled={retrying === d.id}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-ink/15 bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink/70 transition-colors hover:border-ink/40 hover:text-ink disabled:opacity-50"
                      >
                        {retrying === d.id ? (
                          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        Retry
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="mt-6 flex justify-end">
            <button
              onClick={onClose}
              className="rounded-md border border-ink/15 bg-surface px-4 py-2 text-sm font-medium text-ink/70 transition-colors hover:bg-ink/5"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
