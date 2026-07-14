package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// OAuth 2.1 authorization-server storage (migration 0029). Secrets (auth codes,
// access + refresh tokens) are stored ONLY as SHA-256 hashes — see HashToken in
// supabase.go, shared with the PAT model. Plaintext is returned to the client
// once and never persisted or logged.

// OAuthAccessPrefix namespaces OAuth access tokens. The auth middleware
// prefix-gates on it so a bearer that isn't an OAuth access token skips the DB
// lookup, and it keeps these unmistakable for PATs (tdm_pat_) / claim tokens.
const (
	OAuthAccessPrefix   = "tdm_oat_"
	oauthRefreshPrefix  = "tdm_ort_"
	oauthCodePrefix     = "tdm_ac_"
	oauthClientIDPrefix = "tdm_client_"
)

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Errorf("crypto/rand: %w", err))
	}
	return hex.EncodeToString(b)
}

// GenerateOAuthClientID mints a client identifier for dynamic registration. Not
// a secret (public clients use PKCE), but unguessable to avoid enumeration.
func GenerateOAuthClientID() string { return oauthClientIDPrefix + randomHex(16) }

// GenerateAuthCode / GenerateAccessToken / GenerateRefreshToken each mint a
// 256-bit opaque secret with its namespacing prefix.
func GenerateAuthCode() string     { return oauthCodePrefix + randomHex(32) }
func GenerateAccessToken() string  { return OAuthAccessPrefix + randomHex(32) }
func GenerateRefreshToken() string { return oauthRefreshPrefix + randomHex(32) }

// ── DB row types ────────────────────────────────────────────────────────────

