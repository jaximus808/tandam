import type { Gateway } from "./gateway.js";

type Args = Record<string, unknown>;

export async function handleTool(
  gateway: Gateway,
  toolName: string,
  args: Args
): Promise<unknown> {
  switch (toolName) {
    // ── Connection ─────────────────────────────────────────────────────────────
    case "canvas.connect": {
      const code = args.code;
      if (typeof code !== "string" || !code.trim()) {
        throw new Error("`code` (string) is required");
      }
      const session = await gateway.connectWithCode(code.trim());
      return {
        connected: true,
        canvasId: session.canvasId,
        canvasName: session.canvasName,
        canvasCode: session.canvasCode,
      };
    }

    // ── State ──────────────────────────────────────────────────────────────────
    case "canvas.state.read":
      return gateway.get("/api/canvas/state");

    // ── Mode ───────────────────────────────────────────────────────────────────
    case "canvas.mode.set":
      return gateway.post("/api/canvas/mode", { mode: args.mode });

    // ── Map ────────────────────────────────────────────────────────────────────
    case "canvas.map.list":
      return gateway.getPublic("/api/maps");

    case "canvas.map.set":
      // Implicit: switching map also switches mode to "map" (per §10 in DESIGN_PHASE3.md).
      return gateway.post("/api/canvas/template", {
        templateId: `map-${args.mapId}`,
        mode: "map",
        mapId: args.mapId,
      });

    // ── Pins ───────────────────────────────────────────────────────────────────
    case "canvas.pin.add":
      return gateway.post("/api/canvas/pins", {
        pinType: args.pinType ?? "marker",
        lat: args.lat,
        lng: args.lng,
        label: args.label,
        body: args.body,
        color: args.color,
        createdBy: "agent",
      });

    case "canvas.pin.update": {
      const { id, ...partial } = args;
      return gateway.patch(`/api/canvas/pins/${id}`, partial);
    }

    case "canvas.pin.delete":
      return gateway.del(`/api/canvas/pins/${args.id}`);

    // ── Events ─────────────────────────────────────────────────────────────────
    case "canvas.event.add":
      return gateway.post("/api/canvas/events", {
        title: args.title,
        start: args.start,
        end: args.end,
        pinId: args.pinId,
        createdBy: "agent",
      });

    case "canvas.event.update": {
      const { id, ...partial } = args;
      return gateway.patch(`/api/canvas/events/${id}`, partial);
    }

    case "canvas.event.delete":
      return gateway.del(`/api/canvas/events/${args.id}`);

    // ── Notes ──────────────────────────────────────────────────────────────────
    case "canvas.note.add":
      return gateway.post("/api/canvas/notes", {
        body: args.body,
        imageRefs: args.imageRefs ?? [],
        parentId: args.parentId,
        parentKind: args.parentKind,
        createdBy: "agent",
      });

    case "canvas.note.update": {
      const { id, ...partial } = args;
      return gateway.patch(`/api/canvas/notes/${id}`, partial);
    }

    case "canvas.note.delete":
      return gateway.del(`/api/canvas/notes/${args.id}`);

    // ── Pending edits ──────────────────────────────────────────────────────────
    case "canvas.pending_edits.read":
      return gateway.get("/api/canvas/state").then((s: any) => ({
        pendingEdits: s.pendingEdits,
      }));

    case "canvas.pending_edits.complete":
      return gateway.del(`/api/canvas/pending-edits/${args.editId}`);

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

export const TOOLS = [
  {
    name: "canvas.connect",
    description:
      "Bind this MCP session to a canvas. MUST be called before any other canvas.* tool. " +
      "Takes a canvas code (e.g. 'TOKYO7X3K'). Exchanges it for a JWT held in this gateway " +
      "process; from then on, every other tool operates on that canvas with no ID needed. " +
      "May be called again to switch the session to a different canvas.",
    inputSchema: {
      type: "object" as const,
      properties: { code: { type: "string", description: "Canvas code given by the user." } },
      required: ["code"],
    },
  },
  {
    name: "canvas.state.read",
    description:
      "Read the active canvas state. Call this at the start of every canvas-related turn. " +
      "Returns activeCanvasName, activeCanvasId, state (pins/events/notes), and pendingEdits. " +
      "Requires canvas.connect to have been called first.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "canvas.mode.set",
    description:
      "Set the canvas display mode. 'welcome' returns to the template picker; " +
      "'map', 'itinerary', and 'docs' switch the active view.",
    inputSchema: {
      type: "object" as const,
      properties: { mode: { type: "string", enum: ["welcome", "map", "itinerary", "docs"] } },
      required: ["mode"],
    },
  },
  {
    name: "canvas.map.list",
    description:
      "List the available base map presets (world, us, tokyo, japan, etc). " +
      "Use the returned ids with canvas.map.set.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "canvas.map.set",
    description:
      "Switch the base map to a registered preset (e.g. 'world', 'us', 'tokyo'). " +
      "Also switches the canvas into map mode. Call canvas.map.list to enumerate options.",
    inputSchema: {
      type: "object" as const,
      properties: { mapId: { type: "string", description: "Preset id from canvas.map.list" } },
      required: ["mapId"],
    },
  },
  {
    name: "canvas.pin.add",
    description: "Add a location pin to the canvas map.",
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
    inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "canvas.event.add",
    description: "Add a timed event. Link to a pin via pinId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601, e.g. 2024-06-01T18:00:00Z" },
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
    inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "canvas.note.add",
    description: "Add a markdown note. Attach to a Pin or Event via parentId + parentKind.",
    inputSchema: {
      type: "object" as const,
      properties: {
        body: { type: "string" },
        parentId: { type: "string" },
        parentKind: { type: "string", enum: ["pin", "event"] },
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
        parentKind: { type: "string", enum: ["pin", "event"] },
        imageRefs: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
    },
  },
  {
    name: "canvas.note.delete",
    description: "Delete a note by its ID.",
    inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "canvas.pending_edits.read",
    description: "Read pending scoped edit requests from the browser UI.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "canvas.pending_edits.complete",
    description: "Mark a pending edit as done after applying it.",
    inputSchema: {
      type: "object" as const,
      properties: { editId: { type: "string" } },
      required: ["editId"],
    },
  },
];
