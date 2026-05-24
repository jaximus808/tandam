import { useEffect, useRef, useState } from "react";
import type { CanvasMeta, CanvasMode, CanvasState, PendingEdit } from "./types";
import { connectToCanvas, onStateUpdate, sendOp } from "./lib/ws";
import MapMode from "./modes/MapMode";
import ItineraryMode from "./modes/ItineraryMode";
import DocsMode from "./modes/DocsMode";
import Landing from "./pages/Landing";

const MODES: { id: CanvasMode; label: string }[] = [
  { id: "map", label: "Map" },
  { id: "itinerary", label: "Itinerary" },
  { id: "docs", label: "Docs" },
];

function getCodeFromURL(): string | null {
  // Support /c/CODE8CHR and ?code=CODE8CHR
  const path = window.location.pathname;
  const match = path.match(/\/c\/([A-Z0-9]{8})/i);
  if (match) return match[1].toUpperCase();
  return new URLSearchParams(window.location.search).get("code")?.toUpperCase() ?? null;
}

function setCodeInURL(code: string) {
  window.history.replaceState(null, "", `/c/${code}`);
}

export default function App() {
  const [canvasCode, setCanvasCode] = useState<string | null>(getCodeFromURL);
  const [canvas, setCanvas] = useState<CanvasMeta | null>(null);
  const [canvasState, setCanvasState] = useState<CanvasState | null>(null);
  const [pendingEdits, setPendingEdits] = useState<PendingEdit[]>([]);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const shareRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!canvasCode) return;
    connectToCanvas(canvasCode);
  }, [canvasCode]);

  useEffect(() => {
    return onStateUpdate((c, _all, s, edits) => {
      setCanvas(c);
      setCanvasState(s);
      setPendingEdits(edits);
    });
  }, []);

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (shareRef.current && !shareRef.current.contains(e.target as Node)) {
        setShareOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  function handleJoin(code: string) {
    setCanvasCode(code);
    setCodeInURL(code);
    setCanvas(null);
    setCanvasState(null);
  }

  function copyCode() {
    if (!canvas) return;
    navigator.clipboard.writeText(canvas.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (!canvasCode) {
    return <Landing onJoin={handleJoin} />;
  }

  if (!canvasState || !canvas) {
    return (
      <div className="flex items-center justify-center h-screen text-gray-400 text-sm">
        Connecting to canvas {canvasCode}…
      </div>
    );
  }

  const setMode = (mode: CanvasMode) => sendOp({ op: "mode.set", mode });

  return (
    <div className="flex flex-col h-screen bg-gray-50 overflow-hidden">
      <header className="flex items-center gap-2 px-4 py-2 bg-white border-b border-gray-200 shrink-0">
        {/* Canvas name + share */}
        <div className="relative" ref={shareRef}>
          <button
            onClick={() => setShareOpen(o => !o)}
            className="flex items-center gap-1.5 font-semibold text-gray-900 text-sm hover:text-blue-600 transition-colors"
          >
            {canvas.name}
            <span className="text-xs text-gray-400 font-mono ml-1">{canvas.code}</span>
            <span className="text-gray-400 text-xs">▾</span>
          </button>

          {shareOpen && (
            <div className="absolute left-0 top-full mt-1 w-72 bg-white rounded-lg shadow-lg border border-gray-200 z-50 p-4">
              <p className="text-xs font-medium text-gray-700 mb-2">Share this canvas</p>
              <div className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
                <span className="font-mono text-sm tracking-widest text-gray-900 flex-1">
                  {canvas.code}
                </span>
                <button
                  onClick={copyCode}
                  className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <p className="text-xs text-gray-400 mt-2 leading-relaxed">
                Share this code. To connect Claude, add{" "}
                <code className="bg-gray-100 px-1 rounded">CANVAS_CODE={canvas.code}</code>{" "}
                to your MCP gateway env.
              </p>
              <button
                onClick={() => { setShareOpen(false); handleJoin(""); }}
                className="mt-3 text-xs text-gray-400 hover:text-gray-600"
              >
                ← Switch canvas
              </button>
            </div>
          )}
        </div>

        <div className="w-px h-4 bg-gray-200 mx-1" />

        {/* Mode tabs */}
        <div className="flex gap-1">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={[
                "px-3 py-1 rounded-md text-sm font-medium transition-colors",
                canvasState.mode === m.id
                  ? "bg-blue-600 text-white"
                  : "text-gray-500 hover:bg-gray-100",
              ].join(" ")}
            >
              {m.label}
            </button>
          ))}
        </div>

        <span className="ml-auto text-xs text-gray-300">v{canvasState.version}</span>
      </header>

      <div className="flex flex-1 min-h-0">
        {canvasState.mode === "map" && (
          <MapMode
            canvasId={canvas.id}
            state={canvasState}
            pendingEdits={pendingEdits}
            selectedPinId={selectedPinId}
            onSelectPin={setSelectedPinId}
          />
        )}
        {canvasState.mode === "itinerary" && (
          <ItineraryMode state={canvasState} pendingEdits={pendingEdits} />
        )}
        {canvasState.mode === "docs" && (
          <DocsMode canvasId={canvas.id} state={canvasState} pendingEdits={pendingEdits} />
        )}
      </div>
    </div>
  );
}
