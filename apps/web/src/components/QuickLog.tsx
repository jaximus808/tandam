import { useEffect, useRef, useState } from "react";
import {
  Utensils,
  Banknote,
  MapPin,
  Dumbbell,
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

/* ─────────────────────────────────────────────────────────────────────────────
   QuickLog — PROTOTYPE of the Direct-input layer access surface.

   Visual prototype only: the form definitions below are hard-coded mock data and
   submitting does NOT persist anything — it pushes an entry into an in-memory log
   and a toast describing the fan-out the real backend will perform. The point is
   to feel the ACCESS UX before building the `forms` table / submit endpoint.

   One dock, two densities — toggled from the dock itself, choice remembered:
     • collapsed — chip rail in the right gutter; OVERLAYS the mode (input-only,
       confirms via toast). Peripheral, out of the way for a 2-second tap.
     • expanded  — full-height right column that REFLOWS the mode narrower (so the
       sheet/chart you're logging against stays visible and updates beside you);
       forms on top, running log below.

   When the backend lands: replace MOCK_FORMS with forms read off canvas state,
   make onSubmit POST to /api/canvas/forms/{id}/submit.
   ──────────────────────────────────────────────────────────────────────────── */

type FieldType = "text" | "number" | "date" | "select" | "checkbox";

interface FormField {
  key: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  options?: string[];
  required?: boolean;
}

interface QuickForm {
  id: string;
  name: string;
  Icon: LucideIcon;
  /** 6-digit hex; tints derive from it. */
  accent: string;
  /** Human-readable description of what submitting fans out to. */
  fanout: string;
  fields: FormField[];
}

// ── Mock forms (stand-in for agent-defined forms on canvas state) ─────────────
const MOCK_FORMS: QuickForm[] = [
  {
    id: "meal",
    name: "Log a meal",
    Icon: Utensils,
    accent: "#10B981",
    fanout: "Adds a row to Meals · updates today's calories",
    fields: [
      { key: "meal", label: "Meal", type: "text", placeholder: "Chicken bowl", required: true },
      { key: "calories", label: "Calories", type: "number", placeholder: "620" },
      { key: "when", label: "When", type: "select", options: ["Breakfast", "Lunch", "Dinner", "Snack"] },
    ],
  },
  {
    id: "sale",
    name: "Log a sale",
    Icon: Banknote,
    accent: "#F59E0B",
    fanout: "Adds a row to Sales · updates the revenue chart",
    fields: [
      { key: "client", label: "Client", type: "text", placeholder: "Acme Co.", required: true },
      { key: "amount", label: "Amount ($)", type: "number", placeholder: "2500" },
      { key: "status", label: "Status", type: "select", options: ["Lead", "Won", "Lost"] },
    ],
  },
  {
    id: "visited",
    name: "Mark visited",
    Icon: MapPin,
    accent: "#0EA5E9",
    fanout: "Turns the pin green on the map",
    fields: [
      { key: "place", label: "Place", type: "select", options: ["Shibuya Crossing", "Sensō-ji", "Tokyo Tower", "Kyoto"], required: true },
      { key: "note", label: "Note", type: "text", placeholder: "Loved it — go at dusk" },
    ],
  },
  {
    id: "workout",
    name: "Log workout",
    Icon: Dumbbell,
    accent: "#F43F5E",
    fanout: "Adds a row to Workouts",
    fields: [
      { key: "type", label: "Type", type: "select", options: ["Push", "Pull", "Legs", "Cardio"], required: true },
      { key: "minutes", label: "Minutes", type: "number", placeholder: "45" },
      { key: "pr", label: "New PR?", type: "checkbox" },
    ],
  },
];

// hex (#RRGGBB) + alpha byte → tint string.
function tint(hex: string, alpha: string): string {
  return `${hex}${alpha}`;
}

interface LogEntry {
  id: number;
  formId: string;
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

// Seed a couple of entries so the panel's log doesn't read empty.
const SEED_LOG: LogEntry[] = [
  { id: -1, formId: "meal", Icon: Utensils, accent: "#10B981", title: "Greek yogurt · 180 cal", detail: "Meals", time: "8:42 AM" },
  { id: -2, formId: "sale", Icon: Banknote, accent: "#F59E0B", title: "Acme Co. · $2,500", detail: "Sales", time: "Yesterday" },
];

export default function QuickLog() {
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
  const [log, setLog] = useState<LogEntry[]>(SEED_LOG);
  const seq = useRef(0);

  const openForm = MOCK_FORMS.find((f) => f.id === openId) ?? null;

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

  function handleSubmit(form: QuickForm, values: Record<string, string | boolean>) {
    const title = summarize(form, values);
    const id = ++seq.current;
    setLog((l) => [{ id, formId: form.id, Icon: form.Icon, accent: form.accent, title, detail: form.fanout, time: "just now" }, ...l]);
    // Collapsed leans on a toast for confirmation; expanded shows it in the log.
    if (!expanded) {
      setToasts((t) => [...t, { id, Icon: form.Icon, accent: form.accent, title, detail: form.fanout }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
    }
    setOpenId(null);
    setSheetOpen(false);
  }

  function showAgentHint() {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, Icon: Sparkles, accent: "#64748B", title: "Agent-defined", detail: "Ask your agent: “add a meal logger to this canvas.”" }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
  }

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
              {MOCK_FORMS.map((f) => {
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
                {MOCK_FORMS.map((f) => (
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
                  {MOCK_FORMS.map((f) => (
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

      {/* Local keyframes so the prototype is self-contained. */}
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
  const [values, setValues] = useState<Record<string, string | boolean>>({});

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
