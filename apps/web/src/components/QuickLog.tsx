import { useEffect, useMemo, useRef, useState } from "react";
import {
  Utensils,
  Banknote,
  MapPin,
  Dumbbell,
  ClipboardList,
  ListPlus,
  Droplet,
  Moon,
  Plus,
  X,
  Check,
  Zap,
  ChevronLeft,
  Sparkles,
  ChevronsLeft,
  ChevronsRight,
  type LucideIcon,
} from "lucide-react";
import type { Form, FormField } from "../types";
import { submitForm } from "../lib/api";

/* ─────────────────────────────────────────────────────────────────────────────
   QuickLog — the Direct-input layer access surface.

   Renders the canvas's agent-defined forms (state.forms) and submits them to
   POST /api/canvas/forms/{id}/submit. No agent in the submit loop: the recipe
   was compiled once at definition time; a tap resolves it server-side into a
   row/pin mutation and the board updates over WS.

   One dock, two densities — toggled from the dock itself, choice remembered:
     • collapsed — chip rail in the right gutter; OVERLAYS the mode (input-only,
       confirms via toast). Peripheral, out of the way for a 2-second tap.
     • expanded  — full-height right column that REFLOWS the mode narrower (so the
       sheet/chart you're logging against stays visible and updates beside you);
       forms on top, running log below.
   ──────────────────────────────────────────────────────────────────────────── */

// Visual identity for a form (forms themselves are content, not chrome — the
// icon/accent are derived deterministically so the same form looks stable).
const ICONS: LucideIcon[] = [Utensils, Banknote, Dumbbell, Droplet, Moon, ClipboardList, ListPlus];
const ACCENTS = ["#10B981", "#F59E0B", "#0EA5E9", "#F43F5E", "#8B5CF6", "#14B8A6", "#EC4899"];

interface QuickForm {
  id: string;
  name: string;
  Icon: LucideIcon;
  accent: string;
  /** Human-readable description of what submitting fans out to. */
  fanout: string;
  fields: FormField[];
}

function describeFanout(form: Form): string {
  const parts = (form.actions ?? []).map((a) => {
    if (a.op === "pin.patch") return "Updates a pin";
    const sheet = a.target?.sheet ?? "a sheet";
    return a.op === "sheet.row.upsert" ? `Updates ${sheet}` : `Adds a row to ${sheet}`;
  });
  return Array.from(new Set(parts)).join(" · ") || "Updates the canvas";
}

function pickIcon(form: Form, idx: number): LucideIcon {
  if ((form.actions ?? []).some((a) => a.op === "pin.patch")) return MapPin;
  return ICONS[idx % ICONS.length];
}

function toQuickForm(form: Form, idx: number): QuickForm {
  return {
    id: form.id,
    name: form.name || "Untitled form",
    Icon: pickIcon(form, idx),
    accent: ACCENTS[idx % ACCENTS.length],
    fanout: describeFanout(form),
    fields: form.fields ?? [],
  };
}

// hex (#RRGGBB) + alpha byte → tint string.
function tint(hex: string, alpha: string): string {
  return `${hex}${alpha}`;
}

interface LogEntry {
  id: number;
  Icon: LucideIcon;
  accent: string;
  title: string;
  detail: string;
  time: string;
}

interface Toast {
  id: number;
  Icon: LucideIcon;
  accent: string;
  title: string;
  detail: string;
}

const EXPANDED_KEY = "tandem.quicklog.expanded";

