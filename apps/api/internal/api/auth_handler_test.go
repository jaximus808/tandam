package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// authFakeStore stubs the one method the account-deletion path touches. Every
// other Store method panics via the embedded nil interface.
type authFakeStore struct {
	store.Store
	deleted   []uuid.UUID
	deleteErr error
}

func (f *authFakeStore) DeleteUserAccount(_ context.Context, userID uuid.UUID) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	f.deleted = append(f.deleted, userID)
	return nil
}

// deleteMeRequest builds a DELETE /api/auth/me request, optionally carrying a
// RequireUser-style user id in context (uid == uuid.Nil leaves it out).
func deleteMeRequest(uid uuid.UUID) *http.Request {
	req := httptest.NewRequest("DELETE", "/api/auth/me", nil)
	if uid != uuid.Nil {
		req = req.WithContext(context.WithValue(req.Context(), userIDKey, uid))
	}
	return req
}

// sessionCookie returns the tandem_session Set-Cookie from the response, or
// nil if none was written.
func sessionCookie(w *httptest.ResponseRecorder) *http.Cookie {
	for _, c := range w.Result().Cookies() {
		if c.Name == sessionCookieName {
			return c
		}
	}
	return nil
}

// Confirming deletes the account through the store (scoped to the session's
// user id) and clears the session cookie so the client lands signed-out.
func TestDeleteMeDeletesAccountAndClearsSession(t *testing.T) {
	uid := uuid.New()
	fake := &authFakeStore{}
	h := NewAuthHandler(fake, nil, nil, false)

	w := httptest.NewRecorder()
	h.DeleteMe(w, deleteMeRequest(uid))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	if len(fake.deleted) != 1 || fake.deleted[0] != uid {
		t.Fatalf("deleted = %v, want [%s]", fake.deleted, uid)
	}
	c := sessionCookie(w)
	if c == nil {
		t.Fatalf("no %s Set-Cookie in response — session not cleared", sessionCookieName)
	}
	if c.Value != "" || c.MaxAge >= 0 {
		t.Fatalf("session cookie not cleared: value=%q maxAge=%d", c.Value, c.MaxAge)
	}
}

// No validated session in context (RequireUser didn't run / rejected) is a
// 401 and must not touch the store.
func TestDeleteMeUnauthenticated(t *testing.T) {
	fake := &authFakeStore{}
	h := NewAuthHandler(fake, nil, nil, false)

	w := httptest.NewRecorder()
	h.DeleteMe(w, deleteMeRequest(uuid.Nil))

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (body %s)", w.Code, w.Body.String())
	}
	if len(fake.deleted) != 0 {
		t.Fatalf("store called despite missing session: %v", fake.deleted)
	}
}

// A store failure is a 500 and must NOT clear the session cookie — the
// account still exists, so signing the user out would be lying about state.
func TestDeleteMeStoreErrorKeepsSession(t *testing.T) {
	fake := &authFakeStore{deleteErr: fmt.Errorf("db unavailable")}
	h := NewAuthHandler(fake, nil, nil, false)

	w := httptest.NewRecorder()
	h.DeleteMe(w, deleteMeRequest(uuid.New()))

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %s)", w.Code, w.Body.String())
	}
	if c := sessionCookie(w); c != nil {
		t.Fatalf("session cookie written on failure: %+v", c)
	}
}
