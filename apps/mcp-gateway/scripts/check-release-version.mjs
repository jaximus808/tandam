#!/usr/bin/env node
// Release guard for @jaximus/tandem-mcp.
//
// Why this exists: 2.2.1 shipped to npm, then 2.3.0's work landed in the repo
// and was never published — the gateway on npm silently drifted behind the
// gateway in git, because publishing was a human running ./publish.sh from
// memory. The release workflow now runs this check BEFORE it builds, so a
// release can only go out if the three things that must agree actually agree:
//
//   1. apps/mcp-gateway/package.json  "version"
//   2. the top versioned heading in   apps/mcp-gateway/CHANGELOG.md
//   3. (when tag-triggered) the git tag that started the run
//
// Deliberately NOT run on every push to main: during development package.json
// is bumped ahead of the changelog's `## Unreleased` section on purpose, so a
// per-commit version gate would fail constantly and get muted. This is a
// release-time gate.
//
// Usage:
//   node scripts/check-release-version.mjs
//   node scripts/check-release-version.mjs --tag mcp-v2.3.1
//   node scripts/check-release-version.mjs --tag refs/tags/mcp-v2.3.1
//
// Exits 0 with an OK line, or 1 with every problem it found.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgPath = join(pkgDir, "package.json");
const changelogPath = join(pkgDir, "CHANGELOG.md");

// --- args -------------------------------------------------------------------

let tagArg = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--tag") {
    tagArg = argv[++i] ?? null;
  } else if (arg.startsWith("--tag=")) {
    tagArg = arg.slice("--tag=".length);
  } else if (arg === "--help" || arg === "-h") {
    console.log(
      "usage: check-release-version.mjs [--tag <git tag or refs/tags/... >]",
    );
    process.exit(0);
  } else {
    console.error(`check-release-version: unknown argument ${arg}`);
    process.exit(2);
  }
}
// An empty --tag (e.g. a workflow_dispatch run, where github.ref is a branch)
// means "no tag to check", not "check the empty tag".
if (tagArg !== null && tagArg.trim() === "") tagArg = null;

// --- read the sources of truth ---------------------------------------------

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const pkgVersion = pkg.version;
const changelog = readFileSync(changelogPath, "utf8");

const SEMVER = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/**
 * Top versioned `## ` heading in the changelog, skipping `## Unreleased` and
 * any non-semver heading (`## 2.0.x — 2026-05/06` is a historical rollup, not
 * a release). Returns { version, line, body } or null.
 */
function topVersionedSection(md) {
  const lines = md.split("\n");
  const headings = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    if (/^##\s+/.test(line) && !/^###/.test(line)) headings.push({ i, line });
  }
  for (let h = 0; h < headings.length; h++) {
    const { i, line } = headings[h];
    // `## 2.3.0 — 2026-07-28` → first whitespace-delimited token after `##`.
    const token = line.replace(/^##\s+/, "").split(/\s+/)[0] ?? "";
    const m = SEMVER.exec(token.trim());
    if (!m) continue; // Unreleased, 2.0.x, anything unparseable
    const end = headings[h + 1]?.i ?? lines.length;
    return {
      version: m[1],
      line: line.trim(),
      body: lines.slice(i + 1, end).join("\n").trim(),
    };
  }
  return null;
}

/** Content sitting under `## Unreleased`, if any. */
function unreleasedBody(md) {
  const lines = md.split("\n");
  const start = lines.findIndex(
    (l) => /^##\s+/.test(l) && !/^###/.test(l) && /unreleased/i.test(l),
  );
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]) && !/^###/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

// --- checks -----------------------------------------------------------------

const problems = [];
const warnings = [];

if (!SEMVER.test(pkgVersion ?? "")) {
  problems.push(
    `package.json version is not a semver release: ${JSON.stringify(pkgVersion)}`,
  );
}

const section = topVersionedSection(changelog);
if (!section) {
  problems.push(
    `CHANGELOG.md has no versioned "## <semver>" heading — add one for ${pkgVersion}.`,
  );
} else {
  if (section.version !== pkgVersion) {
    problems.push(
      `version drift: package.json is ${pkgVersion} but the top versioned CHANGELOG heading is "${section.line}" (${section.version}).\n` +
        `    Fix by adding a "## ${pkgVersion} — <date>" section at the top of the changelog ` +
        `(move the relevant "## Unreleased" entries into it), or by correcting package.json.`,
    );
  }
  if (!section.body) {
    problems.push(
      `CHANGELOG.md section "${section.line}" is empty — a release with no notes is a release nobody can read.`,
    );
  }
}

if (tagArg) {
  const bare = tagArg.replace(/^refs\/tags\//, "");
  // Accepted shapes: mcp-v2.3.1 (what the workflow uses), v2.3.1, 2.3.1.
  const tagToken = bare.replace(/^mcp-/, "");
  const m = SEMVER.exec(tagToken);
  if (!m) {
    problems.push(
      `tag "${bare}" has no parseable version — expected mcp-v<semver>, e.g. mcp-v${pkgVersion}.`,
    );
  } else if (m[1] !== pkgVersion) {
    problems.push(
      `tag/package mismatch: tag "${bare}" says ${m[1]} but package.json says ${pkgVersion}.`,
    );
  }
}

const pending = unreleasedBody(changelog);
if (pending && problems.length === 0) {
  const firstLine = pending.split("\n").find((l) => l.trim()) ?? "";
  warnings.push(
    `"## Unreleased" still has content (starts: ${firstLine.trim().slice(0, 72)}...).\n` +
      `    Releasing ${pkgVersion} anyway — but if those entries belong to this release, move them up first.`,
  );
}

// --- report -----------------------------------------------------------------

for (const w of warnings) console.warn(`warning: ${w}`);

if (problems.length > 0) {
  console.error(
    `\ncheck-release-version: FAILED (${problems.length} problem${problems.length === 1 ? "" : "s"})\n`,
  );
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    `\nNothing was published. Reconcile apps/mcp-gateway/package.json, ` +
      `apps/mcp-gateway/CHANGELOG.md${tagArg ? ", and the release tag" : ""}, then re-run.\n`,
  );
  process.exit(1);
}

console.log(
  `check-release-version: OK — ${pkg.name}@${pkgVersion} matches CHANGELOG "${section.line}"` +
    (tagArg ? ` and tag ${tagArg.replace(/^refs\/tags\//, "")}` : "") +
    ".",
);
