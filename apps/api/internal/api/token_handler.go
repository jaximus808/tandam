package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// Personal access tokens — user-scoped MCP credentials. These let an agent act
// as the signed-in user over MCP: the human mints a token here, pastes it into
// their MCP client config (TANDEM_TOKEN), and the gateway forwards it on the
// auth handshake so `/api/mcp/auth` resolves their real role on private/shared
// canvases instead of anonymous. See migration 0027 + the design note on TEGLQFXR.
//
// All three routes sit behind RequireUser, so the user id comes from the
// validated session context. The plaintext secret is returned exactly once, at
// mint time; only its hash is ever stored.

// GET /api/me/tokens — list the signed-in user's tokens (metadata only).
func (h *Handler) ListTokens(w http.ResponseWriter, r *http.Request) {
	uid, ok := UserIDFromCtx(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	tokens, err := h.store.ListPersonalAccessTokens(r.Context(), uid)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, tokens)
}

// POST /api/me/tokens — mint a token. Body: { "name": "Claude Desktop" }.
// Returns the metadata plus the plaintext `token` — the ONLY time it's shown.
func (h *Handler) CreateToken(w http.ResponseWriter, r *http.Request) {
	uid, ok := UserIDFromCtx(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = "Untitled token"
	}
	if len(name) > 80 {
		name = name[:80]
	}

	// Generate the secret, then persist only its hash. The plaintext never
	// touches the DB or logs.
	secret := store.GeneratePAT()
	tok, err := h.store.CreatePersonalAccessToken(
		r.Context(), uid, name, store.HashToken(secret), store.LastFour(secret),
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":        tok.ID,
		"name":      tok.Name,
		"lastFour":  tok.LastFour,
		"createdAt": tok.CreatedAt,
		"token":     secret,
		"_note":     "Copy this token now — it won't be shown again. Set it as the TANDEM_TOKEN env var in your MCP client config.",
	})
}

// DELETE /api/me/tokens/{id} — revoke a token. Scoped to the owner.
func (h *Handler) RevokeToken(w http.ResponseWriter, r *http.Request) {
	uid, ok := UserIDFromCtx(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid token id")
		return
	}
	if err := h.store.DeletePersonalAccessToken(r.Context(), uid, id); err != nil {
		if errors.Is(err, store.ErrInvalidToken) {
			writeError(w, http.StatusNotFound, "token not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}
