-- MCP OAuth 2.1 authorization server (for the hosted claude.ai connector).
--
-- The Go API acts as an OAuth 2.1 authorization server so a claude.ai user can
-- authorize Tandem and act as themselves over the hosted /api/mcp connector —
-- the multi-tenant sidecar that can't take a per-user env var the way the stdio
-- gateway takes TANDEM_TOKEN. Follows the MCP Authorization spec: RFC 8414
-- metadata, RFC 7591 dynamic client registration, Authorization Code + PKCE
-- (S256), RFC 8707 resource indicators.
--
-- Three tables:
--   oauth_clients             — dynamically-registered clients (claude.ai self-
--                               registers). Public clients (PKCE, no secret).
--   oauth_authorization_codes — short-lived, single-use codes bridging /authorize
--                               and /token. Stored hashed; deleted on exchange.
--   oauth_tokens              — issued access + refresh tokens. Hashed at rest
--                               (a DB leak yields no usable tokens), revocable,
--                               with rotation on refresh.
--
-- Security mirrors the PAT model (migration 0027): only SHA-256 hashes of the
-- secrets are stored; plaintext is returned to the client exactly once. A token
-- grants only the user's OWN access — role is still resolved per-canvas by
-- ResolveCanvasRole.

CREATE TABLE oauth_clients (
  id                         TEXT        PRIMARY KEY,          -- client_id (tdm_client_…)
  client_name                TEXT        NOT NULL DEFAULT '',
  redirect_uris              JSONB       NOT NULL DEFAULT '[]',
  grant_types                JSONB       NOT NULL DEFAULT '["authorization_code","refresh_token"]',
  token_endpoint_auth_method TEXT        NOT NULL DEFAULT 'none', -- public client / PKCE
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE oauth_authorization_codes (
  code_hash             TEXT        PRIMARY KEY,               -- sha256(code)
  client_id             TEXT        NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id               UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri          TEXT        NOT NULL,
  code_challenge        TEXT        NOT NULL,                  -- PKCE (S256)
  code_challenge_method TEXT        NOT NULL DEFAULT 'S256',
  scope                 TEXT        NOT NULL DEFAULT '',
  resource              TEXT        NOT NULL DEFAULT '',       -- RFC 8707
  expires_at            TIMESTAMPTZ NOT NULL,                  -- short (~5 min)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX oauth_authorization_codes_expires_idx ON oauth_authorization_codes(expires_at);

CREATE TABLE oauth_tokens (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token_hash  TEXT        NOT NULL UNIQUE,              -- sha256(access token)
  refresh_token_hash TEXT        UNIQUE,                       -- sha256(refresh token), null if none
  client_id          TEXT        NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id            UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope              TEXT        NOT NULL DEFAULT '',
  resource           TEXT        NOT NULL DEFAULT '',
  access_expires_at  TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at       TIMESTAMPTZ,
  revoked_at         TIMESTAMPTZ                               -- non-null = revoked
);

CREATE INDEX oauth_tokens_user_id_idx ON oauth_tokens(user_id);
CREATE INDEX oauth_tokens_refresh_idx ON oauth_tokens(refresh_token_hash) WHERE refresh_token_hash IS NOT NULL;
