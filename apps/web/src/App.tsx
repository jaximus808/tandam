import { useEffect, useRef, useState } from "react";
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

function publicApiUrl(): string {
  const fromEnv = (import.meta.env.VITE_PUBLIC_API_URL as string | undefined)?.trim();
  if (fromEnv) return fromEnv;
  return window.location.origin;
}

export default function App() {
  const [route, setRoute] = useState<"home" | "mcp">(() => (isMCPRoute() ? "mcp" : "home"));
  const [canvasCode, setCanvasCode] = useState<string | null>(getCodeFromURL);
  const [canvas, setCanvas] = useState<CanvasMeta | null>(null);
  const [canvasState, setCanvasState] = useState<CanvasState | null>(null);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
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

  function handleJoin(code: string) {
    if (!code) {
      disconnectFromCanvas();
      setCanvasCode(null);
      setCanvas(null);
      setCanvasState(null);
      setAutoOpenedFor(null);
      clearCodeInURL();
      return;
    }
    setCanvasCode(code);
    setCodeInURL(code);
    setCanvas(null);
    setCanvasState(null);
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
          className="flex items-center gap-1.5 font-bold text-gray-900 text-sm hover:text-blue-600 transition-colors"
          title="Back to home"
        >
          <TandemLogo size={20} />
          <span>Tandem</span>
        </button>
        <div className="w-px h-4 bg-gray-200 mx-1" />
        <div className="flex items-center gap-2">
          <span className="font-semibold text-gray-900 text-sm">{canvas.name}</span>
          <span className="text-xs text-gray-400 font-mono">{canvas.code}</span>
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
            <div className="w-px h-4 bg-gray-200 mx-1" />
            <div className="flex gap-1">
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
          </>
        )}

        <button
          onClick={() => setConnectOpen(true)}
          className="ml-auto px-3 py-1 rounded-md text-sm font-medium bg-gray-900 text-white hover:bg-gray-800"
        >
          Connect
        </button>
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
                  selectedEventId={selectedEventId}
                  onSelectEvent={setSelectedEventId}
                />
              )}
              {m === "docs" && <DocsMode canvasId={canvas.id} state={canvasState} />}
              {m === "roadmap" && <RoadmapMode state={canvasState} />}
              {m === "sheets" && <SheetsMode state={canvasState} />}
            </div>
          );
        })}
      </div>

      {connectOpen && (
        <ConnectModal
          code={canvas.code}
          apiUrl={publicApiUrl()}
          version={canvasState.version}
          onClose={() => setConnectOpen(false)}
          onSwitchCanvas={() => { setConnectOpen(false); handleJoin(""); }}
        />
      )}
    </div>
  );
}
