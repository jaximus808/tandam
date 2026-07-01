import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { CanvasMeta, CanvasMode, CanvasState } from "./types";
import { connectToCanvas, disconnectFromCanvas, onStateUpdate, onAccessError, onRoleChange, sendOp, setCanvasReadOnly, type AccessStatus, type ChangeActor } from "./lib/ws";
import { ModeNavContext } from "./lib/modeNav";
import MapMode from "./modes/MapMode";
import ItineraryMode from "./modes/ItineraryMode";
import DocsMode from "./modes/DocsMode";
import RoadmapMode from "./modes/RoadmapMode";
import SheetsMode from "./modes/SheetsMode";
import ChartsMode from "./modes/ChartsMode";
import WelcomeMode from "./modes/WelcomeMode";
import Landing from "./pages/Landing";
import MCPSupport from "./pages/MCPSupport";
import MyCanvases from "./pages/MyCanvases";
import StatsPage from "./pages/StatsPage";
import { fetchMe, type User } from "./lib/auth";
import { copyCanvas, claimCanvas } from "./lib/api";
import ConnectModal, { hasDismissedConnect } from "./components/ConnectModal";
import ShareDialog from "./components/ShareDialog";
import AccessDenied from "./components/AccessDenied";
import TandemLogo from "./components/TandemLogo";
import AccountMenu from "./components/AccountMenu";
import AgentCursor from "./components/AgentCursor";
import AgentPresence from "./components/AgentPresence";
import NotificationBell from "./components/NotificationBell";
import AgentToasts from "./components/AgentToasts";
import QuickLog from "./components/QuickLog";
import ErrorBoundary from "./components/ErrorBoundary";
import { useAgentActivity } from "./lib/useAgentActivity";
import { useAgentNotifications } from "./lib/useAgentNotifications";
import { recordRecent } from "./lib/recentCanvases";
import { MOCK_ENABLED, mockCanvas } from "./lib/mockFixture";
import { modeTheme } from "./lib/modeTheme";

const MODES: { id: CanvasMode; label: string }[] = [
  { id: "map", label: "Map" },
  { id: "itinerary", label: "Itinerary" },
  { id: "docs", label: "Docs" },
  { id: "roadmap", label: "Roadmap" },
  { id: "sheets", label: "Sheets" },
  { id: "charts", label: "Charts" },
];

// The tabs a canvas has: any mode that holds content, plus empty modes a user
// turned on via "+" (persisted in enabledModes). `optimistic` is this viewer's
// locally-selected mode, folded in so a just-clicked "+" tab shows instantly,
// before the mode.enable round-trip lands. When this returns [], the canvas has
// no tabs and the template homepage is shown instead.
function canvasTabs(state: CanvasState, optimistic?: CanvasMode | null): CanvasMode[] {
  const has = {
    map: Object.keys(state.pins).length > 0,
    itinerary: Object.keys(state.events).length > 0,
    docs: Object.keys(state.notes).length > 0,
    roadmap: Object.keys(state.roadmapItems).length > 0,
    sheets: Object.keys(state.sheets).length > 0,
    charts: Object.keys(state.charts).length > 0,
  };
  const out = new Set<CanvasMode>();
  if (has.map) out.add("map");
  if (has.itinerary) out.add("itinerary");
  if (has.docs) out.add("docs");
  if (has.roadmap) out.add("roadmap");
  if (has.sheets) out.add("sheets");
  if (has.charts) out.add("charts");
  for (const m of state.enabledModes ?? []) out.add(m);
  if (optimistic && optimistic !== "welcome") out.add(optimistic);
  return MODES.map((m) => m.id).filter((id) => out.has(id));
}

function getCodeFromURL(): string | null {
  if (MOCK_ENABLED) return mockCanvas.code;
  const path = window.location.pathname;
  const match = path.match(/\/c\/([A-Z0-9]{8})/i);
  if (match) return match[1].toUpperCase();
  return new URLSearchParams(window.location.search).get("code")?.toUpperCase() ?? null;
}

// The private one-time claim token from an agent-created canvas link
// (/c/CODE?claim=clm_…). Present → the visitor should take ownership of THIS
// canvas (not a copy). Read once on load; stripped from the URL after claiming.
function getClaimTokenFromURL(): string | null {
  if (MOCK_ENABLED) return null;
  const t = new URLSearchParams(window.location.search).get("claim");
  return t && t.trim() ? t.trim() : null;
}

