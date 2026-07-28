interface Props {
  title: string;
  hint?: string;
  // Optional primary action so an empty surface can be filled in-place (no modal).
  action?: { label: string; onClick: () => void };
}

/* An empty mode: a quiet dashed placeholder card waiting for someone (or some
   agent) to fill it. */
export default function EmptyState({ title, hint, action }: Props) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-sm rounded-lg border border-dashed border-ink/20 bg-surface px-9 py-8 text-center">
        <p className="text-lg font-semibold tracking-tight text-ink">{title}</p>
        {hint && <p className="mt-1.5 text-sm leading-relaxed text-ink/55">{hint}</p>}
        {action && (
          <button
            onClick={action.onClick}
            className="mt-4 rounded-md bg-accent px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {action.label}
          </button>
        )}
        <p className="mt-3 text-[11px] uppercase tracking-wide text-ink/50">
          Nothing placed here yet
        </p>
      </div>
    </div>
  );
}
