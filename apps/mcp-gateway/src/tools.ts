import type { Gateway } from "./gateway.js";

type Args = Record<string, unknown>;

export async function handleTool(
  gateway: Gateway,
  toolName: string,
  args: Args
): Promise<unknown> {
  // Backwards compat: tools are now advertised with underscore names
  // (canvas_connect) because the old dotted form (canvas.connect) is invalid
  // under Anthropic's tool-name rules and gets dropped by the Claude.ai web
  // connector. Old clients / saved prompts may still call the dotted names, so
  // normalize the incoming name before routing.
  toolName = toolName.replace(/\./g, "_");

  switch (toolName) {
    // ── Connection ─────────────────────────────────────────────────────────────
    case "canvas_connect": {
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
        url: gateway.canvasUrl(session.canvasCode),
      };
    }

    case "canvas_create": {
      const rawName = typeof args.name === "string" ? args.name.trim() : "";
      const name = rawName || "Untitled canvas";
      const session = await gateway.createCanvas(name);
      const result: Record<string, unknown> = {
        created: true,
        canvasId: session.canvasId,
        canvasName: session.canvasName,
        canvasCode: session.canvasCode,
        // Ownership-free view/share link — safe to give anyone.
        url: gateway.canvasUrl(session.canvasCode),
      };
      // For an anonymous create, also surface the PRIVATE claim link so the user
      // can take ownership. Keep the two links distinct in what you tell the user.
      if (session.claimToken) {
        result.claimUrl = gateway.canvasClaimUrl(session.canvasCode, session.claimToken);
        result.claimHint =
          "Give `claimUrl` to the user privately and tell them to open it (signing in if needed) " +
          "to claim this canvas as their own — it'll then show up in their account and stays the " +
          "exact canvas you're editing. Use `url` for sharing/viewing only; it does not grant ownership.";
      }
      return result;
    }

    // ── State ──────────────────────────────────────────────────────────────────
    case "canvas_state_read":
      return gateway.get("/api/canvas/state");

    // ── Mode ───────────────────────────────────────────────────────────────────
    case "canvas_mode_set":
      return gateway.post("/api/canvas/mode", { mode: args.mode });

    // ── Map ────────────────────────────────────────────────────────────────────
    case "canvas_map_list":
      return gateway.getPublic("/api/maps");

    case "canvas_map_set":
      // Implicit: switching map also switches mode to "map" (per §10 in DESIGN_PHASE3.md).
      return gateway.post("/api/canvas/template", {
        templateId: `map-${args.mapId}`,
        mode: "map",
        mapId: args.mapId,
      });

    // ── Pins ───────────────────────────────────────────────────────────────────
    case "canvas_pin_add":
      return gateway.post("/api/canvas/pins", {
        pinType: args.pinType ?? "marker",
        lat: args.lat,
        lng: args.lng,
        label: args.label,
        body: args.body,
        color: args.color,
        createdBy: "agent",
      });

    case "canvas_pin_update": {
      const { id, ...partial } = args;
      return gateway.patch(`/api/canvas/pins/${id}`, partial);
    }

    case "canvas_pin_delete":
      return gateway.del(`/api/canvas/pins/${args.id}`);

    // ── Events ─────────────────────────────────────────────────────────────────
    case "canvas_event_add":
      return gateway.post("/api/canvas/events", {
        title: args.title,
        start: args.start,
        end: args.end,
        timezone: args.timezone,
        pinIds: args.pinIds,
        pinId: args.pinId,
        fromPinId: args.fromPinId,
        toPinId: args.toPinId,
        travelMode: args.travelMode,
        dayTag: args.dayTag,
        cost: args.cost,
        createdBy: "agent",
      });

    case "canvas_event_update": {
      const { id, ...partial } = args;
      return gateway.patch(`/api/canvas/events/${id}`, partial);
    }

    case "canvas_event_delete":
      return gateway.del(`/api/canvas/events/${args.id}`);

    // ── Notes ──────────────────────────────────────────────────────────────────
    case "canvas_note_add":
      return gateway.post("/api/canvas/notes", {
        body: args.body,
        imageRefs: args.imageRefs ?? [],
        parentId: args.parentId,
        parentKind: args.parentKind,
        createdBy: "agent",
      });

    case "canvas_note_update": {
      const { id, ...partial } = args;
      return gateway.patch(`/api/canvas/notes/${id}`, partial);
    }

    case "canvas_note_delete":
      return gateway.del(`/api/canvas/notes/${args.id}`);

    // ── Roadmap items ──────────────────────────────────────────────────────────
    case "canvas_roadmap_item_add":
      return gateway.post("/api/canvas/roadmap-items", {
        parentId: args.parentId,
        title: args.title,
        body: args.body ?? "",
        status: args.status ?? "todo",
        stage: args.stage,
        sortOrder: args.sortOrder ?? 0,
        createdBy: "agent",
      });

    case "canvas_roadmap_item_update": {
      const { id, ...partial } = args;
      return gateway.patch(`/api/canvas/roadmap-items/${id}`, partial);
    }

    case "canvas_roadmap_item_delete":
      return gateway.del(`/api/canvas/roadmap-items/${args.id}`);

    // ── Sheets ─────────────────────────────────────────────────────────────────
    case "canvas_sheet_add":
      return gateway.post("/api/canvas/sheets", {
        name: args.name,
        columns: args.columns,
        sortOrder: args.sortOrder ?? 0,
        createdBy: "agent",
      });

    case "canvas_sheet_update": {
      const { id, ...partial } = args;
      return gateway.patch(`/api/canvas/sheets/${id}`, partial);
    }

    case "canvas_sheet_delete":
      return gateway.del(`/api/canvas/sheets/${args.id}`);

    case "canvas_sheet_column_add":
      return gateway.post(`/api/canvas/sheets/${args.sheetId}/columns`, {
        name: args.name,
        type: args.type,
        sortOrder: args.sortOrder ?? 0,
      });

    case "canvas_sheet_column_update": {
      const { sheetId, columnId, ...partial } = args;
      return gateway.patch(`/api/canvas/sheets/${sheetId}/columns/${columnId}`, partial);
    }

    case "canvas_sheet_column_delete":
      return gateway.del(`/api/canvas/sheets/${args.sheetId}/columns/${args.columnId}`);

    case "canvas_sheet_row_add":
      return gateway.post("/api/canvas/sheet-rows", {
        sheetId: args.sheetId,
        data: args.data ?? {},
        sortOrder: args.sortOrder ?? 0,
        createdBy: "agent",
      });

    case "canvas_sheet_row_update": {
      const { id, ...partial } = args;
      return gateway.patch(`/api/canvas/sheet-rows/${id}`, partial);
    }

    case "canvas_sheet_row_delete":
      return gateway.del(`/api/canvas/sheet-rows/${args.id}`);

    // ── Charts ─────────────────────────────────────────────────────────────────
    case "canvas_chart_add":
      return gateway.post("/api/canvas/charts", {
        name: args.name,
        sheetId: args.sheetId,
        chartType: args.chartType,
        xColumn: args.xColumn,
        yColumns: args.yColumns,
        sortOrder: args.sortOrder ?? 0,
        createdBy: "agent",
      });

    case "canvas_chart_update": {
      const { id, ...partial } = args;
      return gateway.patch(`/api/canvas/charts/${id}`, partial);
    }

    case "canvas_chart_delete":
      return gateway.del(`/api/canvas/charts/${args.id}`);

    // ── Forms (direct-input layer) ───────────────────────────────────────────────
    case "canvas_form_scaffold":
      return gateway.post("/api/canvas/forms/scaffold", { sheet: args.sheet });

    case "canvas_form_define":
      return gateway.post("/api/canvas/forms", {
        name: args.name,
        description: args.description,
        fields: args.fields,
        writes: args.writes,
      });

    case "canvas_form_update": {
      const { id, ...intent } = args;
      return gateway.patch(`/api/canvas/forms/${id}`, intent);
    }

    case "canvas_form_delete":
      return gateway.del(`/api/canvas/forms/${args.id}`);

    // ── Pending edits ──────────────────────────────────────────────────────────
    case "canvas_pending_edits_read":
      return gateway.get("/api/canvas/state").then((s: any) => ({
        pendingEdits: s.pendingEdits,
      }));

    case "canvas_pending_edits_complete":
      return gateway.del(`/api/canvas/pending-edits/${args.editId}`);

    // ── Agents (v1 identity / provenance) ───────────────────────────────────────
    case "agent_register": {
      const res = (await gateway.post("/api/canvas/agents", {
        name: args.name,
        role: args.role,
        model: args.model,
      })) as { agentId: string };
      if (res?.agentId) gateway.setAgentId(res.agentId);
      return res;
    }

    // ── Actions (v1 execution primitive) ────────────────────────────────────────
    case "canvas_action_propose":
      return gateway.post("/api/canvas/actions", {
        type: args.type ?? "navigate",
        payload: args.payload ?? {},
        proposedBy: gateway.getSession().agentId,
        linkedPinIds: args.linkedPinIds,
      });

    case "canvas_action_list": {
      const qs = args.state ? `?state=${encodeURIComponent(String(args.state))}` : "";
      return gateway.get(`/api/canvas/actions${qs}`);
    }

    case "canvas_action_read":
      return gateway.get(`/api/canvas/actions/${args.id}`);

    case "canvas_action_approve":
      return gateway.post(`/api/canvas/actions/${args.id}/approve`, {
        approvedBy: gateway.getSession().agentId,
      });

    case "canvas_action_reject":
      return gateway.post(`/api/canvas/actions/${args.id}/reject`, {
        reason: args.reason,
      });

    case "canvas_action_update_state":
      return gateway.patch(`/api/canvas/actions/${args.id}`, {
        state: args.state,
        result: args.result,
        error: args.error,
        payload: args.payload,
      });

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

export const TOOLS = [
  {
    name: "canvas_connect",
    description:
      "Bind this MCP session to a canvas. MUST be called before any other canvas.* tool " +
      "(unless you call canvas_create, which connects automatically). Takes a canvas code " +
      "(e.g. 'TOKYO7X3K'). Exchanges it for a JWT held in this gateway process; from then on, " +
      "every other tool operates on that canvas with no ID needed. Returns the shareable web " +
      "`url`. May be called again to switch the session to a different canvas.",
    inputSchema: {
      type: "object" as const,
      properties: { code: { type: "string", description: "Canvas code given by the user." } },
      required: ["code"],
    },
  },
  {
    name: "canvas_create",
    description:
      "Create a NEW canvas and bind this session to it in one step — no human needs to make " +
      "one in the browser first. Use this to start fresh (e.g. the user says 'put a plan on a " +
      "canvas' and gave no code). Good moment to OFFER this: when the user is brainstorming or " +
      "planning and would benefit from seeing it laid out — ask if they want it on a Tandem " +
      "canvas. Returns: `url` (ownership-free view/share link — surface this so they can open and " +
      "watch it live) and, for these agent-created canvases, `claimUrl` + `claimHint`. The " +
      "claimUrl is a PRIVATE link that lets the user claim the canvas as their own (it then " +
      "appears in their account and stays the very canvas you keep editing). Give claimUrl only " +
      "to the intended user; never use it as the public share link. After this, all other " +
      "canvas.* tools operate on the new canvas with no ID needed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Human-readable canvas name (e.g. the project or plan title). Optional.",
        },
      },
    },
  },
  {
    name: "canvas_state_read",
    description:
      "Read the active canvas state. Call this at the start of every canvas-related turn. " +
      "Returns activeCanvasName, activeCanvasId, state (pins/events/notes), and pendingEdits. " +
      "Requires canvas_connect to have been called first.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "canvas_mode_set",
    description:
      "Set the canvas display mode. 'welcome' returns to the template picker; " +
      "'map', 'itinerary', and 'docs' switch the active view.",
    inputSchema: {
      type: "object" as const,
      properties: { mode: { type: "string", enum: ["welcome", "map", "itinerary", "docs", "roadmap", "sheets", "charts"] } },
      required: ["mode"],
    },
  },
  {
    name: "canvas_map_list",
    description:
      "List the available base map presets (world, us, tokyo, japan, etc). " +
      "Use the returned ids with canvas_map_set.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "canvas_map_set",
    description:
      "Switch the base map to a registered preset (e.g. 'world', 'us', 'tokyo'). " +
      "Also switches the canvas into map mode. Call canvas_map_list to enumerate options.",
    inputSchema: {
      type: "object" as const,
      properties: { mapId: { type: "string", description: "Preset id from canvas_map_list" } },
      required: ["mapId"],
    },
  },
  {
    name: "canvas_pin_add",
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
    name: "canvas_pin_update",
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
    name: "canvas_pin_delete",
    description: "Delete a pin by its ID.",
    inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "canvas_event_add",
    description:
      "Add a timed itinerary entry. Three flavors:\n" +
      "  • Single-stop entry: set pinIds to one pin id (or use pinId).\n" +
      "  • Multi-stop entry: set pinIds to several pin ids — one entry that " +
      "covers multiple places (e.g. a 'check-in errands' block hitting a few " +
      "stops). All listed pins are grouped under this entry in the map sidebar.\n" +
      "  • Travel segment between two pins (flight/train/drive): set " +
      "fromPinId + toPinId + travelMode TOGETHER. The map will draw a " +
      "polyline between the two pins with a mode icon at the midpoint, " +
      "and the itinerary will show the card as 'A → B'. Use end for the " +
      "arrival time on travel events.\n" +
      "Pins left off every entry stay 'ungrouped' (fine for 'just pin some places' use).\n" +
      "Set `cost` for anything you priced (flights, hotels, activities) — the itinerary " +
      "sums costs into live per-day + grand totals, so spend tracks the plan with no " +
      "separate sheet to maintain. Keep the itinerary the source of truth for trip cost.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string" },
        start: {
          type: "string",
          description:
            "The actual instant as timezone-aware ISO-8601. Write the local time at the " +
            "location WITH its UTC offset, e.g. 6:00 PM in Chicago (CDT) = " +
            "2024-06-01T18:00:00-05:00. A 'Z' UTC form is also fine. Always include an " +
            "offset or Z — do NOT send a bare time. Pair with `timezone` below so it " +
            "displays in the location's local zone.",
        },
        end: {
          type: "string",
          description: "End / arrival instant, same timezone-aware ISO-8601 format as start.",
        },
        timezone: {
          type: "string",
          description:
            "IANA timezone of THIS event's location, e.g. 'America/Chicago', 'America/New_York', " +
            "'Asia/Tokyo'. The itinerary formats and day-groups the event in this zone. Set it " +
            "per-event so a trip across timezones shows each stop in its own local time.",
        },
        pinIds: {
          type: "array",
          items: { type: "string" },
          description: "Pin ids this entry covers. Use this (not pinId) when an entry spans multiple stops.",
        },
        pinId: { type: "string", description: "Single pin this entry takes place at. Legacy — pinIds is preferred." },
        fromPinId: { type: "string", description: "Origin pin for a travel segment." },
        toPinId: { type: "string", description: "Destination pin for a travel segment." },
        travelMode: {
          type: "string",
          enum: ["flight", "train", "drive"],
          description: "Travel mode. Required when fromPinId/toPinId are set.",
        },
        dayTag: {
          type: "string",
          description:
            "Optional SHORT prefix the map renders before the day-cluster label " +
            "(e.g. 'DAY 1' → 'DAY 1 · Friday, May 29'). Any event on a day can carry " +
            "this; the renderer picks the first non-empty tag (sorted by start), so " +
            "typically set it on the FIRST event of each day. Keep it punchy: 'DAY 1', " +
            "'ARRIVAL', 'KYOTO'.",
        },
        cost: {
          type: "number",
          description:
            "Optional cost of this entry (flight/hotel/activity) in the trip's currency. " +
            "The itinerary sums these into live per-day and grand totals — set it whenever " +
            "you know a price so the running trip cost stays correct as the plan changes.",
        },
      },
      required: ["title", "start"],
    },
  },
  {
    name: "canvas_event_update",
    description:
      "Update an existing entry by its ID. Set pinIds to change which pins it " +
      "covers (replaces the whole list; pass [] to clear). To convert an entry " +
      "into a travel segment, set fromPinId + toPinId + travelMode.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        start: {
          type: "string",
          description: "Timezone-aware ISO-8601 instant (include offset or Z), e.g. 2024-06-01T18:00:00-05:00.",
        },
        end: {
          type: "string",
          description: "End / arrival instant, timezone-aware ISO-8601.",
        },
        timezone: {
          type: "string",
          description: "IANA timezone of the location, e.g. 'America/Chicago'. Controls how the event displays.",
        },
        pinIds: {
          type: "array",
          items: { type: "string" },
          description: "Replaces the entry's pin list. Pass [] to clear all pins.",
        },
        pinId: { type: "string" },
        fromPinId: { type: "string" },
        toPinId: { type: "string" },
        travelMode: { type: "string", enum: ["flight", "train", "drive"] },
        dayTag: {
          type: "string",
          description:
            "Short prefix for the map day label, e.g. 'DAY 1'. First non-empty tag on the day wins.",
        },
        cost: {
          type: "number",
          description:
            "Cost of this entry in the trip's currency. Updating it re-totals the itinerary " +
            "live (per-day + grand total) — keep it current so trip spend always matches the plan.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "canvas_event_delete",
    description: "Delete an event by its ID.",
    inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "canvas_note_add",
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
    name: "canvas_note_update",
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
    name: "canvas_note_delete",
    description: "Delete a note by its ID.",
    inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "canvas_roadmap_item_add",
    description:
      "Add a roadmap item (goal / sub-goal / task) to the planning outline. " +
      "Pass parentId to nest under another item, or omit for a top-level entry. " +
      "Pass stage to file a top-level goal under a phase band (e.g. 'Now', " +
      "'Next', 'Later', 'v1', 'v2'). Also switches the canvas into roadmap mode " +
      "if it was on the welcome screen.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string" },
        parentId: { type: "string", description: "Parent roadmap item ID for nesting." },
        body: { type: "string", description: "Optional longer description." },
        status: { type: "string", enum: ["todo", "in_progress", "done", "blocked"] },
        stage: {
          type: "string",
          description:
            "Phase label for grouping top-level goals into bands, e.g. 'Now' / " +
            "'Next' / 'Later' or 'v1' / 'v2'. Free text — reuse an existing label " +
            "to add to that band. Omit for unstaged. Only meaningful on top-level items.",
        },
        sortOrder: { type: "number", description: "Position among siblings; higher = later." },
      },
      required: ["title"],
    },
  },
  {
    name: "canvas_roadmap_item_update",
    description:
      "Update a roadmap item by its ID. Set stage to move a top-level goal " +
      "between phase bands ('' clears the phase / unstages it).",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        parentId: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        status: { type: "string", enum: ["todo", "in_progress", "done", "blocked"] },
        stage: {
          type: "string",
          description:
            "Phase label (e.g. 'Now', 'v2'). Pass '' to clear the phase (unstage).",
        },
        sortOrder: { type: "number" },
      },
      required: ["id"],
    },
  },
  {
    name: "canvas_roadmap_item_delete",
    description: "Delete a roadmap item by its ID. Children are deleted via cascade.",
    inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "canvas_sheet_add",
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
    name: "canvas_sheet_update",
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
    name: "canvas_sheet_delete",
    description: "Delete a sheet and all its rows.",
    inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "canvas_sheet_column_add",
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
    name: "canvas_sheet_column_update",
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
    name: "canvas_sheet_column_delete",
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
    name: "canvas_sheet_row_add",
    description:
      "Add a row to a sheet. `data` is an object of cell values keyed by either the " +
      "column NAME (e.g. \"Task\", case-insensitive) or the column.id — names are " +
      "resolved to ids server-side, so you don't need to look up the uuids. Values: " +
      "strings for text/date, numbers for number, booleans for checkbox.",
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
    name: "canvas_sheet_row_update",
    description:
      "Update a row by ID. `data` is merged into the existing row data — keys not present " +
      "are left untouched; setting a key to null clears that cell. Cells may be keyed by " +
      "column NAME (case-insensitive) or column.id; names are resolved to ids server-side.",
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
    name: "canvas_sheet_row_delete",
    description: "Delete a sheet row by its ID.",
    inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "canvas_chart_add",
    description:
      "Add a chart that visualizes data from a sheet. Pick a source `sheetId`, a " +
      "`chartType` (bar | line | area | pie), an `xColumn` for category/x-axis labels, " +
      "and one or more `yColumns` to plot as numeric series. Columns may be referenced " +
      "by NAME (case-insensitive) or column.id — names are resolved server-side. Use " +
      "this for tracking values over time (e.g. projected inventory by month, spend by " +
      "category). Also switches the canvas into charts mode.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Chart title." },
        sheetId: { type: "string", description: "Source sheet id." },
        chartType: { type: "string", enum: ["bar", "line", "area", "pie"] },
        xColumn: { type: "string", description: "Column name or id for x-axis / categories." },
        yColumns: {
          type: "array",
          items: { type: "string" },
          description: "Column names or ids to plot as series (numeric). Pie uses the first.",
        },
        sortOrder: { type: "number" },
      },
      required: ["sheetId"],
    },
  },
  {
    name: "canvas_chart_update",
    description:
      "Update a chart by ID. Any of name, sheetId, chartType, xColumn, yColumns, sortOrder " +
      "may be set. Column refs (xColumn / yColumns) may be names or ids; resolved server-side.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        sheetId: { type: "string" },
        chartType: { type: "string", enum: ["bar", "line", "area", "pie"] },
        xColumn: { type: "string" },
        yColumns: { type: "array", items: { type: "string" } },
        sortOrder: { type: "number" },
      },
      required: ["id"],
    },
  },
  {
    name: "canvas_chart_delete",
    description: "Delete a chart by its ID.",
    inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "canvas_form_scaffold",
    description:
      "Draft a form from an existing sheet — the easy on-ramp to the direct-input layer. " +
      "Returns a DRAFT intent (one field + one append binding per column) plus a compile " +
      "report. Stores NOTHING. Edit the returned intent (rename, mark fields required, swap " +
      "a field for {computed:'today'}, add upsert/pin writes) then call canvas_form_define. " +
      "Needs the sheet to exist first (create it with canvas_sheet_add if needed).",
    inputSchema: {
      type: "object" as const,
      properties: { sheet: { type: "string", description: "Name of an existing sheet." } },
      required: ["sheet"],
    },
  },
  {
    name: "canvas_form_define",
    description:
      "Define a form: a recipe a human fills from a phone to mutate the canvas directly — " +
      "no agent in the submit loop. You express INTENT (fields + where they go); the server " +
      "validates against live state, compiles it to a stored mapping, and persists it. " +
      "Returns { ok, errors, warnings, formId }. On ok:false NOTHING is stored — fix the " +
      "errors (each has a path + suggestion) and call again. A `writes` entry targets either " +
      "a sheet (append a row, or upsert+increment a running total) or a pin (patch its " +
      "color/label/body/pinType). Columns are referenced by NAME. Each column/set value is a " +
      "Source with EXACTLY ONE of: {field:'<fieldKey>'}, {computed:'today'|'now'}, " +
      "{literal:<scalar>}.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Form name, e.g. 'Log a meal'." },
        description: { type: "string" },
        fields: {
          type: "array",
          description: "The inputs a human fills (1..20).",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "lowercase id: ^[a-z][a-z0-9_]{0,31}$, unique." },
              label: { type: "string" },
              type: { type: "string", enum: ["text", "number", "date", "select", "checkbox"] },
              required: { type: "boolean" },
              options: { type: "array", items: { type: "string" }, description: "Required iff type=select." },
              default: { description: "Type-compatible default; select ⇒ one of options." },
              placeholder: { type: "string" },
            },
            required: ["key", "label", "type"],
          },
        },
        writes: {
          type: "array",
          description:
            "Where submitted values go (1..8). A SheetWrite has {sheet, mode:'append'|'upsert', " +
            "columns:{<colName>:Source}, match?:[colName] (required for upsert), inc?:[colName] " +
            "(upsert only — increments a numeric column, e.g. a running total)}. A PinWrite has " +
            "{pin:<pinId>, set:{color|label|body|pinType: Source}}.",
          items: { type: "object" },
        },
      },
      required: ["name", "fields", "writes"],
    },
  },
  {
    name: "canvas_form_update",
    description:
      "Redefine an existing form by id from a full intent (same shape as canvas_form_define). " +
      "Re-compiled and re-validated; on ok:false nothing changes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        fields: { type: "array", items: { type: "object" } },
        writes: { type: "array", items: { type: "object" } },
      },
      required: ["id", "name", "fields", "writes"],
    },
  },
  {
    name: "canvas_form_delete",
    description: "Delete a form by its ID. (Rows/pins it already produced are unaffected.)",
    inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "canvas_pending_edits_read",
    description: "Read pending scoped edit requests from the browser UI.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "canvas_pending_edits_complete",
    description: "Mark a pending edit as done after applying it.",
    inputSchema: {
      type: "object" as const,
      properties: { editId: { type: "string" } },
      required: ["editId"],
    },
  },
  {
    name: "agent_register",
    description:
      "Identify this agent to the canvas on connect. Returns an agentId that is " +
      "recorded as the author (provenance) of actions this session proposes. v1 " +
      "expects exactly one 'planner' and one 'executor' per canvas.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Human-readable agent name." },
        role: { type: "string", enum: ["planner", "executor"] },
        model: { type: "string", description: "Optional model id, e.g. 'claude-opus-4-8'." },
      },
      required: ["role"],
    },
  },
  {
    name: "canvas_action_propose",
    description:
      "Propose an action for human approval (the v1 execution primitive). The action " +
      "enters state 'proposed' and does NOT execute until a human approves it. v1 " +
      "supports type 'navigate' with payload { goalLabel?, goal?: {lat,lng}, " +
      "waypoints?: {lat,lng}[] }. proposedBy is taken from the registered agent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: { type: "string", enum: ["navigate"] },
        payload: {
          type: "object",
          description: "navigate: { goalLabel?, goal?: {lat,lng}, waypoints?: [{lat,lng}] }",
        },
        linkedPinIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional pin ids this action references.",
        },
      },
      required: ["payload"],
    },
  },
  {
    name: "canvas_action_list",
    description:
      "List actions on the canvas, optionally filtered by state. The executor polls " +
      "this with state='approved' to pick up work the human has approved.",
    inputSchema: {
      type: "object" as const,
      properties: {
        state: {
          type: "string",
          enum: ["proposed", "approved", "rejected", "executing", "done", "failed"],
        },
      },
    },
  },
  {
    name: "canvas_action_read",
    description: "Read a single action by id (poll for state changes / outcome).",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "canvas_action_approve",
    description:
      "Approve a proposed action (proposed → approved). Primarily a human action in " +
      "the browser; exposed here for testing. Only then may the executor run it.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "canvas_action_reject",
    description: "Reject a proposed action (proposed → rejected), with an optional reason.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "canvas_action_update_state",
    description:
      "Executor-only: advance an approved action through execution. Legal targets: " +
      "'executing' (approved → executing), 'done' / 'failed' (executing → …). Set " +
      "`result` on done, `error` on failed. `payload` may be set to write computed " +
      "waypoints back (e.g. before approval) — note that computing a path does not " +
      "move the robot.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        state: { type: "string", enum: ["executing", "done", "failed"] },
        result: { type: "string" },
        error: { type: "string" },
        payload: { type: "object" },
      },
      required: ["id", "state"],
    },
  },
];
