import { useState } from "react";
import { Film, Minus } from "lucide-react";
import { useFollowStyle, type FollowStyle } from "../lib/followStyle";
import { saveFollowStyle } from "../lib/auth";

// A Cinematic / Minimal segmented control for the agent-activity follow style.
// Self-contained: reads the live preference and writes it (device-local always,
// account too when signed in) via saveFollowStyle. Usable anywhere — the canvas
// settings dock (works signed-out) and the /me account page alike.
export default function FollowStyleControl() {
  const style = useFollowStyle();
  const [saving, setSaving] = useState(false);

  async function choose(next: FollowStyle) {
    if (next === style) return;
    setSaving(true);
    try {
      await saveFollowStyle(next);
    } finally {
      setSaving(false);
    }
  }

  const opts: { key: FollowStyle; label: string; icon: typeof Film }[] = [
    { key: "cinematic", label: "Cinematic", icon: Film },
    { key: "minimal", label: "Minimal", icon: Minus },
  ];
  return (
    <div className="inline-flex shrink-0 rounded-lg border border-ink/10 bg-ink/[0.03] p-0.5">
      {opts.map(({ key, label, icon: Icon }) => {
        const active = style === key;
        return (
          <button
            key={key}
            type="button"
            disabled={saving}
            aria-pressed={active}
            onClick={() => choose(key)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              active ? "bg-paper text-ink shadow-sm" : "text-ink/50 hover:text-ink"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
