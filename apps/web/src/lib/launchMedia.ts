/* ─────────────────────────────────────────────────────────────────────────────
   launchMedia — where the landing page's recorded demo assets are configured.

   One constant, one job: the URL of the full walkthrough video. The landing
   page's "Watch the full demo" CTA is rendered ONLY when this is non-empty, so
   the plumbing can ship (and the page renders pixel-identically) before the
   recording is hosted anywhere.

   Jaxon: paste the hosted URL here to turn the CTA on. Either shape works —
     • a plain file URL (…/full-demo.mp4) → played inline with <video controls>
     • a YouTube link (youtube.com/watch?v=… or youtu.be/…) → embedded iframe
   No other change is needed; empty string turns the CTA back off.
   ───────────────────────────────────────────────────────────────────────────── */

// Annotated `string` (not the inferred `""` literal) so the emptiness checks
// downstream stay ordinary runtime conditions rather than types TS can narrow
// to `never` the moment the value is still the empty default.
// Self-hosted (TDM-204): the 4m03s walkthrough, compressed 304MB→16.6MB
// (1600w, crf 28, aac 96k), served from public/ like the section loops — no
// external host in the loop. Swap for a YouTube URL any time; the modal
// handles both shapes.
export const FULL_DEMO_VIDEO_URL: string = "/demo/tandem-demo-full.mp4";
