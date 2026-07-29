/**
 * VillainSection — the WHY beat: a fleet that spans machines has no shared
 * filesystem, so coordination can't live in a repo file any more.
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

/** One dark mini terminal: a machine, its command, and the item it picked.
 *  Both terminals land on the same item — the point of the illustration. */
function SessionTerminal({
  name,
  command,
  read,
  picked,
}: {
  name: string;
  command: string;
  read: string;
  picked: string;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-white/10 bg-[#101014] text-zinc-200 shadow-sm">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
        <span className="h-2 w-2 rounded-full bg-white/15" />
        <span className="h-2 w-2 rounded-full bg-white/15" />
        <span className="truncate font-code text-[10px] text-zinc-500">{name}</span>
      </div>
      <div className="flex-1 px-4 py-3 font-code text-[11.5px] leading-relaxed">
        <div className="text-zinc-400">
          <span className="text-indigo-400">$</span> {command}
        </div>
        <div className="mt-1 text-zinc-500">{read}</div>
        <div className="mt-1 text-zinc-100">
          Working on: <span className="font-medium">{picked}</span>
          <span className="tandem-caret ml-1 inline-block h-3 w-[7px] translate-y-[2px] bg-zinc-400" />
        </div>
      </div>
    </div>
  );
}

/** The aftermath: TODO.md once both machines push what they each believed —
 *  diff lines + merge-conflict markers, monospace, no fabricated UI. */
function MangledDiff() {
  const line = "block whitespace-pre px-4 leading-relaxed";
  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-[#101014] text-zinc-200 shadow-sm">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
        <span className="h-2 w-2 rounded-full bg-white/15" />
        <span className="h-2 w-2 rounded-full bg-white/15" />
        <span className="truncate font-code text-[10px] text-zinc-500">
          git diff TODO.md — when both machines push
        </span>
      </div>
      <div className="overflow-x-auto py-3 font-code text-[11.5px]">
        <span className={`${line} text-zinc-500`}>@@ -1,6 +1,10 @@</span>
        <span className={`${line} text-zinc-400`}> # TODO</span>
        <span className={`${line} bg-rose-500/15 text-rose-300`}>-- [ ] 3. Add rate limiting</span>
        <span className={`${line} bg-amber-400/15 text-amber-300`}>{"+<<<<<<< laptop"}</span>
        <span className={`${line} bg-emerald-500/15 text-emerald-300`}>
          +- [x] 3. Add rate limiting — middleware in api/mw.go
        </span>
        <span className={`${line} bg-amber-400/15 text-amber-300`}>+=======</span>
        <span className={`${line} bg-emerald-500/15 text-emerald-300`}>
          +- [x] 3. Add rate limiting — done, see limiter.ts
        </span>
        <span className={`${line} bg-amber-400/15 text-amber-300`}>{"+>>>>>>> sandbox-7f2c"}</span>
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
            Why it exists
          </span>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-[2rem]">
            Your agents don't share a filesystem.
          </h2>
          <p className="mt-3 leading-relaxed text-ink/65">
            Coordination used to fit in a file. Two terminals, one checkout, a TODO.md that mostly
            held. That isn't the shape any more: a growing share of the fleet runs sandbox-per-task
            in the cloud — fresh container, fresh clone, gone when the task ends — and the person
            supervising is on a machine that's running none of them.
          </p>
          <p className="mt-3 leading-relaxed text-ink/65">
            A file in a repo can't hold a claim between machines that never touch. Each agent reads
            the state it happened to clone, picks the same top item, and finds out at push time.
          </p>
        </div>

        <div className="mt-14 grid gap-6 lg:grid-cols-2">
          <SessionTerminal
            name="your laptop · claude code"
            command={'claude "take the next task from TODO.md"'}
            read="Reading TODO.md…"
            picked="3. Add rate limiting"
          />
          <SessionTerminal
            name="cloud sandbox · fresh checkout"
            command="agent run --task next"
            read="Cloned repo @ main — TODO.md as of 20 min ago"
            picked="3. Add rate limiting"
          />
          <div className="lg:col-span-2">
            <MangledDiff />
          </div>
        </div>

        <p className="mt-6 text-center text-base italic text-ink/50">
          two machines, one file, and no way to ask who has what.
        </p>
      </div>
    </section>
  );
}
