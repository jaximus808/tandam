import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { CanvasMeta, CanvasMode, CanvasState } from "./types";
import { connectToCanvas, disconnectFromCanvas, onStateUpdate, sendOp } from "./lib/ws";
import MapMode from "./modes/MapMode";
import ItineraryMode from "./modes/ItineraryMode";
import DocsMode from "./modes/DocsMode";
import RoadmapMode from "./modes/RoadmapMode";
import SheetsMode from "./modes/SheetsMode";
import WelcomeMode from "./modes/WelcomeMode";
import Landing from "./pages/Landing";
import MCPSupport from "./pages/MCPSupport";
import ConnectModal, { hasDismissedConnect } from "./components/ConnectModal";
import TandemLogo from "./components/TandemLogo";
import AccountMenu from "./components/AccountMenu";
import { recordRecent } from "./lib/recentCanvases";
import { MOCK_ENABLED, mockCanvas } from "./lib/mockFixture";

const MODES: { id: CanvasMode; label: string }[] = [
  { id: "map", label: "Map" },
  { id: "itinerary", label: "Itinerary" },
  { id: "docs", label: "Docs" },
  { id: "roadmap", label: "Roadmap" },
  { id: "sheets", label: "Sheets" },
];

function availableModes(state: CanvasState, currentMode: CanvasMode): CanvasMode[] {
  const has = {
    map: Object.keys(state.pins).length > 0,
    itinerary: Object.keys(state.events).length > 0,
    docs: Object.keys(state.notes).length > 0,
    roadmap: Object.keys(state.roadmapItems).length > 0,
    sheets: Object.keys(state.sheets).length > 0,
  };
  const out = new Set<CanvasMode>();
  // Always include the current mode so the user doesn't lose their tab.
  if (currentMode === "map" || currentMode === "itinerary" || currentMode === "docs" || currentMode === "roadmap" || currentMode === "sheets") {
    out.add(currentMode);
  }
  if (has.map) out.add("map");
  if (has.itinerary) out.add("itinerary");
  if (has.docs) out.add("docs");
  if (has.roadmap) out.add("roadmap");
  if (has.sheets) out.add("sheets");
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
  // Optimistic UI: snap the tab highlight + content swap immediately on click,
  // before the WS roundtrip echoes back. The mode the user MOST RECENTLY
  // clicked is the source of truth for what's displayed — server echoes for
  // older clicks are ignored. Without this, rapid X→Y switching can flicker
  // back to X when the stale X-echo arrives between Y's click and Y's echo.
  const [pendingMode, setPendingMode] = useState<CanvasMode | null>(null);
  // Mirror in a ref so the WS handler closure can read the *latest* intent
  // synchronously, even before React commits the state update.
  const pendingModeRef = useRef<CanvasMode | null>(null);
  const displayMode = (pendingMode ?? (canvasState?.mode as CanvasMode | undefined)) as
    | CanvasMode
    | undefined;

  useEffect(() => {
    if (!displayMode) return;
    setVisitedModes((prev) => (prev.has(displayMode) ? prev : new Set(prev).add(displayMode)));
  }, [displayMode]);

  // Clear the pending mode only when the server's echo matches what we MOST
  // RECENTLY asked for (tracked via the ref). If the user clicked X then Y,
  // and the X-echo arrives first, the ref is "Y" — we keep pendingMode=Y so
  // the UI doesn't flicker back to X. We deliberately do NOT use a timeout
  // fallback: the user's latest click wins until the server confirms it.
  useEffect(() => {
    if (!canvasState?.mode) return;
    if (pendingModeRef.current && canvasState.mode === pendingModeRef.current) {
      pendingModeRef.current = null;
      setPendingMode(null);
    }
  }, [canvasState?.mode]);

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
    setPendingMode(null);
    pendingModeRef.current = null;
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
      <div className="flex items-center justify-center h-screen text-gray-400 text-sm">
        Connecting to canvas {canvasCode}…
      </div>
    );
  }

  const setMode = (mode: CanvasMode) => {
    pendingModeRef.current = mode;
    setPendingMode(mode);
    sendOp({ op: "mode.set", mode });
  };
  const effectiveMode = (displayMode ?? canvasState.mode) as CanvasMode;
  const inWelcome = effectiveMode === "welcome";
  const visibleModes = availableModes(canvasState, effectiveMode);

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
    <div className="flex flex-col h-screen bg-gray-50 overflow-hidden">
      <header className="flex items-center gap-2 px-4 py-2 bg-white border-b border-gray-200 shrink-0">
        <button
          onClick={() => handleJoin("")}
          className="flex items-center gap-1.5 font-bold text-gray-900 text-sm hover:text-blue-600 transition-colors shrink-0"
          title="Back to home"
        >
          <TandemLogo size={20} />
          <span>Tandem</span>
        </button>
        <div className="w-px h-4 bg-gray-200 mx-1 shrink-0" />
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-gray-900 text-sm truncate">{canvas.name}</span>
          <span className="text-xs text-gray-400 font-mono shrink-0">{canvas.code}</span>
        </div>

        {inWelcome && canvasReturnMode && (
          <>
            <div className="w-px h-4 bg-gray-200 mx-1" />
            <button
              onClick={() => setMode(canvasReturnMode)}
              className="px-3 py-1 rounded-md text-sm font-medium text-gray-400 hover:bg-gray-100"
              title="Back to canvas"
            >
              Canvas →
            </button>
          </>
        )}

        {!inWelcome && visibleModes.length > 0 && (
          <>
            <div className="w-px h-4 bg-gray-200 mx-1 shrink-0" />

            {/* Desktop: all modes laid out inline. */}
            <div className="hidden sm:flex gap-1">
              {MODES.filter((m) => visibleModes.includes(m.id)).map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  className={[
                    "px-3 py-1 rounded-md text-sm font-medium transition-colors",
                    effectiveMode === m.id
                      ? "bg-blue-600 text-white"
                      : "text-gray-500 hover:bg-gray-100",
                  ].join(" ")}
                >
                  {m.label}
                </button>
              ))}
              <button
                onClick={() => setMode("welcome")}
                className="px-3 py-1 rounded-md text-sm font-medium text-gray-400 hover:bg-gray-100"
                title="Back to templates"
              >
                ← Templates
              </button>
            </div>

            {/* Mobile: a dropdown so every mode is reachable regardless of count. */}
            <div className="relative sm:hidden">
              <button
                onClick={() => setModeMenuOpen((o) => !o)}
                className="flex items-center gap-1 px-3 py-1 rounded-md text-sm font-medium bg-blue-600 text-white"
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
                    className="absolute left-0 mt-1 z-20 min-w-[10rem] rounded-md bg-white border border-gray-200 shadow-lg py-1"
                  >
                    {MODES.filter((m) => visibleModes.includes(m.id)).map((m) => (
                      <button
                        key={m.id}
                        role="menuitem"
                        onClick={() => {
                          setMode(m.id);
                          setModeMenuOpen(false);
                        }}
                        className={[
                          "w-full text-left px-3 py-2 text-sm font-medium",
                          effectiveMode === m.id
                            ? "bg-blue-50 text-blue-700"
                            : "text-gray-700 hover:bg-gray-100",
                        ].join(" ")}
                      >
                        {m.label}
                      </button>
                    ))}
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
            onClick={() => setConnectOpen(true)}
            className="px-3 py-1 rounded-md text-sm font-medium bg-gray-900 text-white hover:bg-gray-800"
          >
            Connect
          </button>
          <AccountMenu />
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {(["welcome", "map", "itinerary", "docs", "roadmap", "sheets"] as CanvasMode[]).map((m) => {
          const active = effectiveMode === m;
          // Lazy-mount: only render a mode after the user has visited it at
          // least once. After that, keep it mounted and hide with CSS.
          if (!active && !visitedModes.has(m)) return null;
          const wrapperClass = active ? "flex flex-1 min-h-0" : "hidden";
          return (
            <div key={m} className={wrapperClass}>
              {m === "welcome" && (
                <WelcomeMode
                  canvasName={canvas.name}
                  onOpenConnect={() => setConnectOpen(true)}
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
  );
}
