import type { CanvasMeta, CanvasState, PendingEdit, WSClientMessage } from "../types";
import { MOCK_ENABLED } from "./mockFixture";
import { mockConnect, mockOnStateUpdate, mockSendOp } from "./mockWS";

type StateHandler = (canvas: CanvasMeta, canvases: CanvasMeta[], state: CanvasState, pendingEdits: PendingEdit[]) => void;

let socket: WebSocket | null = null;
let handlers: StateHandler[] = [];
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let currentCode: string | null = null;
let outboundQueue: WSClientMessage[] = [];
let reconnectAttempts = 0;
const QUEUE_MAX = 50;
const MAX_RECONNECT_ATTEMPTS = 6;

export function onStateUpdate(fn: StateHandler): () => void {
  if (MOCK_ENABLED) return mockOnStateUpdate(fn);
  handlers.push(fn);
  return () => {
    handlers = handlers.filter((h) => h !== fn);
  };
}

// detachSocket strips every callback off the given socket and (best-effort)
// closes it. Critical for navigation correctness: without it, an old socket's
// onerror/onclose closures still reference the module-level `socket`, so a
// late-firing event on the abandoned socket can call close() on the *new*
// socket we just opened for another canvas.
function detachSocket(s: WebSocket | null) {
  if (!s) return;
  s.onopen = null;
  s.onmessage = null;
  s.onerror = null;
  s.onclose = null;
  try { s.close(); } catch { /* already closed */ }
}

export function connectToCanvas(code: string) {
  if (MOCK_ENABLED) {
    mockConnect(code);
    return;
  }
  if (currentCode === code && socket?.readyState === WebSocket.OPEN) return;
  currentCode = code;
  reconnectAttempts = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  detachSocket(socket);
  socket = null;
  connect(code);
}

export function disconnectFromCanvas() {
  if (MOCK_ENABLED) return;
  currentCode = null;
  reconnectAttempts = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  detachSocket(socket);
  socket = null;
  outboundQueue = [];
}

function connect(code: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/ws?code=${encodeURIComponent(code)}`;
  // Capture the local socket so closures don't read the module-level `socket`
  // (which may have been swapped out by a later connectToCanvas call).
  const ws = new WebSocket(url);
  socket = ws;

  ws.onopen = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
    while (outboundQueue.length && ws.readyState === WebSocket.OPEN) {
      const op = outboundQueue.shift()!;
      ws.send(JSON.stringify(op));
    }
  };

  ws.onmessage = (e: MessageEvent) => {
    try {
      const msg = JSON.parse(e.data as string);
      if (msg.type === "state") {
        handlers.forEach((h) =>
          h(
            msg.canvas as CanvasMeta,
            [],
            msg.state as CanvasState,
            msg.pendingEdits as PendingEdit[]
          )
        );
      }
    } catch {
      // ignore malformed messages
    }
  };

  ws.onclose = () => {
    // Only schedule a reconnect if this socket is still the *current* one
    // and the user hasn't navigated away.
    if (ws !== socket || currentCode !== code) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn(`[ws] giving up after ${reconnectAttempts} reconnect attempts for ${code}`);
      return;
    }
    reconnectAttempts++;
    const delay = Math.min(30_000, 500 * 2 ** reconnectAttempts); // 1s, 2s, 4s, 8s, 16s, 30s
    reconnectTimer = setTimeout(() => connect(code), delay);
  };

  ws.onerror = () => {
    // Close *this* socket only — never reach for the module variable here,
    // which may already point to a newer socket for a different canvas.
    try { ws.close(); } catch { /* already closed */ }
  };
}

export function sendOp(op: WSClientMessage) {
  if (MOCK_ENABLED) {
    mockSendOp(op);
    return;
  }
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(op));
    return;
  }
  if (outboundQueue.length >= QUEUE_MAX) {
    console.warn("[ws] outbound queue full, dropping oldest op");
    outboundQueue.shift();
  }
  outboundQueue.push(op);
}
