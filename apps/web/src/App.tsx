import { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasMeta, CanvasMode, CanvasState, Document, DocumentType } from "./types";
import { connectToCanvas, disconnectFromCanvas, onStateUpdate, onAccessError, onRoleChange, sendOp, setCanvasReadOnly, type AccessStatus, type ChangeActor } from "./lib/ws";
import { ModeNavContext } from "./lib/modeNav";
import { type SidebarView } from "./lib/sidebar";
import { Menu } from "lucide-react";
import DocumentTabs from "./components/DocumentTabs";
import ActivityBar from "./components/ActivityBar";
import SidePanel, { SidePanelReopenHandle, SIDE_PANEL_MIN, SIDE_PANEL_MAX, SIDE_PANEL_DEFAULT } from "./components/SidePanel";
import MobileNavDrawer from "./components/MobileNavDrawer";
import DocumentExplorer from "./components/DocumentExplorer";
import SettingsPanel from "./components/SettingsPanel";
import { DOC_TYPE_TO_MODE } from "./lib/docTypes";
import MapMode from "./modes/MapMode";
import ItineraryMode from "./modes/ItineraryMode";
import DocsMode from "./modes/DocsMode";
import RoadmapMode from "./modes/RoadmapMode";
import SheetsMode from "./modes/SheetsMode";
import ChartsMode from "./modes/ChartsMode";
import WelcomeMode from "./modes/WelcomeMode";
import Landing from "./pages/Landing";
import MCPSupport from "./pages/MCPSupport";
import About from "./pages/About";
import MyCanvases from "./pages/MyCanvases";
import StatsPage from "./pages/StatsPage";
import UserSettings from "./pages/UserSettings";
import OAuthConsent from "./pages/OAuthConsent";
import { fetchMe, getCachedUser, type User } from "./lib/auth";
import { copyCanvas, claimCanvas, setCanvasName } from "./lib/api";
import ConnectModal, { hasDismissedConnect } from "./components/ConnectModal";
import ShareDialog from "./components/ShareDialog";
import CanvasNameEditor from "./components/CanvasNameEditor";
import AccessDenied from "./components/AccessDenied";
import TandemLogo from "./components/TandemLogo";
import AccountMenu from "./components/AccountMenu";
import AgentCursor from "./components/AgentCursor";
import AgentPresence from "./components/AgentPresence";
import NotificationBell from "./components/NotificationBell";
import AgentToasts from "./components/AgentToasts";
import QuickLog from "./components/QuickLog";
import TasksPanel from "./components/TasksPanel";
import ErrorBoundary from "./components/ErrorBoundary";
import { useAgentActivity } from "./lib/useAgentActivity";
import { useAgentNotifications } from "./lib/useAgentNotifications";
import { recordRecent } from "./lib/recentCanvases";
import { loadTabState, saveTabState } from "./lib/tabState";
import { loadSidebarState, saveSidebarState } from "./lib/sidebarState";
import { MOCK_ENABLED, mockCanvas } from "./lib/mockFixture";
import { modeTheme } from "./lib/modeTheme";
import posthog from "./lib/posthog";

// A canvas is a bag of named documents (migration 0024). Each document renders
// through its type's existing mode component; to show ONE document we hand that
// component a state scoped to just that document's slice of the matching kind.
// Cross-references (a pin's attached notes, an event's pins) are left intact —
// the mode components already skip references they can't resolve.
function scopeStateToDocument(state: CanvasState, doc: Document | undefined): CanvasState {
  if (!doc) return state;
  const only = <T extends { documentId?: string }>(rec: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(rec)) if (v.documentId === doc.id) out[k] = v;
    return out;
  };
  switch (doc.type) {
    case "map":
      return { ...state, pins: only(state.pins) };
    case "itinerary":
      return { ...state, events: only(state.events) };
    case "notes":
      return { ...state, notes: only(state.notes) };
    case "roadmap":
      return { ...state, roadmapItems: only(state.roadmapItems) };
    case "sheet":
      return { ...state, sheets: only(state.sheets) };
    case "chart":
      return { ...state, charts: only(state.charts) };
    default:
      return state;
  }
}

