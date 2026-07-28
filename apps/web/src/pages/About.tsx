import type { ComponentType } from "react";
import { Globe, ArrowUpRight } from "lucide-react";
import LandingNav from "../components/LandingNav";

// Brand marks (GitHub / LinkedIn). lucide-react dropped brand icons, so these
// are inlined as filled SVGs — matching Landing's own icon approach.
type IconProps = { className?: string };

function GithubIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.09.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.05A9.36 9.36 0 0112 6.84c.85 0 1.71.12 2.51.34 1.91-1.32 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.82 0 .27.18.59.69.49A10.02 10.02 0 0022 12.25C22 6.58 17.52 2 12 2z" />
    </svg>
  );
}

function LinkedinIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 110-4.13 2.06 2.06 0 010 4.13zM7.12 20.45H3.55V9h3.57v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z" />
    </svg>
  );
}

interface Props {
  onBack: () => void;
  onOpenMCP: () => void;
  onShowCanvases: () => void;
  onShowSettings: () => void;
  onOpenCanvas: (code: string) => void;
}

// Jaxon's personal links.
const WEBSITE_URL = "https://www.jaxonp.com/";
const LINKEDIN_URL = "https://www.linkedin.com/in/jaxon-poentis/";
const GITHUB_URL = "https://github.com/jaximus808";

// Tandem's own source.
const REPO_URL = "https://github.com/jaximus808/tandam";

// About is a short, personal page at /about — who built Tandem and where to find
// him. Kept punchy on purpose: a paragraph, then prominent links out.
export default function About({ onBack, onOpenMCP, onShowCanvases, onShowSettings, onOpenCanvas }: Props) {
  return (
    <div className="min-h-screen bg-paper text-ink antialiased">
      <LandingNav
        onHome={onBack}
        onJoin={onOpenCanvas}
        onOpenMCP={onOpenMCP}
        onShowCanvases={onShowCanvases}
        onShowSettings={onShowSettings}
        onAbout={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      />

      <main className="mx-auto max-w-3xl px-6 py-16 sm:py-24">
        <span className="text-xs font-medium uppercase tracking-wide text-ink/50">
          The person behind it
        </span>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-[2rem]">
          Hi, I’m Jaxon.
        </h1>

        <div className="mt-6 space-y-4 text-[15px] leading-relaxed text-ink/70 sm:text-base">
          <p>
            I’m a solo builder who makes tools I actually want to use. Tandem is one of
            them — the shared state layer my own agent sessions coordinate through. A durable
            task queue they claim from in parallel, instead of a TODO.md they all fight over.
          </p>
          <p>
            I built it because running several coding agents at once shouldn’t mean playing
            traffic controller between them. If you’re running parallel sessions too, I’d love
            to hear how it holds up.
          </p>
        </div>

        {/* Source + design. Tandem is open — the repo is the honest version of
            this story, so link straight to it. */}
        <div className="mt-12 border-t border-ink/10 pt-8">
          <span className="text-xs font-medium uppercase tracking-wide text-ink/50">
            Under the hood
          </span>
          <h2 className="mt-3 text-xl font-semibold tracking-tight sm:text-2xl">
            Tandem is open source.
          </h2>
          <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-ink/70 sm:text-base">
            <p>
              Check out the source code here. It’s a monorepo: a Go API that runs the
              real-time collaboration hub over WebSockets, a React + Vite frontend, and a
              stdio MCP server that lets agents edit the same canvas you do. Shared types
              keep the web app and the agent gateway honest with each other.
            </p>
            <p>
              The design split is simple: intent lives in the repo, state lives in Tandem.
              Specs and code stay in git; the churn — task claims, statuses, results — moves
              into a shared queue every session and every person can see. Fittingly, Tandem
              is built through its own task queue.
            </p>
          </div>
          <div className="mt-6">
            <LinkButton href={REPO_URL} icon={GithubIcon} label="View the source on GitHub" primary />
          </div>
        </div>

        {/* Prominent links out. */}
        <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <LinkButton href={WEBSITE_URL} icon={Globe} label="jaxonp.com" primary />
          <LinkButton href={LINKEDIN_URL} icon={LinkedinIcon} label="LinkedIn" />
          <LinkButton href={GITHUB_URL} icon={GithubIcon} label="GitHub" />
        </div>
      </main>
    </div>
  );
}

function LinkButton({
  href,
  icon: Icon,
  label,
  primary,
}: {
  href: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  primary?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={[
        "group inline-flex items-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        primary
          ? "bg-accent text-white hover:bg-accent/90"
          : "border border-ink/15 bg-surface text-ink/75 hover:bg-ink/5",
      ].join(" ")}
    >
      <Icon className="h-4 w-4" />
      {label}
      <ArrowUpRight className="h-3.5 w-3.5 opacity-50 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
    </a>
  );
}
