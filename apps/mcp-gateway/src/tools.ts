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
        fromPinId: args.fromPinId,
        toPinId: args.toPinId,
        travelMode: args.travelMode,
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

    // ── Roadmap items ──────────────────────────────────────────────────────────
    case "canvas.roadmap_item.add":
      return gateway.post("/api/canvas/roadmap-items", {
        parentId: args.parentId,
        title: args.title,
        body: args.body ?? "",
        status: args.status ?? "todo",
        sortOrder: args.sortOrder ?? 0,
        createdBy: "agent",
      });

    case "canvas.roadmap_item.update": {
      const { id, ...partial } = args;
      return gateway.patch(`/api/canvas/roadmap-items/${id}`, partial);
    }

    case "canvas.roadmap_item.delete":
      return gateway.del(`/api/canvas/roadmap-items/${args.id}`);

    // ── Sheets ─────────────────────────────────────────────────────────────────
    case "canvas.sheet.add":
      return gateway.post("/api/canvas/sheets", {
        name: args.name,
        columns: args.columns,
        sortOrder: args.sortOrder ?? 0,
        createdBy: "agent",
      });

    case "canvas.sheet.update": {
      const { id, ...partial } = args;
      return gateway.patch(`/api/canvas/sheets/${id}`, partial);
    }

    case "canvas.sheet.delete":
      return gateway.del(`/api/canvas/sheets/${args.id}`);

    case "canvas.sheet.column.add":
      return gateway.post(`/api/canvas/sheets/${args.sheetId}/columns`, {
        name: args.name,
        type: args.type,
        sortOrder: args.sortOrder ?? 0,
      });

    case "canvas.sheet.column.update": {
      const { sheetId, columnId, ...partial } = args;
      return gateway.patch(`/api/canvas/sheets/${sheetId}/columns/${columnId}`, partial);
    }

    case "canvas.sheet.column.delete":
      return gateway.del(`/api/canvas/sheets/${args.sheetId}/columns/${args.columnId}`);

    case "canvas.sheet.row.add":
      return gateway.post("/api/canvas/sheet-rows", {
        sheetId: args.sheetId,
        data: args.data ?? {},
        sortOrder: args.sortOrder ?? 0,
        createdBy: "agent",
      });

    case "canvas.sheet.row.update": {
      const { id, ...partial } = args;
      return gateway.patch(`/api/canvas/sheet-rows/${id}`, partial);
    }

    case "canvas.sheet.row.delete":
      return gateway.del(`/api/canvas/sheet-rows/${args.id}`);

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
      properties: { mode: { type: "string", enum: ["welcome", "map", "itinerary", "docs", "roadmap", "sheets"] } },
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
    description:
      "Add a timed event. Two flavors:\n" +
      "  • Point-in-time event at a single location: set pinId.\n" +
      "  • Travel segment between two pins (flight/train/drive): set " +
      "fromPinId + toPinId + travelMode TOGETHER. The map will draw a " +
      "polyline between the two pins with a mode icon at the midpoint, " +
      "and the itinerary will show the card as 'A → B'. Use end for the " +
      "arrival time on travel events.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601, e.g. 2024-06-01T18:00:00Z" },
        end: { type: "string", description: "ISO 8601 end / arrival time." },
        pinId: { type: "string", description: "Pin this event takes place at (point-in-time events only)." },
        fromPinId: { type: "string", description: "Origin pin for a travel segment." },
        toPinId: { type: "string", description: "Destination pin for a travel segment." },
        travelMode: {
          type: "string",
          enum: ["flight", "train", "drive"],
          description: "Travel mode. Required when fromPinId/toPinId are set.",
        },
      },
      required: ["title", "start"],
    },
  },
  {
    name: "canvas.event.update",
    description:
      "Update an existing event by its ID. To convert a point-in-time event " +
      "into a travel segment, set fromPinId + toPinId + travelMode.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        pinId: { type: "string" },
        fromPinId: { type: "string" },
        toPinId: { type: "string" },
        travelMode: { type: "string", enum: ["flight", "train", "drive"] },
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
    name: "canvas.roadmap_item.add",
    description:
      "Add a roadmap item (goal / sub-goal / task) to the planning outline. " +
      "Pass parentId to nest under another item, or omit for a top-level entry. " +
      "Also switches the canvas into roadmap mode if it was on the welcome screen.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string" },
        parentId: { type: "string", description: "Parent roadmap item ID for nesting." },
        body: { type: "string", description: "Optional longer description." },
        status: { type: "string", enum: ["todo", "in_progress", "done", "blocked"] },
        sortOrder: { type: "number", description: "Position among siblings; higher = later." },
      },
      required: ["title"],
    },
  },
  {
    name: "canvas.roadmap_item.update",
    description: "Update a roadmap item by its ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        parentId: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        status: { type: "string", enum: ["todo", "in_progress", "done", "blocked"] },
        sortOrder: { type: "number" },
      },
      required: ["id"],
    },
  },
  {
    name: "canvas.roadmap_item.delete",
    description: "Delete a roadmap item by its ID. Children are deleted via cascade.",
    inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "canvas.sheet.add",
    description:
      "Create a new sheet (spreadsheet) on the canvas. A canvas can have multiple sheets — " +
      "they appear as tabs at the top of the sheets view. Pass `columns` to seed the schema " +
      "(each column needs `name` and `type` ∈ text|number|date|checkbox). Also switches the " +
      "canvas into sheets mode if it was on welcome.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        columns: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", enum: ["text", "number", "date", "checkbox"] },
              sortOrder: { type: "number" },
            },
            required: ["name", "type"],
          },
        },
        sortOrder: { type: "number" },
      },
      required: ["name"],
    },
  },
  {
    name: "canvas.sheet.update",
    description: "Rename or reorder a sheet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        sortOrder: { type: "number" },
      },
      required: ["id"],
    },
  },
  {
    name: "canvas.sheet.delete",
    description: "Delete a sheet and all its rows.",
    inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "canvas.sheet.column.add",
    description:
      "Add a column to an existing sheet. Column types: text | number | date | checkbox. " +
      "Dates are ISO-8601 'YYYY-MM-DD' strings.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sheetId: { type: "string" },
        name: { type: "string" },
        type: { type: "string", enum: ["text", "number", "date", "checkbox"] },
        sortOrder: { type: "number" },
      },
      required: ["sheetId", "name", "type"],
    },
  },
  {
    name: "canvas.sheet.column.update",
    description: "Rename a column, change its type, or reorder it within the sheet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sheetId: { type: "string" },
        columnId: { type: "string" },
        name: { type: "string" },
        type: { type: "string", enum: ["text", "number", "date", "checkbox"] },
        sortOrder: { type: "number" },
      },
      required: ["sheetId", "columnId"],
    },
  },
  {
    name: "canvas.sheet.column.delete",
    description:
      "Delete a column from a sheet. Also strips that column's data from every row " +
      "(non-reversible — the cell values are gone).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sheetId: { type: "string" },
        columnId: { type: "string" },
      },
      required: ["sheetId", "columnId"],
    },
  },
  {
    name: "canvas.sheet.row.add",
    description:
      "Add a row to a sheet. `data` is an object keyed by column.id with cell values " +
      "(strings for text/date, numbers for number, booleans for checkbox).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sheetId: { type: "string" },
        data: { type: "object" },
        sortOrder: { type: "number" },
      },
      required: ["sheetId"],
    },
  },
  {
    name: "canvas.sheet.row.update",
    description:
      "Update a row by ID. `data` is merged into the existing row data — keys not present " +
      "are left untouched; setting a key to null clears that cell.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        data: { type: "object" },
        sortOrder: { type: "number" },
      },
      required: ["id"],
    },
  },
  {
    name: "canvas.sheet.row.delete",
    description: "Delete a sheet row by its ID.",
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
