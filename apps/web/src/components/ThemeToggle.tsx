import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme, type ThemePref } from "../lib/theme";

// Segmented Light / System / Dark control. System is the middle/default so the
// row reads left-to-right dark←→light around "match device". Self-contained
// (drives lib/theme directly), so it drops into any surface — the settings page
// or the account dropdown. Every mounted instance stays in sync via useTheme.
export default function ThemeToggle({
  // Stretch the control to fill its container (used in the account dropdown so
  // the three options read as one full-width row of buttons).
  fullWidth = false,
  // Show labels at every width. Off by default so the settings-row control can
  // collapse to icons on narrow screens.
  alwaysLabel = false,
}: {
  fullWidth?: boolean;
  alwaysLabel?: boolean;
} = {}) {
  const { pref, setPref } = useTheme();
  const opts: { value: ThemePref; label: string; icon: typeof Sun }[] = [
    { value: "light", label: "Light", icon: Sun },
    { value: "system", label: "System", icon: Monitor },
    { value: "dark", label: "Dark", icon: Moon },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={[
        "inline-flex shrink-0 overflow-hidden rounded-lg border border-ink/15 bg-paper p-0.5",
        fullWidth ? "w-full" : "",
      ].join(" ")}
    >
      {opts.map((o) => {
        const active = pref === o.value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            onClick={() => setPref(o.value)}
            className={[
              "inline-flex items-center justify-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-sm font-medium transition-colors",
              fullWidth ? "flex-1" : "",
              active ? "bg-ink text-paper" : "text-ink/55 hover:bg-ink/5 hover:text-ink",
            ].join(" ")}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className={alwaysLabel ? "" : "hidden sm:inline"}>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
