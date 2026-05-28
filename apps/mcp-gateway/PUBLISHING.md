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

You should see only `dist/`, `README.md`, `LICENSE`, and `package.json` in the tarball. If you see `src/` or `node_modules/`, fix the `files` field in `package.json` before publishing.

## Per-release workflow

```bash
cd apps/mcp-gateway

# 1. Bump version
npm version patch   # or: minor, major

# 2. Publish
npm publish
# prepublishOnly runs the build automatically
```

That's it. `npm version` commits and tags. `npm publish` pushes the tarball to npm.

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
