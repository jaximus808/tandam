import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { CanvasMeta, CanvasMode, CanvasState } from "./types";
import { connectToCanvas, disconnectFromCanvas, onStateUpdate } from "./lib/ws";
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
import ConnectModal, { hasDismissedConnect } from "./components/ConnectModal";
import TandemLogo from "./components/TandemLogo";
import AccountMenu from "./components/AccountMenu";
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

function availableModes(state: CanvasState, currentMode: CanvasMode): CanvasMode[] {
  const has = {
    map: Object.keys(state.pins).length > 0,
    itinerary: Object.keys(state.events).length > 0,
    docs: Object.keys(state.notes).length > 0,
    roadmap: Object.keys(state.roadmapItems).length > 0,
    sheets: Object.keys(state.sheets).length > 0,
    charts: Object.keys(state.charts).length > 0,
  };
  const out = new Set<CanvasMode>();
  // Always include the current mode so the user doesn't lose their tab.
  if (
    currentMode === "map" ||
    currentMode === "itinerary" ||
    currentMode === "docs" ||
    currentMode === "roadmap" ||
    currentMode === "sheets" ||
    currentMode === "charts"
  ) {
    out.add(currentMode);
  }
  if (has.map) out.add("map");
  if (has.itinerary) out.add("itinerary");
  if (has.docs) out.add("docs");
  if (has.roadmap) out.add("roadmap");
  if (has.sheets) out.add("sheets");
  if (has.charts) out.add("charts");
  return MODES.map((m) => m.id).filter((id) => out.has(id));
}

function getCodeFromURL(): string | null {
  if (MOCK_ENABLED) return mockCanvas.code;
  const path = window.location.pathname;
  const match = path.match(/\/c\/([A-Z0-9]{8})/i);
  if (match) return match[1].toUpperCase();
  return new URLSearchParams(window.location.search).get("code")?.toUpperCase() ?? null;
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
  const [route, setRoute] = useState<"home" | "mcp">(() => (isMCPRoute() ? "mcp" : "home"));
  const [canvasCode, setCanvasCode] = useState<string | null>(getCodeFromURL);
  const [canvas, setCanvas] = useState<CanvasMeta | null>(null);
  const [canvasState, setCanvasState] = useState<CanvasState | null>(null);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
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
    function onPop() {
      setRoute(isMCPRoute() ? "mcp" : "home");
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    return onStateUpdate((c, _all, s) => {
      setCanvas(c);
      setCanvasState(s);
    });
  }, []);

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
    setConnectOpen(false);
    setModeMenuOpen(false);
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
  }

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

  if (!canvasCode) {
    return (
      <Landing
        onJoin={handleJoin}
        onOpenMCP={() => {
          setMCPInURL();
          setRoute("mcp");
        }}
      />
    );
  }

  if (!canvasState || !canvas) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-paper font-brand text-gray-900">
        <TandemLogo size={56} />
        <p className="mt-6 text-sm font-medium text-gray-600">Joining canvas</p>
        <p className="mt-1 font-code text-xs tracking-[0.3em] text-gray-400">{canvasCode}</p>
      </div>
    );
  }

  // Local navigation only — switching tabs never touches the shared canvas or
  // other viewers. See viewMode above.
  const setMode = (mode: CanvasMode) => setViewMode(mode);
  const effectiveMode = (viewMode ?? canvasState.mode) as CanvasMode;
  // "Following" = no local override, so the view tracks the canvas mode the
  // agent drives. Toggling off pins the view to whatever's showing right now.
  const following = viewMode === null;
  const toggleFollow = () => setViewMode(following ? effectiveMode : null);
  const inWelcome = effectiveMode === "welcome";
  const visibleModes = availableModes(canvasState, effectiveMode);
  const theme = modeTheme(effectiveMode);

  // In welcome mode, "Canvas →" returns the user to whichever existing
  // content-bearing mode is most relevant. Preference: map > itinerary > docs.
  const canvasReturnMode: CanvasMode | null =
    Object.keys(canvasState.pins).length > 0
      ? "map"
      : Object.keys(canvasState.events).length > 0
      ? "itinerary"
      : Object.keys(canvasState.notes).length > 0
      ? "docs"
      : Object.keys(canvasState.roadmapItems).length > 0
      ? "roadmap"
      : Object.keys(canvasState.sheets).length > 0
      ? "sheets"
      : null;

  return (
    <ModeNavContext.Provider value={setMode}>
    <div className="flex flex-col h-screen bg-paper font-brand text-gray-900 overflow-hidden">
      <header className="relative z-30 flex items-center gap-1.5 px-3 py-2.5 bg-paper/85 backdrop-blur border-b border-gray-900/5 shrink-0 sm:gap-2 sm:px-4">
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
          <span className="hidden font-code text-[11px] tracking-[0.15em] text-gray-300 shrink-0 sm:inline">
            {canvas.code}
          </span>
        </div>

        {inWelcome && canvasReturnMode && (
          <>
            <div className="w-px h-4 bg-gray-200 mx-1" />
            <button
              onClick={() => setMode(canvasReturnMode)}
              className="px-3 py-1 rounded-lg text-sm font-medium text-gray-400 hover:bg-gray-900/5 hover:text-gray-700 transition-colors"
              title="Back to canvas"
            >
              Canvas →
            </button>
          </>
        )}

        {!inWelcome && visibleModes.length > 0 && (
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
              <button
                onClick={() => setMode("welcome")}
                className="ml-0.5 rounded-lg px-3 py-1 text-sm font-medium text-gray-400 hover:bg-gray-900/5 hover:text-gray-700 transition-colors"
                title="Back to templates"
              >
                ← Templates
              </button>
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
                {MODES.find((m) => m.id === effectiveMode)?.label ?? "Mode"}
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
                    <div className="my-1 border-t border-gray-100" />
                    <button
                      role="menuitem"
                      onClick={() => {
                        setMode("welcome");
                        setModeMenuOpen(false);
                      }}
                      className="w-full text-left px-3 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100"
                    >
                      ← Templates
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        )}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <button
            onClick={toggleFollow}
            className={[
              "inline-flex items-center gap-1.5 rounded-lg h-8 px-3 text-sm font-medium transition-colors",
              following ? "" : "text-gray-500 hover:bg-gray-900/5 hover:text-gray-800",
            ].join(" ")}
            style={following ? { backgroundColor: theme.soft, color: theme.solid } : undefined}
            title={
              following
                ? "Following the agent — your view jumps to whatever it's working on. Click to pin your own view."
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
            <span className="hidden sm:inline">{following ? "Following" : "Follow agent"}</span>
          </button>
          <button
            onClick={() => setConnectOpen(true)}
            className="rounded-lg px-3.5 py-1.5 text-sm font-medium bg-gray-900 text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow"
          >
            Connect
          </button>
          <AccountMenu />
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {(["welcome", "map", "itinerary", "docs", "roadmap", "sheets", "charts"] as CanvasMode[]).map((m) => {
          const active = effectiveMode === m;
          // Lazy-mount: only render a mode after the user has visited it at
          // least once. After that, keep it mounted and hide with CSS.
          if (!active && !visitedModes.has(m)) return null;
          const wrapperClass = active ? "flex flex-1 min-h-0 min-w-0" : "hidden";
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
      </div>

      {connectOpen && (
        <ConnectModal
          code={canvas.code}
          version={canvasState.version}
          onClose={() => setConnectOpen(false)}
          onSwitchCanvas={() => { setConnectOpen(false); handleJoin(""); }}
        />
      )}
    </div>
    </ModeNavContext.Provider>
  );
}
