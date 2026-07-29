// Reading a task's evidence links (TDM-45).
//
// A completed task carries payload.links[] — whatever the agent or the CI job
// said its work produced. This module turns each one into something renderable:
// what KIND of thing it is, and the shortest label a human recognises.
//
// The parse is duplicated (deliberately) with the API's parseGitHubRef: the
// board must be able to label a chip and decide whether it's worth a status
// lookup at all WITHOUT a round trip. The server stays the authority on what a
// link resolves to; this side only has to agree on what is worth asking about.

export type GitHubLinkKind = "commit" | "pr" | "branch";

export type TaskLink =
  | {
      kind: GitHubLinkKind;
      /** owner/repo#123, owner/repo@b7f1a2c, owner/repo:main */
      label: string;
      /** Screen-reader / tooltip form, spelled out. */
      description: string;
      url: string;
    }
  | {
      kind: "other";
      label: string;
      description: string;
      url: string;
    };

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-fA-F]{7,40}$/;

/**
 * Classifies one evidence link.
 *
 * Anything that isn't a github.com commit / PR / branch comes back as "other":
 * a CI run page, a deploy log, a Loom. Those are still worth showing — they're
 * what the agent offered as proof — they just have no status to fetch.
 */
export function parseTaskLink(raw: string): TaskLink | null {
  const value = raw?.trim();
  if (!value) return null;

  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;

  const host = u.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    return { kind: "other", label: otherLabel(u), description: u.href, url: u.href };
  }

  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length >= 4 && NAME.test(segs[0]) && NAME.test(segs[1].replace(/\.git$/, ""))) {
    const owner = segs[0];
    const repo = segs[1].replace(/\.git$/, "");
    const slug = `${owner}/${repo}`;
    const [, , type, ...rest] = segs;

    if ((type === "commit" || type === "commits") && SHA.test(rest[0])) {
      const short = rest[0].slice(0, 7).toLowerCase();
      return {
        kind: "commit",
        label: `${slug}@${short}`,
        description: `Commit ${short} in ${slug}`,
        url: `https://github.com/${slug}/commit/${rest[0].toLowerCase()}`,
      };
    }
    if ((type === "pull" || type === "pulls") && /^[0-9]+$/.test(rest[0])) {
      return {
        kind: "pr",
        label: `${slug}#${rest[0]}`,
        description: `Pull request #${rest[0]} in ${slug}`,
        url: `https://github.com/${slug}/pull/${rest[0]}`,
      };
    }
    if (type === "tree" || type === "commits") {
      const branch = rest.join("/");
      if (branch) {
        return {
          kind: "branch",
          label: `${slug}:${branch}`,
          description: `Branch ${branch} in ${slug}`,
          url: `https://github.com/${slug}/tree/${branch}`,
        };
      }
    }
  }
  // A github.com URL we can't address (an issue, a release, a bare repo) is
  // still a link — it just doesn't get a dot.
  return { kind: "other", label: otherLabel(u), description: u.href, url: u.href };
}

/** Host plus the last path segment: enough to tell two CI runs apart. */
function otherLabel(u: URL): string {
  const host = u.hostname.replace(/^www\./, "");
  const last = u.pathname.split("/").filter(Boolean).pop();
  const label = last ? `${host}/${clip(last, 24)}` : host;
  return clip(label, 40);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function parseTaskLinks(raw: unknown): TaskLink[] {
  if (!Array.isArray(raw)) return [];
  const out: TaskLink[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const link = parseTaskLink(item);
    if (!link || seen.has(link.url)) continue;
    seen.add(link.url);
    out.push(link);
  }
  return out;
}

/** Only these are worth a status lookup — everything else renders bare. */
export function isResolvable(link: TaskLink): boolean {
  return link.kind !== "other";
}
