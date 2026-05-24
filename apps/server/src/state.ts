import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync } from "fs";
import { join } from "path";
import type {
  CanvasState,
  CanvasMode,
  CanvasMeta,
  PendingEdit,
  Pin,
  CanvasEvent,
  Note,
  EntityId,
} from "@agentcanvas/shared";

const DATA_DIR = join(process.cwd(), "canvas-data");
const INDEX_FILE = join(DATA_DIR, "index.json");

interface Registry {
  canvases: CanvasMeta[];
  activeId: string;
}

// ── in-memory singletons ──────────────────────────────────────────────────────
let _registry: Registry = { canvases: [], activeId: "" };
let _state: CanvasState = emptyState();
let _pendingEdits: PendingEdit[] = [];
let _broadcast: ((meta: CanvasMeta, all: CanvasMeta[], s: CanvasState, e: PendingEdit[]) => void) | null = null;
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

// ── helpers ───────────────────────────────────────────────────────────────────
function emptyState(): CanvasState {
  return { version: 0, mode: "map", pins: {}, events: {}, notes: {} };
}

function canvasDir(id: string) {
  return join(DATA_DIR, id);
}

function stateFile(id: string) {
  return join(canvasDir(id), "state.json");
}

export function imagesDir(id: string) {
  return join(canvasDir(id), "images");
}

function saveRegistry() {
  writeFileSync(INDEX_FILE, JSON.stringify(_registry, null, 2));
}

function scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    writeFileSync(stateFile(_registry.activeId), JSON.stringify(_state, null, 2));
  }, 50);
}

function notifyBroadcast() {
  const meta = getActiveCanvasMeta();
  if (meta) _broadcast?.(meta, _registry.canvases, _state, _pendingEdits);
}

function commit(): CanvasState {
  _state = { ..._state, version: _state.version + 1 };
  const idx = _registry.canvases.findIndex(c => c.id === _registry.activeId);
  if (idx >= 0) _registry.canvases[idx].updatedAt = Date.now();
  scheduleSave();
  notifyBroadcast();
  return _state;
}

// ── bootstrap ─────────────────────────────────────────────────────────────────
export function registerBroadcast(fn: NonNullable<typeof _broadcast>) {
  _broadcast = fn;
}

export function loadAll() {
  mkdirSync(DATA_DIR, { recursive: true });

  // Migrate legacy single-canvas layout (canvas-data/state.json → per-canvas dir)
  const legacyState = join(DATA_DIR, "state.json");
  const legacyImages = join(DATA_DIR, "images");
  if (existsSync(legacyState) && !existsSync(INDEX_FILE)) {
    const id = crypto.randomUUID();
    mkdirSync(canvasDir(id), { recursive: true });
    try { writeFileSync(stateFile(id), readFileSync(legacyState)); } catch {}
    if (existsSync(legacyImages)) {
      try { renameSync(legacyImages, imagesDir(id)); } catch {
        mkdirSync(imagesDir(id), { recursive: true });
      }
    }
    _registry = {
      canvases: [{ id, name: "Default", createdAt: Date.now(), updatedAt: Date.now() }],
      activeId: id,
    };
    saveRegistry();
  }

  if (existsSync(INDEX_FILE)) {
    try { _registry = JSON.parse(readFileSync(INDEX_FILE, "utf8")); } catch {}
  }

  if (_registry.canvases.length === 0) {
    const id = crypto.randomUUID();
    _registry = {
      canvases: [{ id, name: "Default", createdAt: Date.now(), updatedAt: Date.now() }],
      activeId: id,
    };
    saveRegistry();
  }

  _loadActiveState();
}

function _loadActiveState() {
  const id = _registry.activeId;
  mkdirSync(imagesDir(id), { recursive: true });
  const sf = stateFile(id);
  if (existsSync(sf)) {
    try { _state = JSON.parse(readFileSync(sf, "utf8")); return; } catch {}
  }
  _state = emptyState();
}

// ── reads ─────────────────────────────────────────────────────────────────────
export function getState() { return _state; }
export function getPendingEdits() { return _pendingEdits; }
export function getActiveId() { return _registry.activeId; }
export function getActiveCanvasMeta(): CanvasMeta {
  return _registry.canvases.find(c => c.id === _registry.activeId)!;
}
export function listCanvases(): CanvasMeta[] {
  return _registry.canvases;
}

