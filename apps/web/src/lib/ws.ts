import type { CanvasMeta, CanvasState, PendingEdit, WSClientMessage } from "../types";

type StateHandler = (canvas: CanvasMeta, canvases: CanvasMeta[], state: CanvasState, pendingEdits: PendingEdit[]) => void;

let socket: WebSocket | null = null;
let handlers: StateHandler[] = [];
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let currentCode: string | null = null;

export function onStateUpdate(fn: StateHandler): () => void {
  handlers.push(fn);
  return () => {
    handlers = handlers.filter((h) => h !== fn);
  };
}

export function connectToCanvas(code: string) {
  if (currentCode === code && socket?.readyState === WebSocket.OPEN) return;
  currentCode = code;
  if (socket) {
    socket.onclose = null; // prevent reconnect loop
    socket.close();
  }
  connect(code);
}

function connect(code: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/ws?code=${encodeURIComponent(code)}`;
  socket = new WebSocket(url);

  socket.onopen = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  socket.onmessage = (e: MessageEvent) => {
    try {
      const msg = JSON.parse(e.data as string);
      if (msg.type === "state") {
        // Go API returns a single canvas, no canvases list — pass empty array for compat
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

  socket.onclose = () => {
    reconnectTimer = setTimeout(() => connect(code), 2000);
  };

  socket.onerror = () => {
    socket?.close();
  };
}

export function sendOp(op: WSClientMessage) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(op));
  }
}
