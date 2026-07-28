import type { Gateway } from "./gateway.js";

type Args = Record<string, unknown>;

// Contextual fan-out nudge for single-item updates (mirrors the task fan-out
// nudge above). A model that's editing several elements of one type tends to
// call canvas_X_update in a tight burst instead of reaching for
// canvas_X_update_batch. Track recent single-update calls per element type in
// this process, and once a burst is clearly underway, attach a one-time hint
// to the tool result. Resets after firing so it doesn't nag on every call.
const recentUpdateCalls = new Map<string, number[]>();
const UPDATE_FANOUT_WINDOW_MS = 20_000;
const UPDATE_FANOUT_THRESHOLD = 3;

function updateFanOutHint(kind: string, plural: string, batchTool: string): string | undefined {
  const now = Date.now();
  const calls = (recentUpdateCalls.get(kind) ?? []).filter((t) => now - t < UPDATE_FANOUT_WINDOW_MS);
  calls.push(now);
  if (calls.length < UPDATE_FANOUT_THRESHOLD) {
    recentUpdateCalls.set(kind, calls);
    return undefined;
  }
  // Fired — reset so the next hint only shows up after another real burst.
  recentUpdateCalls.set(kind, []);
  return (
    `That's ${calls.length} ${kind}_update calls in a row. If you're updating more ${plural}, ` +
    `switch to ${batchTool} — it does them all in one call instead of one round trip each.`
  );
}

