import { useState } from "react";
import { Bot, Check, Link2, User } from "lucide-react";
import type { CanvasState } from "../types";
import type { TaskDraft } from "../lib/api";

/* ─────────────────────────────────────────────────────────────────────────────
   TaskComposer — the one task-authoring form on the Board (toolbar "New task"
   + the empty-state CTA + card editing).

   Tasks are Action rows of type "task" ({title, body?, linkedIds?, assignee}).
   assignee splits the queue: "agent" tasks are what agent sessions pull over
   MCP; "human" tasks are your own todos and never reach the agent queue.
   Human-authored tasks are born approved — the gate exists for agent-proposed
   work.

   Creating and editing share this form: `initial` present = editing. The save
   REPLACES the payload server-side, so untouched fields (epicId,
   requiresApproval, …) must round-trip through `initial`.
   ──────────────────────────────────────────────────────────────────────────── */

// A pickable link target: any roadmap item or note on the canvas.
export interface LinkTarget {
  id: string;
  kind: "roadmap" | "note";
  label: string;
}

export function linkTargets(state: CanvasState): LinkTarget[] {
  const roadmap = Object.values(state.roadmapItems ?? {}).map((r) => ({
    id: r.id,
    kind: "roadmap" as const,
    label: r.title || "Untitled goal",
  }));
  const notes = Object.values(state.notes ?? {}).map((n) => ({
    id: n.id,
    kind: "note" as const,
    label: (n.body ?? "").split("\n")[0].replace(/^#+\s*/, "").slice(0, 60) || "Untitled note",
  }));
  return [...roadmap, ...notes];
}

export default function TaskComposer({
  targets,
  initial,
  submitLabel = "Add task",
  onSubmit,
  onCancel,
}: {
  targets: LinkTarget[];
  initial?: TaskDraft;
  submitLabel?: string;
  onSubmit: (draft: TaskDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [assignee, setAssignee] = useState<"agent" | "human">(initial?.assignee ?? "agent");
  const [linked, setLinked] = useState<Set<string>>(new Set(initial?.linkedIds ?? []));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = initial !== undefined;

  function toggleLink(id: string) {
    setLinked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        // Preserve payload fields this editor doesn't surface (epicId,
        // requiresApproval, …) — the save REPLACES the payload wholesale.
        ...initial,
        title: title.trim(),
        body: body.trim() || undefined,
        linkedIds: linked.size > 0 ? [...linked] : undefined,
        assignee,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save task");
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Who is this for? Agent tasks land in the agent queue; yours don't. */}
      <div className="flex rounded-md border border-ink/10 bg-ink/[0.03] p-0.5">
        {(["agent", "human"] as const).map((a) => {
          const active = assignee === a;
          return (
            <button
              key={a}
              onClick={() => setAssignee(a)}
              aria-pressed={active}
              className={[
                // tandem-tap (index.css): the same 44px touch floor the Board's
                // card controls use, collapsing to the dense desktop height on
                // sm+ so this segmented control is unchanged above 640px.
                "tandem-tap flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                active ? "bg-surface text-accent shadow-sm" : "text-ink/40 hover:text-ink/65",
              ].join(" ")}
            >
              {a === "agent" ? <Bot size={13} /> : <User size={13} />}
              {a === "agent" ? "For the agent" : "For me"}
            </button>
          );
        })}
      </div>
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        placeholder={assignee === "agent" ? "What should the agent do?" : "What do you need to do?"}
        className="w-full rounded-md border border-ink/15 bg-surface px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink/30 focus:border-accent/50 focus:ring-2 focus:ring-accent/40"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Brief: what, why, acceptance criteria (optional)"
        rows={3}
        className="w-full resize-none rounded-md border border-ink/15 bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink/30 focus:border-accent/50 focus:ring-2 focus:ring-accent/40"
      />

      {targets.length > 0 && (
        <div>
          <button
            onClick={() => setPickerOpen((o) => !o)}
            aria-expanded={pickerOpen}
            className="tandem-tap flex items-center gap-1 text-[11px] font-medium text-ink/45 hover:text-ink/70"
          >
            <Link2 size={12} />
            {linked.size > 0 ? `${linked.size} linked` : "Link roadmap items / notes"}
          </button>
          {pickerOpen && (
            // Taller on a phone: each row is a 44px target, so a 10rem box shows
            // barely two of them and the list reads as broken rather than short.
            <div className="mt-1.5 max-h-[13rem] overflow-y-auto rounded-md border border-ink/10 bg-ink/[0.02] p-1 sm:max-h-40">
              {targets.map((t) => (
                <button
                  key={t.id}
                  onClick={() => toggleLink(t.id)}
                  aria-pressed={linked.has(t.id)}
                  className="tandem-tap flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] text-ink/70 hover:bg-ink/5"
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors ${
                      linked.has(t.id) ? "border-accent bg-accent" : "border-ink/20 bg-transparent"
                    }`}
                  >
                    {linked.has(t.id) && <Check size={10} className="text-white" />}
                  </span>
                  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-ink/50">
                    {t.kind === "roadmap" ? "goal" : "note"}
                  </span>
                  <span className="truncate">{t.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <p className="text-[11px] text-rose-600">{error}</p>}

      <div className="flex gap-1.5">
        <button
          onClick={() => void submit()}
          disabled={!title.trim() || saving}
          className="tandem-tap flex flex-1 items-center justify-center rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
        >
          {saving ? "Saving…" : submitLabel}
        </button>
        <button
          onClick={onCancel}
          className="tandem-tap flex items-center justify-center rounded-md border border-ink/15 px-3 py-1.5 text-sm font-medium text-ink/60 hover:border-ink/30"
        >
          Cancel
        </button>
      </div>
      {!editing && (
        <p className="text-[10px] leading-snug text-ink/50">
          Your tasks are ready immediately — no approval needed. Agent sessions pull only
          “For the agent” tasks from the queue.
        </p>
      )}
    </div>
  );
}
