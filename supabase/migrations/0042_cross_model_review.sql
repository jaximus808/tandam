-- Cross-model review (TDM-155): an OPT-IN canvas flag that extends the peer rule
-- from "a different agent" to "a different model".
--
-- WHY. Migration 0041 gave a 'peer' canvas a non-self rule: the approver must be
-- a different AGENT than the proposer. But two agents on the same model are the
-- same reviewer wearing two name tags — Opus approving Opus is self-review with
-- extra steps, and the entire argument for agent review is that a different model
-- forms a different opinion. This flag says: on this canvas, don't just be a
-- different agent, be a different model.
--
-- WHAT IT GATES. Both halves of the peer reviewer's job, and only under 'peer':
--   - peer APPROVAL (0041 / TDM-145)  — refusal code `peer_same_model`
--   - peer REWORK   (TDM-154)          — refusal code `rework_same_model`
-- Human approval, reject, bulk approve, born-approved and epic approval are all
-- untouched: they were human-only before this column existed and still are.
--
-- WIDEN, DON'T REWRITE — the same posture as 0041. This migration ADDS one
-- column with a false default and changes no existing row, no existing column and
-- no existing constraint. Every canvas keeps behaving byte-for-byte as it did:
-- the flag is reachable only through the owner-only
-- PATCH /api/canvases/{code}/approval-policy, and it does nothing at all unless
-- approval_policy is already 'peer'.
--
-- The API tolerates this migration NOT being applied: PostgREST simply omits the
-- key, Go decodes the missing bool as false, and false is "off". So the deploy
-- order is free — nothing breaks in either direction.
--
-- THE HONEST LIMIT, and it must be repeated wherever this feature is described:
-- agents.model is SELF-ASSERTED by the connecting agent (canvas_connect takes a
-- `model` argument and stores it verbatim; nothing verifies it). This flag raises
-- the cost of ACCIDENTAL same-model self-review — the realistic failure, where a
-- fleet is all one model and nobody noticed. It does not and cannot stop a client
-- that lies about which model it is. It is not a guarantee. Do not describe it as
-- one. The strong side of the gate is still "human", which no agent credential
-- can produce.
--
-- Corollary, deliberately not papered over: the comparison is on the model ID
-- string (normalized for case, whitespace, a provider prefix like "anthropic/",
-- and a bracketed variant suffix like "[1m]"). It catches the SAME model spelled
-- two ways. It does not claim to know model FAMILIES — "claude-opus-4-8"
-- reviewing "claude-opus-5" passes this check. Different weights, plausibly a
-- different opinion; pretending to adjudicate architecture lineage from a free
-- text string would be a guess wearing a uniform.

-- APPLY MANUALLY (Jaxon). Safe to apply before or after the API deploy.

ALTER TABLE public.canvases
  ADD COLUMN IF NOT EXISTS require_cross_model_review boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN canvases.require_cross_model_review IS
  'Opt-in, default false. Under approval_policy = ''peer'' only: a peer approval or rework bounce is refused when the reviewer and the author/completer report the SAME self-asserted agents.model (codes peer_same_model / rework_same_model). Fails OPEN when either model is unrecorded — an unknown model must not brick peer review on a live canvas. Model is self-asserted: this raises the cost of accidental self-review, it does not prevent a lying client. See apps/api/internal/api/peer_approval.go.';
