-- Canvas claim tokens — turn an anonymous canvas into an owned one without copying.
--
-- Motivation: when Claude (or any anonymous client) creates a canvas via the MCP
-- gateway, owner_user_id is NULL. We want the human Claude is talking to to be
-- able to CLAIM that exact canvas (set themselves as owner) so the agent keeps
-- writing to the same canvas the user is watching — unlike copy_canvas (0018),
-- which forks into a new canvas and breaks the live link.
--
-- Security model: claiming is a bearer capability. Possession of the claim_token
-- is the only thing required to claim — there is deliberately NO time window
-- (a timer punishes the legit user, who needs minutes to sign up, far more than
-- an attacker, who claims in one second). The token is:
--   • a DIFFERENT format from the canvas code (code = 8 chars, uppercase, ambiguity
--     -free alphabet; token = 'clm_' + 32 hex). They can never be confused for or
--     collide with one another.
--   • separate from the code on purpose: the code is the VIEW capability (safe to
--     share); the token is the OWN capability (kept private, handed only to the
--     intended human). Sharing a view link can never leak claim rights.
--   • single-use: voided (set NULL) the instant a claim succeeds.
--
-- The claim itself is a single atomic UPDATE ... WHERE owner_user_id IS NULL, so
-- the first holder to claim wins with no race; later attempts find owner set.
--
-- NULL claim_token = not claimable this way: either already owned (created by a
-- logged-in user, or already claimed) or a legacy pre-0020 canvas.

ALTER TABLE canvases
  ADD COLUMN claim_token TEXT NULL;

-- Partial unique index: tokens are unique while live, but the many NULLs (owned /
-- legacy / claimed canvases) are exempt so they don't collide.
CREATE UNIQUE INDEX canvases_claim_token_key
  ON canvases(claim_token)
  WHERE claim_token IS NOT NULL;