// Remove the ?claim token from the address bar (keep the canvas path) once it's
// been used or is no longer needed — it's single-use and shouldn't linger.
function stripClaimFromURL() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("claim")) return;
  url.searchParams.delete("claim");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

type Route = "home" | "mcp" | "me" | "stats";

function routeFromPath(): Route {
  const p = window.location.pathname.replace(/\/$/, "");
  if (p === "/mcp") return "mcp";
  if (p === "/me") return "me";
  if (p === "/stats") return "stats";
  return "home";
}

function isMCPRoute(): boolean {
  return window.location.pathname.replace(/\/$/, "") === "/mcp";
}

function setCodeInURL(code: string) {
  window.history.replaceState(null, "", `/c/${code}`);
}

function clearCodeInURL() {
  window.history.replaceState(null, "", "/");
}

function setMCPInURL() {
  window.history.pushState(null, "", "/mcp");
}

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromPath);
  const [canvasCode, setCanvasCode] = useState<string | null>(getCodeFromURL);
  const [canvas, setCanvas] = useState<CanvasMeta | null>(null);
  const [canvasState, setCanvasState] = useState<CanvasState | null>(null);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // Set when this canvas can't be opened (private, no access) or our access was
  // revoked live. Drives the access-denied screen instead of an endless spinner.
  const [accessError, setAccessError] = useState<AccessStatus | null>(null);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [addTabOpen, setAddTabOpen] = useState(false);
  // The signed-in user (or null). Drives the "Copy to my account" button —
  // shown when this canvas isn't already owned by me.
  const [me, setMe] = useState<User | null>(null);
  const [copying, setCopying] = useState(false);
  // Pending claim token from a /c/CODE?claim=… link. Held in state (not just the
  // URL) so it survives the URL being stripped and a later sign-in.
  const [claimToken, setClaimToken] = useState<string | null>(getClaimTokenFromURL);
  const [claiming, setClaiming] = useState(false);
  // Transient "Saved to your account ✓" confirmation after a successful claim.
  const [claimNotice, setClaimNotice] = useState<string | null>(null);
  // A given claim token is attempted at most once, even as `canvas` re-renders
  // from incoming WS updates.
  const claimAttemptedRef = useRef<string | null>(null);
  // Actor behind the latest state push ("agent" | "user"), read by the activity
  // hook. A ref so it's set synchronously before the re-render it triggers.
  const lastChangeByRef = useRef<ChangeActor | undefined>(undefined);
  // Latest active mode, mirrored into a ref so the "user scrolled → stop
  // following" listeners (set up before the mode is computed) can read it.
  const effectiveModeRef = useRef<CanvasMode>("welcome");
  const [autoOpenedFor, setAutoOpenedFor] = useState<string | null>(null);
  // Keep-alive: once a mode has been opened, keep its subtree mounted and
  // toggle visibility instead of re-mounting on every tab switch. This avoids
  // re-constructing Leaflet, re-parsing markdown, and losing useMemo caches.
  const [visitedModes, setVisitedModes] = useState<Set<CanvasMode>>(new Set());
  // The active tab is LOCAL to this viewer — switching tabs only changes what
  // *I* see, never the shared canvas (like switching tabs in a Google Doc). It
  // is never persisted to canvas state and never broadcast.
  //   - null → "follow the canvas": show whatever mode the canvas is in. Lets a
  //     fresh viewer land where the agent/template put things, and auto-advances
  //     off the welcome screen once content appears.
  //   - set  → the user took the wheel; their view is fully local and unaffected
  //     by what anyone else (or the agent) does.
  const [viewMode, setViewMode] = useState<CanvasMode | null>(null);
  // While following, the tab to show — driven by where the agent last acted
  // (an edit OR an explicit mode change), so a follower auto-jumps to the tab
  // the agent is working in even when no mode.set was sent. Ignored once the
  // user takes the wheel (viewMode set). null → fall back to canvasState.mode.
  const [followMode, setFollowMode] = useState<CanvasMode | null>(null);
  const currentMode = (viewMode ?? (canvasState?.mode as CanvasMode | undefined)) as
    | CanvasMode
    | undefined;

  useEffect(() => {
    if (!currentMode) return;
    setVisitedModes((prev) => (prev.has(currentMode) ? prev : new Set(prev).add(currentMode)));
  }, [currentMode]);

  useEffect(() => {
    if (!canvasCode) return;
    connectToCanvas(canvasCode);
  }, [canvasCode]);

  useEffect(() => {
    let cancelled = false;
    fetchMe().then((u) => {
      if (!cancelled) setMe(u);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onPop() {
      setRoute(routeFromPath());
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    return onStateUpdate((c, _all, s, _edits, lastChangeBy) => {
      // Stash who triggered this update (agent vs user) before the state change
      // re-renders — the activity hook reads it to drive the agent cursor.
      // Undefined on the initial connect snapshot.
      lastChangeByRef.current = lastChangeBy;
      setCanvas((prev) => {
        // yourRole rides only on the per-connection initial snapshot; later
        // broadcasts omit it. Keep the established role sticky across updates so
        // a refresh broadcast can't accidentally un-read-only the board.
        if (c.yourRole == null && prev?.yourRole != null) {
          return { ...c, yourRole: prev.yourRole };
        }
        return c;
      });
      setCanvasState(s);
    });
  }, []);

  // Mirror the resolved role into the WS write-gate: a 'read' viewer's outbound
  // ops are muted at the source (the server rejects them too — this just keeps
  // the UI from looking like edits saved).
  useEffect(() => {
    setCanvasReadOnly(canvas?.yourRole === "read");
  }, [canvas?.yourRole]);

  // A failed WS upgrade (probed to a real reason) or a live revoke surfaces here
  // → render the access-denied screen. Arriving state clears it (we got in).
  useEffect(() => onAccessError(setAccessError), []);

  // The owner changed our access while we're connected (e.g. view→edit) — flip
  // the board's read-only state live, no reconnect.
  useEffect(
    () =>
      onRoleChange((role) =>
        setCanvas((prev) => (prev ? { ...prev, yourRole: role } : prev)),
      ),
    [],
  );

  // If we were denied and the visitor then signs in, retry: the new session
  // cookie may grant access (the canvas could be shared with that account). A
  // still-denied retry just re-emits the error — no loop, since `me` is stable.
  useEffect(() => {
    if (me && accessError?.kind === "forbidden" && canvasCode) {
      setAccessError(null);
      connectToCanvas(canvasCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, canvasCode]);

  // Auto-open the connect modal the first time we see a given canvas in this browser.
  useEffect(() => {
    if (!canvas) return;
    if (autoOpenedFor === canvas.code) return;
    if (!hasDismissedConnect(canvas.code)) {
      setConnectOpen(true);
    }
    setAutoOpenedFor(canvas.code);
  }, [canvas, autoOpenedFor]);

  // Remember recently opened canvases so Landing can offer quick re-entry.
  useEffect(() => {
    if (canvas) recordRecent(canvas.code, canvas.name);
  }, [canvas]);

  // resetPerCanvasState clears every piece of UI state scoped to the canvas
  // we're leaving. Without this, a stale selectedPinId / visitedModes /
  // pendingMode from canvas A leaks into canvas B and can render references
  // to entities that don't exist there.
  function resetPerCanvasState() {
    setCanvas(null);
    setCanvasState(null);
    setSelectedPinId(null);
    setSelectedEventId(null);
    setVisitedModes(new Set());
    setViewMode(null);
    setFollowMode(null);
    setConnectOpen(false);
    setShareOpen(false);
    setModeMenuOpen(false);
    setAddTabOpen(false);
    setAccessError(null);
  }

  function handleJoin(code: string) {
    if (!code) {
      disconnectFromCanvas();
      setCanvasCode(null);
      setAutoOpenedFor(null);
      resetPerCanvasState();
      clearCodeInURL();
      return;
    }
    // Switching from one canvas straight to another: tear down the old socket
    // explicitly so its lingering reconnect/onerror can't interfere with the
    // new connection (canvasCode change alone triggers connectToCanvas, but
    // the old socket's queued events would otherwise still fire first).
    if (canvasCode && canvasCode !== code) {
      disconnectFromCanvas();
      setAutoOpenedFor(null);
    }
    setCanvasCode(code);
    setCodeInURL(code);
    resetPerCanvasState();
    // A claim token is scoped to the canvas it arrived with — drop it when the
    // user navigates elsewhere so it can't be misapplied to another canvas.
    setClaimToken(null);
  }

  function showMyCanvases() {
    window.history.pushState(null, "", "/me");
    setRoute("me");
  }

  // Deep-copy the current canvas into my account, then open the owned copy.
  async function handleCopyToAccount() {
    if (!canvas || copying) return;
    setCopying(true);
    try {
      const copy = await copyCanvas(canvas.code);
      handleJoin(copy.code);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Copy failed");
    } finally {
      setCopying(false);
    }
  }

  // Auto-claim: landing on /c/CODE?claim=TOKEN while signed in takes ownership
  // of THIS canvas in place (the agent keeps editing the very same canvas), and
  // the API voids the token so the link can't be reused. If the visitor isn't
  // signed in yet, we wait — signing in updates `me`, which re-runs this.
  useEffect(() => {
    if (!claimToken || !me || !canvas || !canvasCode) return;
    // Already mine (e.g. just claimed, or I created it) — nothing to do but tidy.
    if (canvas.ownerUserId === me.id) {
      stripClaimFromURL();
      setClaimToken(null);
      return;
    }
    if (claimAttemptedRef.current === claimToken) return;
    claimAttemptedRef.current = claimToken;
    setClaiming(true);
    claimCanvas(canvasCode, claimToken)
      .then((updated) => {
        // Reflect new ownership immediately so the "Copy to my account" button
        // disappears; WS updates will keep meta fresh after this.
        setCanvas((prev) =>
          prev && prev.code === updated.code ? { ...prev, ...updated } : prev,
        );
        stripClaimFromURL();
        setClaimToken(null);
        setClaimNotice("Saved to your account");
        window.setTimeout(() => setClaimNotice(null), 4000);
      })
      .catch((err) => {
        // Don't trap the user: a bad/used token just means no auto-claim — the
        // "Copy to my account" fallback still works. Log for diagnosis.
        console.warn("Claim failed:", err instanceof Error ? err.message : err);
        stripClaimFromURL();
        setClaimToken(null);
      })
      .finally(() => setClaiming(false));
  }, [claimToken, me, canvas, canvasCode]);

  // Live agent presence: detect agent-authored edits and surface a cursor +
  // who's in the room. Safe to call with nulls before a canvas loads.
  const {
    edit: agentEdit,
    agents: agentList,
    reading: agentReading,
    lastAction: agentAction,
  } = useAgentActivity(canvas?.id, canvasState, lastChangeByRef);

  // Notification center: turns agent actions into transient toasts + a bell log.
  const notify = useAgentNotifications(agentAction);

  // Auto-follow: while following, jump the view to wherever the agent acts.
  // (1) An agent edit pulls the follower to that entity's tab — this is the bit
  // mode.set alone couldn't do (adding a roadmap item never set the mode).
  useEffect(() => {
    if (viewMode === null && agentEdit) setFollowMode(agentEdit.mode);
  }, [agentEdit, viewMode]);
  // (2) An explicit agent mode change (template / map / mode.set) is also
  // followed; this effect runs last so an explicit switch wins ties, and on
  // resume-follow (viewMode→null) it re-baselines to the canvas mode.
  useEffect(() => {
    if (viewMode === null && canvasState) setFollowMode(canvasState.mode as CanvasMode);
  }, [canvasState?.mode, viewMode]);

  // While following, scroll the agent's just-edited element into view so its
  // cursor is always on screen. The element may not be mounted yet (the tab is
  // mid-switch), so retry across a few frames until it's present + visible.
  useEffect(() => {
    if (viewMode !== null || !agentEdit) return;
    const id = agentEdit.entityId;
    let raf = 0;
    let tries = 0;
    const tryScroll = () => {
      const el = document.querySelector<HTMLElement>(`[data-agent-target="${id}"]`);
      if (el && el.getClientRects().length > 0) {
        // center on BOTH axes so nested scrollboxes (e.g. a roadmap column's own
        // vertical scroll) AND the outer strip (horizontal column scroll) both
        // move to put the edited line squarely in frame.
        el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        return;
      }
      if (tries++ < 30) raf = requestAnimationFrame(tryScroll);
    };
    raf = requestAnimationFrame(tryScroll);
    return () => cancelAnimationFrame(raf);
  }, [agentEdit, viewMode]);

  // A user scroll/pan while following = "I'm taking the wheel": pin to the
  // current tab and stop following until they click Follow again. We listen for
  // wheel/touch (unambiguous scroll intent) and ONLY the keyboard keys that
  // actually scroll the page — not every keypress. Typing in a field, hitting a
  // shortcut, or cmd-tabbing must never silently drop follow. We also skip
  // 'scroll' itself, which the auto-scroll above fires programmatically.
  useEffect(() => {
    if (viewMode !== null) return;
    const stop = () => setViewMode(effectiveModeRef.current);
    const passive: AddEventListenerOptions = { passive: true };
    // The keys that move the viewport — only these hand off the wheel.
    const SCROLL_KEYS = new Set([
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "PageUp", "PageDown", "Home", "End", " ", "Spacebar",
    ]);
    const onKey = (e: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(e.key)) return;
      // A scroll key aimed at a text field moves the caret, not the page — ignore.
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      stop();
    };
    window.addEventListener("wheel", stop, passive);
    window.addEventListener("touchmove", stop, passive);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", stop, passive);
      window.removeEventListener("touchmove", stop, passive);
      window.removeEventListener("keydown", onKey);
    };
  }, [viewMode]);

  if (route === "mcp") {
    return (
      <MCPSupport
        onBack={() => {
          window.history.pushState(null, "", "/");
          setRoute("home");
        }}
      />
    );
  }

  if (route === "stats") {
    return (
      <StatsPage
        onHome={() => {
          window.history.pushState(null, "", "/");
          setRoute("home");
        }}
      />
    );
  }

  if (route === "me") {
    return (
      <MyCanvases
        onOpenCanvas={(code) => {
          setRoute("home");
          handleJoin(code);
        }}
        onHome={() => {
          setRoute("home");
          handleJoin("");
        }}
        onOpenMCP={() => {
          setMCPInURL();
          setRoute("mcp");
        }}
      />
    );
  }

  if (!canvasCode) {
    return (
      <Landing
        onJoin={handleJoin}
        onOpenMCP={() => {
          setMCPInURL();
          setRoute("mcp");
        }}
        onShowCanvases={showMyCanvases}
      />
    );
  }

  // Can't open this canvas (private / not a member / not found), or our access
  // was revoked live — show a clear screen instead of spinning forever.
  if (accessError) {
    return (
      <AccessDenied
        status={accessError}
        me={me}
        onHome={() => handleJoin("")}
        onShowCanvases={showMyCanvases}
        onUserChange={setMe}
      />
    );
  }

  if (!canvasState || !canvas) {
    return (
      <div className="relative flex h-screen flex-col items-center justify-center overflow-hidden bg-paper font-brand text-ink">
        <div
          aria-hidden="true"
          className="surface-grid-faint absolute inset-0"
          style={{
            maskImage: "radial-gradient(60% 60% at 50% 50%, black 30%, transparent 100%)",
            WebkitMaskImage: "radial-gradient(60% 60% at 50% 50%, black 30%, transparent 100%)",
          }}
        />
        <TandemLogo size={56} />
        <p className="relative mt-6 text-sm font-medium text-ink/70">Joining canvas</p>
        <p className="relative mt-2 rounded-[4px] border border-ink/15 bg-white px-2.5 py-1 font-code text-xs tracking-[0.3em] text-ink/50">
          {canvasCode}
        </p>
      </div>
    );
  }

  // Local navigation only — switching tabs never touches the shared canvas or
  // other viewers. See viewMode above.
  const setMode = (mode: CanvasMode) => setViewMode(mode);

  // The canvas's tabs. Empty → no tabs yet → show the template "homepage".
  const visibleModes = canvasTabs(canvasState, viewMode);
  const hasTabs = visibleModes.length > 0;
  // "Following" = no local override, so the view tracks the agent. While
  // following, the target tab is followMode (where the agent last acted),
  // falling back to the canvas mode.
  const following = viewMode === null;
  // Following is armed even before any agent shows up — distinguish "an agent is
  // here" from "on, waiting for one" so the button reads as live, not dead.
  const agentPresent = agentList.length > 0;
  const followTarget = (followMode ?? (canvasState.mode as CanvasMode)) as CanvasMode;
  // The active tab: when the user has taken the wheel, their pick; while
  // following, the agent's tab; else the canvas mode; else the first tab. With
  // no tabs at all we sit on "welcome" (the template homepage).
  const effectiveMode: CanvasMode = !hasTabs
    ? "welcome"
    : !following && viewMode && visibleModes.includes(viewMode)
    ? viewMode
    : following && visibleModes.includes(followTarget)
    ? followTarget
    : visibleModes.includes(canvasState.mode as CanvasMode)
    ? (canvasState.mode as CanvasMode)
    : visibleModes[0];
  effectiveModeRef.current = effectiveMode;
  // The homepage shows iff the canvas has zero tabs.
  const inWelcome = !hasTabs;
  // Toggling off pins the view to whatever's showing right now.
  const toggleFollow = () => setViewMode(following ? effectiveMode : null);
  const theme = modeTheme(effectiveMode);
  // Modes not yet shown as a tab — the "+" dropdown offers exactly these.
  const addableModes = MODES.filter((m) => !visibleModes.includes(m.id));

  // Add an empty tab: persist it (so it survives + the agent sees it in
  // state.read) and locally switch this viewer to it.
  function addTab(mode: CanvasMode) {
    sendOp({ op: "mode.enable", mode });
    setViewMode(mode);
    setAddTabOpen(false);
    setModeMenuOpen(false);
  }

  return (
    <ModeNavContext.Provider value={setMode}>
    <div className="flex flex-col h-screen bg-paper font-brand text-gray-900 overflow-hidden">
      {/* z-[80] so the header (and its bell dropdown) sits above the agent
          cursor overlay (z-[70]); modals are z-[2000] and still cover it. */}
      <header className="relative z-[80] flex items-center gap-1.5 px-3 py-2.5 bg-paper/85 backdrop-blur border-b border-gray-900/5 shrink-0 sm:gap-2 sm:px-4">
        {/* Accent rule across the top of the chrome — picks up the active mode's
            colour and eases between them as you switch views. */}
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-0.5 transition-colors duration-500"
          style={{ backgroundColor: theme.solid }}
        />

        <button
          onClick={() => handleJoin("")}
          className="group flex items-center gap-1.5 text-sm shrink-0"
          title="Back to home"
        >
          <TandemLogo size={22} animate={false} />
          <span className="hidden font-semibold tracking-tight text-gray-900 transition-colors group-hover:text-sky-600 sm:inline">
            Tandem
          </span>
        </button>
        <span className="hidden text-gray-200 shrink-0 sm:inline">/</span>
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-display text-[15px] font-medium leading-tight text-gray-900 truncate">
            {canvas.name}
          </span>
          <span className="hidden rounded-[3px] border border-ink/10 bg-white px-1.5 py-px font-code text-[10px] tracking-[0.14em] text-ink/40 shrink-0 sm:inline">
            {canvas.code}
          </span>
          {canvas.yourRole === "read" && (
            <span
              className="inline-flex items-center gap-1 rounded-[3px] border border-ink/15 bg-ink/[0.04] px-1.5 py-px font-code text-[10px] uppercase tracking-[0.12em] text-ink/50 shrink-0"
              title="You have view-only access to this canvas"
            >
              <span className="h-1 w-1 rounded-full bg-ink/35" />
              View only
            </span>
          )}
        </div>

        {/* Agent-activity bell — rings + badges when an agent changes anything,
            opens the recent-activity log, and toggles the popup alerts. */}
        <NotificationBell
          log={notify.log}
          unread={notify.unread}
          muted={notify.muted}
          toggleMute={notify.toggleMute}
          markRead={notify.markRead}
          clearLog={notify.clearLog}
        />

        {/* Tab bar — always present once a canvas is loaded. On the template
            homepage (zero tabs) only the "+" shows, so you can create a tab
            right from the homepage. */}
        <>
            <div className="hidden w-px h-4 bg-gray-200 mx-1.5 shrink-0 sm:block" />

            {/* Desktop: all modes laid out inline as accent-tinted pills. */}
            <div className="hidden sm:flex items-center gap-0.5">
              {MODES.filter((m) => visibleModes.includes(m.id)).map((m) => {
                const active = effectiveMode === m.id;
                const t = modeTheme(m.id);
                return (
                  <button
                    key={m.id}
                    onClick={() => setMode(m.id)}
                    className={[
                      "rounded-lg px-3 py-1 text-sm font-medium transition-colors",
                      active ? "" : "text-gray-500 hover:bg-gray-900/5 hover:text-gray-800",
                    ].join(" ")}
                    style={active ? { backgroundColor: t.soft, color: t.solid } : undefined}
                  >
                    {m.label}
                  </button>
                );
              })}
              {addableModes.length > 0 && (
                <div className="relative">
                  <button
                    onClick={() => setAddTabOpen((o) => !o)}
                    className="ml-0.5 rounded-lg px-2.5 py-1 text-sm font-medium text-gray-400 hover:bg-gray-900/5 hover:text-gray-700 transition-colors"
                    title="Add a tab"
                    aria-haspopup="menu"
                    aria-expanded={addTabOpen}
                  >
                    +
                  </button>
                  {addTabOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setAddTabOpen(false)} />
                      <div
                        role="menu"
                        className="absolute left-0 mt-1.5 z-20 min-w-[11rem] rounded-xl bg-white border border-gray-900/10 shadow-lg shadow-gray-900/5 py-1"
                      >
                        <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                          Add a tab
                        </div>
                        {addableModes.map((m) => {
                          const t = modeTheme(m.id);
                          return (
                            <button
                              key={m.id}
                              role="menuitem"
                              onClick={() => addTab(m.id)}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-gray-700 hover:bg-gray-100"
                            >
                              <span
                                className="h-2 w-2 rounded-full shrink-0"
                                style={{ backgroundColor: t.solid }}
                              />
                              {m.label}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Mobile: a dropdown so every mode is reachable regardless of count. */}
            <div className="relative shrink-0 sm:hidden">
              <button
                onClick={() => setModeMenuOpen((o) => !o)}
                className="flex items-center gap-1 rounded-lg px-3 py-1 text-sm font-semibold"
                style={{ backgroundColor: theme.soft, color: theme.solid }}
                aria-haspopup="menu"
                aria-expanded={modeMenuOpen}
              >
                {hasTabs ? MODES.find((m) => m.id === effectiveMode)?.label ?? "Mode" : "+ Tab"}
                <ChevronDown
                  className={`w-3.5 h-3.5 transition-transform ${modeMenuOpen ? "rotate-180" : ""}`}
                  aria-hidden="true"
                />
              </button>
              {modeMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setModeMenuOpen(false)} />
                  <div
                    role="menu"
                    className="absolute left-0 mt-1.5 z-20 min-w-[10rem] rounded-xl bg-white border border-gray-900/10 shadow-lg shadow-gray-900/5 py-1"
                  >
                    {MODES.filter((m) => visibleModes.includes(m.id)).map((m) => {
                      const active = effectiveMode === m.id;
                      const t = modeTheme(m.id);
                      return (
                        <button
                          key={m.id}
                          role="menuitem"
                          onClick={() => {
                            setMode(m.id);
                            setModeMenuOpen(false);
                          }}
                          className="w-full text-left px-3 py-2 text-sm font-medium"
                          style={active ? { backgroundColor: t.soft, color: t.solid } : undefined}
                        >
                          <span className={active ? "" : "text-gray-700"}>{m.label}</span>
                        </button>
                      );
                    })}
                    {addableModes.length > 0 && (
                      <>
                        {visibleModes.length > 0 && (
                          <div className="my-1 border-t border-gray-100" />
                        )}
                        <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                          Add a tab
                        </div>
                        {addableModes.map((m) => {
                          const t = modeTheme(m.id);
                          return (
                            <button
                              key={m.id}
                              role="menuitem"
                              onClick={() => addTab(m.id)}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-gray-700 hover:bg-gray-100"
                            >
                              <span
                                className="h-2 w-2 rounded-full shrink-0"
                                style={{ backgroundColor: t.solid }}
                              />
                              {m.label}
                            </button>
                          );
                        })}
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
        </>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <AgentPresence agents={agentList} edit={agentEdit} reading={agentReading} onJump={setViewMode} />
          <button
            onClick={toggleFollow}
            className={[
              "inline-flex items-center gap-1.5 rounded-lg h-8 px-3 text-sm font-medium transition-colors",
              following ? "" : "text-gray-500 hover:bg-gray-900/5 hover:text-gray-800",
            ].join(" ")}
            style={following ? { backgroundColor: theme.soft, color: theme.solid } : undefined}
            title={
              following
                ? agentPresent
                  ? "Following the agent — your view jumps to whatever it's working on. Click to pin your own view."
                  : "Armed and waiting — the moment an agent connects and edits, your view jumps to it. Click to pin your own view."
                : "Pinned to your own view. Click to follow the agent and track where it's working."
            }
            aria-pressed={following}
          >
            <span className="relative flex h-1.5 w-1.5">
              {following && (
                <span
                  className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70"
                  style={{ backgroundColor: theme.solid }}
                />
              )}
              <span
                className="relative inline-flex h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: following ? theme.solid : "#9ca3af" }}
              />
            </span>
            <span className="hidden sm:inline">
              {following ? (agentPresent ? "Following" : "Following · waiting") : "Follow agent"}
            </span>
          </button>
          {claiming ? (
            <span className="hidden rounded-md border border-ink/20 px-3 py-1.5 text-sm font-medium text-ink/60 sm:inline-block">
              Saving to your account…
            </span>
          ) : (
            me &&
            canvas.ownerUserId !== me.id && (
              <button
                onClick={handleCopyToAccount}
                disabled={copying}
                className="hidden rounded-md border border-ink/20 px-3 py-1.5 text-sm font-medium text-ink/75 transition-colors hover:border-ink/50 hover:bg-white disabled:opacity-60 sm:inline-block"
                title="Save a copy of this canvas to your account so it shows up in My canvases on every device"
              >
                {copying ? "Copying…" : "Copy to my account"}
              </button>
            )
          )}
          {me && canvas.ownerUserId === me.id && (
            <button
              onClick={() => setShareOpen(true)}
              className="rounded-md border border-ink/20 px-3 py-1.5 text-sm font-medium text-ink/75 transition-colors hover:border-ink/50 hover:bg-white"
              title="Control who can open and edit this canvas"
            >
              Share
            </button>
          )}
          <button
            onClick={() => setConnectOpen(true)}
            className="btn-press rounded-md px-3.5 py-1.5 text-sm font-medium bg-ink text-paper shadow-[2px_2px_0_#C75B39]"
          >
            Connect
          </button>
          <AccountMenu onShowCanvases={showMyCanvases} onUserChange={setMe} onOpenCanvas={handleJoin} />
        </div>
      </header>

      {claimNotice && (
        <div className="pointer-events-none fixed inset-x-0 top-16 z-50 flex justify-center">
          <div className="pointer-events-auto rounded-full bg-ink px-4 py-2 text-sm font-medium text-paper shadow-lg">
            {claimNotice} ✓
          </div>
        </div>
      )}

      {canvas.yourRole === "read" && (
        <div className="flex items-center justify-center gap-2 border-b border-ink/10 bg-paper px-4 py-1.5 text-center font-code text-[11.5px] text-ink/55">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-ink/30" />
          View only — you can follow along but not edit this canvas.
        </div>
      )}

      {/* Live agent op-feed popups. Muting is controlled from the header bell. */}
      <AgentToasts toasts={notify.toasts} onDismiss={notify.dismissToast} />

      <div className="relative flex flex-1 min-h-0">
        <ErrorBoundary resetKey={`${canvas.id}:${effectiveMode}`}>
        {(["welcome", "map", "itinerary", "docs", "roadmap", "sheets", "charts"] as CanvasMode[]).map((m) => {
          const active = effectiveMode === m;
          // Lazy-mount: only render a mode after the user has visited it at
          // least once. After that, keep it mounted and hide with CSS.
          if (!active && !visitedModes.has(m)) return null;
          // `isolate` gives each mode its own stacking context so a mode's
          // internal z-indexes (notably Leaflet's panes/controls, which go up to
          // ~1000) can't escape and paint over the QuickLog dock beside it.
          const wrapperClass = active ? "relative isolate flex flex-1 min-h-0 min-w-0" : "hidden";
          return (
            <div key={m} className={wrapperClass}>
              {m === "welcome" && (
                <WelcomeMode
                  canvasName={canvas.name}
                  onOpenConnect={() => setConnectOpen(true)}
                  onApply={(mode) => setViewMode(mode)}
                />
              )}
              {m === "map" && (
                <MapMode
                  canvasId={canvas.id}
                  mapId={canvas.mapId}
                  state={canvasState}
                  active={active}
                  selectedPinId={selectedPinId}
                  onSelectPin={setSelectedPinId}
                  selectedEventId={selectedEventId}
                  onSelectEvent={setSelectedEventId}
                />
              )}
              {m === "itinerary" && (
                <ItineraryMode
                  state={canvasState}
                  canvasCode={canvas.code}
                  canvasName={canvas.name}
                  selectedEventId={selectedEventId}
                  onSelectEvent={setSelectedEventId}
                />
              )}
              {m === "docs" && <DocsMode canvasId={canvas.id} state={canvasState} />}
              {m === "roadmap" && <RoadmapMode state={canvasState} />}
              {m === "sheets" && <SheetsMode state={canvasState} canvasCode={canvas.code} />}
              {m === "charts" && <ChartsMode state={canvasState} />}
            </div>
          );
        })}
        </ErrorBoundary>

        {/* Direct-input layer: quick-log rail + mobile FAB, overlaid on whatever
            mode is showing. Renders the canvas's agent-defined forms. */}
        <QuickLog code={canvas.code} forms={canvasState.forms} />
      </div>

      {connectOpen && (
        <ConnectModal
          code={canvas.code}
          version={canvasState.version}
          agents={agentList}
          onClose={() => setConnectOpen(false)}
          onSwitchCanvas={() => { setConnectOpen(false); handleJoin(""); }}
        />
      )}

      {shareOpen && (
        <ShareDialog code={canvas.code} canvas={canvas} onClose={() => setShareOpen(false)} />
      )}

      <AgentCursor edit={agentEdit} name={agentList[0]?.name ?? "Claude"} />
    </div>
    </ModeNavContext.Provider>
  );
}
