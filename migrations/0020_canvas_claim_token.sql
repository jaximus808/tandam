-- Canvas claim tokens — let the rightful recipient of an anonymous canvas take
-- ownership of THE SAME canvas (not a copy), without a fragile time window.
--
-- Background: anonymous canvases (owner_user_id NULL) are created by the MCP
-- gateway (Claude) and, later, by logged-out web users. Until now the only way
-- to "own" one was copy_canvas (migration 0018) — a deep COPY, which forks the
-- canvas and breaks the "agent keeps editing the canvas you now own" story.
--
-- The claim_token is a one-time bearer secret, SEPARATE from the canvas code:
--   * code       = view / collaborate capability — safe to share.
--   * claim_token = own-it capability — secret, single-use, voided on claim.
-- Possession of the token (not timing) authorizes the claim, so refresh /
-- sign-up delay / sharing the view link never cost the user their canvas. The
-- claim is atomic + first-wins: an UPDATE gated on owner_user_id IS NULL.
--
-- Format is deliberately distinct from the canvas code (8 chars, uppercase,
-- ambiguity-free alphabet) — claim tokens are `clm_`-prefixed lowercase hex — so
-- a code can never be confused for a token (or collide with one).
--
-- NULL once a canvas is owned: set only on anonymous creates, cleared on claim.

ALTER TABLE canvases
  ADD COLUMN claim_token TEXT NULL;

-- Partial unique index: tokens are unique while live, but the many owned/legacy
-- canvases (claim_token NULL) are exempt so NULLs don't need to be distinct.
CREATE UNIQUE INDEX canvases_claim_token_key
  ON canvases(claim_token)
  WHERE claim_token IS NOT NULL;
