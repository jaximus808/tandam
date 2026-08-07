/**
 * SeeItInActionSection — the recorded demo as its own named stop on the page,
 * two beats: 01 connect (an agent joins, proposes, and one approval releases
 * the batch) and 02 steer (the plan changes while the fleet is mid-run).
 *
 * The clips lived inline in HowItWorksSection first, as illustrations under
 * the step transcripts. Moved here (TDM-214) because a named section scans —
 * "See it in action" is a promise a visitor can navigate to, while a video
 * embedded in step 03 is something they find only if they read step 03. The
 * clips appear ONCE on the page: this section owns them now, and How-it-works
 * is back to pure call transcripts.
 *
 * Beat 02 keeps the widest frame on purpose — steering a running fleet is the
 * differentiator; connecting is merely the price of entry. The full-demo CTA
 * sits at the section's foot, where watch-intent peaks, and opens the SAME
 * FullDemoModal the hero CTA does (the caller passes the opener — this section
 * holds no modal state and renders the CTA only when a recording is configured).
 *
 * Plain paper, no band: it follows HowItWorksSection (also paper) and the
 * clips' own hairline frames give it structure; a `bg-surface` band here would
 * merge with AudienceSection's band right below it.
 */

import { useEffect, useState } from "react";
import { FULL_DEMO_VIDEO_URL } from "../../lib/launchMedia";

/** Mirrors HeroBoardDemo's hook — this section stays self-contained by design. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * A screen recording, played as a silent loop — evidence, not decoration, so it
 * gets the same hairline frame as the call transcripts in How-it-works.
 *
 * Two things it deliberately does (moved verbatim from HowItWorksSection):
 *  · `onError` unmounts the WHOLE beat (frame + caption). A section missing a
 *    clip must read as finished, not as a broken player or an empty frame.
 *  · `prefers-reduced-motion` swaps autoplay+loop for the poster with native
 *    controls, so the clip is still reachable without anything moving on its own.
 */
function DemoClip({
  src,
  poster,
  caption,
}: {
  src: string;
  poster: string;
  caption: string;
}) {
  const reduced = usePrefersReducedMotion();
  const [failed, setFailed] = useState(false);

  if (failed) return null;

  return (
    <figure>
      <div className="overflow-hidden rounded-lg border border-ink/10 bg-surface">
        <video
          // React can drop the `muted` prop on the initial mount; without the
          // attribute set on the element, autoplay is blocked outright.
          ref={(el) => {
            if (el) el.muted = true;
          }}
          className="block h-auto w-full"
          src={src}
          poster={poster}
          preload="metadata"
          muted
          playsInline
          autoPlay={!reduced}
          loop={!reduced}
          controls={reduced}
          aria-label={caption}
          onError={() => setFailed(true)}
        />
      </div>
      <figcaption className="mt-3 max-w-2xl text-sm leading-relaxed text-ink/60">
        {caption}
      </figcaption>
    </figure>
  );
}

/** The numbered beat header — same chip idiom as How-it-works' step rail. */
function BeatHeader({ n, title, lede }: { n: string; title: string; lede: string }) {
  return (
    <div className="mb-5 flex items-start gap-5 sm:gap-7">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-ink/15 bg-surface font-code text-[12px] font-medium text-ink/70 sm:h-10 sm:w-10">
        {n}
      </span>
      <div className="min-w-0 pt-1">
        <h3 className="text-xl font-semibold tracking-tight text-ink">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-ink/65">{lede}</p>
      </div>
    </div>
  );
}

export default function SeeItInActionSection({
  onWatchFull,
}: {
  /** Opens the page's FullDemoModal; the CTA renders only when both this and a configured recording exist. */
  onWatchFull?: () => void;
}) {
  return (
    <section id="see-it-in-action" className="mx-auto max-w-6xl px-6 py-24">
      <div className="max-w-2xl">
        <span className="text-xs font-medium uppercase tracking-wide text-ink/50">
          See it in action
        </span>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-[2rem]">
          The loop above, running for real
        </h2>
        <p className="mt-3 leading-relaxed text-ink/65">
          Two unedited screen recordings: a fleet picking up a plan, and the plan changing under
          it. No mock data — this is Tandem planning Tandem.
        </p>
      </div>

      <div className="mt-14 max-w-4xl">
        <BeatHeader
          n="01"
          title="Connect, propose, approve"
          lede="One MCP connect, a proposed epic, one approval on the board — and the whole batch turns pullable, with workers claiming tickets seconds later."
        />
        <DemoClip
          src="/demo/queue-loop.mp4"
          poster="/demo/queue-loop-poster.jpg"
          caption="An agent connects, proposes a batch, and waits. The approval is the go signal — no second prompt, no copy-pasting task lists between sessions."
        />
      </div>

      <div className="mt-16 max-w-4xl">
        <BeatHeader
          n="02"
          title="Steer mid-run"
          lede="You change your mind while the fleet is working — and nothing has to stop."
        />
        <DemoClip
          src="/demo/steer-loop.mp4"
          poster="/demo/steer-loop-poster.jpg"
          caption="Reject a ticket, amend the plan, add work mid-batch. Sessions already in flight pick the change up on their next pull — you don't stop the fleet to steer it."
        />
      </div>

      {onWatchFull && FULL_DEMO_VIDEO_URL !== "" && (
        <div className="mt-12 max-w-4xl">
          <button
            onClick={onWatchFull}
            className="inline-flex items-center gap-2 rounded-md border border-ink/15 bg-surface px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:border-ink/25"
          >
            Watch the full demo
            <span className="font-code text-[11px] text-ink/50">4 min · with audio</span>
          </button>
        </div>
      )}
    </section>
  );
}
