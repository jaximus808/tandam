package api

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
)

// OAuth 2.1 authorization server for the hosted MCP connector (migration 0029).
//
// Lets a claude.ai user authorize Tandem and act as themselves over the hosted
// /api/mcp connector — the multi-tenant sidecar that can't take a per-user env
// var the way the stdio gateway takes TANDEM_TOKEN. Implements the slice of the
// MCP Authorization spec the connector drives: RFC 8414 + RFC 9728 metadata,
// RFC 7591 dynamic client registration, Authorization Code + PKCE (S256), RFC
// 8707 resource indicators, and refresh-token rotation.
//
// Split of responsibilities:
//   - /.well-known/*         discovery metadata (this handler)
//   - POST /oauth/register   dynamic client registration (this handler)
//   - GET  /oauth/authorize  the consent PAGE — falls through to the SPA, which
//                            reuses the Google session, then calls the two
//                            /api/oauth/authorize endpoints below
//   - GET  /api/oauth/authorize   validate the request + return client info (RequireUser)
//   - POST /api/oauth/authorize   mint the authorization code (RequireUser)
//   - POST /oauth/token      code→token exchange + refresh (this handler)

const (
	oauthAuthCodeTTL = 5 * time.Minute
	oauthAccessTTL   = time.Hour
	oauthRefreshTTL  = 30 * 24 * time.Hour
	// mcpResourcePath is the protected resource (the hosted MCP endpoint) this
	// authorization server issues tokens for.
	mcpResourcePath = "/api/mcp"
	oauthScope      = "tandem"
)

type OAuthHandler struct {
	store         store.Store
	publicBaseURL string
}

func NewOAuthHandler(s store.Store, publicBaseURL string) *OAuthHandler {
	return &OAuthHandler{store: s, publicBaseURL: strings.TrimRight(publicBaseURL, "/")}
}

// baseURL is the externally-reachable origin used to build issuer + endpoint
// URLs. Prefers the configured PUBLIC_BASE_URL; otherwise derives it from the
// request (Host + forwarded proto), which is correct for local dev.
func (h *OAuthHandler) baseURL(r *http.Request) string {
	if h.publicBaseURL != "" {
		return h.publicBaseURL
	}
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// writeOAuthError emits an RFC 6749 error envelope with no-store caching.
func writeOAuthError(w http.ResponseWriter, status int, code, desc string) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, map[string]string{"error": code, "error_description": desc})
}

// ── Discovery ───────────────────────────────────────────────────────────────

// GET /.well-known/oauth-protected-resource[/…] (RFC 9728). Tells the client
// which authorization server guards the MCP resource.
func (h *OAuthHandler) ProtectedResourceMetadata(w http.ResponseWriter, r *http.Request) {
	base := h.baseURL(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"resource":                 base + mcpResourcePath,
		"authorization_servers":    []string{base},
		"bearer_methods_supported": []string{"header"},
		"scopes_supported":         []string{oauthScope},
	})
}

// GET /.well-known/oauth-authorization-server[/…] (RFC 8414).
func (h *OAuthHandler) AuthorizationServerMetadata(w http.ResponseWriter, r *http.Request) {
	base := h.baseURL(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                base,
		"authorization_endpoint":                base + "/oauth/authorize",
		"token_endpoint":                        base + "/oauth/token",
		"registration_endpoint":                 base + "/oauth/register",
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":      []string{"S256"},
		"token_endpoint_auth_methods_supported": []string{"none"},
		"scopes_supported":                      []string{oauthScope},
	})
}

// ── Dynamic client registration (RFC 7591) ──────────────────────────────────

// POST /oauth/register. Public clients only (PKCE, no secret).
func (h *OAuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ClientName              string   `json:"client_name"`
		RedirectURIs            []string `json:"redirect_uris"`
		GrantTypes              []string `json:"grant_types"`
		TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
	}
	if err := decode(r, &body); err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client_metadata", "invalid registration body")
		return
	}
	if len(body.RedirectURIs) == 0 {
		writeOAuthError(w, http.StatusBadRequest, "invalid_redirect_uri", "at least one redirect_uri is required")
		return
	}
	for _, u := range body.RedirectURIs {
		if !isValidRedirectURI(u) {
			writeOAuthError(w, http.StatusBadRequest, "invalid_redirect_uri", "redirect_uri must be an absolute http(s) URL")
			return
		}
	}
	client := &store.OAuthClient{
		ID:                      store.GenerateOAuthClientID(),
		ClientName:              strings.TrimSpace(body.ClientName),
		RedirectURIs:            body.RedirectURIs,
		GrantTypes:              []string{"authorization_code", "refresh_token"},
		TokenEndpointAuthMethod: "none",
	}
	if err := h.store.CreateOAuthClient(r.Context(), client); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to register client")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, map[string]any{
		"client_id":                  client.ID,
		"client_id_issued_at":        time.Now().Unix(),
		"client_name":                client.ClientName,
		"redirect_uris":              client.RedirectURIs,
		"grant_types":                client.GrantTypes,
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": "none",
	})
}

