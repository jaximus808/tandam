/**
 * VillainSection — the recognition beat: two parallel sessions collide on TODO.md.
 *
 * Usage (assembler / TDM-6):
 *   import VillainSection from "../components/landing/VillainSection";
 *   ...
 *   <VillainSection />
 *
 * Self-contained, no props, no external state. Renders a full-bleed band
 * (`bg-surface` + `border-y border-ink/10`, like the Modes section), so place it
 * between plain-paper sections. Static illustration by design — the hero owns
 * the big animation; the only motion here is the blinking caret (reduced-motion
 * safe via the global `.tandem-caret` rule in index.css).
 */

const AGENT = "#C75B39";

/** One dark mini terminal. `theme-light` pins its ink/paper vars to light-mode
 *  values so the block stays dark in both themes (same pattern as the
 *  bring-your-own-agent card on the landing page). */
function SessionTerminal({ name, delayCaret }: { name: string; delayCaret?: boolean }) {
  return (
    <div className="theme-light flex flex-col overflow-hidden rounded-md border-[1.5px] border-ink bg-ink text-paper shadow-[5px_5px_0_rgba(28,25,23,0.15)]">
      <div className="flex items-center gap-2 border-b border-paper/10 px-4 py-2.5">
        <span className="h-2 w-2 rounded-full bg-paper/20" />
        <span className="h-2 w-2 rounded-full bg-paper/20" />
        <span className="font-code text-[10px] text-paper/45">{name}</span>
      </div>
      <div className="flex-1 px-4 py-3 font-code text-[11.5px] leading-relaxed">
        <div className="text-paper/55">
          <span style={{ color: AGENT }}>$</span> claude "pick the next task from TODO.md"
        </div>
        <div className="mt-1 text-paper/45">Reading TODO.md…</div>
        <div className="mt-1 text-paper/90">
          Working on: <span className="font-medium" style={{ color: "#E89277" }}>3. Add rate limiting</span>
          {!delayCaret && (
            <span
              className="tandem-caret ml-1 inline-block h-3 w-[7px] translate-y-[2px]"
              style={{ backgroundColor: AGENT }}
            />
          )}
        </div>
        {delayCaret && (
          <div className="mt-1 text-paper/45">
            Editing TODO.md…
            <span
              className="tandem-caret ml-1 inline-block h-3 w-[7px] translate-y-[2px]"
              style={{ backgroundColor: AGENT }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** The aftermath: TODO.md after both sessions wrote it from their own stale
 *  read — diff lines + merge-conflict markers, monospace, no fabricated UI. */
function MangledDiff() {
  const line = "block whitespace-pre px-4 leading-relaxed";
  return (
    <div className="theme-light overflow-hidden rounded-md border-[1.5px] border-ink bg-ink text-paper shadow-[5px_5px_0_rgba(199,91,57,0.5)]">
      <div className="flex items-center gap-2 border-b border-paper/10 px-4 py-2.5">
        <span className="h-2 w-2 rounded-full bg-paper/20" />
        <span className="h-2 w-2 rounded-full bg-paper/20" />
        <span className="font-code text-[10px] text-paper/45">git diff TODO.md — after both finish</span>
      </div>
      <div className="overflow-x-auto py-3 font-code text-[11.5px]">
        <span className={`${line} text-paper/40`}>@@ -1,6 +1,10 @@</span>
        <span className={`${line} text-paper/60`}> # TODO</span>
        <span className={`${line} bg-rose-500/15 text-rose-300`}>-- [ ] 3. Add rate limiting</span>
        <span className={`${line} bg-amber-400/15 text-amber-300`}>{"+<<<<<<< session-A"}</span>
        <span className={`${line} bg-emerald-500/15 text-emerald-300`}>
          +- [x] 3. Add rate limiting — middleware in api/mw.go
        </span>
        <span className={`${line} bg-amber-400/15 text-amber-300`}>+=======</span>
        <span className={`${line} bg-emerald-500/15 text-emerald-300`}>
          +- [x] 3. Add rate limiting — done, see limiter.ts
        </span>
        <span className={`${line} bg-amber-400/15 text-amber-300`}>{"+>>>>>>> session-B"}</span>
        <span className={`${line} text-paper/60`}> - [ ] 4. Fix flaky reconnect test</span>
        <span className={`${line} text-paper/60`}> - [ ] 5. Update quickstart docs</span>
      </div>
    </div>
  );
}

export default function VillainSection() {
  return (
    <section className="relative overflow-hidden border-y border-ink/10 bg-surface">
      <div aria-hidden="true" className="surface-grid-faint absolute inset-0 opacity-60" />
      <div className="relative mx-auto max-w-6xl px-6 py-24">
        <div className="max-w-2xl">
          <span className="font-code text-[11px] uppercase tracking-[0.22em] text-ink/40">
            The failure mode
          </span>
          <h2 className="mt-3 font-display text-3xl font-medium tracking-tight text-ink sm:text-4xl">
            Your agents are fighting over a markdown file.
          </h2>
          <p className="mt-3 leading-relaxed text-ink/65">
            Run two sessions in the same repo and both read TODO.md, both pick the top item, and
            both rewrite the file from their own stale read — the second writer clobbers the
            first. There's no bug to fix: a markdown file just isn't a queue. It has no claims, no
            state, and no idea who's doing what right now.
          </p>
        </div>

        <div className="mt-14 grid gap-6 lg:grid-cols-2">
          <SessionTerminal name="session-A" />
          <SessionTerminal name="session-B" delayCaret />
          <div className="lg:col-span-2">
            <MangledDiff />
          </div>
        </div>

        <p className="mt-6 text-center font-display text-lg italic text-ink/50">
          every parallel-session setup, eventually.
        </p>
      </div>
    </section>
  );
}
