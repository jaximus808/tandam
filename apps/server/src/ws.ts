import type { FastifyInstance } from "fastify";
import type { SocketStream } from "@fastify/websocket";
import type { WebSocket } from "ws";
import type { CanvasMeta, CanvasState, PendingEdit, WSClientMessage } from "@agentcanvas/shared";
import { newId } from "./entities.js";
import * as state from "./state.js";

const clients = new Set<WebSocket>();

export function broadcast(canvas: CanvasMeta, canvases: CanvasMeta[], canvasState: CanvasState, pendingEdits: PendingEdit[]) {
  const msg = JSON.stringify({ type: "state", canvas, canvases, state: canvasState, pendingEdits });
  for (const client of clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

export function registerWs(fastify: FastifyInstance) {
  fastify.get("/ws", { websocket: true }, (connection: SocketStream) => {
    const socket = connection.socket;
    clients.add(socket);

    socket.send(JSON.stringify({
      type: "state",
      canvas: state.getActiveCanvasMeta(),
      canvases: state.listCanvases(),
      state: state.getState(),
      pendingEdits: state.getPendingEdits(),
    }));

    socket.on("message", (raw: Buffer) => {
      let msg: WSClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      try {
        switch (msg.op) {
          case "mode.set":
            state.setMode(msg.mode);
            break;

          case "pin.add":
            state.addPin({ id: newId(), ...msg.data, createdBy: "user" });
            break;
          case "pin.update":
            state.updatePin(msg.id, msg.partial);
            break;
          case "pin.delete":
            state.deletePin(msg.id);
            break;

          case "event.add":
            state.addEvent({ id: newId(), ...msg.data, createdBy: "user" });
            break;
          case "event.update":
            state.updateEvent(msg.id, msg.partial);
            break;
          case "event.delete":
            state.deleteEvent(msg.id);
            break;

          case "note.add":
            state.addNote({ id: newId(), ...msg.data, createdBy: "user" });
            break;
          case "note.update":
            state.updateNote(msg.id, msg.partial);
            break;
          case "note.delete":
            state.deleteNote(msg.id);
            break;

          case "scoped_edit_request":
            state.addPendingEdit(msg.entityId, msg.instruction);
            break;
        }
      } catch (err) {
        socket.send(JSON.stringify({ type: "error", message: String(err) }));
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
    });
  });
}