type dbOAuthClient struct {
	ID                      string   `json:"id"`
	ClientName              string   `json:"client_name"`
	RedirectURIs            []string `json:"redirect_uris"`
	GrantTypes              []string `json:"grant_types"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
	CreatedAt               string   `json:"created_at"`
}

type dbOAuthCode struct {
	ClientID            string `json:"client_id"`
	UserID              string `json:"user_id"`
	RedirectURI         string `json:"redirect_uri"`
	CodeChallenge       string `json:"code_challenge"`
	CodeChallengeMethod string `json:"code_challenge_method"`
	Scope               string `json:"scope"`
	Resource            string `json:"resource"`
	ExpiresAt           string `json:"expires_at"`
}

type dbOAuthToken struct {
	ID               string  `json:"id"`
	ClientID         string  `json:"client_id"`
	UserID           string  `json:"user_id"`
	Scope            string  `json:"scope"`
	Resource         string  `json:"resource"`
	AccessExpiresAt  string  `json:"access_expires_at"`
	RefreshExpiresAt *string `json:"refresh_expires_at"`
}

// ── Clients ─────────────────────────────────────────────────────────────────

func (s *supabaseStore) CreateOAuthClient(_ context.Context, c *OAuthClient) error {
	return s.exec(s.client.From("oauth_clients").
		Insert(map[string]any{
			"id":                         c.ID,
			"client_name":                c.ClientName,
			"redirect_uris":              c.RedirectURIs,
			"grant_types":                c.GrantTypes,
			"token_endpoint_auth_method": c.TokenEndpointAuthMethod,
		}, false, "", "minimal", ""))
}

func (s *supabaseStore) GetOAuthClient(_ context.Context, id string) (*OAuthClient, error) {
	var rows []dbOAuthClient
	_, err := s.client.From("oauth_clients").
		Select("*", "", false).
		Eq("id", id).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, ErrInvalidGrant
	}
	d := rows[0]
	return &OAuthClient{
		ID: d.ID, ClientName: d.ClientName,
		RedirectURIs: d.RedirectURIs, GrantTypes: d.GrantTypes,
		TokenEndpointAuthMethod: d.TokenEndpointAuthMethod,
		CreatedAt:               parseTime(d.CreatedAt),
	}, nil
}

// ── Authorization codes ─────────────────────────────────────────────────────

func (s *supabaseStore) CreateAuthCode(_ context.Context, codeHash string, c *OAuthCode) error {
	return s.exec(s.client.From("oauth_authorization_codes").
		Insert(map[string]any{
			"code_hash":             codeHash,
			"client_id":             c.ClientID,
			"user_id":               c.UserID.String(),
			"redirect_uri":          c.RedirectURI,
			"code_challenge":        c.CodeChallenge,
			"code_challenge_method": c.CodeChallengeMethod,
			"scope":                 c.Scope,
			"resource":              c.Resource,
			"expires_at":            c.ExpiresAt.UTC().Format(time.RFC3339),
		}, false, "", "minimal", ""))
}

// ConsumeAuthCode deletes the code row and returns what it deleted — a single
// atomic step, so a replayed code finds nothing (single use). Expiry is checked
// in Go after the delete; an expired code is still consumed (can't be reused).
func (s *supabaseStore) ConsumeAuthCode(_ context.Context, codeHash string) (*OAuthCode, error) {
	var rows []dbOAuthCode
	_, err := s.client.From("oauth_authorization_codes").
		Delete("representation", "").
		Eq("code_hash", codeHash).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, ErrInvalidGrant
	}
	d := rows[0]
	uid, err := uuid.Parse(d.UserID)
	if err != nil {
		return nil, ErrInvalidGrant
	}
	c := &OAuthCode{
		ClientID: d.ClientID, UserID: uid, RedirectURI: d.RedirectURI,
		CodeChallenge: d.CodeChallenge, CodeChallengeMethod: d.CodeChallengeMethod,
		Scope: d.Scope, Resource: d.Resource, ExpiresAt: parseTime(d.ExpiresAt),
	}
	if time.Now().After(c.ExpiresAt) {
		return nil, ErrInvalidGrant
	}
	return c, nil
}

// ── Tokens ──────────────────────────────────────────────────────────────────

func (s *supabaseStore) CreateOAuthGrant(_ context.Context, accessHash, refreshHash string, g *OAuthGrant) error {
	row := map[string]any{
		"access_token_hash": accessHash,
		"client_id":         g.ClientID,
		"user_id":           g.UserID.String(),
		"scope":             g.Scope,
		"resource":          g.Resource,
		"access_expires_at": g.AccessExpiresAt.UTC().Format(time.RFC3339),
	}
	if refreshHash != "" {
		row["refresh_token_hash"] = refreshHash
	}
	if g.RefreshExpiresAt != nil {
		row["refresh_expires_at"] = g.RefreshExpiresAt.UTC().Format(time.RFC3339)
	}
	return s.exec(s.client.From("oauth_tokens").
		Insert(row, false, "", "minimal", ""))
}

// OAuthUserByAccessHash resolves the user behind a live access token (not
// expired, not revoked) and best-effort touches last_used_at. Returns
// ErrInvalidToken otherwise so the middleware can fall through to anonymous.
func (s *supabaseStore) OAuthUserByAccessHash(_ context.Context, accessHash string) (uuid.UUID, error) {
	var rows []dbOAuthToken
	_, err := s.client.From("oauth_tokens").
		Select("id,user_id,access_expires_at", "", false).
		Eq("access_token_hash", accessHash).
		Is("revoked_at", "null").
		ExecuteTo(&rows)
	if err != nil {
		return uuid.Nil, err
	}
	if len(rows) == 0 {
		return uuid.Nil, ErrInvalidToken
	}
	d := rows[0]
	if time.Now().After(parseTime(d.AccessExpiresAt)) {
		return uuid.Nil, ErrInvalidToken
	}
	uid, err := uuid.Parse(d.UserID)
	if err != nil {
		return uuid.Nil, ErrInvalidToken
	}
	_ = s.exec(s.client.From("oauth_tokens").
		Update(map[string]string{"last_used_at": time.Now().UTC().Format(time.RFC3339)}, "minimal", "").
		Eq("id", d.ID))
	return uid, nil
}

// ConsumeRefreshGrant atomically revokes the grant behind a refresh-token hash
// (only if still live) and returns its metadata so the caller can mint a rotated
// pair. The revoke-and-return is the race guard: a replayed refresh token finds
// the row already revoked and gets nothing. Expiry is checked after.
func (s *supabaseStore) ConsumeRefreshGrant(_ context.Context, refreshHash string) (*OAuthGrant, error) {
	var rows []dbOAuthToken
	_, err := s.client.From("oauth_tokens").
		Update(map[string]any{"revoked_at": time.Now().UTC().Format(time.RFC3339)}, "representation", "").
		Eq("refresh_token_hash", refreshHash).
		Is("revoked_at", "null").
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, ErrInvalidGrant
	}
	d := rows[0]
	uid, err := uuid.Parse(d.UserID)
	if err != nil {
		return nil, ErrInvalidGrant
	}
	g := &OAuthGrant{ClientID: d.ClientID, UserID: uid, Scope: d.Scope, Resource: d.Resource}
	if d.RefreshExpiresAt != nil {
		exp := parseTime(*d.RefreshExpiresAt)
		if time.Now().After(exp) {
			return nil, ErrInvalidGrant
		}
		g.RefreshExpiresAt = &exp
	}
	return g, nil
}

// ── Connections (user-facing) ───────────────────────────────────────────────

type dbOAuthConnRow struct {
	ClientID   string  `json:"client_id"`
	CreatedAt  string  `json:"created_at"`
	LastUsedAt *string `json:"last_used_at"`
	Client     *struct {
		ClientName string `json:"client_name"`
	} `json:"oauth_clients"`
}

// ListOAuthConnections returns one entry per client the user has a live token
// for (deduped, newest activity first) — the "connected apps" list.
func (s *supabaseStore) ListOAuthConnections(_ context.Context, userID uuid.UUID) ([]*OAuthConnection, error) {
	var rows []dbOAuthConnRow
	_, err := s.client.From("oauth_tokens").
		Select("client_id,created_at,last_used_at,oauth_clients(client_name)", "", false).
		Eq("user_id", userID.String()).
		Is("revoked_at", "null").
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	// Dedupe by client: keep the earliest created_at and latest last_used_at.
	byClient := map[string]*OAuthConnection{}
	order := []string{}
	for _, d := range rows {
		conn, ok := byClient[d.ClientID]
		if !ok {
			conn = &OAuthConnection{ClientID: d.ClientID}
			if d.Client != nil {
				conn.ClientName = d.Client.ClientName
			}
			byClient[d.ClientID] = conn
			order = append(order, d.ClientID)
		}
		created := parseTime(d.CreatedAt)
		if conn.CreatedAt.IsZero() || created.Before(conn.CreatedAt) {
			conn.CreatedAt = created
		}
		if d.LastUsedAt != nil && *d.LastUsedAt != "" {
			lu := parseTime(*d.LastUsedAt)
			if conn.LastUsedAt == nil || lu.After(*conn.LastUsedAt) {
				conn.LastUsedAt = &lu
			}
		}
	}
	out := make([]*OAuthConnection, 0, len(order))
	for _, id := range order {
		out = append(out, byClient[id])
	}
	return out, nil
}

// RevokeOAuthConnection revokes all of the user's live tokens for a client.
func (s *supabaseStore) RevokeOAuthConnection(_ context.Context, userID uuid.UUID, clientID string) error {
	var rows []dbOAuthToken
	_, err := s.client.From("oauth_tokens").
		Update(map[string]any{"revoked_at": time.Now().UTC().Format(time.RFC3339)}, "representation", "").
		Eq("user_id", userID.String()).
		Eq("client_id", clientID).
		Is("revoked_at", "null").
		ExecuteTo(&rows)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return ErrInvalidGrant
	}
	return nil
}
