import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CanvasMode } from "@agentcanvas/shared";
import { newId } from "./entities.js";
import * as state from "./state.js";

const TOOLS = [
  // ── canvas management ───────────────────────────────────────────────────────
  {
    name: "canvas.list",
    description:
      "List all canvases and which one is currently active. " +
      "The active canvas is sticky — it persists until you explicitly call canvas.select or canvas.create. " +
      "You do NOT need to pass a canvas id to content tools (pin.add, event.add, etc.) — they always operate on the active canvas implicitly.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "canvas.create",
    description:
      "Create a new named canvas and make it the active canvas. " +
      "After this call, all content tools (pin.add, event.add, note.add, etc.) automatically target this new canvas — no canvas id needed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Human-readable name, e.g. 'Tokyo Trip' or 'Mac Migration'" },
      },
      required: ["name"],
    },
  },
  {
    name: "canvas.select",
    description:
      "Switch the active canvas by id. " +
      "Once selected, every content tool call (pin, event, note, mode) targets this canvas automatically — you do not need to re-select it on each turn or pass the id anywhere else.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "canvas.rename",
    description: "Rename a canvas.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        name: { type: "string" },
      },
      required: ["id", "name"],
    },
  },
  {
    name: "canvas.delete",
    description: "Permanently delete a canvas and all its data. Cannot delete the last canvas.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  // ── canvas content ──────────────────────────────────────────────────────────
  {
    name: "canvas.state.read",
    description:
      "Read the active canvas state (pins, events, notes, pending edits). Call this at the start of every canvas-related turn to pick up user edits made since you last looked.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "canvas.mode.set",
    description: "Set the active canvas display mode (map, itinerary, or docs).",
    inputSchema: {
      type: "object" as const,
      properties: { mode: { type: "string", enum: ["map", "itinerary", "docs"] } },
      required: ["mode"],
    },
  },
  {
    name: "canvas.pin.add",
    description: "Add a location pin to the active canvas map.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pinType: { type: "string", enum: ["marker", "annotation"] },
        lat: { type: "number" },
        lng: { type: "number" },
        label: { type: "string" },
        body: { type: "string" },
        color: { type: "string" },
      },
      required: ["pinType", "lat", "lng"],
    },
  },
  {
    name: "canvas.pin.update",
    description: "Update an existing pin by its ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        pinType: { type: "string", enum: ["marker", "annotation"] },
        lat: { type: "number" },
        lng: { type: "number" },
        label: { type: "string" },
        body: { type: "string" },
        color: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "canvas.pin.delete",
    description: "Delete a pin by its ID.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "canvas.event.add",
    description: "Add a timed event to the active canvas. Link it to a pin via pinId to show a badge on the map.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601 datetime, e.g. 2024-06-01T18:00:00" },
        end: { type: "string" },
        pinId: { type: "string" },
      },
      required: ["title", "start"],
    },
  },
  {
    name: "canvas.event.update",
    description: "Update an existing event by its ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        pinId: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "canvas.event.delete",
    description: "Delete an event by its ID.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "canvas.note.add",
    description: "Add a markdown note to the active canvas. Attach it to a Pin or Event via parentId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        body: { type: "string", description: "Markdown content" },
        parentId: { type: "string", description: "Optional Pin or Event ID to attach this note to" },
        imageRefs: { type: "array", items: { type: "string" } },
      },
      required: ["body"],
    },
  },
  {
    name: "canvas.note.update",
    description: "Update an existing note by its ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        body: { type: "string" },
        parentId: { type: "string" },
        imageRefs: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
    },
  },
  {
    name: "canvas.note.delete",
    description: "Delete a note by its ID.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "canvas.pending_edits.read",
    description: "Read pending scoped edit requests submitted via the browser UI.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "canvas.pending_edits.complete",
    description: "Mark a pending edit as done after you have applied it.",
    inputSchema: {
      type: "object" as const,
      properties: { editId: { type: "string" } },
      required: ["editId"],
    },
  },
];

function stateResult() {
  const canvas = state.getActiveCanvasMeta();
  return {
    activeCanvasId: canvas.id,
    activeCanvasName: canvas.name,
    state: state.getState(),
    pendingEdits: state.getPendingEdits(),
    _note: "All content tools (pin, event, note, mode) operate on the active canvas above. No canvas id needed.",
  };
}

export async function startMcp() {
  const server = new Server(
    { name: "agentcanvas", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    try {
      let result: unknown;

      switch (name) {
        // ── canvas management ─────────────────────────────────────────────────
        case "canvas.list":
          result = { activeId: state.getActiveId(), canvases: state.listCanvases() };
          break;

        case "canvas.create":
          result = { canvas: state.createCanvas(a.name as string), state: state.getState() };
          break;

        case "canvas.select":
          result = { canvas: state.selectCanvas(a.id as string), state: state.getState() };
          break;

        case "canvas.rename":
          result = { canvas: state.renameCanvas(a.id as string, a.name as string) };
          break;

        case "canvas.delete":
          state.deleteCanvas(a.id as string);
          result = { ok: true, activeId: state.getActiveId(), canvases: state.listCanvases() };
          break;

        // ── canvas content ────────────────────────────────────────────────────
        case "canvas.state.read":
          result = stateResult();
          break;

        case "canvas.mode.set":
          result = { state: state.setMode(a.mode as CanvasMode) };
          break;

        case "canvas.pin.add": {
          const id = newId();
          result = {
            id,
            state: state.addPin({
              id,
              pinType: a.pinType as "marker" | "annotation",
              lat: a.lat as number,
              lng: a.lng as number,
              ...(a.label != null && { label: a.label as string }),
              ...(a.body != null && { body: a.body as string }),
              ...(a.color != null && { color: a.color as string }),
              createdBy: "agent",
            }),
          };
          break;
        }

        case "canvas.pin.update": {
          const { id, ...partial } = a;
          result = { id, state: state.updatePin(id as string, partial as Parameters<typeof state.updatePin>[1]) };
          break;
        }

        case "canvas.pin.delete":
          result = { state: state.deletePin(a.id as string) };
          break;

        case "canvas.event.add": {
          const id = newId();
          result = {
            id,
            state: state.addEvent({
              id,
              title: a.title as string,
              start: a.start as string,
              ...(a.end != null && { end: a.end as string }),
              ...(a.pinId != null && { pinId: a.pinId as string }),
              createdBy: "agent",
            }),
          };
          break;
        }

        case "canvas.event.update": {
          const { id, ...partial } = a;
          result = { id, state: state.updateEvent(id as string, partial as Parameters<typeof state.updateEvent>[1]) };
          break;
        }

        case "canvas.event.delete":
          result = { state: state.deleteEvent(a.id as string) };
          break;

        case "canvas.note.add": {
          const id = newId();
          result = {
            id,
            state: state.addNote({
              id,
              body: a.body as string,
              imageRefs: (a.imageRefs as string[]) ?? [],
              ...(a.parentId != null && { parentId: a.parentId as string }),
              createdBy: "agent",
            }),
          };
          break;
        }

        case "canvas.note.update": {
          const { id, ...partial } = a;
          result = { id, state: state.updateNote(id as string, partial as Parameters<typeof state.updateNote>[1]) };
          break;
        }

        case "canvas.note.delete":
          result = { state: state.deleteNote(a.id as string) };
          break;

        case "canvas.pending_edits.read":
          result = { pendingEdits: state.getPendingEdits() };
          break;

        case "canvas.pending_edits.complete":
          state.completePendingEdit(a.editId as string);
          result = { ok: true };
          break;

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: String(err) }) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
