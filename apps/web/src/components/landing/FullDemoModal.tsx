import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { FULL_DEMO_VIDEO_URL } from "../../lib/launchMedia";

interface Props {
  onClose: () => void;
}

/**
 * Turn whatever URL is configured into a YouTube *embed* URL, or null when it
 * isn't a YouTube link at all (the common case: a plain hosted .mp4, which the
 * modal plays with a native <video> instead).
 *
 * Handles the three shapes a copy-pasted YouTube link actually takes —
 * youtu.be/ID, youtube.com/watch?v=ID, youtube.com/embed/ID — and carries a
 * start time through if the link had one.
 */
export function youtubeEmbedUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "");
  let id = "";
  if (host === "youtu.be") {
    id = u.pathname.slice(1);
  } else if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v") ?? "";
    else if (u.pathname.startsWith("/embed/")) id = u.pathname.slice("/embed/".length);
    else if (u.pathname.startsWith("/shorts/")) id = u.pathname.slice("/shorts/".length);
  }
  id = id.split("/")[0];
  if (!id) return null;
  // Start time: ?t=90 on a share link, ?start=90 on an embed link.
  const t = u.searchParams.get("start") ?? u.searchParams.get("t");
  const start = t ? String(parseInt(t, 10) || 0) : "";
  const qs = new URLSearchParams({ rel: "0", modestbranding: "1" });
  if (start && start !== "0") qs.set("start", start);
  return `https://www.youtube.com/embed/${encodeURIComponent(id)}?${qs.toString()}`;
}

// FullDemoModal — click-to-play for the full walkthrough recording. Same modal
// idiom as SignInModal (portal to body, scrim click, Escape, close button); the
// body is either a native <video> for a hosted file or a YouTube embed, decided
// from the URL shape. Never autoplays and never preloads: the hero already owns
// the page's motion budget, so this only fetches bytes once someone asks.
export default function FullDemoModal({ onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const embed = youtubeEmbedUrl(FULL_DEMO_VIDEO_URL);

  // Portal to body: transformed/filtered ancestors on the landing page can
  // create a containing block for position:fixed, which would anchor the modal
  // to a section instead of the viewport.
  return createPortal(
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="full-demo-title"
        className="w-full max-w-3xl overflow-hidden rounded-[10px] border border-ink/10 bg-surface shadow-lg lg:max-w-4xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-ink/10 px-4 py-2.5 dark:border-white/10">
          <h2 id="full-demo-title" className="truncate text-sm font-medium text-ink">
            Tandem — the full demo
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink/55 transition-colors hover:bg-ink/5 hover:text-ink/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X size={15} />
          </button>
        </div>

        {/* 16:9 stage on a constant dark ground, so letterboxing reads the same
            in light and dark themes. aspect-video keeps it sane on phones. */}
        <div className="aspect-video w-full bg-black">
          {embed ? (
            <iframe
              src={embed}
              title="Tandem — the full demo"
              className="h-full w-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
            />
          ) : (
            <video
              src={FULL_DEMO_VIDEO_URL}
              controls
              preload="none"
              playsInline
              className="h-full w-full"
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
