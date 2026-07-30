import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Shield, Users, X } from "lucide-react";
import type { Action } from "../types";
import type { FleetAgent, FleetTask } from "../lib/api";
import { useFleetRoster } from "../lib/useFleetRoster";
import { useActivityFeed } from "../lib/useActivityFeed";
import { contentionByAgent, type ContentionTally } from "../lib/contention";
import { ageOf, fullDate } from "../lib/relativeTime";
import ActivityFeed from "./ActivityFeed";
import posthog from "../lib/posthog";

/* ─────────────────────────────────────────────────────────────────────────────
   FleetView — the header's fleet trigger + the roster panel it opens (TDM-47).
   Replaces the old "Follow agent" toggle: with a TEAM of agents on a board,
   "follow one of them around the document tabs" is the wrong question. The
   question is "who is working, on what, and what are they waiting on" — which
   is a readout, not a camera.

   THE READOUT. Every row is three aligned columns, so a fleet of six scans in
   one pass without reading a word:

     ●  planner-1                                     claude
        working   TDM-47  Fleet panel UI                 12m
     ○  doc-agent                                         codex
        idle                                              6m

   status dot (state) · verb column (what it's doing) · mono age (for how long).
   Colour comes only from the closed semantic state set — working violet, done
   emerald — and vendor identity from the agent token. No avatars: an agent's
   identity is its name, its model, and what it holds.

   ACTIVE vs DORMANT. The API returns every identity that has ever registered on
   the canvas, which on a long-lived board is a graveyard. The panel shows the
   fleet that is actually around (holding a claim, or online and recently
   active) and folds the rest behind a disclosure — and the trigger chip counts
   the active ones, so "4 agents" means four agents you could be waiting on.

   TWO TABS, ONE PANEL (TDM-48). "Who is working" and "what just happened" are
   the same question asked in two tenses, so the Feed is a tab on THIS popover
   rather than a second one competing for the same corner of the header: one
   place to watch the team. The roster is unchanged behind its tab; the Feed
   loads nothing until you look at it, and carries a small count while facts
   pile up on the side you aren't reading.
   ──────────────────────────────────────────────────────────────────────────── */

// An idle registered agent counts as "around" for this long after its last
// provable activity. Agents holding a claim are always active regardless (a
// long task is quiet by nature).
const ACTIVE_MS = 30 * 60_000;
// How recently a completion still reads as "just finished" on an idle row.
const RECENT_DONE_MS = 45 * 60_000;
// Ages re-render on this cadence so "12m" doesn't freeze while the panel is up.
const TICK_MS = 30_000;
const MAX_DEPTH = 4;

interface Props {
  /** Canvas code — the roster read is a canvas-JWT call keyed on it. */
  code: string;
  /** Canvas actions, already in hand: powers "just finished" + the approval foot. */
  actions: Record<string, Action>;
  /** Agent rows in canvas state — a change here means someone registered. */
  agentCount: number;
  /** Tasks sitting in `proposed`: the fleet's blocker is the human. */
  proposedCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Focus a task on the Board (scope → its epic, detail slide-over open). */
  onOpenTask: (taskId: string) => void;
  /** Show the Board — used by the "awaiting approval" foot. */
  onOpenBoard: () => void;
  /** Open the Connect dialog — the empty state's one action. */
  onConnect: () => void;
}

type TabId = "fleet" | "feed";
const TABS: { id: TabId; label: string }[] = [
  { id: "fleet", label: "Fleet" },
  { id: "feed", label: "Feed" },
];

// ── identity ─────────────────────────────────────────────────────────────────

type VendorKind = "claude" | "vendor" | "model" | "external";
type Vendor = { label: string; kind: VendorKind; title: string };

