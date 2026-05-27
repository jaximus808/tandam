# Publishing `@tandem/mcp-gateway`

One-time setup, then a single command per release.

## One-time setup

### 1. Claim the `@tandem` scope on npm

```bash
npm login
# username, password, OTP — uses your existing npm account
```

If you don't have an org, create one (free for public packages):

1. Go to <https://www.npmjs.com/org/create>
2. Org name: `tandem`
3. Plan: "Unlimited public packages" (free)

If `tandem` is taken, switch to a different scope and update `name` in `package.json` accordingly.

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

- The package is live at <https://www.npmjs.com/package/@tandem/mcp-gateway>
- Users can immediately `npx -y @tandem/mcp-gateway` or `npm i -g @tandem/mcp-gateway`
- `pnpm dlx` and `yarn dlx` also work — npm publish covers all four install methods.

## Smoke test after publish

```bash
# In a scratch directory, NOT inside this repo:
cd /tmp
npx -y @tandem/mcp-gateway
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
