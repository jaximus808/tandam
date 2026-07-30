package api

import (
	"encoding/json"
	"net/http"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// writeCodedError writes the API's machine-readable error envelope:
//
//	{"error": "<code>", "message": "<what to do about it>", …extra}
//
// The shape the inbound status endpoint has always answered in
// (writeTaskStatusError), lifted out here so a MIDDLEWARE answering on behalf of
// many routes can speak it too — see ResolveTicketRef, which now 404s an unknown
// ticket ref instead of letting each handler mislabel it as a malformed id.
// `error` is a stable code to branch on; `message` says what the next call
// should be, because the caller may be a curl in CI with no model behind it.
// `extra` carries the fact that makes it actionable (the ref, the holder, …).
//
// Plain writeError (prose in `error`, no code) stays the shape of the existing
// per-handler errors: it is what today's clients of those routes parse, so this
// envelope is for NEW answers rather than a retrofit of every one of them.
func writeCodedError(w http.ResponseWriter, status int, code, message string, extra map[string]string) {
	out := map[string]string{"error": code, "message": message}
	for k, v := range extra {
		out[k] = v
	}
	writeJSON(w, status, out)
}

func decode(r *http.Request, v any) error {
	return json.NewDecoder(r.Body).Decode(v)
}
