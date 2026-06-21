import { modeTheme } from "../lib/modeTheme";
import { actionPhrase } from "../lib/agentPhrase";
import type { Notification } from "../lib/useAgentNotifications";

interface Props {
  toasts: Notification[];
  onDismiss: (id: number) => void;
}

/**
 * Live op-feed popups: a stack of cards in the bottom-right that announce what
 * an agent just did ("Claude created a doc") and fade themselves out. Styled as
 * worksurface objects — hard terracotta offset shadow, mono action label, an
 * accent timer bar that drains in the mode's colour.
 */
export default function AgentToasts({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[19rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => (
        <Toast key={t.id} t={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function Toast({ t, onDismiss }: { t: Notification; onDismiss: (id: number) => void }) {
  const accent = modeTheme(t.mode).solid;
  return (
    <div
      className="tandem-toast-in pointer-events-auto relative overflow-hidden rounded-[7px] border border-ink/10 bg-white/95 backdrop-blur shadow-[3px_3px_0_#C75B39]"
      role="status"
    >
      <button
        onClick={() => onDismiss(t.id)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
        title="Dismiss"
      >
        {/* Agent mark — terracotta for Claude, ink for any other agent. */}
        <span
          className="grid h-7 w-7 shrink-0 place-items-center rounded-[6px]"
          style={{ background: t.isClaude ? "#C75B39" : "#1C1917" }}
        >
          <Sparkle />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-tight text-ink">
            <span className="font-semibold">{t.agentName}</span>{" "}
            <span className="text-ink/65">{actionPhrase(t.op, t.kind)}</span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 font-code text-[10px] uppercase tracking-[0.13em] text-ink/35">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: accent }} />
            {t.kind}
          </span>
        </span>
      </button>

      {/* Drain bar — visually counts down the toast's life. */}
      <span
        aria-hidden="true"
        className="tandem-toast-bar absolute bottom-0 left-0 h-[2px]"
        style={{ backgroundColor: accent }}
      />
    </div>
  );
}

function Sparkle() {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M6 0.5 C6.4 3 7.2 3.8 9.5 4.2 C7.2 4.6 6.4 5.4 6 7.8 C5.6 5.4 4.8 4.6 2.5 4.2 C4.8 3.8 5.6 3 6 0.5 Z"
        fill="white"
      />
      <circle cx="10" cy="9" r="1" fill="white" opacity="0.85" />
    </svg>
  );
}
