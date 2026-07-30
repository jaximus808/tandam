# Publishing `@jaximus/tandem-mcp`

One-time setup, then a single command per release.

## One-time setup

### 1. Log in to npm

```bash
npm login
# username, password, OTP — uses your existing npm account
```

The package is published under your personal username scope (`@jaximus`), so
there's no org to create — any package named `@jaximus/*` publishes straight to
your account. `publishConfig.access` is already set to `public` in
`package.json`, which scoped packages require to be visible.

If you ever change your npm username, update the `@jaximus` scope in `name` in
`package.json` (and the docs that reference it) accordingly.

### 2. Verify what will ship

```bash
cd apps/mcp-gateway
pnpm run build
npm pack --dry-run
```

You should see only `dist/`, `README.md`, `CHANGELOG.md`, `LICENSE`, and `package.json` in the tarball. If you see `src/` or `node_modules/`, fix the `files` field in `package.json` before publishing.

### 3. Add the `NPM_TOKEN` repo secret

CI publishes, so GitHub needs its own credential. Create an npm **Automation**
access token (Automation, not Publish — Automation tokens bypass 2FA, which is
what a non-interactive runner needs) and add it as the repository secret
`NPM_TOKEN` under Settings → Secrets and variables → Actions.

## Per-release workflow

Releases go through **`.github/workflows/release-mcp-gateway.yml`**, not a
laptop. This is why: 2.2.1 sat on npm while 2.3.0's work lived only in the repo,
because publishing was a human remembering to run `./publish.sh`. Nothing
announced the drift.

```bash
cd apps/mcp-gateway

# 1. Bump the version (no git tag — the release tag is pushed by hand below).
npm version patch --no-git-tag-version   # or: minor, major

# 2. Write the changelog section. REQUIRED: the release fails without it.
#    Add "## <new version> — <YYYY-MM-DD>" at the top of CHANGELOG.md and move
#    the relevant "## Unreleased" entries into it.

# 3. Commit both files to main as usual.

# 4. Tag and push — this triggers the release.
git tag mcp-v2.4.0 && git push origin mcp-v2.4.0
```

The workflow then verifies, builds, tests, and publishes. Before it touches npm
it runs `scripts/check-release-version.mjs`, which fails the run unless all
three agree:

| These must agree                                                | Failure it prevents                                    |
| --------------------------------------------------------------- | ------------------------------------------------------ |
| `package.json` version ↔ top versioned `## ` heading in `CHANGELOG.md` | publishing a version nobody wrote release notes for |
| `package.json` version ↔ the `mcp-v*` tag you pushed            | tagging `mcp-v2.4.0` and publishing 2.3.9              |

It also refuses to publish a version that is already on npm, and warns if
`## Unreleased` still has entries that probably belonged in the release. You can
run the same check locally before tagging:

```bash
cd apps/mcp-gateway
node scripts/check-release-version.mjs --tag mcp-v2.4.0
```

### Dry run

Actions → **Release tandem-mcp to npm** → Run workflow, leaving `dry_run`
ticked (the default). It verifies, builds, tests, and does
`npm publish --dry-run` — publishes nothing. Untick `dry_run` to publish the
current version without pushing a tag.

Pushing an `mcp-v*` tag does **not** trigger the GCP deploy: `deploy.yml` only
runs on pushes to `main`.

### Escape hatch

`./publish.sh` still publishes straight from your laptop (bump + build +
`npm publish`). It runs **no** version/CHANGELOG guard, so treat it as the
break-glass path when Actions is down — not the normal route.

After publish:

- The package is live at <https://www.npmjs.com/package/@jaximus/tandem-mcp>
- Users can immediately `npx -y @jaximus/tandem-mcp` or `npm i -g @jaximus/tandem-mcp`
- `pnpm dlx` and `yarn dlx` also work — npm publish covers all four install methods.

## Smoke test after publish

```bash
# In a scratch directory, NOT inside this repo:
cd /tmp
npx -y @jaximus/tandem-mcp
# should start and wait on stdin — kill with Ctrl-C
```

If that hangs cleanly waiting for input, you're good.

## Versioning

- **Patch** (`2.0.0` → `2.0.1`): bug fixes, internal refactors, no tool surface change.
- **Minor** (`2.0.0` → `2.1.0`): new tools, new optional params, anything additive.
- **Major** (`2.0.0` → `3.0.0`): renamed or removed tools, changed param semantics, breaking auth changes.

Keep majors rare — every existing MCP config out there pins the same major via `npx -y` resolving to `^2.0.0`.

## Roadmap (future install paths)

| Method                   | Status   | Notes                                                                 |
| ------------------------ | -------- | --------------------------------------------------------------------- |
| `npx` / `npm i -g`       | Live     | Covered by `npm publish` above.                                       |
| Standalone binaries      | Planned  | `bun build --compile` per platform → GitHub Releases.                 |
| Homebrew tap             | Planned  | Wraps the standalone binary; auto-update via GoReleaser-style tool.   |
| Docker image             | Planned  | `ghcr.io/jaximus808/tandem-mcp`; published from GitHub Actions on tag.|
| Hosted HTTP MCP endpoint | Planned  | Streamable HTTP transport; zero install for users.                    |
