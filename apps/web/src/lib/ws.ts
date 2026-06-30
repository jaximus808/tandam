import type { CanvasMeta, CanvasState, PendingEdit, WSClientMessage } from "../types";
import { MOCK_ENABLED } from "./mockFixture";
import { mockConnect, mockOnStateUpdate, mockSendOp } from "./mockWS";

export type ChangeActor = "agent" | "user";
type StateHandler = (
  canvas: CanvasMeta,
  canvases: CanvasMeta[],
  state: CanvasState,
  pendingEdits: PendingEdit[],
  lastChangeBy?: ChangeActor,
) => void;

let socket: WebSocket | null = null;
let handlers: StateHandler[] = [];
// When the connected human has only read access, every outbound op is muted
// here — one choke point instead of threading a prop through every mode. This
// mirrors the server's WS write gate; the server is the real enforcement, this
// just keeps the UI honest (no silently-dropped edits looking like they saved).
let readOnly = false;
export function setCanvasReadOnly(v: boolean) {
  readOnly = v;
}
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

// Stateless agent-presence pulses (e.g. "an agent just read the canvas"),
// separate from the heavyweight state stream so the UI can animate live
// activity without a full re-render. Not wired through the mock backend.
export type AgentActivity = { action: "read" };
type ActivityHandler = (a: AgentActivity) => void;
let activityHandlers: ActivityHandler[] = [];

export function onAgentActivity(fn: ActivityHandler): () => void {
  activityHandlers.push(fn);
  return () => {
    activityHandlers = activityHandlers.filter((h) => h !== fn);
  };
}

// Access outcome for a canvas we can't open (or were just kicked from). A failed
// WS upgrade is invisible to the browser (close 1006, no status), so we probe
// HTTP to learn the real reason and surface a proper screen instead of an
// endless "Joining" spinner. null = cleared (access is fine again).
export type AccessStatus = { kind: "forbidden" | "notFound"; message: string };
let accessErrorHandlers: ((s: AccessStatus | null) => void)[] = [];
export function onAccessError(fn: (s: AccessStatus | null) => void): () => void {
  accessErrorHandlers.push(fn);
  return () => {
    accessErrorHandlers = accessErrorHandlers.filter((h) => h !== fn);
  };
}
function emitAccessError(s: AccessStatus | null) {
  accessErrorHandlers.forEach((h) => h(s));
}

// Live role changes pushed by the server when an owner edits sharing while we're
// connected (e.g. view→edit), so the board flips its read-only state without a
// reconnect. A revoke (role "none") goes through onAccessError instead.
type RoleHandler = (role: "write" | "read") => void;
let roleHandlers: RoleHandler[] = [];
export function onRoleChange(fn: RoleHandler): () => void {
  roleHandlers.push(fn);
  return () => {
    roleHandlers = roleHandlers.filter((h) => h !== fn);
  };
}

// Pull the {error} message out of a probe response (or fall back).
async function errMessage(res: Response, fallback: string): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    return j.error || fallback;
  } catch {
    return fallback;
  }
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
  readOnly = false; // fresh canvas — don't carry a prior board's read-only gate
  emitAccessError(null); // clear any denial from a previous canvas
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
  // Did this socket ever open? A close *before* opening means the upgrade was
  // refused — which for a private canvas is a 403 the WebSocket API hides from
  // us. We probe HTTP in that case to tell "access denied" from "network blip".
  let opened = false;

  ws.onopen = () => {
    opened = true;
    emitAccessError(null); // we got in — clear any stale denial
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
            msg.pendingEdits as PendingEdit[],
            msg.lastChangeBy as ChangeActor | undefined
          )
        );
      } else if (msg.type === "activity") {
        activityHandlers.forEach((h) => h({ action: msg.action as "read" }));
      } else if (msg.type === "access") {
        // The owner changed sharing while we're connected.
        const role = msg.role as "write" | "read" | "none";
        if (role === "none") {
          // Revoked live — tear down and show the access screen.
          emitAccessError({
            kind: "forbidden",
            message: "Your access to this canvas was removed by the owner.",
          });
          disconnectFromCanvas();
        } else {
          readOnly = role === "read";
          roleHandlers.forEach((h) => h(role));
        }
      }
    } catch {
      // ignore malformed messages
    }
  };

  ws.onclose = () => {
    // Only react if this socket is still the *current* one and the user hasn't
    // navigated away.
    if (ws !== socket || currentCode !== code) return;
    if (!opened) {
      // Never connected: could be access-denied (a 403 the WS hid) or a transient
      // failure. Probe HTTP to decide whether to surface a screen or keep retrying.
      void diagnoseFailedConnect(code);
      return;
    }
    scheduleReconnect(code);
  };

  ws.onerror = () => {
    // Close *this* socket only — never reach for the module variable here,
    // which may already point to a newer socket for a different canvas.
    try { ws.close(); } catch { /* already closed */ }
  };
}

function scheduleReconnect(code: string) {
  if (currentCode !== code) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn(`[ws] giving up after ${reconnectAttempts} reconnect attempts for ${code}`);
    return;
  }
  reconnectAttempts++;
  const delay = Math.min(30_000, 500 * 2 ** reconnectAttempts); // 1s, 2s, 4s, 8s, 16s, 30s
  reconnectTimer = setTimeout(() => connect(code), delay);
}

// A WS upgrade that closed before opening tells us nothing (close 1006). Probe
// the cookie-aware HTTP auth endpoint — which runs the same access resolver — to
// learn the real reason: 403 → private/no access (show the screen, stop
// retrying); 404 → no such canvas; anything else → access is fine, so the WS
// failure was transient and we keep reconnecting.
async function diagnoseFailedConnect(code: string) {
  try {
    const res = await fetch("/api/mcp/auth", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (currentCode !== code) return; // navigated away mid-probe
    if (res.status === 403) {
      emitAccessError({
        kind: "forbidden",
        message: await errMessage(res, "You don't have access to this canvas."),
      });
      return; // stop retrying — the user must sign in or ask the owner
    }
    if (res.status === 404) {
      emitAccessError({ kind: "notFound", message: "That canvas doesn't exist." });
      return;
    }
    // Access is fine — the WS drop was transient. Resume the backoff loop.
    scheduleReconnect(code);
  } catch {
    // Network error reaching the probe too — treat as transient and keep trying.
    if (currentCode === code) scheduleReconnect(code);
  }
}

export function sendOp(op: WSClientMessage) {
  if (readOnly) return; // read-only viewer: drop the write (server would reject it too)
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