// Vendor is READ OFF the declared model, never guessed from behaviour. An
// unregistered claimant has no model to read (it never called agent_register),
// so it gets its own treatment rather than a wrong badge.
function vendorOf(a: FleetAgent): Vendor {
  if (!a.registered) {
    return {
      label: "external",
      kind: "external",
      title: `${a.name} holds work on this canvas but never registered (no agent_register), so its model is unknown`,
    };
  }
  const model = (a.model ?? "").trim();
  const named = (label: string, kind: VendorKind): Vendor => ({
    label,
    kind,
    title: model ? `Model: ${model}` : `${label} agent`,
  });
  if (/claude/i.test(model) || (!model && /claude/i.test(a.name))) return named("claude", "claude");
  if (/codex/i.test(model)) return named("codex", "vendor");
  if (/gpt|openai|^o[134]\b/i.test(model)) return named("openai", "vendor");
  if (/gemini/i.test(model)) return named("gemini", "vendor");
  if (model) return named(model, "model");
  return {
    label: "agent",
    kind: "model",
    title: `${a.name} registered without declaring a model`,
  };
}

const VENDOR_CLS: Record<VendorKind, string> = {
  // Terracotta is the agent-presence token — the one place it survives.
  claude: "bg-agent/10 text-agent",
  vendor: "bg-ink/[0.06] text-ink/60",
  model: "bg-ink/[0.06] text-ink/55",
  external: "border border-dashed border-ink/25 text-ink/55",
};

// ── time ─────────────────────────────────────────────────────────────────────
// ageOf / fullDate live in lib/relativeTime so the Feed tab's right-hand column
// reads identically to the roster's.

function within(iso: string | undefined, ms: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && Date.now() - t < ms;
}

// ── component ────────────────────────────────────────────────────────────────

