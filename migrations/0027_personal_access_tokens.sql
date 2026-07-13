-- Personal access tokens — let an agent act as a USER over MCP.
--
-- Motivation: `/api/mcp/auth` only ever saw a browser session cookie, so an MCP
-- client (stdio gateway or hosted sidecar) resolved as anonymous → 403 on any
-- private / shared-with-me canvas. A PAT is a user-scoped bearer secret the human
-- mints on /me and pastes into their MCP client config (TANDEM_TOKEN). The gateway
-- forwards it on the auth handshake; the API resolves the user's real role for the
-- canvas and bakes it into the short-lived canvas JWT exactly as before. See the
-- design note on canvas TEGLQFXR.
--
-- Security model:
--   • We store ONLY a SHA-256 hash of the secret. The plaintext is shown to the
--     user exactly once, at mint time, and never persisted or logged — a DB leak
--     cannot recover usable tokens.
--   • The secret is `tdm_pat_` + 32 random bytes (hex). Prefix-namespaced so it
--     can never be confused with a canvas code ('clm_' claim tokens, 8-char codes)
--     and so the API can prefix-gate the hash lookup (skip the DB call for any
--     bearer that isn't a PAT).
--   • Revocation = delete the row. A PAT grants nothing beyond the user's OWN
--     access: role is still resolved per-canvas by ResolveCanvasRole, so the token
--     is least-privilege by construction.
--   • last_four is the trailing 4 chars of the plaintext, kept purely so the UI can
--     disambiguate tokens in a list. expires_at is reserved for a future TTL
--     (NULL = never expires).

CREATE TABLE personal_access_tokens (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT        NOT NULL UNIQUE,          -- sha256(plaintext), hex
  name         TEXT        NOT NULL DEFAULT '',      -- user label, e.g. "Claude Desktop"
  last_four    TEXT        NOT NULL DEFAULT '',      -- trailing 4 chars, for UI only
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NULL,                     -- touched on each successful auth
  expires_at   TIMESTAMPTZ NULL                      -- reserved; NULL = no expiry
);

CREATE INDEX personal_access_tokens_user_id_idx ON personal_access_tokens(user_id);