function withUpdateFanOutHint<T>(result: T, hint: string | undefined): T | (T & { hint: string }) {
  if (!hint || typeof result !== "object" || result === null) return result;
  return { ...(result as object), hint } as T & { hint: string };
}

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

  // Model-carried binding. The hosted HTTP connector (claude.ai) does not keep
  // one MCP session alive across an idle gap, so the per-session gateway binding
  // can be gone by the time a later tool call lands — the classic "not connected"
  // between calls. To make each call self-sufficient, canvas_connect/create hand
  // the model an opaque `session` handle and every other tool accepts it back;
  // adopt it here (before dispatch) so the call targets the right canvas even on
  // a brand-new gateway. Then strip it so it never leaks into per-tool args.
  const carried = args.session;
  if (
    typeof carried === "string" &&
    carried &&
    toolName !== "canvas_connect" &&
    toolName !== "canvas_create"
  ) {
    gateway.adoptSession(carried);
  }
  delete args.session;

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
        session: gateway.exportSession(),
        _surface_url_now:
          "FIRST, before any research or edits: tell the user the canvas is connected and give them " +
          "this `url` so they can open it now and WATCH your changes land in real time. Don't make " +
          "them wait with no artifact to look at while you work. THEN do the work. When you finish, " +
          "summarize what you changed and repeat the `url` so they can jump straight to it.",
        _session_note:
          "Pass `session` back as the `session` argument on EVERY later canvas_* call. The hosted " +
          "MCP connection can reset between calls; carrying this handle keeps your edits on this " +
          "canvas without having to reconnect.",
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
        session: gateway.exportSession(),
        _surface_url_now:
          "FIRST, before any research or edits: tell the user their canvas is live and give them " +
          "this `url` so they can open it now and WATCH your changes land in real time. Don't make " +
          "them wait staring at nothing while you research or plan. THEN do the work. When you " +
          "finish, summarize what you changed and repeat the `url` so they can jump straight to it.",
        _session_note:
          "Pass `session` back as the `session` argument on EVERY later canvas_* call. The hosted " +
          "MCP connection can reset between calls; carrying this handle keeps your edits on this " +
          "canvas without having to reconnect.",
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
    case "canvas_state_read": {
      // Default is a cheap summary (counts + names). fields=[...] pulls only the
      // named kinds in full; full=true returns the entire canvas (can be huge).
      const qs = new URLSearchParams();
      if (Array.isArray(args.fields) && args.fields.length > 0) {
        qs.set("fields", args.fields.join(","));
      }
      if (args.full === true) qs.set("full", "true");
      const q = qs.toString();
      return gateway.get(`/api/canvas/state${q ? `?${q}` : ""}`);
    }

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

    // ── Documents ──────────────────────────────────────────────────────────────
    case "canvas_document_list":
      return gateway.get("/api/canvas/documents");

    case "canvas_document_add":
      return gateway.post("/api/canvas/documents", {
        type: args.type,
        name: args.name,
        config: args.config,
        sortOrder: args.sortOrder,
        parentId: args.parentId,
        createdBy: "agent",
      });

    case "canvas_document_add_batch":
      return gateway.post("/api/canvas/documents/batch", {
        documents: ((args.documents as Record<string, unknown>[]) ?? []).map((d) => ({
          type: d.type,
          name: d.name,
          config: d.config,
          sortOrder: d.sortOrder,
          parentId: d.parentId,
          createdBy: "agent",
        })),
      });

    case "canvas_document_update":
      // {ref} is a document id OR name (url-encoded); server resolves it.
      return gateway.patch(`/api/canvas/documents/${encodeURIComponent(String(args.document))}`, {
        name: args.name,
        sortOrder: args.sortOrder,
        config: args.config,
        parentId: args.parentId,
      });

    case "canvas_document_delete":
      return gateway.del(`/api/canvas/documents/${encodeURIComponent(String(args.document))}`);

    case "canvas_document_delete_batch":
      return gateway.post("/api/canvas/documents/batch-delete", {
        refs: (args.documents as unknown[]) ?? [],
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
        document: args.document,
        createdBy: "agent",
      });

    case "canvas_pin_add_batch":
      return gateway.post("/api/canvas/pins/batch", {
        document: args.document,
        pins: ((args.pins as Record<string, unknown>[]) ?? []).map((p) => ({
          pinType: p.pinType ?? "marker",
          lat: p.lat,
          lng: p.lng,
          label: p.label,
          body: p.body,
          color: p.color,
          document: p.document,
          createdBy: "agent",
        })),
      });

    case "canvas_pin_update": {
      const { id, ...partial } = args;
      const result = await gateway.patch(`/api/canvas/pins/${id}`, partial);
      return withUpdateFanOutHint(result, updateFanOutHint("pin", "pins", "canvas_pin_update_batch"));
    }

    case "canvas_pin_update_batch":
      return gateway.post("/api/canvas/pins/batch-update", {
        items: ((args.items as Record<string, unknown>[]) ?? []).map((it) => ({
          id: it.id,
          pinType: it.pinType,
          lat: it.lat,
          lng: it.lng,
          label: it.label,
          body: it.body,
          color: it.color,
        })),
      });

    case "canvas_pin_delete":
      return gateway.del(`/api/canvas/pins/${args.id}`);

    case "canvas_pin_delete_batch":
      return gateway.post("/api/canvas/pins/batch-delete", { ids: (args.ids as unknown[]) ?? [] });

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
        document: args.document,
        createdBy: "agent",
      });

    case "canvas_event_add_batch":
      return gateway.post("/api/canvas/events/batch", {
        document: args.document,
        events: ((args.events as Record<string, unknown>[]) ?? []).map((e) => ({
          title: e.title,
          start: e.start,
          end: e.end,
          timezone: e.timezone,
          pinIds: e.pinIds,
          pinId: e.pinId,
          fromPinId: e.fromPinId,
          toPinId: e.toPinId,
          travelMode: e.travelMode,
          dayTag: e.dayTag,
          cost: e.cost,
          document: e.document,
          createdBy: "agent",
        })),
      });

    case "canvas_event_update": {
      const { id, ...partial } = args;
      const result = await gateway.patch(`/api/canvas/events/${id}`, partial);
      return withUpdateFanOutHint(result, updateFanOutHint("event", "events", "canvas_event_update_batch"));
    }

    case "canvas_event_update_batch":
      return gateway.post("/api/canvas/events/batch-update", {
        items: ((args.items as Record<string, unknown>[]) ?? []).map((it) => ({
          id: it.id,
          title: it.title,
          start: it.start,
          end: it.end,
          timezone: it.timezone,
          pinIds: it.pinIds,
          pinId: it.pinId,
          fromPinId: it.fromPinId,
          toPinId: it.toPinId,
          travelMode: it.travelMode,
          dayTag: it.dayTag,
          cost: it.cost,
        })),
      });

    case "canvas_event_delete":
      return gateway.del(`/api/canvas/events/${args.id}`);

    case "canvas_event_delete_batch":
      return gateway.post("/api/canvas/events/batch-delete", { ids: (args.ids as unknown[]) ?? [] });

    // ── Map (pins + events in one write) ─────────────────────────────────────────
    case "canvas_map_add_batch":
      return gateway.post("/api/canvas/map/batch", {
        document: args.document,
        itineraryDocument: args.itineraryDocument,
        pins: ((args.pins as Record<string, unknown>[]) ?? []).map((p) => ({
          clientId: p.clientId,
          pinType: p.pinType ?? "marker",
          lat: p.lat,
          lng: p.lng,
          label: p.label,
          body: p.body,
          color: p.color,
          document: p.document,
          createdBy: "agent",
        })),
        events: ((args.events as Record<string, unknown>[]) ?? []).map((e) => ({
          title: e.title,
          start: e.start,
          end: e.end,
          timezone: e.timezone,
          clientPinIds: e.clientPinIds,
          clientPinId: e.clientPinId,
          fromClientId: e.fromClientId,
          toClientId: e.toClientId,
          pinIds: e.pinIds,
          pinId: e.pinId,
          fromPinId: e.fromPinId,
          toPinId: e.toPinId,
          travelMode: e.travelMode,
          dayTag: e.dayTag,
          cost: e.cost,
          document: e.document,
          createdBy: "agent",
        })),
      });

    // ── Notes ──────────────────────────────────────────────────────────────────
    case "canvas_note_add":
      return gateway.post("/api/canvas/notes", {
        body: args.body,
        imageRefs: args.imageRefs ?? [],
        parentId: args.parentId,
        parentKind: args.parentKind,
        document: args.document,
        createdBy: "agent",
      });

    case "canvas_note_add_batch":
      return gateway.post("/api/canvas/notes/batch", {
        document: args.document,
        notes: ((args.notes as Record<string, unknown>[]) ?? []).map((n) => ({
          body: n.body,
          imageRefs: n.imageRefs ?? [],
          parentId: n.parentId,
          parentKind: n.parentKind,
          document: n.document,
          createdBy: "agent",
        })),
      });

    case "canvas_note_update": {
      const { id, ...partial } = args;
      const result = await gateway.patch(`/api/canvas/notes/${id}`, partial);
      return withUpdateFanOutHint(result, updateFanOutHint("note", "notes", "canvas_note_update_batch"));
    }

    case "canvas_note_update_batch":
      return gateway.post("/api/canvas/notes/batch-update", {
        items: ((args.items as Record<string, unknown>[]) ?? []).map((it) => ({
          id: it.id,
          body: it.body,
          parentId: it.parentId,
          parentKind: it.parentKind,
          imageRefs: it.imageRefs,
          sortOrder: it.sortOrder,
        })),
      });

    case "canvas_note_delete":
      return gateway.del(`/api/canvas/notes/${args.id}`);

    case "canvas_note_delete_batch":
      return gateway.post("/api/canvas/notes/batch-delete", { ids: (args.ids as unknown[]) ?? [] });

    // ── Roadmap items ──────────────────────────────────────────────────────────
    case "canvas_roadmap_item_add":
      return gateway.post("/api/canvas/roadmap-items", {
        parentId: args.parentId,
        title: args.title,
        body: args.body ?? "",
        status: args.status ?? "todo",
        stage: args.stage,
        assignee: args.assignee,
        sortOrder: args.sortOrder ?? 0,
        document: args.document,
        createdBy: "agent",
      });

    case "canvas_roadmap_item_add_batch":
      return gateway.post("/api/canvas/roadmap-items/batch", {
        document: args.document,
        items: ((args.items as Record<string, unknown>[]) ?? []).map((it) => ({
          parentId: it.parentId,
          title: it.title,
          body: it.body ?? "",
          status: it.status ?? "todo",
          stage: it.stage,
          assignee: it.assignee,
          sortOrder: it.sortOrder ?? 0,
          document: it.document,
          createdBy: "agent",
        })),
      });

    case "canvas_roadmap_item_update": {
      const { id, ...partial } = args;
      const result = await gateway.patch(`/api/canvas/roadmap-items/${id}`, partial);
      return withUpdateFanOutHint(
        result,
        updateFanOutHint("roadmap_item", "roadmap items", "canvas_roadmap_item_update_batch")
      );
    }

    case "canvas_roadmap_item_update_batch":
      return gateway.post("/api/canvas/roadmap-items/batch-update", {
        items: ((args.items as Record<string, unknown>[]) ?? []).map((it) => ({
          id: it.id,
          parentId: it.parentId,
          title: it.title,
          body: it.body,
          status: it.status,
          stage: it.stage,
          assignee: it.assignee,
          sortOrder: it.sortOrder,
        })),
      });

    case "canvas_roadmap_item_delete":
      return gateway.del(`/api/canvas/roadmap-items/${args.id}`);

    case "canvas_roadmap_item_delete_batch":
      return gateway.post("/api/canvas/roadmap-items/batch-delete", { ids: (args.ids as unknown[]) ?? [] });

    case "canvas_roadmap_task_list": {
      // The agent-task queue drawn from the roadmap: goals a human marked for an
      // agent session to execute. Compact projection — canvas_roadmap_item /
      // canvas_state_read has the rest. We also fold in whether a type="task"
      // action already links each item, so a session can tell which agent-marked
      // goals are still TASKLESS (candidates to propose a task for) vs already
      // being worked.
      const [roadmapRes, actionsRes] = (await Promise.all([
        gateway.get("/api/canvas/roadmap-items?assignee=agent"),
        gateway.get("/api/canvas/actions?type=task"),
      ])) as [
        {
          items: Array<{
            id: string;
            title: string;
            body: string;
            status: string;
            stage?: string;
            parentId?: string;
          }>;
        },
        {
          actions: Array<{
            id: string;
            state: string;
            payload?: { linkedIds?: string[] };
          }>;
        },
      ];

      // roadmap item id → the tasks pointing at it (id + state).
      const linkedByItem = new Map<string, Array<{ id: string; state: string }>>();
      for (const a of actionsRes.actions ?? []) {
        for (const rid of a.payload?.linkedIds ?? []) {
          const arr = linkedByItem.get(rid) ?? [];
          arr.push({ id: a.id, state: a.state });
          linkedByItem.set(rid, arr);
        }
      }
      // A done/failed/rejected task doesn't keep an item "covered" — it can be
      // re-tasked, so only still-actionable states count as an open task.
      const isOpen = (s: string) =>
        s === "proposed" || s === "approved" || s === "executing";

      return {
        tasks: (roadmapRes.items ?? []).map((it) => {
          const linked = linkedByItem.get(it.id) ?? [];
          const hasOpenTask = linked.some((t) => isOpen(t.state));
          return {
            id: it.id,
            title: it.title,
            status: it.status,
            ...(it.body ? { body: it.body } : {}),
            ...(it.stage ? { stage: it.stage } : {}),
            ...(it.parentId ? { parentId: it.parentId } : {}),
            // false ⇒ no open task links this goal yet — propose one via
            // canvas_task_add (linkedIds:[id]) if you intend to work it.
            hasOpenTask,
            ...(linked.length > 0 ? { linkedTasks: linked } : {}),
          };
        }),
      };
    }

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

    case "canvas_sheet_delete_batch":
      return gateway.post("/api/canvas/sheets/batch-delete", { ids: (args.ids as unknown[]) ?? [] });

    case "canvas_sheet_column_add":
      return gateway.post(`/api/canvas/sheets/${args.sheetId}/columns`, {
        name: args.name,
        type: args.type,
        sortOrder: args.sortOrder ?? 0,
      });

    case "canvas_sheet_column_add_batch":
      return gateway.post(`/api/canvas/sheets/${args.sheetId}/columns/batch`, {
        columns: ((args.columns as Record<string, unknown>[]) ?? []).map((c) => ({
          name: c.name,
          type: c.type ?? "text",
          sortOrder: c.sortOrder,
        })),
      });

    case "canvas_sheet_column_update": {
      const { sheetId, columnId, ...partial } = args;
      const result = await gateway.patch(`/api/canvas/sheets/${sheetId}/columns/${columnId}`, partial);
      return withUpdateFanOutHint(
        result,
        updateFanOutHint("sheet_column", "columns", "canvas_sheet_column_update_batch")
      );
    }

    case "canvas_sheet_column_update_batch":
      return gateway.post("/api/canvas/sheet-columns/batch-update", {
        items: ((args.items as Record<string, unknown>[]) ?? []).map((it) => ({
          sheetId: it.sheetId,
          columnId: it.columnId,
          name: it.name,
          type: it.type,
          sortOrder: it.sortOrder,
        })),
      });

    case "canvas_sheet_column_delete":
      return gateway.del(`/api/canvas/sheets/${args.sheetId}/columns/${args.columnId}`);

    case "canvas_sheet_column_delete_batch":
      return gateway.post("/api/canvas/sheet-columns/batch-delete", {
        items: ((args.items as Record<string, unknown>[]) ?? []).map((it) => ({
          sheetId: it.sheetId,
          columnId: it.columnId,
        })),
      });

    case "canvas_sheet_row_add":
      return gateway.post("/api/canvas/sheet-rows", {
        sheetId: args.sheetId,
        data: args.data ?? {},
        sortOrder: args.sortOrder ?? 0,
        createdBy: "agent",
      });

    case "canvas_sheet_row_add_batch":
      return gateway.post(`/api/canvas/sheets/${args.sheetId}/rows/batch`, {
        rows: ((args.rows as Record<string, unknown>[]) ?? []).map((r) => ({
          data: r.data ?? {},
          sortOrder: r.sortOrder ?? 0,
          createdBy: "agent",
        })),
      });

    case "canvas_sheet_row_update": {
      const { id, ...partial } = args;
      const result = await gateway.patch(`/api/canvas/sheet-rows/${id}`, partial);
      return withUpdateFanOutHint(result, updateFanOutHint("sheet_row", "rows", "canvas_sheet_row_update_batch"));
    }

    case "canvas_sheet_row_update_batch":
      return gateway.post("/api/canvas/sheet-rows/batch-update", {
        items: ((args.items as Record<string, unknown>[]) ?? []).map((it) => ({
          id: it.id,
          data: it.data,
          sortOrder: it.sortOrder,
        })),
      });

    case "canvas_sheet_row_delete":
      return gateway.del(`/api/canvas/sheet-rows/${args.id}`);

    case "canvas_sheet_row_delete_batch":
      return gateway.post("/api/canvas/sheet-rows/batch-delete", { ids: (args.ids as unknown[]) ?? [] });

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

    case "canvas_chart_add_batch":
      return gateway.post("/api/canvas/charts/batch", {
        charts: ((args.charts as Record<string, unknown>[]) ?? []).map((c) => ({
          name: c.name,
          sheetId: c.sheetId,
          chartType: c.chartType,
          xColumn: c.xColumn,
          yColumns: c.yColumns,
          sortOrder: c.sortOrder ?? 0,
          createdBy: "agent",
        })),
      });

    case "canvas_chart_update": {
      const { id, ...partial } = args;
      const result = await gateway.patch(`/api/canvas/charts/${id}`, partial);
      return withUpdateFanOutHint(result, updateFanOutHint("chart", "charts", "canvas_chart_update_batch"));
    }

    case "canvas_chart_update_batch":
      return gateway.post("/api/canvas/charts/batch-update", {
        items: ((args.items as Record<string, unknown>[]) ?? []).map((it) => ({
          id: it.id,
          name: it.name,
          sheetId: it.sheetId,
          chartType: it.chartType,
          xColumn: it.xColumn,
          yColumns: it.yColumns,
          sortOrder: it.sortOrder,
        })),
      });

    case "canvas_chart_delete":
      return gateway.del(`/api/canvas/charts/${args.id}`);

    case "canvas_chart_delete_batch":
      return gateway.post("/api/canvas/charts/batch-delete", { ids: (args.ids as unknown[]) ?? [] });

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

    case "canvas_form_delete_batch":
      return gateway.post("/api/canvas/forms/batch-delete", { ids: (args.ids as unknown[]) ?? [] });

    // ── Pending edits ──────────────────────────────────────────────────────────
    case "canvas_pending_edits_read":
      // Dedicated endpoint — queries just the pending_edits table. Previously this
      // hit /api/canvas/state, forcing the server to build the whole summary
      // (counts + per-kind names for the entire board) just to return this slice.
      return gateway.get("/api/canvas/pending-edits");

    case "canvas_pending_edits_complete":
      return gateway.del(`/api/canvas/pending-edits/${args.editId}`);

    // ── Agents (v1 identity / provenance) ───────────────────────────────────────
    case "agent_register": {
      const res = (await gateway.post("/api/canvas/agents", {
        name: args.name,
        role: args.role,
        model: args.model,
      })) as { agentId: string };
      if (res?.agentId) {
        gateway.setAgentId(res.agentId, args.name ? String(args.name) : undefined);
      }
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

    // ── Tasks (actions of type "task": the agent work queue) ───────────────────
    case "canvas_task_add":
      return gateway.post("/api/canvas/actions", {
        type: "task",
        payload: {
          title: args.title,
          body: args.body,
          linkedIds: args.linkedIds,
          assignee: args.assignee ?? "agent",
        },
        proposedBy: gateway.getSession().agentId,
      });

    case "canvas_task_add_batch":
      return gateway.post("/api/canvas/actions/batch", {
        actions: ((args.tasks as Record<string, unknown>[]) ?? []).map((t) => ({
          type: "task",
          payload: {
            title: t.title,
            body: t.body,
            linkedIds: t.linkedIds,
            assignee: t.assignee ?? "agent",
          },
          proposedBy: gateway.getSession().agentId,
        })),
      });

    case "canvas_task_list": {
      // Agents pull THEIR queue by default — human todos stay out unless asked.
      const assignee = String(args.assignee ?? "agent");
      let qs = assignee === "any" ? "" : `&assignee=${encodeURIComponent(assignee)}`;
      if (args.state) qs += `&state=${encodeURIComponent(String(args.state))}`;
      const res = (await gateway.get(`/api/canvas/actions?type=task${qs}`)) as {
        actions: Array<{
          id: string;
          state: string;
          payload?: { title?: string; assignee?: string };
          proposedBy: string;
          claimedBy?: string;
          result?: string;
          ticketId?: string;
          createdAt: string;
        }>;
      };
      // Compact projection: no bodies, no linkedIds. canvas_task_get has the rest.
      const tasks = (res.actions ?? []).map((a) => ({
        id: a.id,
        ...(a.ticketId ? { ticketId: a.ticketId } : {}),
        title: a.payload?.title ?? "",
        state: a.state,
        assignee: a.payload?.assignee ?? "agent",
        proposedBy: a.proposedBy,
        ...(a.claimedBy ? { claimedBy: a.claimedBy } : {}),
        ...(a.result ? { result: a.result } : {}),
        createdAt: a.createdAt,
      }));
      // Contextual fan-out nudge: only when there's a real batch of ready work.
      // Subagents are a HARNESS capability (e.g. Claude Code's Agent tool), not
      // something this server can start — so this just tells the agent it may
      // offer it. Each subagent should agent_register (role "executor",
      // parentAgentId = the orchestrator's id) so the fan-out shows on the board
      // rather than the orchestrator narrating what it's doing.
      const approvedCount = tasks.filter((t) => t.state === "approved").length;
      const hint =
        approvedCount >= 2
          ? `${approvedCount} approved tasks are ready. If you're in a harness with subagents (e.g. Claude Code), you can offer the user to spin up one subagent per task and execute them in parallel — have each subagent connect, agent_register (role "executor", parentAgentId = your registered agent id), then task_start → work → task_complete. Skip this if your harness has no subagent primitive.`
          : undefined;
      return { tasks, ...(hint ? { hint } : {}) };
    }

    case "canvas_task_get":
      return gateway.get(`/api/canvas/actions/${args.id}`);

    case "canvas_task_start": {
      // The claim is atomic server-side: exactly one concurrent task_start wins.
      // A 409 loss is an expected outcome, surfaced as data (not a thrown error)
      // so the model routes to the next task instead of retrying or stalling.
      const session = gateway.getSession();
      const claimant =
        (args.agentName as string | undefined) ?? session.agentName ?? session.agentId;
      const res = await gateway.patchWithConflict<Record<string, unknown>, { claimedBy?: string }>(
        `/api/canvas/actions/${args.id}`,
        { state: "executing", ...(claimant ? { agentName: claimant } : {}) }
      );
      if (res.conflict) {
        const claimedBy = res.conflict.claimedBy || "another agent";
        return {
          claimed: false,
          claimedBy,
          message:
            `This task is already claimed by "${claimedBy}" — another session got it first. ` +
            `Do NOT work on it. Call canvas_task_list with state "approved" and pick the next task.`,
        };
      }
      return res.data;
    }

    case "canvas_task_complete": {
      const { action } = (await gateway.get(`/api/canvas/actions/${args.id}`)) as {
        action: { state: string };
      };
      if (action.state === "approved") {
        const s = gateway.getSession();
        const claimant = s.agentName ?? s.agentId;
        await gateway.patch(`/api/canvas/actions/${args.id}`, {
          state: "executing",
          ...(claimant ? { agentName: claimant } : {}),
        });
      }
      return gateway.patch(`/api/canvas/actions/${args.id}`, {
        state: args.status ?? "done",
        result: args.result,
        error: args.error,
      });
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

const RAW_TOOLS = [
  {
    name: "canvas_connect",
    description:
      "Bind this MCP session to a canvas. MUST be called before any other canvas.* tool " +
      "(unless you call canvas_create, which connects automatically). Takes a canvas code " +
      "(e.g. 'TOKYO7X3K'). Exchanges it for a JWT held in this gateway process; from then on, " +
      "every other tool operates on that canvas with no ID needed. Returns the shareable web " +
      "`url` — surface it to the user right away (before you start researching or editing) so " +
      "they can open the canvas and watch your changes live, then repeat it in your final summary. " +
      "May be called again to switch the session to a different canvas.",
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
      "canvas. Returns: `url` (ownership-free view/share link). Surface `url` to the user " +
      "IMMEDIATELY — before any research, planning, or edits — so they can open the canvas and " +
      "watch your changes appear live instead of waiting with nothing to look at; then repeat it " +
      "in your final summary of what changed. Also returns, for these agent-created canvases, " +
      "`claimUrl` + `claimHint`. The " +
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
      "Read the active canvas state. Requires canvas_connect first. By DEFAULT returns a " +
      "lightweight SUMMARY — per-kind counts plus the name/title of each item (mode, version, " +
      "enabledModes too) — so you can see what's on the canvas without pulling the whole board " +
      "(a real canvas is 100k+ chars and will blow your token budget). To read actual objects, " +
      "pass `fields` with just the kinds you need, e.g. fields:[\"roadmapItems\"] or " +
      "fields:[\"sheets\",\"sheetRows\"]. Valid kinds: pins, events, notes, roadmapItems, sheets, " +
      "sheetRows, charts, forms, actions, agents. Reading a sheet? request BOTH \"sheets\" and " +
      "\"sheetRows\". Only pass full:true if you truly need the entire canvas. If you're looking " +
      "for work to do, start with canvas_task_list instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        fields: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "documents", "pins", "events", "notes", "roadmapItems", "sheets",
              "sheetRows", "charts", "forms", "actions", "agents",
            ],
          },
          description:
            "Return the full objects for only these kinds. Omit for a summary of the whole canvas.",
        },
        full: {
          type: "boolean",
          description: "Return the ENTIRE canvas (can be very large). Prefer `fields` instead.",
        },
      },
    },
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
      "List the available base map presets (currently just 'us', the Continental US map). " +
      "Use the returned ids with canvas_map_set.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "canvas_map_set",
    description:
      "Switch the base map to a registered preset. The only preset today is 'us' (the " +
      "Continental US map). Also switches the canvas into map mode. Call canvas_map_list to enumerate options.",
    inputSchema: {
      type: "object" as const,
      properties: { mapId: { type: "string", description: "Preset id from canvas_map_list" } },
      required: ["mapId"],
    },
  },

  // ── Documents ────────────────────────────────────────────────────────────────
  {
    name: "canvas_document_list",
    description:
      "List the canvas's documents (its tabs) — each is {id, type, name, parentId?, sortOrder, config}, " +
      "ordered for display. A canvas holds multiple named documents of each type (e.g. a " +
      "'Japan' map and a 'Budget' sheet). Use this to discover what exists, then address a " +
      "document by name or id when adding content or editing it. A `type: \"folder\"` document " +
      "holds no content — it groups others into a tree; a document's `parentId` is the folder it " +
      "sits under (absent = root level).",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "canvas_document_add",
    description:
      "Create a new document (a new tab). type is one of map, notes, itinerary, roadmap, sheet, folder. " +
      "A 'sheet' document also creates its empty backing sheet (add columns/rows next). A 'folder' " +
      "holds no content — it groups other documents in the explorer tree; put documents in it by " +
      "passing their `parentId`. To create a chart use canvas_chart_add (a chart needs a source " +
      "sheet). New content added afterward can target this document by its name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: { type: "string", enum: ["map", "notes", "itinerary", "roadmap", "sheet", "folder"] },
        name: { type: "string", description: "Display name / tab title (e.g. \"Japan trip\")." },
        config: {
          type: "object",
          description: "Type-specific settings — e.g. { \"mapId\": \"us\" } for a map document.",
        },
        sortOrder: { type: "number", description: "Tab position; omit to append at the end." },
        parentId: {
          type: "string",
          description:
            "Folder to create this document inside — a folder document's id or name. Omit for the root level.",
        },
      },
      required: ["type"],
    },
  },
  {
    name: "canvas_document_add_batch",
    description:
      "Create MANY documents (new tabs) in ONE call. Strongly preferred over calling " +
      "canvas_document_add repeatedly when creating several documents at once (e.g. a set of " +
      "notes tabs): the whole array persists in a single write and fires one live update, " +
      "instead of one round trip per document. Each item takes the SAME fields as " +
      "canvas_document_add EXCEPT type \"sheet\" isn't supported here (a sheet needs its paired " +
      "backing sheet minted 1:1 — create it individually with canvas_document_add) and \"chart\" " +
      "is never valid (use canvas_chart_add_batch — a chart needs a source sheet). Returns the " +
      "created documents (with their generated ids), in input order.",
    inputSchema: {
      type: "object" as const,
      properties: {
        documents: {
          type: "array",
          description: "The documents to add. At least one.",
          items: {
            type: "object" as const,
            properties: {
              type: { type: "string", enum: ["map", "notes", "itinerary", "roadmap", "folder"] },
              name: { type: "string", description: "Display name / tab title (e.g. \"Japan trip\")." },
              config: {
                type: "object",
                description: "Type-specific settings — e.g. { \"mapId\": \"us\" } for a map document.",
              },
              sortOrder: { type: "number", description: "Tab position; omit to append at the end." },
              parentId: {
                type: "string",
                description:
                  "Folder to create this document inside — a folder document's id or name. Omit for the root level.",
              },
            },
            required: ["type"],
          },
        },
      },
      required: ["documents"],
    },
  },
  {
    name: "canvas_document_update",
    description:
      "Rename, reorder, reconfigure, or move a document. Address it by `document` = its id or current " +
      "name (e.g. \"Budget\"). Set config to change type-specific settings (e.g. a map's base layer). " +
      "Set parentId to move it into a folder (or to \"root\" to pull it back to the top level).",
    inputSchema: {
      type: "object" as const,
      properties: {
        document: { type: "string", description: "Target document — its id or current name." },
        name: { type: "string", description: "New name." },
        sortOrder: { type: "number" },
        config: { type: "object" },
        parentId: {
          type: "string",
          description:
            "Move into this folder — a folder document's id or name. Pass \"root\" (or \"\") to move it " +
            "back to the top level. Omit to leave its folder unchanged.",
        },
      },
      required: ["document"],
    },
  },
  {
    name: "canvas_document_delete",
    description:
      "Delete a document (a tab) and everything in it — addressed by `document` = id or name. " +
      "Cascades: a map doc takes its pins, a notes doc its notes, a sheet doc its rows, etc. " +
      "Irreversible.",
    inputSchema: {
      type: "object" as const,
      properties: { document: { type: "string", description: "Target document — its id or name." } },
      required: ["document"],
    },
  },
  {
    name: "canvas_document_delete_batch",
    description:
      "Delete MANY documents in ONE call — the batch counterpart of canvas_document_delete. " +
      "Strongly preferred over calling canvas_document_delete repeatedly when removing several " +
      "documents at once; N one-at-a-time deletes become one round trip and one live update. " +
      "Each cascades exactly like the single delete. Irreversible.",
    inputSchema: {
      type: "object" as const,
      properties: {
        documents: {
          type: "array",
          items: { type: "string" },
          description: "The documents to delete — each an id or name. At least one.",
        },
      },
      required: ["documents"],
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
        document: {
          type: "string",
          description:
            "Which map document (tab) to add this pin to — an existing document id or name (e.g. \"Japan\"); " +
            "the named document must already exist (create it first with canvas_document_add). " +
            "Omit to use the canvas's default map document, which IS created on demand if none exists.",
        },
      },
      required: ["pinType", "lat", "lng"],
    },
  },
  {
    name: "canvas_pin_add_batch",
    description:
      "Add MANY location pins in ONE call. Strongly preferred over calling " +
      "canvas_pin_add repeatedly when placing several pins (e.g. a full trip's " +
      "stops): the whole array persists in a single write and fires one live " +
      "update, instead of one round trip per pin. Returns the created pins (with " +
      "their generated ids), in input order — use those ids when you then add " +
      "itinerary entries that reference the pins.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pins: {
          type: "array",
          description: "The pins to add. At least one.",
          items: {
            type: "object" as const,
            properties: {
              pinType: { type: "string", enum: ["marker", "annotation"] },
              lat: { type: "number" },
              lng: { type: "number" },
              label: { type: "string" },
              body: { type: "string" },
              color: { type: "string" },
              document: {
                type: "string",
                description:
                  "Per-pin override of the target map document. Usually omit and set `document` " +
                  "once at the top level for the whole batch.",
              },
            },
            required: ["pinType", "lat", "lng"],
          },
        },
        document: {
          type: "string",
          description:
            "Shared target map document (tab) for every pin in this batch — an existing document " +
            "id or name (e.g. \"Japan\"); the named document must already exist. Omit to use the " +
            "canvas's default map document, which IS created on demand if none exists.",
        },
      },
      required: ["pins"],
    },
  },
  {
    name: "canvas_pin_update",
    description:
      "Update an existing pin by its ID. To edit several pins at once, use " +
      "canvas_pin_update_batch instead of calling this repeatedly.",
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
    name: "canvas_pin_update_batch",
    description:
      "Update MANY pins in ONE call - the batch counterpart of canvas_pin_update. Strongly " +
      "preferred over calling canvas_pin_update repeatedly when editing several existing pins " +
      "at once; N one-at-a-time updates become one round trip and one live update.",
    inputSchema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array",
          description: "The pins to update. At least one.",
          items: {
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
      },
      required: ["items"],
    },
  },
  {
    name: "canvas_pin_delete",
    description: "Delete a pin by its ID.",
    inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "canvas_pin_delete_batch",
    description:
      "Delete MANY pins in ONE call — the batch counterpart of canvas_pin_delete. Strongly " +
      "preferred over calling canvas_pin_delete repeatedly when removing several pins at once; " +
      "N one-at-a-time deletes become one round trip and one live update.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Pin ids to delete. At least one." },
      },
      required: ["ids"],
    },
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
        document: {
          type: "string",
          description:
            "Which itinerary document (tab) to add this entry to — an existing document id or name; " +
            "the named document must already exist (create it first with canvas_document_add). " +
            "Omit to use the canvas's default itinerary, which IS created on demand if none exists.",
        },
      },
      required: ["title", "start"],
    },
  },
  {
    name: "canvas_event_add_batch",
    description:
      "Add MANY itinerary entries in ONE call — the batch counterpart of " +
      "canvas_event_add. Strongly preferred when adding several entries at once " +
      "(a whole day, or a whole trip): the array persists in a single write and " +
      "fires one live update instead of one round trip per entry. Each entry " +
      "takes the SAME fields as canvas_event_add (title, start, end, timezone, " +
      "pinIds/pinId, fromPinId+toPinId+travelMode, dayTag, cost). Entries " +
      "reference pins by their real ids, so create the pins first " +
      "(canvas_pin_add_batch) and use the ids it returns. If you're adding the " +
      "pins AND the events together from scratch, prefer canvas_map_add_batch — " +
      "it lets events reference brand-new pins by a clientId, so the whole trip " +
      "goes out in ONE call with no id round trip.",
    inputSchema: {
      type: "object" as const,
      properties: {
        events: {
          type: "array",
          description: "The itinerary entries to add. At least one.",
          items: {
            type: "object" as const,
            properties: {
              title: { type: "string" },
              start: {
                type: "string",
                description:
                  "Timezone-aware ISO-8601 instant (include offset or Z), e.g. 2024-06-01T18:00:00-05:00.",
              },
              end: { type: "string", description: "End / arrival instant, timezone-aware ISO-8601." },
              timezone: {
                type: "string",
                description: "IANA timezone of THIS entry's location, e.g. 'Asia/Tokyo'.",
              },
              pinIds: {
                type: "array",
                items: { type: "string" },
                description: "Pin ids this entry covers (multi-stop). Prefer over pinId.",
              },
              pinId: { type: "string", description: "Single pin this entry takes place at. Legacy." },
              fromPinId: { type: "string", description: "Origin pin for a travel segment." },
              toPinId: { type: "string", description: "Destination pin for a travel segment." },
              travelMode: {
                type: "string",
                enum: ["flight", "train", "drive"],
                description: "Travel mode. Required when fromPinId/toPinId are set.",
              },
              dayTag: { type: "string", description: "Optional short day-cluster prefix, e.g. 'DAY 1'." },
              cost: { type: "number", description: "Optional cost; summed into per-day and grand totals." },
              document: {
                type: "string",
                description:
                  "Per-entry override of the target itinerary document. Usually omit and set " +
                  "`document` once at the top level for the whole batch.",
              },
            },
            required: ["title", "start"],
          },
        },
        document: {
          type: "string",
          description:
            "Shared target itinerary document (tab) for every entry in this batch — an existing " +
            "document id or name; must already exist. Omit to use the canvas's default itinerary, " +
            "which IS created on demand if none exists.",
        },
      },
      required: ["events"],
    },
  },
  {
    name: "canvas_map_add_batch",
    description:
      "Place pins AND itinerary entries in ONE call — the highest-leverage tool " +
      "for building a trip from scratch. Normally an itinerary entry references " +
      "pins by their real ids, so you'd have to add pins, read back their ids, " +
      "THEN add events — two-plus round trips. Here you give each pin a `clientId` " +
      "(any short handle you choose, e.g. \"hotel\" or \"p1\") and let events " +
      "reference those not-yet-created pins via clientPinIds / clientPinId / " +
      "fromClientId / toClientId. The server mints the real pin ids, resolves your " +
      "client refs against them, and writes pins + events with a single live " +
      "update — a whole 13-pin / 8-event itinerary in ONE call. Events may also " +
      "reference ALREADY-EXISTING pins by real id (pinIds/pinId/fromPinId/toPinId); " +
      "the two styles compose. Use canvas_pin_add_batch or canvas_event_add_batch " +
      "instead when you only need one of the two.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pins: {
          type: "array",
          description:
            "Pins to place. Give a pin a `clientId` when an event in this same call needs to reference it.",
          items: {
            type: "object" as const,
            properties: {
              clientId: {
                type: "string",
                description:
                  "Your temporary handle for this pin (e.g. \"hotel\", \"p1\"). Events in the SAME call " +
                  "reference it via clientPinIds/clientPinId/fromClientId/toClientId. Must be unique within " +
                  "the batch. Not stored — it only wires up references. Omit for pins no event points at.",
              },
              pinType: { type: "string", enum: ["marker", "annotation"] },
              lat: { type: "number" },
              lng: { type: "number" },
              label: { type: "string" },
              body: { type: "string" },
              color: { type: "string" },
              document: {
                type: "string",
                description:
                  "Per-pin override of the target map document. Usually omit and set `document` once at top level.",
              },
            },
            required: ["pinType", "lat", "lng"],
          },
        },
        events: {
          type: "array",
          description:
            "Itinerary entries to add. Reference pins from `pins` above by their clientId, or existing pins by real id.",
          items: {
            type: "object" as const,
            properties: {
              title: { type: "string" },
              start: {
                type: "string",
                description: "Timezone-aware ISO-8601 instant (include offset or Z), e.g. 2024-06-01T18:00:00-05:00.",
              },
              end: { type: "string", description: "End / arrival instant, timezone-aware ISO-8601." },
              timezone: { type: "string", description: "IANA timezone of THIS entry's location, e.g. 'Asia/Tokyo'." },
              clientPinIds: {
                type: "array",
                items: { type: "string" },
                description:
                  "clientIds of pins (declared in `pins` above) this entry covers. Resolved to real ids server-side.",
              },
              clientPinId: { type: "string", description: "Single pin (by clientId) this entry takes place at." },
              fromClientId: { type: "string", description: "Origin pin (by clientId) for a travel segment." },
              toClientId: { type: "string", description: "Destination pin (by clientId) for a travel segment." },
              pinIds: {
                type: "array",
                items: { type: "string" },
                description: "Real ids of ALREADY-EXISTING pins this entry covers (composes with clientPinIds).",
              },
              pinId: { type: "string", description: "Single already-existing pin by real id. Legacy." },
              fromPinId: { type: "string", description: "Origin pin by real id (already-existing)." },
              toPinId: { type: "string", description: "Destination pin by real id (already-existing)." },
              travelMode: {
                type: "string",
                enum: ["flight", "train", "drive"],
                description: "Travel mode. Required when a from/to pin (client or real) is set.",
              },
              dayTag: { type: "string", description: "Optional short day-cluster prefix, e.g. 'DAY 1'." },
              cost: { type: "number", description: "Optional cost; summed into per-day and grand totals." },
              document: {
                type: "string",
                description: "Per-entry override of the target itinerary document.",
              },
            },
            required: ["title", "start"],
          },
        },
        document: {
          type: "string",
          description:
            "Shared target MAP document for every pin in this batch — an existing document id or name; must " +
            "already exist. Omit to use the canvas's default map doc, created on demand if none exists.",
        },
        itineraryDocument: {
          type: "string",
          description:
            "Shared target ITINERARY document for every event in this batch — an existing document id or name; " +
            "must already exist. Omit to use the canvas's default itinerary, created on demand if none exists.",
        },
      },
    },
  },
  {
    name: "canvas_event_update",
    description:
      "Update an existing entry by its ID. Set pinIds to change which pins it " +
      "covers (replaces the whole list; pass [] to clear). To convert an entry " +
      "into a travel segment, set fromPinId + toPinId + travelMode. To edit " +
      "several entries at once, use canvas_event_update_batch instead of " +
      "calling this repeatedly.",
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
    name: "canvas_event_update_batch",
    description:
      "Update MANY itinerary entries in ONE call - the batch counterpart of canvas_event_update. " +
      "Strongly preferred over calling canvas_event_update repeatedly when editing several " +
      "existing entries at once; N one-at-a-time updates become one round trip and one live update.",
    inputSchema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array",
          description: "The entries to update. At least one.",
          items: {
            type: "object" as const,
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              start: {
                type: "string",
                description:
                  "Timezone-aware ISO-8601 instant (include offset or Z), e.g. 2024-06-01T18:00:00-05:00.",
              },
              end: { type: "string", description: "End / arrival instant, timezone-aware ISO-8601." },
              timezone: {
                type: "string",
                description: "IANA timezone of the location, e.g. 'America/Chicago'.",
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
                description: "Short prefix for the map day label, e.g. 'DAY 1'.",
              },
              cost: {
                type: "number",
                description: "Cost of this entry; updating re-totals the itinerary live.",
              },
            },
            required: ["id"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "canvas_event_delete",
    description: "Delete an event by its ID.",
    inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "canvas_event_delete_batch",
    description:
      "Delete MANY itinerary entries in ONE call — the batch counterpart of canvas_event_delete. " +
      "Strongly preferred over calling canvas_event_delete repeatedly when removing several " +
      "entries at once; N one-at-a-time deletes become one round trip and one live update.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Event ids to delete. At least one." },
      },
      required: ["ids"],
    },
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
        document: {
          type: "string",
          description:
            "Which notes document (tab) to add this note to — an existing document id or name; " +
            "the named document must already exist (create it first with canvas_document_add). " +
            "Omit to use the canvas's default notes doc, which IS created on demand if none exists.",
        },
      },
      required: ["body"],
    },
  },
  {
    name: "canvas_note_add_batch",
    description:
      "Add MANY notes in ONE call — the batch counterpart of canvas_note_add. " +
      "Strongly preferred over calling canvas_note_add repeatedly when adding " +
      "several notes at once: the whole array persists in a single write and " +
      "fires one live update, instead of one round trip per note. Returns the " +
      "created notes (with their generated ids), in input order.",
    inputSchema: {
      type: "object" as const,
      properties: {
        notes: {
          type: "array",
          description: "The notes to add. At least one.",
          items: {
            type: "object" as const,
            properties: {
              body: { type: "string" },
              parentId: { type: "string" },
              parentKind: { type: "string", enum: ["pin", "event"] },
              imageRefs: { type: "array", items: { type: "string" } },
              document: {
                type: "string",
                description:
                  "Per-note override of the target notes document. Usually omit and set " +
                  "`document` once at the top level for the whole batch.",
              },
            },
            required: ["body"],
          },
        },
        document: {
          type: "string",
          description:
            "Shared target notes document (tab) for every note in this batch — an existing " +
            "document id or name; the named document must already exist. Omit to use the " +
            "canvas's default notes doc, which IS created on demand if none exists.",
        },
      },
      required: ["notes"],
    },
  },
  {
    name: "canvas_note_update",
    description:
      "Update an existing note by its ID. To edit several notes at once, use " +
      "canvas_note_update_batch instead of calling this repeatedly.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        body: { type: "string" },
        parentId: { type: "string" },
        parentKind: { type: "string", enum: ["pin", "event"] },
        imageRefs: { type: "array", items: { type: "string" } },
        sortOrder: {
          type: "number",
          description:
            "Position within the notes document (0 = first). Notes are appended on create; " +
            "set this to reorder. Renumber the whole document densely (0..n-1) rather than " +
            "leaving gaps.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "canvas_note_update_batch",
    description:
      "Update MANY notes in ONE call - the batch counterpart of canvas_note_update. Strongly " +
      "preferred over calling canvas_note_update repeatedly when editing several existing notes " +
      "at once; N one-at-a-time updates become one round trip and one live update.",
    inputSchema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array",
          description: "The notes to update. At least one.",
          items: {
            type: "object" as const,
            properties: {
              id: { type: "string" },
              body: { type: "string" },
              parentId: { type: "string" },
              parentKind: { type: "string", enum: ["pin", "event"] },
              imageRefs: { type: "array", items: { type: "string" } },
              sortOrder: {
                type: "number",
                description: "Position within the notes document (0 = first).",
              },
            },
            required: ["id"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "canvas_note_delete",
    description: "Delete a note by its ID.",
    inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "canvas_note_delete_batch",
    description:
      "Delete MANY notes in ONE call — the batch counterpart of canvas_note_delete. Strongly " +
      "preferred over calling canvas_note_delete repeatedly when removing several notes at once; " +
      "N one-at-a-time deletes become one round trip and one live update.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Note ids to delete. At least one." },
      },
      required: ["ids"],
    },
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
        assignee: {
          type: "string",
          enum: ["agent", "human"],
          description:
            "Mark who the item is FOR. 'agent' = an agent task pulled via " +
            "canvas_roadmap_task_list and executed by a session; 'human' (default) " +
            "= a human goal. Omit for a human goal.",
        },
        sortOrder: { type: "number", description: "Position among siblings; higher = later." },
        document: {
          type: "string",
          description:
            "Which roadmap document (tab) to add this item to — an existing document id or name; " +
            "the named document must already exist (create it first with canvas_document_add). " +
            "Omit to use the canvas's default roadmap, which IS created on demand if none exists.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "canvas_roadmap_item_add_batch",
    description:
      "Add MANY roadmap items in ONE call — the batch counterpart of " +
      "canvas_roadmap_item_add. Strongly preferred over calling " +
      "canvas_roadmap_item_add repeatedly when seeding several goals/tasks at " +
      "once: the whole array persists in a single write and fires one live " +
      "update, instead of one round trip per item. Returns the created items " +
      "(with their generated ids), in input order.",
    inputSchema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array",
          description: "The roadmap items to add. At least one.",
          items: {
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
                  "'Next' / 'Later' or 'v1' / 'v2'. Only meaningful on top-level items.",
              },
              assignee: {
                type: "string",
                enum: ["agent", "human"],
                description: "'agent' = an agent task; 'human' (default) = a human goal.",
              },
              sortOrder: { type: "number", description: "Position among siblings; higher = later." },
              document: {
                type: "string",
                description:
                  "Per-item override of the target roadmap document. Usually omit and set " +
                  "`document` once at the top level for the whole batch.",
              },
            },
            required: ["title"],
          },
        },
        document: {
          type: "string",
          description:
            "Shared target roadmap document (tab) for every item in this batch — an existing " +
            "document id or name; the named document must already exist. Omit to use the " +
            "canvas's default roadmap, which IS created on demand if none exists.",
        },
      },
      required: ["items"],
    },
  },
  {
    name: "canvas_roadmap_item_update",
    description:
      "Update a roadmap item by its ID. Set stage to move a top-level goal " +
      "between phase bands ('' clears the phase / unstages it). Set assignee to " +
      "mark it as an agent task ('agent') or clear the mark ('human'). To edit " +
      "several roadmap items at once, use canvas_roadmap_item_update_batch " +
      "instead of calling this repeatedly.",
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
        assignee: {
          type: "string",
          enum: ["agent", "human"],
          description: "'agent' marks it an agent task; 'human' clears the mark.",
        },
        sortOrder: { type: "number" },
      },
      required: ["id"],
    },
  },
  {
    name: "canvas_roadmap_item_update_batch",
    description:
      "Update MANY roadmap items in ONE call - the batch counterpart of canvas_roadmap_item_update. " +
      "Strongly preferred over calling canvas_roadmap_item_update repeatedly when editing several " +
      "existing items at once; N one-at-a-time updates become one round trip and one live update.",
    inputSchema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array",
          description: "The roadmap items to update. At least one.",
          items: {
            type: "object" as const,
            properties: {
              id: { type: "string" },
              parentId: { type: "string" },
              title: { type: "string" },
              body: { type: "string" },
              status: { type: "string", enum: ["todo", "in_progress", "done", "blocked"] },
              stage: {
                type: "string",
                description: "Phase label (e.g. 'Now', 'v2'). Pass '' to clear the phase (unstage).",
              },
              assignee: {
                type: "string",
                enum: ["agent", "human"],
                description: "'agent' marks it an agent task; 'human' clears the mark.",
              },
              sortOrder: { type: "number" },
            },
            required: ["id"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "canvas_roadmap_task_list",
    description:
      "List the roadmap's AGENT tasks: goals a human marked (assignee='agent') " +
      "for an agent session to execute. Returns { tasks: [{id, title, status, " +
      "body?, stage?, parentId?, hasOpenTask, linkedTasks?}] }. This is the " +
      "roadmap-side work queue — use it to pull work to do, then " +
      "canvas_roadmap_item_update to move a task's status to 'in_progress' / " +
      "'done' as you go. `hasOpenTask` is false when no still-actionable task " +
      "(proposed/approved/executing) links the goal yet: if you intend to work " +
      "it, propose a task with canvas_task_add and linkedIds:[<goal id>] so the " +
      "human can approve a concrete unit of work. `linkedTasks` lists the tasks " +
      "already pointing at the goal (id + state).",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "canvas_roadmap_item_delete",
    description: "Delete a roadmap item by its ID. Children are deleted via cascade.",
    inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "canvas_roadmap_item_delete_batch",
    description:
      "Delete MANY roadmap items in ONE call — the batch counterpart of canvas_roadmap_item_delete. " +
      "Strongly preferred over calling canvas_roadmap_item_delete repeatedly when removing several " +
      "items at once; N one-at-a-time deletes become one round trip and one live update. Each " +
      "item's children are deleted via cascade, same as the single delete.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Roadmap item ids to delete. At least one.",
        },
      },
      required: ["ids"],
    },
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
    name: "canvas_sheet_delete_batch",
    description:
      "Delete MANY sheets in ONE call — the batch counterpart of canvas_sheet_delete. Strongly " +
      "preferred over calling canvas_sheet_delete repeatedly when removing several sheets at once; " +
      "N one-at-a-time deletes become one round trip and one live update. Each sheet's rows are " +
      "deleted along with it, same as the single delete.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Sheet ids to delete. At least one." },
      },
      required: ["ids"],
    },
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
    name: "canvas_sheet_column_add_batch",
    description:
      "Add MANY columns to a sheet in ONE call — the batch counterpart of " +
      "canvas_sheet_column_add. Strongly preferred over calling the single-item tool " +
      "repeatedly when defining a sheet's schema (several columns at once): the whole " +
      "array persists in a single write and fires one live update, instead of one round " +
      "trip per column. Column types: text | number | date | checkbox.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sheetId: { type: "string" },
        columns: {
          type: "array",
          description: "The columns to add. At least one.",
          items: {
            type: "object" as const,
            properties: {
              name: { type: "string" },
              type: { type: "string", enum: ["text", "number", "date", "checkbox"] },
              sortOrder: { type: "number" },
            },
            required: ["name", "type"],
          },
        },
      },
      required: ["sheetId", "columns"],
    },
  },
  {
    name: "canvas_sheet_column_update",
    description:
      "Rename a column, change its type, or reorder it within the sheet. To edit " +
      "several columns at once, use canvas_sheet_column_update_batch instead of " +
      "calling this repeatedly.",
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
    name: "canvas_sheet_column_update_batch",
    description:
      "Update MANY columns in ONE call - the batch counterpart of canvas_sheet_column_update. " +
      "Strongly preferred over calling canvas_sheet_column_update repeatedly when editing several " +
      "existing columns at once; N one-at-a-time updates become one round trip and one live update. " +
      "Each item carries its own sheetId + columnId, so a single call can span multiple sheets.",
    inputSchema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array",
          description: "The columns to update. At least one.",
          items: {
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
      },
      required: ["items"],
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
    name: "canvas_sheet_column_delete_batch",
    description:
      "Delete MANY columns in ONE call — the batch counterpart of canvas_sheet_column_delete. " +
      "Strongly preferred over calling canvas_sheet_column_delete repeatedly when removing " +
      "several columns at once; N one-at-a-time deletes become one round trip and one live " +
      "update. Each item carries its own sheetId + columnId, so a single call can span multiple " +
      "sheets. Also strips each column's data from every row (non-reversible).",
    inputSchema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array",
          description: "The columns to delete. At least one.",
          items: {
            type: "object" as const,
            properties: {
              sheetId: { type: "string" },
              columnId: { type: "string" },
            },
            required: ["sheetId", "columnId"],
          },
        },
      },
      required: ["items"],
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
    name: "canvas_sheet_row_add_batch",
    description:
      "Add MANY rows to a sheet in ONE call — the batch counterpart of canvas_sheet_row_add. " +
      "Strongly preferred over calling the single-item tool repeatedly: spreadsheets are " +
      "inherently many-row, so batching an N-row add turns N round trips (and N live " +
      "updates) into one. Each row's `data` is an object of cell values keyed by either the " +
      "column NAME (e.g. \"Task\", case-insensitive) or the column.id — names are resolved to " +
      "ids server-side. Values: strings for text/date, numbers for number, booleans for checkbox.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sheetId: { type: "string" },
        rows: {
          type: "array",
          description: "The rows to add. At least one.",
          items: {
            type: "object" as const,
            properties: {
              data: { type: "object" },
              sortOrder: { type: "number" },
            },
          },
        },
      },
      required: ["sheetId", "rows"],
    },
  },
  {
    name: "canvas_sheet_row_update",
    description:
      "Update a row by ID. `data` is merged into the existing row data — keys not present " +
      "are left untouched; setting a key to null clears that cell. Cells may be keyed by " +
      "column NAME (case-insensitive) or column.id; names are resolved to ids server-side. " +
      "To edit several rows at once, use canvas_sheet_row_update_batch instead of calling " +
      "this repeatedly.",
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
    name: "canvas_sheet_row_update_batch",
    description:
      "Update MANY rows in ONE call - the batch counterpart of canvas_sheet_row_update. Strongly " +
      "preferred over calling canvas_sheet_row_update repeatedly when editing several existing " +
      "rows at once; N one-at-a-time updates become one round trip and one live update. Each row's " +
      "`data` is merged into the existing row data — keys not present are left untouched, setting " +
      "a key to null clears that cell. Cells may be keyed by column NAME (case-insensitive) or " +
      "column.id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array",
          description: "The rows to update. At least one.",
          items: {
            type: "object" as const,
            properties: {
              id: { type: "string" },
              data: { type: "object" },
              sortOrder: { type: "number" },
            },
            required: ["id"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "canvas_sheet_row_delete",
    description: "Delete a sheet row by its ID.",
    inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "canvas_sheet_row_delete_batch",
    description:
      "Delete MANY rows in ONE call — the batch counterpart of canvas_sheet_row_delete. Strongly " +
      "preferred over calling canvas_sheet_row_delete repeatedly when removing several rows at " +
      "once (spreadsheets are inherently many-row): N one-at-a-time deletes become one round trip " +
      "and one live update.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Sheet row ids to delete. At least one.",
        },
      },
      required: ["ids"],
    },
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
    name: "canvas_chart_add_batch",
    description:
      "Add MANY charts in ONE call — the batch counterpart of canvas_chart_add. Strongly " +
      "preferred over calling canvas_chart_add repeatedly when adding several charts at once " +
      "(e.g. one chart per category from the same sheet): the whole array persists in a single " +
      "write and fires one live update, instead of one round trip per chart. Each entry takes " +
      "the SAME fields as canvas_chart_add (sheetId, chartType, xColumn, yColumns, sortOrder) " +
      "and gets its own 1:1 backing chart document, same as the single-item tool. Returns the " +
      "created charts (with their generated ids), in input order.",
    inputSchema: {
      type: "object" as const,
      properties: {
        charts: {
          type: "array",
          description: "The charts to add. At least one.",
          items: {
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
      },
      required: ["charts"],
    },
  },
  {
    name: "canvas_chart_update",
    description:
      "Update a chart by ID. Any of name, sheetId, chartType, xColumn, yColumns, sortOrder " +
      "may be set. Column refs (xColumn / yColumns) may be names or ids; resolved server-side. " +
      "To edit several charts at once, use canvas_chart_update_batch instead of calling this " +
      "repeatedly.",
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
    name: "canvas_chart_update_batch",
    description:
      "Update MANY charts in ONE call - the batch counterpart of canvas_chart_update. Strongly " +
      "preferred over calling canvas_chart_update repeatedly when editing several existing charts " +
      "at once; N one-at-a-time updates become one round trip and one live update.",
    inputSchema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array",
          description: "The charts to update. At least one.",
          items: {
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
      },
      required: ["items"],
    },
  },
  {
    name: "canvas_chart_delete",
    description: "Delete a chart by its ID.",
    inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "canvas_chart_delete_batch",
    description:
      "Delete MANY charts in ONE call — the batch counterpart of canvas_chart_delete. Strongly " +
      "preferred over calling canvas_chart_delete repeatedly when removing several charts at " +
      "once; N one-at-a-time deletes become one round trip and one live update.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Chart ids to delete. At least one." },
      },
      required: ["ids"],
    },
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
    name: "canvas_form_delete_batch",
    description:
      "Delete MANY forms in ONE call — the batch counterpart of canvas_form_delete. Strongly " +
      "preferred over calling canvas_form_delete repeatedly when removing several forms at once; " +
      "N one-at-a-time deletes become one round trip and one live update. (Rows/pins they already " +
      "produced are unaffected.)",
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Form ids to delete. At least one." },
      },
      required: ["ids"],
    },
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
        type: { type: "string", enum: ["navigate", "task"] },
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
  {
    name: "canvas_task_add",
    description:
      "Add a task to the canvas work queue for a future agent session to implement. " +
      "Enters state 'proposed'; a human approves it in the web UI before any session " +
      "picks it up. Keep `body` a concise brief — heavy context belongs in roadmap " +
      "items / notes referenced via linkedIds, which canvas_task_get hydrates later. " +
      "The created task gets a per-canvas ticket ID (e.g. 'TDM-142'), returned as " +
      "`ticketId` — the short handle for referring to the task in commits and chat.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Short imperative title, e.g. 'Add CSV export to sheets'." },
        body: { type: "string", description: "Concise brief: what to do, acceptance criteria." },
        linkedIds: {
          type: "array",
          items: { type: "string" },
          description: "Roadmap item / note ids carrying the detailed context.",
        },
        assignee: {
          type: "string",
          enum: ["agent", "human"],
          description:
            "Who the task is FOR. 'agent' (default) = an agent session executes it; " +
            "'human' = the human's own todo, invisible to the agent queue.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "canvas_task_add_batch",
    description:
      "Add MANY tasks to the canvas work queue in ONE call — the batch counterpart of " +
      "canvas_task_add. Strongly preferred over calling canvas_task_add repeatedly when " +
      "proposing a whole plan (e.g. breaking a project into 8 tasks): the whole array " +
      "persists via a single write and fires one live update, instead of one round trip " +
      "per task. Each task takes the SAME fields as canvas_task_add (title, body, " +
      "linkedIds, assignee) and enters state 'proposed' — a human approves each in the " +
      "web UI before any session picks it up.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tasks: {
          type: "array",
          description: "The tasks to add. At least one.",
          items: {
            type: "object" as const,
            properties: {
              title: { type: "string", description: "Short imperative title, e.g. 'Add CSV export to sheets'." },
              body: { type: "string", description: "Concise brief: what to do, acceptance criteria." },
              linkedIds: {
                type: "array",
                items: { type: "string" },
                description: "Roadmap item / note ids carrying the detailed context.",
              },
              assignee: {
                type: "string",
                enum: ["agent", "human"],
                description:
                  "Who the task is FOR. 'agent' (default) = an agent session executes it; " +
                  "'human' = the human's own todo, invisible to the agent queue.",
              },
            },
            required: ["title"],
          },
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "canvas_task_list",
    description:
      "List AGENT tasks as a compact queue: {id, ticketId?, title, state, assignee, " +
      "proposedBy, result?, createdAt} — no bodies or linked context. START HERE when looking for " +
      "work instead of canvas_state_read; then canvas_task_get exactly the task you'll " +
      "work on. state='approved' = ready to pick up. Human todos are excluded by " +
      "default; pass assignee='human' or 'any' to see them.",
    inputSchema: {
      type: "object" as const,
      properties: {
        state: {
          type: "string",
          enum: ["proposed", "approved", "rejected", "executing", "done", "failed"],
        },
        assignee: {
          type: "string",
          enum: ["agent", "human", "any"],
          description: "Default 'agent' — the queue meant for agent sessions.",
        },
      },
    },
  },
  {
    name: "canvas_task_get",
    description:
      "Read one task by id with its linked context hydrated: returns { action, linked } " +
      "where linked[] contains the referenced roadmap items / notes (title, body, status). " +
      "Everything a session needs to start work — no full state pull required.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "canvas_task_start",
    description:
      "Claim an approved task before working on it (approved → executing) so other " +
      "sessions listing the queue skip it. The claim is ATOMIC: if another session " +
      "already claimed it you get { claimed: false, claimedBy } back — do not work " +
      "on that task; call canvas_task_list (state 'approved') and pick the next one. " +
      "The claimant name (agentName, or your agent_register identity) shows on the board. " +
      "The returned action carries the task's `ticketId` (e.g. 'TDM-142') — include " +
      "that ticket ID in any commit messages for this work so the commits trace back " +
      "to the task.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        agentName: {
          type: "string",
          description:
            "Name to record as the claimant (defaults to your agent_register identity).",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "canvas_task_complete",
    description:
      "Finish a task with a result summary. Marks it 'done' (or 'failed' via status) — " +
      "auto-claims first if you skipped canvas_task_start. `result` should be a short " +
      "human-readable summary of what was done, INCLUDING the commit hash(es) of the " +
      "work when commits were made; it shows in the web Tasks panel.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        result: { type: "string", description: "What was done / where — include the commit hash(es), PR, or files touched." },
        status: { type: "string", enum: ["done", "failed"] },
        error: { type: "string", description: "Failure detail when status='failed'." },
      },
      required: ["id", "result"],
    },
  },
];