export default function FleetView({
  code,
  actions,
  agentCount,
  proposedCount,
  open,
  onOpenChange,
  onOpenTask,
  onOpenBoard,
  onConnect,
}: Props) {
  const { roster, error, loading, reload } = useFleetRoster(code, open, agentCount);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [showDormant, setShowDormant] = useState(false);
  const [tab, setTab] = useState<TabId>("fleet");
  const [actorFilter, setActorFilter] = useState<string | null>(null);
  // The feed fetches only while it's the visible tab — a board where nobody
  // opens it costs one WS subscription and nothing else.
  const feed = useActivityFeed(code, open && tab === "feed");
  // Re-render on a slow tick so relative ages stay honest while the panel is up.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(t);
  }, [open]);

  // Another board's agent names mean nothing here.
  useEffect(() => setActorFilter(null), [code]);

  const all = useMemo(() => roster?.agents ?? [], [roster]);
  // Working, or online and recently active. Everything else is dormant history.
  const isActive = useCallback(
    (a: FleetAgent) =>
      a.tasks.length > 0 ||
      (a.registered ? a.status === "online" && within(a.lastActivityAt, ACTIVE_MS) : within(a.lastActivityAt, ACTIVE_MS)),
    [],
  );
  const active = useMemo(() => all.filter(isActive), [all, isActive]);
  const dormant = useMemo(() => all.filter((a) => !isActive(a)), [all, isActive]);
  const workingCount = useMemo(() => active.filter((a) => a.tasks.length > 0).length, [active]);

  // "Just finished": the newest done/failed task each identity completed, taken
  // straight from canvas state we already hold — no second fetch, and it stays
  // live with the board.
  const lastDone = useMemo(() => {
    const out = new Map<string, Action>();
    for (const a of Object.values(actions)) {
      if (a.type !== "task") continue;
      if (a.state !== "done" && a.state !== "failed") continue;
      if (!a.claimedBy || !within(a.updatedAt, RECENT_DONE_MS)) continue;
      const prev = out.get(a.claimedBy);
      if (!prev || Date.parse(a.updatedAt) > Date.parse(prev.updatedAt)) out.set(a.claimedBy, a);
    }
    return out;
  }, [actions]);

  // Collisions per agent (TDM-100). The roster answers "who is working on what";
  // this adds "and who has been losing races", which is the question a fleet that
  // is fighting itself makes urgent. Derived from the canvas actions already in
  // hand — every task's contention trail rides the same state push — so it costs
  // no fetch and stays live with the board, exactly like `lastDone` above.
  const contention = useMemo(() => contentionByAgent(actions), [actions]);

  // Panel lifecycle: focus in on open, back to the trigger on close, Esc closes.
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  function trapTab(e: ReactKeyboardEvent) {
    if (e.key !== "Tab") return;
    const root = panelRef.current;
    if (!root) return;
    const focusables = Array.from(
      root.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0);
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first || document.activeElement === root) {
        e.preventDefault();
        last.focus();
      }
    } else if (document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Left/Right move between the tabs, per the tabs pattern. Both stay in the
  // Tab order (rather than roving tabindex) so the panel's existing focus trap
  // keeps working unchanged.
  function onTabKey(e: ReactKeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    setTab(next.id);
    (e.currentTarget as HTMLElement)
      .querySelector<HTMLElement>(`#fleet-tab-${next.id}`)
      ?.focus();
  }

  function openTask(id: string) {
    close();
    onOpenTask(id);
  }

  // Nest executors under the parent that spawned them. An agent whose parent
  // isn't on the roster renders at the top level rather than disappearing.
  const byId = useMemo(() => {
    const m = new Map<string, FleetAgent>();
    for (const a of active) if (a.id) m.set(a.id, a);
    return m;
  }, [active]);
  const childrenById = useMemo(() => {
    const m = new Map<string, FleetAgent[]>();
    for (const a of active) {
      const pid = a.parentAgentId;
      if (!pid || pid === a.id || !byId.has(pid)) continue;
      const kids = m.get(pid) ?? [];
      kids.push(a);
      m.set(pid, kids);
    }
    return m;
  }, [active, byId]);
  const roots = useMemo(
    () => active.filter((a) => !a.parentAgentId || a.parentAgentId === a.id || !byId.has(a.parentAgentId)),
    [active, byId],
  );

  const counts = roster?.counts;
  const total = active.length;
  const chipLabel =
    total === 0
      ? "Fleet"
      : workingCount > 0
        ? `${total} agent${total === 1 ? "" : "s"} · ${workingCount} working`
        : `${total} agent${total === 1 ? "" : "s"} · idle`;

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        onClick={() => {
          const next = !open;
          onOpenChange(next);
          if (next) {
            posthog.capture("fleet_panel_opened", {
              canvas_code: code,
              agents: total,
              working: workingCount,
            });
          }
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          total === 0
            ? "Fleet — no agents on this canvas"
            : `Fleet — ${total} agent${total === 1 ? "" : "s"}, ${workingCount} working`
        }
        title={
          total === 0
            ? "No agents on this canvas yet — open the fleet for how to connect one"
            : "Who's on this canvas and what they're working on"
        }
        className={[
          // h-9 below sm, matching the header's other controls; on a phone this
          // chip collapses to a gauge + count, so it is also the narrowest.
          "inline-flex h-9 items-center gap-2 rounded-md px-2.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper sm:h-8",
          open ? "bg-accent/[0.08] text-accent" : "text-ink/60 hover:bg-ink/5 hover:text-ink/85",
        ].join(" ")}
      >
        <FleetGauge total={total} working={workingCount} />
        <span className="hidden sm:inline">{chipLabel}</span>
        {total > 0 && <span className="sm:hidden tabular-nums">{total}</span>}
      </button>

      {open && (
        <>
          {/* Click-away catcher. No scrim: this is a popover on a live board, not
              a modal that should dim the work behind it. */}
          <div className="fixed inset-0 z-40" onClick={close} aria-hidden="true" />
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Fleet"
            tabIndex={-1}
            onKeyDown={trapTab}
            className="absolute right-0 top-full z-50 mt-2 flex max-h-[min(70vh,560px)] w-[min(380px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-[10px] border border-ink/10 bg-surface shadow-lg focus-visible:outline-none"
          >
            {/* Head — the two readings of "how is the team doing", plus close.
                The tab labels are the panel's title; a separate heading over
                them would say "Fleet" twice. */}
            <div className="flex shrink-0 items-center gap-1 border-b border-ink/10 px-2 py-1.5">
              <div
                role="tablist"
                aria-label="Fleet views"
                onKeyDown={onTabKey}
                className="flex min-w-0 items-center gap-1"
              >
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    role="tab"
                    id={`fleet-tab-${t.id}`}
                    aria-selected={tab === t.id}
                    aria-controls={`fleet-panel-${t.id}`}
                    onClick={() => {
                      setTab(t.id);
                      if (t.id === "feed") {
                        posthog.capture("fleet_feed_opened", { canvas_code: code, unseen: feed.unseen });
                      }
                    }}
                    className={[
                      // tandem-tap: on a phone the fleet popover is a full-width
                      // panel and these tabs are its only navigation.
                      "tandem-tap flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                      tab === t.id
                        ? "bg-accent/[0.08] text-accent"
                        : "text-ink/50 hover:bg-ink/5 hover:text-ink/80",
                    ].join(" ")}
                  >
                    {t.label}
                    {/* What happened while you were reading the other tab.
                        Terracotta is the agent-activity token — this count is
                        exactly that. */}
                    {t.id === "feed" && tab !== "feed" && feed.unseen > 0 && (
                      <span
                        aria-label={`${feed.unseen} new`}
                        className="flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-agent px-1 text-[10px] font-semibold leading-none text-white tabular-nums"
                      >
                        {feed.unseen > 9 ? "9+" : feed.unseen}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <button
                onClick={() => {
                  close();
                  triggerRef.current?.focus();
                }}
                aria-label="Close fleet"
                className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink/40 transition-colors hover:bg-ink/5 hover:text-ink/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-6 sm:w-6"
              >
                <X size={14} />
              </button>
            </div>

            {tab === "feed" && (
              <div
                role="tabpanel"
                id="fleet-panel-feed"
                aria-labelledby="fleet-tab-feed"
                className="flex min-h-0 flex-1 flex-col"
              >
                <ActivityFeed
                  events={feed.events}
                  loading={feed.loading}
                  error={feed.error}
                  onReload={() => void feed.reload()}
                  onOpenTask={openTask}
                  actorFilter={actorFilter}
                  onFilterChange={setActorFilter}
                />
              </div>
            )}

            {/* Roster */}
            <div
              role="tabpanel"
              id="fleet-panel-fleet"
              aria-labelledby="fleet-tab-fleet"
              hidden={tab !== "fleet"}
              className={tab === "fleet" ? "min-h-0 flex-1 overflow-y-auto" : "hidden"}
            >
              {total > 0 && (
                <p className="border-b border-ink/[0.07] px-3 py-1.5 text-[11px] text-ink/50">
                  {workingCount} working
                  {total - workingCount > 0 ? ` · ${total - workingCount} idle` : ""}
                  {counts && counts.unregistered > 0 ? ` · ${counts.unregistered} external` : ""}
                </p>
              )}
              {/* A failed refresh keeps the last roster on screen — stale rows
                  beat a blank panel while the next ping or poll retries. */}
              {error && roster && (
                <div className="flex items-center gap-2 border-b border-ink/[0.07] px-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-[11px] text-ink/50">
                    Couldn't refresh — showing the last roster.
                  </span>
                  <button
                    onClick={() => void reload()}
                    className="shrink-0 text-[11px] font-medium text-accent transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    Retry
                  </button>
                </div>
              )}
              {error && !roster ? (
                <div className="px-3 py-4">
                  <p className="text-[12.5px] leading-relaxed text-ink/70">{error}</p>
                  <button
                    onClick={() => void reload()}
                    className="mt-2 rounded-md border border-ink/15 px-2.5 py-1 text-[12px] font-medium text-ink/70 transition-colors hover:border-ink/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    Try again
                  </button>
                </div>
              ) : !roster && loading ? (
                <p className="px-3 py-4 text-[12.5px] text-ink/50">Reading the roster…</p>
              ) : total === 0 ? (
                <div className="px-3 py-4">
                  <p className="text-[12.5px] font-medium text-ink/80">
                    {dormant.length > 0 ? "Nobody is around right now." : "No agents here yet."}
                  </p>
                  <p className="mt-1 text-[12px] leading-relaxed text-ink/55">
                    {dormant.length > 0
                      ? `${dormant.length} agent${dormant.length === 1 ? " has" : "s have"} worked this canvas before. Start a session and it rejoins the list here.`
                      : "Point a session at this canvas over MCP. It appears the moment it registers, and every task it claims shows up on this list."}
                  </p>
                  <button
                    onClick={() => {
                      close();
                      onConnect();
                    }}
                    className="mt-2.5 rounded-md bg-accent px-2.5 py-1.5 text-[12px] font-medium text-white transition-[filter] hover:brightness-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    Connect an agent
                  </button>
                </div>
              ) : (
                <ul className="py-1">
                  {roots.map((a) => (
                    <AgentRow
                      key={a.id ?? a.name}
                      agent={a}
                      depth={0}
                      childrenById={childrenById}
                      lastDone={lastDone}
                      contention={contention}
                      onOpenTask={openTask}
                    />
                  ))}
                </ul>
              )}

              {/* Everyone who has registered here but isn't around right now. */}
              {dormant.length > 0 && (
                <div className="border-t border-ink/[0.07]">
                  <button
                    onClick={() => setShowDormant((s) => !s)}
                    aria-expanded={showDormant}
                    className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11.5px] text-ink/50 transition-colors hover:bg-ink/[0.03] hover:text-ink/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
                  >
                    {showDormant ? "Hide" : "Show"} {dormant.length} dormant
                    <span className="text-ink/50">
                      {showDormant ? "" : "— registered here, not around now"}
                    </span>
                  </button>
                  {showDormant && (
                    <ul className="pb-1">
                      {dormant.map((a) => (
                        <AgentRow
                          key={a.id ?? a.name}
                          agent={a}
                          depth={0}
                          childrenById={childrenById}
                          lastDone={lastDone}
                          contention={contention}
                          onOpenTask={openTask}
                          dormant
                        />
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            {/* What the fleet is waiting on. The blocker is you. */}
            {proposedCount > 0 && (
              <button
                onClick={() => {
                  close();
                  onOpenBoard();
                }}
                className="group flex shrink-0 items-center gap-2 border-t border-ink/10 px-3 py-2.5 text-left transition-colors hover:bg-ink/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-medium text-ink/80">
                    {proposedCount} task{proposedCount === 1 ? "" : "s"} awaiting your approval
                  </span>
                  {workingCount === 0 && (
                    <span className="mt-px block text-[11px] text-ink/50">
                      Nothing is running — the fleet is waiting on you.
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[11.5px] font-medium text-accent">Review</span>
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* FleetGauge — the trigger's mark. One bar per active agent (capped at five):
   tall + violet while it holds a claim, short + neutral while idle. It carries
   the same fact as the label, in a shape you can read without reading. The
   working bars are the one pulse this surface is allowed. */
function FleetGauge({ total, working }: { total: number; working: number }) {
  const shown = Math.min(Math.max(total, 1), 5);
  return (
    <span className="flex h-3.5 shrink-0 items-end gap-[2px]" aria-hidden="true">
      {Array.from({ length: shown }, (_, i) => {
        const busy = i < working;
        return (
          <span
            key={i}
            style={busy ? { animationDelay: `${i * 300}ms` } : undefined}
            className={[
              "w-[2px] rounded-full transition-all duration-200",
              busy ? "h-3.5 bg-violet-500 tandem-breathe" : total === 0 ? "h-1.5 bg-ink/20" : "h-1.5 bg-ink/30",
            ].join(" ")}
          />
        );
      })}
    </span>
  );
}

/* One fleet member, plus any executors it spawned (nested under a hairline
   rail — the same hierarchy idiom the board uses for epic membership). */
function AgentRow({
  agent,
  depth,
  childrenById,
  lastDone,
  contention,
  onOpenTask,
  dormant = false,
}: {
  agent: FleetAgent;
  depth: number;
  childrenById: Map<string, FleetAgent[]>;
  lastDone: Map<string, Action>;
  /** Collisions per agent name — see contentionByAgent. */
  contention: Map<string, ContentionTally>;
  onOpenTask: (taskId: string) => void;
  dormant?: boolean;
}) {
  const vendor = vendorOf(agent);
  const kids = depth < MAX_DEPTH ? (agent.id ? (childrenById.get(agent.id) ?? []) : []) : [];
  const done = lastDone.get(agent.name) ?? (agent.id ? lastDone.get(agent.id) : undefined);
  const working = agent.tasks.length > 0;
  // Matched by NAME first then by id, the same two-step the roster join uses:
  // `claimed_by` and the contention trail both record the free-text identity, so
  // the two agree without a lookup table.
  const raced = contention.get(agent.name) ?? (agent.id ? contention.get(agent.id) : undefined);

  return (
    <li>
      {/* Dormant rows are tighter, never dimmer — sub-12px text at reduced
          opacity falls under the readability floor. */}
      <div className={dormant ? "px-3 py-1.5" : "px-3 py-2"}>
        {/* Identity line: state · name · role · vendor. */}
        <div className="flex items-center gap-1.5">
          <StatusDot working={working} done={!working && !!done} dormant={dormant} />
          <span
            className="truncate font-code text-[11.5px] font-medium text-ink"
            title={agent.name}
          >
            {agent.name}
          </span>
          {agent.role && agent.role !== "agent" && (
            <span className="shrink-0 text-[10.5px] text-ink/50">{agent.role}</span>
          )}
          {/* How much this member has collided with the rest of the fleet
              (TDM-100). Sits with the IDENTITY, not with the status line, because
              it is a fact about the agent across the whole board rather than about
              whatever it happens to hold right now. */}
          {raced && <ContentionCount tally={raced} name={agent.name} />}
          <span
            title={vendor.title}
            className={`ml-auto shrink-0 rounded-[3px] px-1 py-px font-code text-[10px] ${VENDOR_CLS[vendor.kind]}`}
          >
            {vendor.label}
          </span>
        </div>

        {/* Status lines: one per claim, or a single idle/just-finished line. */}
        <div className="mt-0.5 pl-[14px]">
          {working ? (
            agent.tasks.map((t) => (
              <TaskLine key={t.id} task={t} agentName={agent.name} onOpen={onOpenTask} />
            ))
          ) : done ? (
            <DoneLine action={done} agentName={agent.name} onOpen={onOpenTask} />
          ) : (
            <div className="flex items-center gap-2 py-px">
              <span className="w-[52px] shrink-0 text-[11px] text-ink/50">idle</span>
              <span className="min-w-0 flex-1" />
              <span
                className="shrink-0 font-code text-[10.5px] text-ink/50"
                title={
                  agent.lastActivityAt
                    ? `Last active ${fullDate(agent.lastActivityAt)}`
                    : "No recorded activity"
                }
              >
                {/* The right column is uniformly "how long" — spell that out for
                    a screen reader, where the visual column is no help. */}
                <span className="sr-only">last active </span>
                {ageOf(agent.lastActivityAt)}
                <span className="sr-only"> ago</span>
              </span>
            </div>
          )}
        </div>
      </div>

      {kids.length > 0 && (
        <ul className="ml-[18px] border-l border-ink/10">
          {kids.map((k) => (
            <AgentRow
              key={k.id ?? k.name}
              agent={k}
              depth={depth + 1}
              childrenById={childrenById}
              lastDone={lastDone}
              contention={contention}
              onOpenTask={onOpenTask}
              dormant={dormant}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/* ContentionCount — how often this member has been refused (TDM-100).
   Two numbers, never one, because they mean different things:

     ⌾ n  RACED   claims it lost at the door. Routine on a busy queue: it asked,
                  was told no, and went and took other work. Nothing was wasted.
     ⛨ n  FENCED  writes of its own that were refused because it no longer held
                  the claim. That is a worker outliving its lease and coming back
                  to finish work that had moved on — the near miss the fence exists
                  to catch, and the only one of the two worth a human's attention.

   Collapsing them into "3 collisions" would hide the distinction the reader acts
   on, so both are shown, fenced first, and each hides itself at zero.

   No hue, per the marker on the cards: a fenced write can happen to an agent in
   any state, and this panel's colours are spoken for (violet = working, emerald =
   just finished, terracotta = the agent token). Weight carries it instead. */
function ContentionCount({ tally, name }: { tally: ContentionTally; name: string }) {
  if (tally.total === 0) return null;
  const title = [
    tally.fenced > 0
      ? `${tally.fenced} write${tally.fenced === 1 ? "" : "s"} by ${name} refused because it no longer held the claim — its lease had lapsed and the task had moved on.`
      : "",
    tally.raced > 0
      ? `${tally.raced} time${tally.raced === 1 ? "" : "s"} ${name} asked for a task another agent already held, and yielded.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className="flex shrink-0 items-center gap-1.5" title={title}>
      {tally.fenced > 0 && (
        <span className="inline-flex items-center gap-0.5 font-code text-[10px] font-medium text-ink/70">
          <Shield size={9} className="shrink-0" aria-hidden="true" />
          {tally.fenced}
        </span>
      )}
      {tally.raced > 0 && (
        <span className="inline-flex items-center gap-0.5 font-code text-[10px] text-ink/45">
          <Users size={9} className="shrink-0" aria-hidden="true" />
          {tally.raced}
        </span>
      )}
      <span className="sr-only">{title}</span>
    </span>
  );
}

function StatusDot({
  working,
  done,
  dormant,
}: {
  working: boolean;
  done: boolean;
  dormant: boolean;
}) {
  if (working) {
    return (
      <span
        aria-hidden="true"
        className="tandem-breathe h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500"
      />
    );
  }
  if (done) {
    return <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500/70" />;
  }
  return (
    <span
      aria-hidden="true"
      className={`h-1.5 w-1.5 shrink-0 rounded-full border ${dormant ? "border-ink/20" : "border-ink/35"}`}
    />
  );
}

// A live claim: click through to the task on the Board.
function TaskLine({
  task,
  agentName,
  onOpen,
}: {
  task: FleetTask;
  agentName: string;
  onOpen: (taskId: string) => void;
}) {
  const title = task.title || "Untitled task";
  return (
    <button
      onClick={() => onOpen(task.id)}
      title={`${task.ticketId ? `${task.ticketId} — ` : ""}${title}\nOpen on the Board`}
      aria-label={`${agentName} is working ${task.ticketId ?? "a task"}, ${title}, for ${ageOf(task.claimedAt)}. Open it on the board.`}
      className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-[4px] px-1 py-px text-left transition-colors hover:bg-ink/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <span className="w-[52px] shrink-0 text-[11px] text-ink/55">working</span>
      {task.ticketId && (
        <span className="shrink-0 font-code text-[10.5px] font-medium text-violet-600 dark:text-violet-400">
          {task.ticketId}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink/70">{title}</span>
      <span
        className="shrink-0 font-code text-[10.5px] text-ink/50"
        title={task.claimedAt ? `Claimed ${fullDate(task.claimedAt)}` : undefined}
      >
        {ageOf(task.claimedAt)}
      </span>
    </button>
  );
}

// The last thing this agent finished, while it's still recent enough to matter.
function DoneLine({
  action,
  agentName,
  onOpen,
}: {
  action: Action;
  agentName: string;
  onOpen: (taskId: string) => void;
}) {
  const failed = action.state === "failed";
  const title = (action.payload as { title?: string }).title || "Untitled task";
  const hue = failed
    ? "text-rose-600 dark:text-rose-400"
    : "text-emerald-600 dark:text-emerald-400";
  return (
    <button
      onClick={() => onOpen(action.id)}
      title={`${action.ticketId ? `${action.ticketId} — ` : ""}${title}\nOpen on the Board`}
      aria-label={`${agentName} ${failed ? "failed" : "finished"} ${action.ticketId ?? "a task"}, ${title}, ${ageOf(action.updatedAt)} ago. Open it on the board.`}
      className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-[4px] px-1 py-px text-left transition-colors hover:bg-ink/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <span className="w-[52px] shrink-0 text-[11px] text-ink/55">{failed ? "failed" : "done"}</span>
      {action.ticketId && (
        <span className={`shrink-0 font-code text-[10.5px] font-medium ${hue}`}>{action.ticketId}</span>
      )}
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink/60">{title}</span>
      <span className="shrink-0 font-code text-[10.5px] text-ink/50" title={fullDate(action.updatedAt)}>
        {ageOf(action.updatedAt)}
      </span>
    </button>
  );
}
