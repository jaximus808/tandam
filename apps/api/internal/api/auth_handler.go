package api

import (
	"net/http"
	"time"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/store"
)

const (
	sessionCookieName = "tandem_session"
	sessionTTL        = 30 * 24 * time.Hour
)

// AuthHandler owns the human login flow: verify a Google ID token, upsert the
// user, and hand back an httpOnly session cookie. google may be nil when
// GOOGLE_CLIENT_ID isn't configured — login routes then return 503 so the rest
// of the app still boots.
type AuthHandler struct {
	store        store.Store
	authSvc      *auth.Service
	google       *auth.GoogleVerifier
	cookieSecure bool
}

func NewAuthHandler(s store.Store, authSvc *auth.Service, google *auth.GoogleVerifier, cookieSecure bool) *AuthHandler {
	return &AuthHandler{store: s, authSvc: authSvc, google: google, cookieSecure: cookieSecure}
}

func (h *AuthHandler) setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(sessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (h *AuthHandler) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

// POST /api/auth/google  — body: { credential: <google id token> }
func (h *AuthHandler) GoogleLogin(w http.ResponseWriter, r *http.Request) {
	if h.google == nil {
		writeError(w, http.StatusServiceUnavailable, "google sign-in is not configured")
		return
	}
	var body struct {
		Credential string `json:"credential"`
	}
	if err := decode(r, &body); err != nil || body.Credential == "" {
		writeError(w, http.StatusBadRequest, "credential is required")
		return
	}
	claims, err := h.google.Verify(r.Context(), body.Credential)
	if err != nil {
		writeError(w, http.StatusUnauthorized, err.Error())
		return
	}
	user, err := h.store.UpsertUserByGoogleSub(r.Context(), &store.User{
		GoogleSub:   claims.Sub,
		Email:       claims.Email,
		DisplayName: claims.Name,
		AvatarURL:   claims.Picture,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	token, err := h.authSvc.IssueSession(user.ID, sessionTTL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	h.setSessionCookie(w, token)
	writeJSON(w, http.StatusOK, user)
}

// GET /api/auth/me — returns the logged-in user, or 401 if not signed in.
func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || cookie.Value == "" {
		writeError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	claims, err := h.authSvc.ValidateSession(cookie.Value)
	if err != nil {
		h.clearSessionCookie(w)
		writeError(w, http.StatusUnauthorized, "invalid session")
		return
	}
	user, err := h.store.GetUserByID(r.Context(), claims.UserID)
	if err != nil {
		h.clearSessionCookie(w)
		writeError(w, http.StatusUnauthorized, "user not found")
		return
	}
	writeJSON(w, http.StatusOK, user)
}

// POST /api/auth/logout — clears the session cookie.
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	h.clearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}