// The optional handle every non-connector tool accepts so the model can re-bind
// a call to its canvas even after the hosted MCP connection resets. See the
// model-carried binding note in handleTool and Gateway.exportSession.
const SESSION_ARG = {
  type: "string",
  description:
    "Session handle returned by canvas_connect / canvas_create. Pass it on EVERY call so this " +
    "operation still targets your canvas even if the hosted MCP connection was reset between " +
    "calls. Omit only if you have not connected yet.",
} as const;

const CONNECTORS = new Set(["canvas_connect", "canvas_create"]);

/**
 * MCP tool annotations (behaviour hints). Clients — notably the Claude.ai web
 * connector — use these to decide how to gate a call for user consent: a
 * `readOnlyHint` tool can be auto-approved / batched instead of prompting for
 * each one, which is what was stalling read-heavy sessions with the connector's
 * per-call "approve?" gate. Derived by name so we don't hand-annotate ~60 tools:
 *   - *_read / *_list / *_get           → read-only
 *   - *_delete / *_delete_batch         → write + destructive
 *   - everything else (add/update/set…) → write, non-destructive
 * `openWorldHint: false` on all of them — every tool acts on the bound canvas,
 * a closed system, not the open internet.
 */
function annotationsFor(name: string): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
} {
  const readOnly = /_(read|list|get)$/.test(name);
  const destructive = /_delete(_batch)?$/.test(name);
  return {
    readOnlyHint: readOnly,
    // Only meaningful when not read-only; keep it false for plain writes so
    // clients don't over-warn on routine add/update calls.
    destructiveHint: destructive,
    openWorldHint: false,
  };
}

// Advertise `session` on every tool except the two that establish the binding,
// and attach behaviour annotations to every tool.
export const TOOLS = RAW_TOOLS.map((tool) => {
  const annotations = annotationsFor(tool.name);
  if (CONNECTORS.has(tool.name)) {
    return { ...tool, annotations };
  }
  return {
    ...tool,
    annotations,
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...tool.inputSchema.properties, session: SESSION_ARG },
    },
  };
});