export default function QuickLog({ code, forms }: { code: string; forms?: Record<string, Form> }) {
  const quickForms = useMemo(() => {
    const list = Object.values(forms ?? {}).sort((a, b) => a.sortOrder - b.sortOrder);
    return list.map(toQuickForm);
  }, [forms]);

  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem(EXPANDED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false); // mobile bottom sheet
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const seq = useRef(0);

  const openForm = quickForms.find((f) => f.id === openId) ?? null;

  function setExpandedPersist(next: boolean) {
    setExpanded(next);
    setOpenId(null);
    try {
      localStorage.setItem(EXPANDED_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  // Esc closes whatever's open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpenId(null);
      setSheetOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function summarize(form: QuickForm, values: Record<string, string | boolean>): string {
    const parts = form.fields
      .map((f) => values[f.key])
      .filter((v) => v !== "" && v !== false && v != null)
      .slice(0, 2)
      .map(String);
    return parts.join(" · ") || form.name;
  }

  function pushToast(t: Omit<Toast, "id">) {
    const id = ++seq.current;
    setToasts((ts) => [...ts, { ...t, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 3600);
  }

  async function handleSubmit(form: QuickForm, values: Record<string, string | boolean>) {
    const title = summarize(form, values);
    const id = ++seq.current;
    // Optimistic recent-log entry; the canvas itself updates via WS broadcast.
    setLog((l) => [{ id, Icon: form.Icon, accent: form.accent, title, detail: form.fanout, time: "just now" }, ...l].slice(0, 30));
    if (!expanded) {
      pushToast({ Icon: form.Icon, accent: form.accent, title, detail: form.fanout });
    }
    setOpenId(null);
    setSheetOpen(false);

    try {
      const submissionId = crypto.randomUUID();
      await submitForm(code, form.id, values, submissionId);
    } catch (err) {
      // Roll the optimistic entry back and surface the failure.
      setLog((l) => l.filter((e) => e.id !== id));
      pushToast({
        Icon: X,
        accent: "#DC2626",
        title: "Couldn't log that",
        detail: err instanceof Error ? err.message : "Submit failed",
      });
    }
  }

  function showAgentHint() {
    pushToast({ Icon: Sparkles, accent: "#64748B", title: "Agent-defined", detail: "Ask your agent: “add a meal logger to this canvas.”" });
  }

  const hasForms = quickForms.length > 0;

  return (
    <>
      {/* ── Desktop COLLAPSED: chip rail in the right gutter (overlays mode) ─── */}
      {!expanded && (
        <div className="absolute right-4 top-1/2 z-20 hidden -translate-y-1/2 sm:block">
          <div className="relative">
            {/* Card is absolutely positioned OFF the chip column, so opening it
                never resizes/moves the chips (fixes the centering jank). */}
            {openForm && (
              <div className="absolute right-full top-1/2 mr-2.5 w-[264px] -translate-y-1/2 animate-[quicklog-in_140ms_ease-out]">
                <FormCard form={openForm} onSubmit={handleSubmit} onClose={() => setOpenId(null)} />
              </div>
            )}

            <div className="flex flex-col items-center gap-2 rounded-2xl border border-ink/10 bg-white/85 p-1.5 shadow-[2px_3px_0_rgba(17,17,17,0.06)] backdrop-blur">
              <button
                onClick={() => setExpandedPersist(true)}
                title="Expand log"
                className="flex h-7 w-11 items-center justify-center rounded-lg text-ink/30 transition-colors hover:bg-ink/5 hover:text-ink/60"
              >
                <ChevronsLeft size={16} strokeWidth={1.75} />
              </button>
              <div className="h-px w-6 bg-ink/10" />
              {quickForms.map((f) => {
                const active = f.id === openId;
                return (
                  <button
                    key={f.id}
                    onClick={() => setOpenId(active ? null : f.id)}
                    title={f.name}
                    className="flex h-11 w-11 items-center justify-center rounded-xl transition-all hover:scale-105"
                    style={{
                      backgroundColor: active ? tint(f.accent, "1F") : "transparent",
                      boxShadow: active ? `inset 0 0 0 1.5px ${f.accent}` : undefined,
                    }}
                  >
                    <f.Icon size={18} strokeWidth={1.75} style={{ color: f.accent }} />
                  </button>
                );
              })}
              <div className="my-0.5 h-px w-6 bg-ink/10" />
              <button
                title="Forms are defined by your agent — ask it to add one"
                onClick={showAgentHint}
                className="flex h-11 w-11 items-center justify-center rounded-xl text-ink/35 transition-colors hover:bg-ink/5 hover:text-ink/60"
              >
                <Plus size={18} strokeWidth={1.75} />
              </button>
              <span className="select-none pb-0.5 text-[9px] font-medium uppercase tracking-[0.14em] text-ink/35">Log</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Desktop EXPANDED: full-height right column; in-flow so the mode
            reflows narrower beside it (not overlaid). Forms on top, log below. */}
      {expanded && (
        <div className="z-20 hidden w-[300px] shrink-0 flex-col border-l border-ink/10 bg-white/90 backdrop-blur sm:flex">
          <div className="flex items-center justify-between border-b border-ink/10 px-3 py-3 pl-4">
            <span className="flex items-center gap-2 text-sm font-semibold text-ink">
              {openForm ? (
                <button onClick={() => setOpenId(null)} className="flex items-center gap-1 text-ink/50 hover:text-ink/80">
                  <ChevronLeft size={15} /> All forms
                </button>
              ) : (
                "Quick log"
              )}
            </span>
            <button
              onClick={() => setExpandedPersist(false)}
              title="Collapse to rail"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-ink/35 transition-colors hover:bg-ink/5 hover:text-ink/60"
            >
              <ChevronsRight size={16} strokeWidth={1.75} />
            </button>
          </div>

          {/* Top: either the form list or the active form. */}
          <div className="border-b border-ink/10 p-3">
            {openForm ? (
              <FormCard form={openForm} onSubmit={handleSubmit} onClose={() => setOpenId(null)} flat />
            ) : (
              <div className="flex flex-col gap-1.5">
                {quickForms.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setOpenId(f.id)}
                    className="flex items-center gap-3 rounded-xl border border-ink/10 bg-white p-2.5 text-left transition-colors hover:border-ink/20"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: tint(f.accent, "1A") }}>
                      <f.Icon size={17} strokeWidth={1.75} style={{ color: f.accent }} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink">{f.name}</span>
                      <span className="block truncate text-[11px] text-ink/45">{f.fanout}</span>
                    </span>
                  </button>
                ))}
                {!hasForms && (
                  <p className="px-1 py-2 text-[12px] leading-relaxed text-ink/45">
                    No forms yet. Ask your agent to add one — e.g. “add a meal logger to this canvas.”
                  </p>
                )}
                <button onClick={showAgentHint} className="mt-0.5 flex items-center gap-2 px-1 py-1 text-xs font-medium text-ink/40 hover:text-ink/60">
                  <Plus size={14} /> Agent adds forms here
                </button>
              </div>
            )}
          </div>

          {/* Bottom: the running log. */}
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink/35">Recent</div>
            <div className="flex flex-col gap-1">
              {log.length === 0 && <p className="px-1.5 text-[12px] text-ink/35">Nothing logged yet this session.</p>}
              {log.map((e) => (
                <div key={e.id} className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: tint(e.accent, "1A") }}>
                    <e.Icon size={14} strokeWidth={1.75} style={{ color: e.accent }} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">{e.title}</span>
                    <span className="block text-[11px] text-ink/40">{e.detail}</span>
                  </span>
                  <span className="shrink-0 text-[10px] text-ink/35">{e.time}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Mobile: FAB → bottom sheet (collapse/expand is desktop-only) ────── */}
      <button
        onClick={() => setSheetOpen(true)}
        className="fixed bottom-5 right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-ink text-paper shadow-[3px_3px_0_#C75B39] active:translate-y-px sm:hidden"
        aria-label="Quick log"
      >
        <Plus size={26} />
      </button>

      {sheetOpen && (
        <div className="fixed inset-0 z-40 sm:hidden">
          <div className="absolute inset-0 bg-ink/30 backdrop-blur-[1px]" onClick={() => setSheetOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-3xl border-t border-ink/10 bg-paper p-4 pb-8 animate-[quicklog-up_180ms_ease-out]">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink/15" />
            {openForm ? (
              <FormCard form={openForm} onSubmit={handleSubmit} onClose={() => setOpenId(null)} flat />
            ) : (
              <>
                <h3 className="mb-3 px-1 text-sm font-semibold text-ink">Quick log</h3>
                <div className="flex flex-col gap-1.5">
                  {quickForms.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setOpenId(f.id)}
                      className="flex items-center gap-3 rounded-xl border border-ink/10 bg-white p-3 text-left active:scale-[0.99]"
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: tint(f.accent, "1A") }}>
                        <f.Icon size={19} strokeWidth={1.75} style={{ color: f.accent }} />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-ink">{f.name}</span>
                        <span className="block truncate text-xs text-ink/50">{f.fanout}</span>
                      </span>
                    </button>
                  ))}
                  {!hasForms && (
                    <p className="px-1 py-2 text-[13px] leading-relaxed text-ink/50">
                      No forms yet. Ask your agent to add one — e.g. “add a meal logger to this canvas.”
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Toasts (collapsed view) ─────────────────────────────────────────── */}
      <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex max-w-[92vw] items-center gap-2.5 rounded-xl border border-ink/10 bg-white px-3.5 py-2.5 shadow-[3px_4px_0_rgba(17,17,17,0.08)] animate-[quicklog-up_160ms_ease-out]"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ backgroundColor: tint(t.accent, "1A") }}>
              <t.Icon size={15} strokeWidth={1.75} style={{ color: t.accent }} />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                <span className="truncate">{t.title}</span>
                <Check size={14} style={{ color: t.accent }} />
              </span>
              <span className="block text-xs text-ink/50">{t.detail}</span>
            </span>
          </div>
        ))}
      </div>

      {/* Local keyframes so the component is self-contained. */}
      <style>{`
        @keyframes quicklog-in { from { opacity: 0; transform: translateX(6px) translateY(-50%) } to { opacity: 1; transform: translateX(0) translateY(-50%) } }
        @keyframes quicklog-up { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: translateY(0) } }
      `}</style>
    </>
  );
}

// ── The form itself, shared by rail card, panel, and mobile sheet ────────────
function FormCard({
  form,
  onSubmit,
  onClose,
  flat = false,
}: {
  form: QuickForm;
  onSubmit: (form: QuickForm, values: Record<string, string | boolean>) => void;
  onClose: () => void;
  flat?: boolean;
}) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    // Seed defaults so the dock matches the agent's intent on open.
    const seed: Record<string, string | boolean> = {};
    for (const f of form.fields) {
      if (f.default !== undefined) seed[f.key] = f.type === "checkbox" ? Boolean(f.default) : String(f.default);
    }
    return seed;
  });

  function set(key: string, v: string | boolean) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  const missingRequired = form.fields.some((f) => f.required && (values[f.key] === undefined || values[f.key] === ""));

  return (
    <div className={flat ? "" : "rounded-2xl border border-ink/10 bg-white p-3.5 shadow-[3px_4px_0_rgba(17,17,17,0.08)]"}>
      <div className="mb-2.5 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ backgroundColor: tint(form.accent, "1A") }}>
          <form.Icon size={15} strokeWidth={1.75} style={{ color: form.accent }} />
        </span>
        <span className="flex-1 text-sm font-semibold text-ink">{form.name}</span>
        {!flat && (
          <button onClick={onClose} className="rounded-md p-0.5 text-ink/35 hover:bg-ink/5 hover:text-ink/60" aria-label="Close">
            <X size={15} />
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2.5">
        {form.fields.map((f) => (
          <label key={f.key} className="block">
            <span className="mb-1 block text-xs font-medium text-ink/55">
              {f.label}
              {f.required && <span style={{ color: form.accent }}> *</span>}
            </span>
            {f.type === "select" ? (
              <select
                value={(values[f.key] as string) ?? ""}
                onChange={(e) => set(f.key, e.target.value)}
                className="w-full rounded-lg border border-ink/15 bg-white px-2.5 py-1.5 text-sm text-ink outline-none focus:border-ink/40"
              >
                <option value="">Choose…</option>
                {f.options?.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : f.type === "checkbox" ? (
              <button
                type="button"
                onClick={() => set(f.key, !(values[f.key] as boolean))}
                className="flex items-center gap-2 text-sm text-ink/80"
              >
                <span
                  className="flex h-5 w-5 items-center justify-center rounded-md border"
                  style={{
                    backgroundColor: values[f.key] ? form.accent : "transparent",
                    borderColor: values[f.key] ? form.accent : "rgba(17,17,17,0.2)",
                  }}
                >
                  {values[f.key] && <Check size={13} color="#fff" />}
                </span>
                {values[f.key] ? "Yes" : "No"}
              </button>
            ) : (
              <input
                type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                value={(values[f.key] as string) ?? ""}
                placeholder={f.placeholder}
                onChange={(e) => set(f.key, e.target.value)}
                className="w-full rounded-lg border border-ink/15 bg-white px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink/30 focus:border-ink/40"
              />
            )}
          </label>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-ink/45">
        <Zap size={12} style={{ color: form.accent }} />
        <span className="leading-tight">{form.fanout}</span>
      </div>

      <button
        onClick={() => onSubmit(form, values)}
        disabled={missingRequired}
        className="mt-3 w-full rounded-lg px-3 py-2 text-sm font-semibold text-white transition-opacity disabled:opacity-40"
        style={{ backgroundColor: form.accent }}
      >
        Log
      </button>
    </div>
  );
}