// ── Authorization (consent) ─────────────────────────────────────────────────

// GET /api/oauth/authorize?client_id=&redirect_uri= (RequireUser). Validates the
// request enough for the SPA consent page to render (or fail fast) and returns
// the client's display name.
func (h *OAuthHandler) GetAuthorizationInfo(w http.ResponseWriter, r *http.Request) {
	if _, ok := UserIDFromCtx(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	clientID := r.URL.Query().Get("client_id")
	redirectURI := r.URL.Query().Get("redirect_uri")
	client, err := h.validateClientRedirect(r, clientID, redirectURI)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"clientId":   client.ID,
		"clientName": client.ClientName,
	})
}

// POST /api/oauth/authorize (RequireUser). The consent "Allow" action: validates
// the request, mints a single-use authorization code bound to this user + PKCE
// challenge, and returns the redirect URL (client callback + code + state) for
// the SPA to navigate to.
func (h *OAuthHandler) Approve(w http.ResponseWriter, r *http.Request) {
	uid, ok := UserIDFromCtx(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	var body struct {
		ClientID            string `json:"clientId"`
		RedirectURI         string `json:"redirectUri"`
		CodeChallenge       string `json:"codeChallenge"`
		CodeChallengeMethod string `json:"codeChallengeMethod"`
		State               string `json:"state"`
		Scope               string `json:"scope"`
		Resource            string `json:"resource"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if _, err := h.validateClientRedirect(r, body.ClientID, body.RedirectURI); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// PKCE is mandatory (public client). Only S256 is supported.
	if body.CodeChallenge == "" || (body.CodeChallengeMethod != "" && body.CodeChallengeMethod != "S256") {
		writeError(w, http.StatusBadRequest, "a valid S256 code_challenge is required")
		return
	}

	code := store.GenerateAuthCode()
	err := h.store.CreateAuthCode(r.Context(), store.HashToken(code), &store.OAuthCode{
		ClientID:            body.ClientID,
		UserID:              uid,
		RedirectURI:         body.RedirectURI,
		CodeChallenge:       body.CodeChallenge,
		CodeChallengeMethod: "S256",
		Scope:               scopeOrDefault(body.Scope),
		Resource:            body.Resource,
		ExpiresAt:           time.Now().Add(oauthAuthCodeTTL),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to issue authorization code")
		return
	}

	// Build the callback URL: redirect_uri + ?code=&state=.
	sep := "?"
	if strings.Contains(body.RedirectURI, "?") {
		sep = "&"
	}
	redirect := body.RedirectURI + sep + "code=" + url.QueryEscape(code)
	if body.State != "" {
		redirect += "&state=" + url.QueryEscape(body.State)
	}
	writeJSON(w, http.StatusOK, map[string]any{"redirectUri": redirect})
}

// ── Token endpoint ──────────────────────────────────────────────────────────

// POST /oauth/token. Form-encoded per OAuth. Handles authorization_code (with
// PKCE) and refresh_token (rotating) grants.
func (h *OAuthHandler) Token(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "could not parse form body")
		return
	}
	switch r.PostForm.Get("grant_type") {
	case "authorization_code":
		h.tokenFromCode(w, r)
	case "refresh_token":
		h.tokenFromRefresh(w, r)
	default:
		writeOAuthError(w, http.StatusBadRequest, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token")
	}
}

func (h *OAuthHandler) tokenFromCode(w http.ResponseWriter, r *http.Request) {
	code := r.PostForm.Get("code")
	verifier := r.PostForm.Get("code_verifier")
	clientID := r.PostForm.Get("client_id")
	redirectURI := r.PostForm.Get("redirect_uri")
	if code == "" || verifier == "" || clientID == "" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "code, code_verifier and client_id are required")
		return
	}

	c, err := h.store.ConsumeAuthCode(r.Context(), store.HashToken(code))
	if err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "authorization code is invalid or expired")
		return
	}
	// The code is single-use and now consumed; every check below simply rejects.
	if c.ClientID != clientID || c.RedirectURI != redirectURI {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "code does not match this client/redirect")
		return
	}
	if !verifyPKCE(verifier, c.CodeChallenge) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "PKCE verification failed")
		return
	}

	h.issueTokens(w, r, &store.OAuthGrant{
		ClientID: c.ClientID, UserID: c.UserID, Scope: c.Scope, Resource: c.Resource,
	})
}

func (h *OAuthHandler) tokenFromRefresh(w http.ResponseWriter, r *http.Request) {
	refresh := r.PostForm.Get("refresh_token")
	clientID := r.PostForm.Get("client_id")
	if refresh == "" || clientID == "" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "refresh_token and client_id are required")
		return
	}
	g, err := h.store.ConsumeRefreshGrant(r.Context(), store.HashToken(refresh))
	if err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "refresh token is invalid or expired")
		return
	}
	if g.ClientID != clientID {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "refresh token does not match this client")
		return
	}
	h.issueTokens(w, r, g)
}

// issueTokens mints a rotated access+refresh pair for a grant and writes the
// token response.
func (h *OAuthHandler) issueTokens(w http.ResponseWriter, r *http.Request, g *store.OAuthGrant) {
	access := store.GenerateAccessToken()
	refresh := store.GenerateRefreshToken()
	refreshExp := time.Now().Add(oauthRefreshTTL)
	g.AccessExpiresAt = time.Now().Add(oauthAccessTTL)
	g.RefreshExpiresAt = &refreshExp

	if err := h.store.CreateOAuthGrant(r.Context(), store.HashToken(access), store.HashToken(refresh), g); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to issue token")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token":  access,
		"token_type":    "Bearer",
		"expires_in":    int(oauthAccessTTL.Seconds()),
		"refresh_token": refresh,
		"scope":         scopeOrDefault(g.Scope),
	})
}

// ── Connected apps (user-facing revocation) ─────────────────────────────────

// GET /api/me/connections (RequireUser). The user's active OAuth authorizations.
func (h *OAuthHandler) ListConnections(w http.ResponseWriter, r *http.Request) {
	uid, ok := UserIDFromCtx(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	conns, err := h.store.ListOAuthConnections(r.Context(), uid)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, conns)
}

// DELETE /api/me/connections/{clientId} (RequireUser). Disconnect a client —
// revokes every live token the user holds for it.
func (h *OAuthHandler) RevokeConnection(w http.ResponseWriter, r *http.Request) {
	uid, ok := UserIDFromCtx(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	clientID := chi.URLParam(r, "clientId")
	if err := h.store.RevokeOAuthConnection(r.Context(), uid, clientID); err != nil {
		if errors.Is(err, store.ErrInvalidGrant) {
			writeError(w, http.StatusNotFound, "no active connection for that app")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// validateClientRedirect loads the client and checks the redirect_uri is one it
// registered — the anti-open-redirect guard shared by the authorize endpoints.
func (h *OAuthHandler) validateClientRedirect(r *http.Request, clientID, redirectURI string) (*store.OAuthClient, error) {
	if clientID == "" || redirectURI == "" {
		return nil, errors.New("client_id and redirect_uri are required")
	}
	client, err := h.store.GetOAuthClient(r.Context(), clientID)
	if err != nil {
		return nil, errors.New("unknown client_id")
	}
	if !client.AllowsRedirect(redirectURI) {
		return nil, errors.New("redirect_uri is not registered for this client")
	}
	return client, nil
}

// verifyPKCE checks base64url(sha256(verifier)) == challenge (S256, RFC 7636).
func verifyPKCE(verifier, challenge string) bool {
	sum := sha256.Sum256([]byte(verifier))
	computed := base64.RawURLEncoding.EncodeToString(sum[:])
	return computed == challenge
}

func isValidRedirectURI(u string) bool {
	return strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://")
}

func scopeOrDefault(s string) string {
	if strings.TrimSpace(s) == "" {
		return oauthScope
	}
	return s
}
