interface Props {
  title: string;
  hint?: string;
}

/* An empty mode = an unplaced object on the surface: a dashed placeholder
   frame with corner handles, waiting for someone (or some agent) to fill it. */
export default function EmptyState({ title, hint }: Props) {
  return (
    <div className="surface-grid-faint flex flex-1 items-center justify-center p-6">
      <div className="tandem-mode-enter relative max-w-sm border-[1.5px] border-dashed border-ink/30 bg-white/70 px-9 py-8 text-center backdrop-blur-[1px]">
        <span aria-hidden="true" className="sel-handle" style={{ top: -4, left: -4 }} />
        <span aria-hidden="true" className="sel-handle" style={{ top: -4, right: -4 }} />
        <span aria-hidden="true" className="sel-handle" style={{ bottom: -4, left: -4 }} />
        <span aria-hidden="true" className="sel-handle" style={{ bottom: -4, right: -4 }} />
        <p className="font-display text-lg font-medium text-ink">{title}</p>
        {hint && <p className="mt-1.5 text-sm leading-relaxed text-ink/55">{hint}</p>}
        <p className="mt-3 font-code text-[10px] uppercase tracking-[0.18em] text-ink/30">
          nothing placed here yet
        </p>
      </div>
    </div>
  );
}
