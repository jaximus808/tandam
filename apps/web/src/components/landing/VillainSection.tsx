/**
 * VillainSection — the recognition beat: two parallel sessions collide on TODO.md.
 *
 * Usage (assembler / TDM-6):
 *   import VillainSection from "../components/landing/VillainSection";
 *   ...
 *   <VillainSection />
 *
 * Self-contained, no props, no external state. Renders a full-bleed band
 * (`bg-surface` + `border-y border-ink/10`), so place it between plain-paper
 * sections. Static illustration by design — the hero owns the big animation;
 * the only motion here is the blinking caret (reduced-motion safe via the
 * global `.tandem-caret` rule in index.css).
 *
 * Terminals sit on an explicit dark ground (#101014 + white/10 hairline) so
 * they read identically in both themes — no light-lock.
 */

/** One dark mini terminal. Explicit dark ground, theme-independent. */
function SessionTerminal({ name, delayCaret }: { name: string; delayCaret?: boolean }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-white/10 bg-[#101014] text-zinc-200 shadow-sm">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
        <span className="h-2 w-2 rounded-full bg-white/15" />
        <span className="h-2 w-2 rounded-full bg-white/15" />
        <span className="font-code text-[10px] text-zinc-500">{name}</span>
      </div>
      <div className="flex-1 px-4 py-3 font-code text-[11.5px] leading-relaxed">
        <div className="text-zinc-400">
          <span className="text-indigo-400">$</span> claude "pick the next task from TODO.md"
        </div>
        <div className="mt-1 text-zinc-500">Reading TODO.md…</div>
        <div className="mt-1 text-zinc-100">
          Working on: <span className="font-medium">3. Add rate limiting</span>
          {!delayCaret && (
            <span className="tandem-caret ml-1 inline-block h-3 w-[7px] translate-y-[2px] bg-zinc-400" />
          )}
        </div>
        {delayCaret && (
          <div className="mt-1 text-zinc-500">
            Editing TODO.md…
            <span className="tandem-caret ml-1 inline-block h-3 w-[7px] translate-y-[2px] bg-zinc-400" />
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
    <div className="overflow-hidden rounded-lg border border-white/10 bg-[#101014] text-zinc-200 shadow-sm">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
        <span className="h-2 w-2 rounded-full bg-white/15" />
        <span className="h-2 w-2 rounded-full bg-white/15" />
        <span className="font-code text-[10px] text-zinc-500">git diff TODO.md — after both finish</span>
      </div>
      <div className="overflow-x-auto py-3 font-code text-[11.5px]">
        <span className={`${line} text-zinc-500`}>@@ -1,6 +1,10 @@</span>
        <span className={`${line} text-zinc-400`}> # TODO</span>
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
        <span className={`${line} text-zinc-400`}> - [ ] 4. Fix flaky reconnect test</span>
        <span className={`${line} text-zinc-400`}> - [ ] 5. Update quickstart docs</span>
      </div>
    </div>
  );
}

export default function VillainSection() {
  return (
    <section className="relative overflow-hidden border-y border-ink/10 bg-surface">
      <div className="relative mx-auto max-w-6xl px-6 py-24">
        <div className="max-w-2xl">
          <span className="text-xs font-medium uppercase tracking-wide text-ink/50">
            The failure mode
          </span>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-[2rem]">
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

        <p className="mt-6 text-center text-base italic text-ink/50">
          every parallel-session setup, eventually.
        </p>
      </div>
    </section>
  );
}
