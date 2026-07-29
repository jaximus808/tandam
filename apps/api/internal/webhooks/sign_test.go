package webhooks

import (
	"strings"
	"testing"
	"time"
)

// The published test vector. A receiver implementer can paste these three
// inputs into any HMAC library and must get this exact digest — that is the
// whole point of pinning it here rather than asserting Sign against a
// re-computation of itself (which would pass even if the signed string changed
// shape and silently broke every receiver in the field).
//
// Reproduce it in Python:
//
//	import hmac, hashlib
//	hmac.new(b"whsec_tandem_test_secret",
//	         b"1753660800." + body, hashlib.sha256).hexdigest()
//
// Node:
//
//	crypto.createHmac("sha256", "whsec_tandem_test_secret")
//	      .update("1753660800." + body).digest("hex")
const (
	vectorSecret    = "whsec_tandem_test_secret"
	vectorTimestamp = int64(1753660800)
	vectorBody      = `{"task":{"id":"9f1c2b3a-0000-4000-8000-000000000001","ticket":36},"type":"task.approved"}`
	vectorSignature = "31fbedd83d4bd79a7bc7fbec034794677f73771aee73c0b243f341dc9f198196"
)

func TestSignKnownVector(t *testing.T) {
	got := Sign(vectorSecret, vectorTimestamp, []byte(vectorBody))
	if got != vectorSignature {
		t.Fatalf("Sign = %q, want %q\n\nIf you changed the signing scheme, every deployed receiver breaks. "+
			"Update the wire contract deliberately (sign.go docs + this vector), never just this constant.", got, vectorSignature)
	}
	if strings.ToLower(got) != got {
		t.Errorf("signature must be lowercase hex, got %q", got)
	}
	if len(got) != 64 {
		t.Errorf("signature = %d chars, want 64 (sha256 hex)", len(got))
	}
}

// The signed string is "<unix_seconds>.<raw body>" — asserted directly, since
// it is the one detail a receiver must replicate byte for byte.
func TestSigningStringShape(t *testing.T) {
	got := string(SigningString(vectorTimestamp, []byte(vectorBody)))
	want := "1753660800." + vectorBody
	if got != want {
		t.Fatalf("SigningString = %q, want %q", got, want)
	}
}

func TestVerifyAcceptsOwnSignature(t *testing.T) {
	sig := Sign(vectorSecret, vectorTimestamp, []byte(vectorBody))
	if !Verify(vectorSecret, vectorTimestamp, []byte(vectorBody), sig) {
		t.Fatal("Verify rejected a signature produced by Sign")
	}
}

// Every input to the signature is covered: flipping any one of them must
// invalidate it. The timestamp case is the important one — it is what makes the
// replay window tamper-evident rather than advisory.
func TestVerifyRejectsTampering(t *testing.T) {
	sig := Sign(vectorSecret, vectorTimestamp, []byte(vectorBody))

	tests := []struct {
		name   string
		secret string
		ts     int64
		body   string
	}{
		{"wrong secret", "whsec_other", vectorTimestamp, vectorBody},
		{"timestamp slid forward", vectorSecret, vectorTimestamp + 1, vectorBody},
		{"body byte changed", vectorSecret, vectorTimestamp, strings.Replace(vectorBody, "36", "37", 1)},
		{"body byte appended", vectorSecret, vectorTimestamp, vectorBody + " "},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if Verify(tc.secret, tc.ts, []byte(tc.body), sig) {
				t.Fatal("Verify accepted a tampered attempt")
			}
		})
	}

	// Malformed signatures are rejected, not panicked on.
	for _, bad := range []string{"", "zzzz", vectorSignature[:63], vectorSignature + "00"} {
		if Verify(vectorSecret, vectorTimestamp, []byte(vectorBody), bad) {
			t.Fatalf("Verify accepted malformed signature %q", bad)
		}
	}
}

// The replay window is 60s on either side of the receiver's clock: a captured
// attempt goes stale in a minute, while modest clock skew still verifies.
func TestVerifyWithinReplayWindow(t *testing.T) {
	signedAt := time.Unix(vectorTimestamp, 0)
	sig := Sign(vectorSecret, vectorTimestamp, []byte(vectorBody))

	tests := []struct {
		name  string
		now   time.Time
		valid bool
	}{
		{"same second", signedAt, true},
		{"59s later", signedAt.Add(59 * time.Second), true},
		{"59s of skew the other way", signedAt.Add(-59 * time.Second), true},
		{"61s later — replayed", signedAt.Add(61 * time.Second), false},
		{"61s forward-dated", signedAt.Add(-61 * time.Second), false},
		{"an hour later — replayed", signedAt.Add(time.Hour), false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := VerifyWithin(vectorSecret, vectorTimestamp, []byte(vectorBody), sig, tc.now, ReplayWindow)
			if got != tc.valid {
				t.Fatalf("VerifyWithin = %v, want %v", got, tc.valid)
			}
		})
	}
	if ReplayWindow != 60*time.Second {
		t.Errorf("ReplayWindow = %s, want 60s (the documented receiver contract)", ReplayWindow)
	}
}

// Header names are part of the wire contract; renaming one silently breaks
// every receiver, so they are pinned.
func TestHeaderNames(t *testing.T) {
	pairs := []struct{ got, want string }{
		{HeaderSignature, "Tandem-Signature"},
		{HeaderTimestamp, "Tandem-Timestamp"},
		{HeaderDeliveryID, "Tandem-Delivery-Id"},
		{HeaderEvent, "Tandem-Event"},
	}
	for _, p := range pairs {
		if p.got != p.want {
			t.Errorf("header name = %q, want %q", p.got, p.want)
		}
	}
}
