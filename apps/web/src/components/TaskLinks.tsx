import { GitBranch, GitCommitHorizontal, GitPullRequest, Link2 } from "lucide-react";
import type { GitHubLinkStatus } from "../lib/api";
import { isResolvable, parseTaskLinks, type TaskLink } from "../lib/githubLinks";
import { useGitHubStatus } from "../lib/githubStatus";

/* ─────────────────────────────────────────────────────────────────────────────
   TaskLinks (TDM-45) — the evidence a completion left behind, and what GitHub
   currently says about it.

   Design brief, in one line: a CITATION, not a CI dashboard.

   A result summary is the agent's account of its work; these links are the
   receipts. So the chip is typeset like a reference — the ref in the mono face
   (`owner/repo#123`, `owner/repo@b7f1a2c`), because it is an identifier and
   identifiers are machine text under Design v2's Precision Canon — with the
   live part reduced to a single 6px dot at the END of the chip.

   Why the dot trails rather than leads (the FreshnessChip leads with its dot):
   there, the status IS the subject. Here the ref is, and the status is an
   annotation on it. Trailing also means an unknown status costs no layout: the
   chip just ends sooner, where a missing leading dot would shift every label.

   Hue stays inside the board's closed six-hue set (lib/stateChips) mapped onto
   GitHub's vocabulary, so a green dot means the same thing here as a green
   column header:
     merged / checks green   emerald — done
     open                    sky     — live, waiting on someone
     checks running          amber   — in flight (and the ONLY thing that
                                       animates: a pulse, because something is
                                       genuinely happening)
     checks failing          rose    — the one state that raises its voice: the
                                       ref goes rose too, so a red build is
                                       findable without reading every chip
     draft / closed unmerged zinc    — dormant
     unknown                 NOTHING. A lookup that 404'd, got rate-limited, or
                             was never made must render identically: absence of
                             a claim, not a claim of absence. This is what keeps
                             the board honest when GitHub is unreachable.

   Everything else stays quiet at rest — no fill, no border on cards, dim ink —
   and the chips are real links: they open GitHub in a new tab, and never the
   card's detail panel.
   ──────────────────────────────────────────────────────────────────────────── */

type Tone = { dot: string; text: string; pulse?: boolean };

/** GitHub state → the board's hues. Null = no dot at all. */
function toneFor(status: GitHubLinkStatus | null): Tone | null {
  if (!status) return null;
  if (status.checks === "fail" || status.state === "failure") {
    return { dot: "bg-rose-500", text: "text-rose-600 dark:text-rose-400" };
  }
  switch (status.state) {
    case "merged":
    case "ok":
      return { dot: "bg-emerald-500", text: "" };
    case "open":
      return { dot: "bg-sky-500", text: "" };
    case "pending":
      return { dot: "bg-amber-500", text: "", pulse: true };
    case "draft":
    case "closed":
      return { dot: "bg-zinc-400", text: "" };
    default:
      return null; // unknown — see the note above
  }
}

/** The sentence behind the dot: what GitHub says, in words. */
function statusSentence(link: TaskLink, status: GitHubLinkStatus | null): string {
  if (!status || status.state === "unknown") {
    if (status?.reason === "rate_limited") {
      return `${link.description} — GitHub's rate limit is spent; the status will resolve shortly`;
    }
    if (status?.reason === "not_found") {
      return `${link.description} — GitHub has no such ref (deleted, or a private repo)`;
    }
    return link.description;
  }
  const what =
    status.state === "merged"
      ? "merged"
      : status.state === "closed"
        ? "closed without merging"
        : status.state === "draft"
          ? "still a draft"
          : status.state === "open"
            ? "open"
            : status.state === "failure"
              ? "checks failing"
              : status.state === "pending"
                ? "checks running"
                : "on GitHub";
  const checks =
    status.checks === "pass" ? " · checks green" : status.checks === "fail" ? " · checks failing" : "";
  const title = status.title ? ` — ${status.title}` : "";
  return `${link.description}: ${what}${checks}${title}`;
}

function GlyphFor({ kind }: { kind: TaskLink["kind"] }) {
  const props = { size: 10, className: "shrink-0" as const, "aria-hidden": true };
  if (kind === "pr") return <GitPullRequest {...props} />;
  if (kind === "commit") return <GitCommitHorizontal {...props} />;
  if (kind === "branch") return <GitBranch {...props} />;
  return <Link2 {...props} />;
}

function LinkChip({
  code,
  link,
  live,
  boxed,
}: {
  code: string;
  link: TaskLink;
  /** Ask the server what GitHub says. Off = render the chip bare (no request). */
  live: boolean;
  /** Detail-panel form: a bordered well, matching the panel's other chip rows. */
  boxed: boolean;
}) {
  const resolvable = isResolvable(link);
  const status = useGitHubStatus(code, resolvable ? link.url : null, live && resolvable);
  const tone = toneFor(status);

  return (
    <a
      href={link.url}
      target="_blank"
      rel="noreferrer noopener"
      // Chips live on a card that is itself a button into the detail panel.
      onClick={(e) => e.stopPropagation()}
      title={statusSentence(link, status)}
      className={[
        "inline-flex min-w-0 max-w-full items-center gap-1 rounded-[4px] transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        boxed
          ? "border border-ink/10 bg-ink/[0.03] px-1.5 py-0.5 hover:border-ink/25"
          : "px-1 py-px hover:bg-ink/5",
        tone?.text || "text-ink/50",
        tone?.text ? "" : "hover:text-ink/80",
      ].join(" ")}
    >
      <GlyphFor kind={link.kind} />
      {/* The visible label is an abbreviation; the sr-only sentence below is the
          full one, so a screen reader gets "Pull request #123 in o/r: merged"
          rather than "o/r#123" twice. */}
      <span
        aria-hidden
        className={`truncate font-code ${boxed ? "text-[10.5px]" : "text-[10px]"} leading-none`}
      >
        {link.label}
      </span>
      {tone && (
        <span
          aria-hidden
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot} ${
            tone.pulse ? "animate-pulse motion-reduce:animate-none" : ""
          }`}
        />
      )}
      <span className="sr-only">{statusSentence(link, status)}</span>
    </a>
  );
}

/**
 * The evidence row. Renders nothing when a task has no links — most don't, and
 * an empty "Evidence" heading on every card is how a board turns to soup.
 */
export default function TaskLinks({
  code,
  links,
  live = false,
  boxed = false,
  max,
  className = "",
}: {
  code: string;
  /** Raw payload.links[] — parsed and deduped here. */
  links: unknown;
  live?: boolean;
  boxed?: boolean;
  /** Cap the chips shown; the rest collapse into a "+N" mark. */
  max?: number;
  className?: string;
}) {
  const parsed = parseTaskLinks(links);
  if (parsed.length === 0) return null;
  const shown = max ? parsed.slice(0, max) : parsed;
  const hidden = parsed.length - shown.length;

  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      {shown.map((link) => (
        <LinkChip key={link.url} code={code} link={link} live={live} boxed={boxed} />
      ))}
      {hidden > 0 && (
        <span
          className="font-code text-[10px] text-ink/40"
          title={`${hidden} more link${hidden === 1 ? "" : "s"} — open the task to see them all`}
        >
          +{hidden}
        </span>
      )}
    </div>
  );
}