// ── canvas management ─────────────────────────────────────────────────────────
export function createCanvas(name: string): CanvasMeta {
  const meta: CanvasMeta = {
    id: crypto.randomUUID(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  _registry.canvases.push(meta);
  _registry.activeId = meta.id;
  _pendingEdits = [];
  mkdirSync(imagesDir(meta.id), { recursive: true });
  _state = emptyState();
  saveRegistry();
  writeFileSync(stateFile(meta.id), JSON.stringify(_state, null, 2));
  notifyBroadcast();
  return meta;
}

export function selectCanvas(id: string): CanvasMeta {
  const meta = _registry.canvases.find(c => c.id === id);
  if (!meta) throw new Error(`Canvas "${id}" not found`);
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  writeFileSync(stateFile(_registry.activeId), JSON.stringify(_state, null, 2));
  _registry.activeId = id;
  _pendingEdits = [];
  saveRegistry();
  _loadActiveState();
  notifyBroadcast();
  return meta;
}

export function renameCanvas(id: string, name: string): CanvasMeta {
  const meta = _registry.canvases.find(c => c.id === id);
  if (!meta) throw new Error(`Canvas "${id}" not found`);
  meta.name = name;
  meta.updatedAt = Date.now();
  saveRegistry();
  notifyBroadcast();
  return meta;
}

export function deleteCanvas(id: string): void {
  if (_registry.canvases.length <= 1) throw new Error("Cannot delete the only canvas");
  const idx = _registry.canvases.findIndex(c => c.id === id);
  if (idx < 0) throw new Error(`Canvas "${id}" not found`);
  _registry.canvases.splice(idx, 1);
  if (_registry.activeId === id) {
    _registry.activeId = _registry.canvases[0].id;
    _pendingEdits = [];
    _loadActiveState();
  }
  saveRegistry();
  try { rmSync(canvasDir(id), { recursive: true, force: true }); } catch {}
  notifyBroadcast();
}

// ── canvas state mutations ────────────────────────────────────────────────────
export function setMode(mode: CanvasMode): CanvasState {
  _state = { ..._state, mode };
  return commit();
}

export function addPin(data: Omit<Pin, "kind" | "updatedAt">): CanvasState {
  const pin: Pin = { ...data, kind: "pin", updatedAt: Date.now() };
  _state = { ..._state, pins: { ..._state.pins, [pin.id]: pin } };
  return commit();
}

export function updatePin(id: EntityId, partial: Partial<Omit<Pin, "id" | "kind">>): CanvasState {
  const existing = _state.pins[id];
  if (!existing) throw new Error(`Pin ${id} not found`);
  _state = {
    ..._state,
    pins: { ..._state.pins, [id]: { ...existing, ...partial, id, kind: "pin", updatedAt: Date.now() } },
  };
  return commit();
}

export function deletePin(id: EntityId): CanvasState {
  const pins = { ..._state.pins };
  delete pins[id];
  _state = { ..._state, pins };
  return commit();
}

export function addEvent(data: Omit<CanvasEvent, "kind" | "updatedAt">): CanvasState {
  const event: CanvasEvent = { ...data, kind: "event", updatedAt: Date.now() };
  _state = { ..._state, events: { ..._state.events, [event.id]: event } };
  return commit();
}

export function updateEvent(id: EntityId, partial: Partial<Omit<CanvasEvent, "id" | "kind">>): CanvasState {
  const existing = _state.events[id];
  if (!existing) throw new Error(`Event ${id} not found`);
  _state = {
    ..._state,
    events: { ..._state.events, [id]: { ...existing, ...partial, id, kind: "event", updatedAt: Date.now() } },
  };
  return commit();
}

export function deleteEvent(id: EntityId): CanvasState {
  const events = { ..._state.events };
  delete events[id];
  _state = { ..._state, events };
  return commit();
}

export function addNote(data: Omit<Note, "kind" | "updatedAt">): CanvasState {
  const note: Note = { ...data, kind: "note", updatedAt: Date.now() };
  _state = { ..._state, notes: { ..._state.notes, [note.id]: note } };
  return commit();
}

export function updateNote(id: EntityId, partial: Partial<Omit<Note, "id" | "kind">>): CanvasState {
  const existing = _state.notes[id];
  if (!existing) throw new Error(`Note ${id} not found`);
  _state = {
    ..._state,
    notes: { ..._state.notes, [id]: { ...existing, ...partial, id, kind: "note", updatedAt: Date.now() } },
  };
  return commit();
}

export function deleteNote(id: EntityId): CanvasState {
  const notes = { ..._state.notes };
  delete notes[id];
  _state = { ..._state, notes };
  return commit();
}

export function addPendingEdit(entityId: EntityId, instruction: string): PendingEdit {
  const edit: PendingEdit = {
    id: crypto.randomUUID(),
    entityId,
    instruction,
    createdAt: Date.now(),
  };
  _pendingEdits = [..._pendingEdits, edit];
  notifyBroadcast();
  return edit;
}

export function completePendingEdit(editId: string): void {
  _pendingEdits = _pendingEdits.filter(e => e.id !== editId);
  notifyBroadcast();
}