// Which document an entity belongs to — used to follow the agent to the right
// tab when it edits. Sheet rows resolve via their parent sheet.
function documentIdForEntity(state: CanvasState, entityId: string): string | null {
  const direct =
    state.pins[entityId] ??
    state.events[entityId] ??
    state.notes[entityId] ??
    state.roadmapItems[entityId] ??
    state.sheets[entityId] ??
    state.charts[entityId];
  if (direct?.documentId) return direct.documentId;
  const row = state.sheetRows[entityId];
  if (row) return state.sheets[row.sheetId]?.documentId ?? null;
  return null;
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

// Panel width is a genuine size preference — global (one value for the whole app)
// and not expiry-gated. Which view is selected and whether the panel is open are
// per-canvas position, stored via lib/sidebarState instead.
const SIDEBAR_WIDTH_KEY = "tandem.sidebar.width";

type Route = "home" | "mcp" | "dashboard" | "stats" | "settings" | "about" | "authorize";

function routeFromPath(): Route {
  const p = window.location.pathname.replace(/\/$/, "");
  if (p === "/mcp") return "mcp";
  if (p === "/dashboard") return "dashboard";
  if (p === "/stats") return "stats";
  if (p === "/me") return "settings";
  if (p === "/about") return "about";
  // OAuth consent screen (hosted MCP connector). This is the authorization_endpoint
  // advertised to clients; it renders a self-contained consent page.
  if (p === "/oauth/authorize") return "authorize";
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
  // Left activity-bar dock (VS Code style). The SELECTED view (Documents / Agent
  // tasks / Settings) and whether the panel is OPEN are tracked separately: the
  // selection is what the rail highlights, and it survives a close — so collapsing
  // keeps the icon lit and clicking it again re-opens the same view. The activity
  // bar (lib/sidebar) is the holder future "extension" panels attach to.
  //
  // Both are PER-CANVAS position (lib/sidebarState), keyed by code — each canvas is
  // its own playground, so collapsing the panel on one board never touches another.
  // Restored on mount for the URL's canvas; a GENUINE first visit (nothing saved,
  // or lapsed) defaults to the Documents explorer open so the tabs are immediately
  // discoverable. Switching canvases re-hydrates via hydrateSidebarFor; edits are
  // written back by the save effect below.
  const initialSidebar = useMemo(() => loadSidebarState(getCodeFromURL()), []);
  const [sidebarView, setSidebarView] = useState<SidebarView | null>(
    () => initialSidebar?.view ?? "documents",
  );
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => initialSidebar?.open ?? true);
  // Mobile-only: the off-canvas nav drawer (the desktop left dock has no phone
  // home — ActivityBar + SidePanel are `hidden sm:flex`). It reuses `sidebarView`
  // for which panel shows, so the view choice is continuous across breakpoints.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // The drawer always shows a concrete view (the desktop panel can be collapsed
  // to null; the drawer can't). Fall back to Documents.
  const mobileNavView: SidebarView = sidebarView ?? "documents";
  // Rail click: same icon toggles the panel open/closed (selection stays lit);
  // a different icon selects that view and opens it.
  function selectSidebarView(view: SidebarView) {
    if (view === sidebarView) {
      setSidebarOpen((o) => !o);
      return;
    }
    setSidebarView(view);
    setSidebarOpen(true);
  }
  // Collapse the panel but KEEP the selection so the rail stays highlighted and
  // the same view re-opens on the next click (X button + drag-to-close).
  function closeSidebar() {
    setSidebarOpen(false);
  }
  // Reopen the collapsed panel (drag/click the edge strip), optionally at a width.
  function openSidebar(width?: number) {
    if (width !== undefined) setPanelWidthPersist(width);
    setSidebarOpen(true);
  }
  // The side panel's width, drag-resized and remembered across reloads.
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
      return Number.isFinite(n) && n >= SIDE_PANEL_MIN && n <= SIDE_PANEL_MAX ? n : SIDE_PANEL_DEFAULT;
    } catch {
      return SIDE_PANEL_DEFAULT;
    }
  });
  function setPanelWidthPersist(w: number) {
    setPanelWidth(w);
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
    } catch {
      /* ignore */
    }
  }
  // Agent-proposed tasks awaiting your approval — badges the header button.
  const proposedTaskCount = Object.values(canvasState?.actions ?? {}).filter(
    (a) => a.type === "task" && a.state === "proposed",
  ).length;
  // Set when this canvas can't be opened (private, no access) or our access was
  // revoked live. Drives the access-denied screen instead of an endless spinner.
  const [accessError, setAccessError] = useState<AccessStatus | null>(null);
  // The signed-in user (or null). Drives the "Copy to my account" button —
  // shown when this canvas isn't already owned by me.
  const [me, setMe] = useState<User | null>(getCachedUser);
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
  // Latest focused mode + document, mirrored into refs so the "user scrolled →
  // stop following" listeners (set up before these are computed) can read them.
  const effectiveModeRef = useRef<CanvasMode>("welcome");
  const effectiveDocIdRef = useRef<string | null>(null);
  const [autoOpenedFor, setAutoOpenedFor] = useState<string | null>(null);
  // Keep-alive: once a mode has been opened, keep its subtree mounted and
  // toggle visibility instead of re-mounting on every tab switch. This avoids
  // re-constructing Leaflet, re-parsing markdown, and losing useMemo caches.
  const [visitedModes, setVisitedModes] = useState<Set<CanvasMode>>(new Set());

  // ── Document tabs (migration 0024) ──────────────────────────────────────────
  // A canvas is a bag of named documents; the tab strip shows the OPEN ones.
  // Which docs are open, their order, and which one is focused are LOCAL to this
  // viewer (like tabs in a Google Doc) — never broadcast. closedDocIds remembers
  // tabs this viewer explicitly closed so the sync effect won't reopen them.
  // activeDocId null = "follow the agent"; set = the viewer took the wheel.
  // Initial values are restored from localStorage (item 11 — smart default-open)
  // so a reload lands on the tabs you had open. A GENUINE first visit restores
  // nothing → zero open tabs → the welcome/start page.
  const initialTabs = useMemo(() => loadTabState(getCodeFromURL()), []);
  const [openDocIds, setOpenDocIds] = useState<string[]>(() => initialTabs?.open ?? []);
  const [closedDocIds, setClosedDocIds] = useState<Set<string>>(
    () => new Set(initialTabs?.closed ?? []),
  );
  const [activeDocId, setActiveDocId] = useState<string | null>(() =>
    initialTabs && !initialTabs.following ? initialTabs.active : null,
  );
  const [followDocId, setFollowDocId] = useState<string | null>(() =>
    initialTabs && initialTabs.following ? initialTabs.active : null,
  );
  // A created document's server id is unknown until it lands in the next state
  // push; this flags "focus the next brand-new doc that appears".
  const activateNextNewDocRef = useRef(false);
  const prevDocIdsRef = useRef<string[]>([]);
  // Have we processed the first state snapshot for this canvas yet? On that first
  // snapshot the pre-existing documents are adopted per the restored open set and
  // are NOT auto-opened — so a first visit lands at zero tabs. Only documents that
  // appear AFTER (created live by you or the agent) auto-open. Reset per canvas.
  const firstSnapshotDoneRef = useRef(false);

  // All documents, ordered for display, plus the open subset.
  const documents = useMemo<Document[]>(
    () =>
      canvasState
        ? Object.values(canvasState.documents ?? {}).sort((a, b) => a.sortOrder - b.sortOrder)
        : [],
    [canvasState],
  );
  const docsById = useMemo(() => {
    const m: Record<string, Document> = {};
    for (const d of documents) m[d.id] = d;
    return m;
  }, [documents]);
  const openSet = useMemo(() => new Set(openDocIds), [openDocIds]);
  const openDocs = useMemo(() => documents.filter((d) => openSet.has(d.id)), [documents, openSet]);

  // Keep the open set in sync with the documents that exist: drop deleted ones,
  // and auto-open documents that appear AFTER this viewer connected (so a tab the
  // agent or you create live surfaces on its own) — but NOT the documents that
  // already existed at connect time, so a first visit lands at zero tabs. Focuses
  // a doc we just created via activateNext… .
  useEffect(() => {
    if (!canvasState) return; // wait for the first real snapshot
    const ids = documents.map((d) => d.id);
    const existing = new Set(ids);
    // On the first snapshot after (re)connecting nothing counts as "new": the
    // restored open set stands as-is. Afterwards, ids absent from the previous
    // snapshot are freshly-created and auto-open (unless explicitly closed).
    const firstSnapshot = !firstSnapshotDoneRef.current;
    firstSnapshotDoneRef.current = true;
    // Folders never open as tabs — they only nest documents in the explorer —
    // so a freshly-created folder must not auto-surface as a tab.
    const newIds = firstSnapshot
      ? []
      : ids.filter((id) => !prevDocIdsRef.current.includes(id) && docsById[id]?.type !== "folder");
    prevDocIdsRef.current = ids;

    setOpenDocIds((prev) => {
      let next = prev.filter((id) => existing.has(id));
      for (const id of newIds) {
        if (!next.includes(id) && !closedDocIds.has(id)) next = [...next, id];
      }
      return next.length === prev.length && next.every((v, i) => v === prev[i]) ? prev : next;
    });
    setClosedDocIds((prev) => {
      const kept = [...prev].filter((id) => existing.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
    if (activateNextNewDocRef.current && newIds.length > 0) {
      activateNextNewDocRef.current = false;
      setActiveDocId(newIds[newIds.length - 1]);
    }
  }, [documents, closedDocIds, canvasState]);

  const following = activeDocId === null;
  // The focused document: the viewer's pick if still open; else (following) the
  // agent's doc; else the first open tab; else none (welcome / empty canvas).
  const effectiveDoc: Document | undefined =
    (!following && activeDocId && openSet.has(activeDocId) ? docsById[activeDocId] : undefined) ??
    (following && followDocId && openSet.has(followDocId) ? docsById[followDocId] : undefined) ??
    openDocs[0];
  const effectiveDocId = effectiveDoc?.id ?? null;
  const effectiveMode: CanvasMode = effectiveDoc ? DOC_TYPE_TO_MODE[effectiveDoc.type] : "welcome";
  const hasTabs = openDocs.length > 0;
  effectiveModeRef.current = effectiveMode;
  effectiveDocIdRef.current = effectiveDocId;

  // Keep-alive: mark the focused mode visited so its subtree stays mounted.
  useEffect(() => {
    if (!hasTabs) return;
    setVisitedModes((prev) => (prev.has(effectiveMode) ? prev : new Set(prev).add(effectiveMode)));
  }, [effectiveMode, hasTabs]);

  // Persist this viewer's tab state per canvas (item 11) so a reload restores the
  // same open tabs and focus. Only saves once a canvas is loaded; `active` is the
  // effective (shown) document, and `following` records whether we were tracking
  // the agent vs pinned to a tab.
  const loadedCode = canvas?.code;
  useEffect(() => {
    if (!loadedCode) return;
    saveTabState(loadedCode, {
      open: openDocIds,
      closed: [...closedDocIds],
      active: effectiveDocId,
      following,
    });
  }, [loadedCode, openDocIds, closedDocIds, effectiveDocId, following]);

  // Persist this viewer's sidebar position per canvas, mirroring the tab-state save
  // above — so a reload (and re-entry) restores the same view + open/closed state
  // for THIS canvas, and marks it "visited" so the first-visit force fires only once.
  useEffect(() => {
    if (!loadedCode) return;
    saveSidebarState(loadedCode, { view: sidebarView, open: sidebarOpen });
  }, [loadedCode, sidebarView, sidebarOpen]);

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
    setActiveDocId(null);
    setFollowDocId(null);
    setOpenDocIds([]);
    setClosedDocIds(new Set());
    prevDocIdsRef.current = [];
    firstSnapshotDoneRef.current = false;
    setConnectOpen(false);
    setShareOpen(false);
    setAccessError(null);
  }

  // Restore this viewer's saved tab state for a canvas we're entering (item 11).
  // Runs after resetPerCanvasState in handleJoin, so it wins. No saved state → a
  // genuine first visit: zero open tabs → the welcome/start page. When following,
  // land back on the doc that was showing (followDocId), still tracking the agent.
  function hydrateTabsFor(code: string) {
    const saved = loadTabState(code);
    prevDocIdsRef.current = [];
    firstSnapshotDoneRef.current = false;
    if (saved) {
      setOpenDocIds(saved.open);
      setClosedDocIds(new Set(saved.closed));
      setActiveDocId(saved.following ? null : saved.active);
      setFollowDocId(saved.following ? saved.active : null);
    } else {
      setOpenDocIds([]);
      setClosedDocIds(new Set());
      setActiveDocId(null);
      setFollowDocId(null);
    }
  }

  // Restore this viewer's saved sidebar position for a canvas we're entering, or —
  // on a genuine first visit (nothing saved / lapsed) — reveal the Documents
  // explorer so the tabs are discoverable. Mirrors hydrateTabsFor: each canvas is
  // its own playground, so a collapse on one board doesn't follow you to another.
  function hydrateSidebarFor(code: string) {
    const saved = loadSidebarState(code);
    if (saved) {
      setSidebarView(saved.view);
      setSidebarOpen(saved.open);
    } else {
      setSidebarView("documents");
      setSidebarOpen(true);
    }
  }

  // Welcome-page "Open all tabs" (item 10): surface every document on the canvas
  // as a tab at once. Clears any explicit closes so the sync effect keeps them.
  function openAllDocs() {
    // Folders aren't tabs — open only the real documents.
    const ids = documents.filter((d) => d.type !== "folder").map((d) => d.id);
    if (ids.length === 0) return;
    setClosedDocIds(new Set());
    setOpenDocIds(ids);
    setFollowDocId((f) => f ?? ids[0]);
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
    posthog.capture("canvas_joined", { canvas_code: code });
    setCanvasCode(code);
    setCodeInURL(code);
    resetPerCanvasState();
    hydrateTabsFor(code);
    hydrateSidebarFor(code);
    // A claim token is scoped to the canvas it arrived with — drop it when the
    // user navigates elsewhere so it can't be misapplied to another canvas.
    setClaimToken(null);
  }

  function showMyCanvases() {
    window.history.pushState(null, "", "/dashboard");
    setRoute("dashboard");
  }

  function showSettings() {
    window.history.pushState(null, "", "/me");
    setRoute("settings");
  }

  function showAbout() {
    window.history.pushState(null, "", "/about");
    setRoute("about");
  }

  // Deep-copy the current canvas into my account, then open the owned copy.
  async function handleCopyToAccount() {
    if (!canvas || copying) return;
    setCopying(true);
    try {
      const copy = await copyCanvas(canvas.code);
      posthog.capture("canvas_copied_to_account", { source_canvas_code: canvas.code, new_canvas_code: copy.code });
      handleJoin(copy.code);
    } catch (err) {
      posthog.captureException(err instanceof Error ? err : new Error(String(err)));
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
        posthog.capture("canvas_claimed", { canvas_code: updated.code });
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

  // Auto-follow: while following, an agent edit pulls the follower to the
  // document that edit lives in (so you watch the agent move between tabs).
  useEffect(() => {
    if (activeDocId !== null || !agentEdit || !canvasState) return;
    const docId = documentIdForEntity(canvasState, agentEdit.entityId);
    if (docId) setFollowDocId(docId);
  }, [agentEdit, activeDocId, canvasState]);

  // While following, scroll the agent's just-edited element into view so its
  // cursor is always on screen. The element may not be mounted yet (the tab is
  // mid-switch), so retry across a few frames until it's present + visible.
  useEffect(() => {
    if (activeDocId !== null || !agentEdit) return;
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
  }, [agentEdit, activeDocId]);

  // A user scroll/pan while following = "I'm taking the wheel": pin to the
  // current tab and stop following until they click Follow again. We listen for
  // wheel/touch (unambiguous scroll intent) and ONLY the keyboard keys that
  // actually scroll the page — not every keypress. Typing in a field, hitting a
  // shortcut, or cmd-tabbing must never silently drop follow. We also skip
  // 'scroll' itself, which the auto-scroll above fires programmatically.
  useEffect(() => {
    if (activeDocId !== null) return;
    const stop = () => setActiveDocId(effectiveDocIdRef.current);
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
  }, [activeDocId]);

  // OAuth consent — a self-contained page (its own sign-in + redirect flow), so
  // it needs none of the canvas/nav wiring below.
  if (route === "authorize") {
    return <OAuthConsent />;
  }

  if (route === "mcp") {
    return (
      <MCPSupport
        onBack={() => {
          window.history.pushState(null, "", "/");
          setRoute("home");
        }}
        onOpenMCP={() => {
          setMCPInURL();
          setRoute("mcp");
        }}
        onShowCanvases={showMyCanvases}
        onShowSettings={showSettings}
        onAbout={showAbout}
        onOpenCanvas={(code) => {
          setRoute("home");
          handleJoin(code);
        }}
      />
    );
  }

  if (route === "about") {
    return (
      <About
        onBack={() => {
          window.history.pushState(null, "", "/");
          setRoute("home");
        }}
        onOpenMCP={() => {
          setMCPInURL();
          setRoute("mcp");
        }}
        onShowCanvases={showMyCanvases}
        onShowSettings={showSettings}
        onOpenCanvas={(code) => {
          setRoute("home");
          handleJoin(code);
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
        onOpenMCP={() => {
          setMCPInURL();
          setRoute("mcp");
        }}
        onShowCanvases={showMyCanvases}
        onShowSettings={showSettings}
        onShowAbout={showAbout}
        onOpenCanvas={(code) => {
          setRoute("home");
          handleJoin(code);
        }}
      />
    );
  }

  if (route === "settings") {
    return (
      <UserSettings
        onHome={() => {
          setRoute("home");
          handleJoin("");
        }}
        onShowCanvases={showMyCanvases}
        onShowAbout={showAbout}
        onOpenCanvas={(code) => {
          setRoute("home");
          handleJoin(code);
        }}
      />
    );
  }

  if (route === "dashboard") {
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
        onShowSettings={showSettings}
        onShowAbout={showAbout}
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
        onShowSettings={showSettings}
        onAbout={showAbout}
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
        <p className="relative mt-2 rounded-[4px] border border-ink/15 bg-surface px-2.5 py-1 font-code text-xs tracking-[0.3em] text-ink/50">
          {canvasCode}
        </p>
      </div>
    );
  }

  // Local navigation only — switching tabs never touches the shared canvas or
  // other viewers. Deep components (ModeNavContext) request a mode; map it to the
  // first open document of that type.
  const setMode = (mode: CanvasMode) => {
    const d = openDocs.find((o) => DOC_TYPE_TO_MODE[o.type] === mode);
    if (d) setActiveDocId(d.id);
  };

  // Following is armed even before any agent shows up — distinguish "an agent is
  // here" from "on, waiting for one" so the button reads as live, not dead.
  const agentPresent = agentList.length > 0;
  // The homepage shows iff the canvas has zero open tabs.
  const inWelcome = !hasTabs;
  // Toggling off pins the view to the current tab; on resumes following.
  const toggleFollow = () => setActiveDocId(following ? effectiveDocId : null);
  const theme = modeTheme(effectiveMode);

  // ── Document tab actions ────────────────────────────────────────────────────
  function selectDoc(id: string) {
    setActiveDocId(id);
  }
  // Close = hide locally + remember it's closed so the sync won't reopen it.
  // Non-destructive: the document still exists (reopen via reload for now).
  function closeDoc(id: string) {
    setClosedDocIds((prev) => new Set(prev).add(id));
    setOpenDocIds((prev) => prev.filter((x) => x !== id));
    if (activeDocId === id) setActiveDocId(null);
  }
  function createDocument(type: DocumentType) {
    posthog.capture("document_created", { document_type: type, canvas_code: canvas?.code });
    activateNextNewDocRef.current = true;
    sendOp({ op: "document.add", data: { type } });
  }
  // Explorer → create an (empty) folder to organize documents. Not a tab, so we
  // don't arm activateNextNewDoc; it surfaces in the explorer tree on the next
  // state push.
  function createFolder() {
    sendOp({ op: "document.add", data: { type: "folder", name: "New folder" } });
  }
  // Explorer → move a document into a folder (parentId) or back to the root
  // (parentId null). Keeps its own sortOrder so relative order is preserved.
  function moveDoc(id: string, parentId: string | null) {
    const doc = docsById[id];
    if (!doc || (doc.parentId ?? null) === parentId) return;
    sendOp({
      op: "document.reorder",
      updates: [{ id, parentId, sortOrder: doc.sortOrder }],
    });
  }
  // Explorer → open a document as a tab and focus it. Clears any prior "closed"
  // mark so the sync effect keeps it open; adds it to the open set immediately.
  function openDoc(id: string) {
    setClosedDocIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setOpenDocIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActiveDocId(id);
  }
  // Explorer → delete a document for everyone. The doc (and its child entities,
  // via the DB cascade) disappears on the next state push; the sync effect drops
  // it from the open set. If it was the focused tab, resume following the agent.
  function deleteDoc(id: string) {
    sendOp({ op: "document.delete", id });
    setClosedDocIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (activeDocId === id) setActiveDocId(null);
  }

  return (
    <ModeNavContext.Provider value={setMode}>
    <div className="flex flex-col h-screen bg-paper font-brand text-ink overflow-hidden">
      {/* z-[80] so the header (and its bell dropdown) sits above the agent
          cursor overlay (z-[70]); modals are z-[2000] and still cover it. */}
      <header className="relative z-[80] flex items-center gap-1.5 px-3 py-2.5 bg-paper/85 backdrop-blur border-b border-ink/5 shrink-0 sm:gap-2 sm:px-4">
        {/* Accent rule across the top of the chrome — picks up the active mode's
            colour and eases between them as you switch views. */}
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-0.5 transition-colors duration-500"
          style={{ backgroundColor: theme.solid }}
        />

        {/* Mobile-only: open the nav drawer (explorer / tasks / settings). The
            desktop left dock is `hidden sm:flex`, so this is the only way in on
            a phone. Badges the proposed-task count like the desktop rail. */}
        <button
          onClick={() => setMobileNavOpen(true)}
          className="relative -ml-1 flex h-9 w-9 items-center justify-center rounded-lg text-ink/60 transition-colors hover:bg-ink/5 hover:text-ink shrink-0 sm:hidden"
          title="Menu"
          aria-label="Open navigation"
        >
          <Menu size={20} strokeWidth={1.75} />
          {proposedTaskCount > 0 && (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#C75B39] px-1 text-[9px] font-bold text-white">
              {proposedTaskCount}
            </span>
          )}
        </button>

        <button
          onClick={() => handleJoin("")}
          className="group flex items-center gap-1.5 text-sm shrink-0"
          title="Back to home"
        >
          <TandemLogo size={28} animate={false} />
          <span className="hidden font-semibold tracking-tight text-ink transition-colors group-hover:text-sky-600 sm:inline">
            Tandem
          </span>
        </button>
        <span className="hidden text-ink/20 shrink-0 sm:inline">/</span>
        <div className="flex items-center gap-2 min-w-0">
          <CanvasNameEditor
            name={canvas.name}
            canEdit={!!me && canvas.ownerUserId === me.id}
            onSubmit={async (newName) => {
              const prevName = canvas.name;
              // Optimistic: show the new name immediately, revert if the PATCH
              // fails. On success the server broadcasts fresh state, which
              // reconciles this and every other connected viewer.
              setCanvas((prev) => (prev ? { ...prev, name: newName } : prev));
              try {
                await setCanvasName(canvas.code, newName);
              } catch (err) {
                setCanvas((prev) => (prev ? { ...prev, name: prevName } : prev));
                throw err;
              }
            }}
          />
          <span className="hidden rounded-[3px] border border-ink/10 bg-surface px-1.5 py-px font-code text-[10px] tracking-[0.14em] text-ink/40 shrink-0 sm:inline">
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

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <AgentPresence agents={agentList} edit={agentEdit} reading={agentReading} onJump={() => setActiveDocId(null)} />
          <button
            onClick={toggleFollow}
            className={[
              "inline-flex items-center gap-1.5 rounded-lg h-8 px-3 text-sm font-medium transition-colors",
              following ? "" : "text-ink/55 hover:bg-ink/5 hover:text-ink/80",
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
                className="hidden rounded-md border border-ink/20 px-3 py-1.5 text-sm font-medium text-ink/75 transition-colors hover:border-ink/50 hover:bg-surface disabled:opacity-60 sm:inline-block"
                title="Save a copy of this canvas to your account so it shows up in My canvases on every device"
              >
                {copying ? "Copying…" : "Copy to my account"}
              </button>
            )
          )}
          {me && canvas.ownerUserId === me.id && (
            <button
              onClick={() => setShareOpen(true)}
              className="rounded-md border border-ink/20 px-3 py-1.5 text-sm font-medium text-ink/75 transition-colors hover:border-ink/50 hover:bg-surface"
              title="Control who can open and edit this canvas"
            >
              Share
            </button>
          )}
          <button
            onClick={() => setConnectOpen(true)}
            className="btn-press rounded-md px-3.5 py-1.5 text-sm font-medium bg-ink text-paper shadow-[2px_2px_0_#0D6E66]"
          >
            Connect
          </button>
          <AccountMenu onShowCanvases={showMyCanvases} onShowSettings={showSettings} onShowAbout={showAbout} onUserChange={setMe} onOpenCanvas={handleJoin} />
        </div>
      </header>

      {claimNotice && (
        <div className="pointer-events-none fixed inset-x-0 top-16 z-50 flex justify-center">
          <div className="pointer-events-auto rounded-full bg-ink px-4 py-2 text-sm font-medium text-paper shadow-lg">
            {claimNotice} ✓
          </div>
        </div>
      )}

      {/* Live agent op-feed popups. Muting is controlled from the header bell. */}
      <AgentToasts toasts={notify.toasts} onDismiss={notify.dismissToast} />

      {/* Main row, flush under the header: the left dock (activity rail + one
          swappable panel) rises the full height beside the header, and the tab
          strip lives in the RIGHT column above the mode content — so tabs sit
          only over the document they switch, not over the sidebar. */}
      <div className="relative flex flex-1 min-h-0">
        {/* VS Code-style left dock: an always-present icon rail (ActivityBar)
            plus ONE swappable side panel. Documents, Agent tasks, and Settings
            share the slot — selecting an icon opens its panel; the active one
            toggles closed. */}
        <ActivityBar
          active={sidebarView}
          onSelect={selectSidebarView}
          badges={{ tasks: proposedTaskCount }}
        />
        {sidebarView && sidebarOpen && (
          <SidePanel width={panelWidth} onWidthChange={setPanelWidthPersist} onClose={closeSidebar}>
            {sidebarView === "documents" && (
              <DocumentExplorer
                documents={documents}
                state={canvasState}
                openIds={openSet}
                activeDocId={effectiveDocId}
                onOpen={openDoc}
                onDelete={deleteDoc}
                onCreateFolder={createFolder}
                onMove={moveDoc}
                readOnly={canvas.yourRole === "read"}
                onClose={closeSidebar}
              />
            )}
            {sidebarView === "tasks" && (
              <TasksPanel
                code={canvas.code}
                state={canvasState}
                readOnly={canvas.yourRole === "read"}
                onClose={closeSidebar}
              />
            )}
            {sidebarView === "settings" && (
              <SettingsPanel
                canvas={canvas}
                isOwner={!!me && canvas.ownerUserId === me.id}
                onDeleted={showMyCanvases}
                onClose={closeSidebar}
              />
            )}
          </SidePanel>
        )}
        {/* Collapsed but a view is still selected → a grab strip at the dock edge
            so you can drag (or click) the boundary to reopen that view. */}
        {sidebarView && !sidebarOpen && (
          <SidePanelReopenHandle defaultWidth={panelWidth} onOpen={openSidebar} />
        )}

        {/* Right column: tab strip + view-only banner on top, mode content below. */}
        <div className="flex min-w-0 flex-1 flex-col">
        {/* Tab strip — VS Code-style, above the mode content. One tab per OPEN
            document; the "+" creates new ones. Always present once a canvas is
            loaded, so even on the empty homepage (zero tabs) the "+" is there to
            start one. z-[75] keeps its add-menu above the mode content but below
            the header (z-[80]). */}
        <div className="relative z-[75] flex items-center px-3 py-1 bg-paper/70 backdrop-blur border-b border-ink/5 shrink-0 sm:px-4">
          <DocumentTabs
            docs={openDocs}
            activeDocId={effectiveDocId}
            onSelect={selectDoc}
            onClose={closeDoc}
            onCreate={createDocument}
            readOnly={canvas.yourRole === "read"}
          />
        </div>

        {canvas.yourRole === "read" && (
          <div className="flex items-center justify-center gap-2 border-b border-ink/10 bg-paper px-4 py-1.5 text-center font-code text-[11.5px] text-ink/55">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-ink/30" />
            View only — you can follow along but not edit this canvas.
          </div>
        )}

        {/* Mode content row: the focused document's view + the QuickLog dock.
            The mode components + QuickLog are dark-mode-ready (grays swept to
            paper/surface/ink tokens), so the worksurface follows the active
            theme. MapMode is a deliberate exception: the raster tiles + baked
            annotation pills stay light (a light map framed by dark chrome),
            while its toolbar, sidebar, and popups follow the theme. */}
        <div className="relative flex flex-1 min-h-0 bg-paper text-ink">
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
          // Render just the focused document's slice. For a hidden (kept-alive)
          // mode, fall back to the first open doc of its type so it stays coherent.
          const docForMode = active ? effectiveDoc : openDocs.find((d) => DOC_TYPE_TO_MODE[d.type] === m);
          const scopedState = scopeStateToDocument(canvasState, docForMode);
          return (
            <div key={m} className={wrapperClass}>
              {m === "welcome" && (
                <WelcomeMode
                  canvasName={canvas.name}
                  currentCode={canvas.code}
                  docCount={documents.filter((d) => d.type !== "folder").length}
                  onOpenConnect={() => setConnectOpen(true)}
                  onOpenCanvas={handleJoin}
                  onCreateDoc={createDocument}
                  onOpenAll={openAllDocs}
                />
              )}
              {m === "map" && (
                <MapMode
                  canvasId={canvas.id}
                  mapId={canvas.mapId}
                  state={scopedState}
                  active={active}
                  selectedPinId={selectedPinId}
                  onSelectPin={setSelectedPinId}
                  selectedEventId={selectedEventId}
                  onSelectEvent={setSelectedEventId}
                />
              )}
              {m === "itinerary" && (
                <ItineraryMode
                  state={scopedState}
                  canvasCode={canvas.code}
                  canvasName={canvas.name}
                  selectedEventId={selectedEventId}
                  onSelectEvent={setSelectedEventId}
                />
              )}
              {m === "docs" && (
                <DocsMode
                  canvasId={canvas.id}
                  state={scopedState}
                  readOnly={canvas.yourRole === "read"}
                />
              )}
              {m === "roadmap" && (
                <RoadmapMode
                  state={scopedState}
                  code={canvas.code}
                  readOnly={canvas.yourRole === "read"}
                />
              )}
              {m === "sheets" && <SheetsMode state={scopedState} canvasCode={canvas.code} />}
              {m === "charts" && <ChartsMode state={scopedState} />}
            </div>
          );
        })}
        </ErrorBoundary>

        {/* Direct-input layer: quick-log rail + mobile FAB, overlaid on whatever
            mode is showing. Renders the canvas's agent-defined forms. */}
        <QuickLog code={canvas.code} forms={canvasState.forms} />
        </div>
        </div>
      </div>

      {/* Mobile nav drawer — the desktop left dock (explorer / tasks / settings)
          as an off-canvas panel, reusing the exact same view components. Purely
          additive (`sm:hidden`); opening a document closes the drawer. */}
      <MobileNavDrawer
        open={mobileNavOpen}
        view={mobileNavView}
        onSelectView={setSidebarView}
        onClose={() => setMobileNavOpen(false)}
        badges={{ tasks: proposedTaskCount }}
      >
        {mobileNavView === "documents" && (
          <DocumentExplorer
            documents={documents}
            state={canvasState}
            openIds={openSet}
            activeDocId={effectiveDocId}
            onOpen={(id) => {
              openDoc(id);
              setMobileNavOpen(false);
            }}
            onDelete={deleteDoc}
            onCreateFolder={createFolder}
            onMove={moveDoc}
            readOnly={canvas.yourRole === "read"}
            onClose={() => setMobileNavOpen(false)}
          />
        )}
        {mobileNavView === "tasks" && (
          <TasksPanel
            code={canvas.code}
            state={canvasState}
            readOnly={canvas.yourRole === "read"}
            onClose={() => setMobileNavOpen(false)}
          />
        )}
        {mobileNavView === "settings" && (
          <SettingsPanel
            canvas={canvas}
            isOwner={!!me && canvas.ownerUserId === me.id}
            onDeleted={() => {
              setMobileNavOpen(false);
              showMyCanvases();
            }}
            onClose={() => setMobileNavOpen(false)}
          />
        )}
      </MobileNavDrawer>

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
