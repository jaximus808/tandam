package webhooks

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"time"
)

// Header names on every outbound delivery. Two of them (signature + timestamp)
// are the security contract; two are addressing.
//
// NOTE for anyone diffing against migration 0038: that file *suggested* a single
// Stripe-style `Tandem-Signature: t=<ts>,v1=<hex>` header. The shipped scheme
// splits them into two headers instead — the signature is bare hex and the
// timestamp is its own header. Functionally identical (the timestamp is still
// inside the signed string, so it is still tamper-evident), and it saves every
// receiver a parse step. Where 0038's comments and this file disagree, this
// file is the wire format.
const (
	// HeaderSignature carries the lowercase hex HMAC-SHA256 of the signed
	// string (see SigningString). No prefix, no version tag, no comma syntax.
	HeaderSignature = "Tandem-Signature"
	// HeaderTimestamp carries the unix SECONDS at which the attempt was signed.
	// It is part of the signed string, so it cannot be rewritten in transit.
	HeaderTimestamp = "Tandem-Timestamp"
	// HeaderDeliveryID carries the delivery row id — STABLE ACROSS RETRIES, so a
	// receiver that has already applied a delivery can dedupe the retry.
	HeaderDeliveryID = "Tandem-Delivery-Id"
	// HeaderEvent carries the event type ("task.approved" | "task.completed" |
	// "task.claim_expired" | "task.returned" | "task.rejected") — see
	// store.KnownWebhookEvents.
	HeaderEvent = "Tandem-Event"
)

// ReplayWindow is how much clock skew a receiver should allow between
// Tandem-Timestamp and its own clock. A captured attempt is replayable only
// inside this window; a legitimate retry is signed fresh (new timestamp, new
// signature, SAME delivery id) so it is accepted and deduped by id.
const ReplayWindow = 60 * time.Second

// SigningString is the exact byte sequence that gets HMAC'd:
//
//	<unix_seconds> "." <raw request body>
//
// Binding the timestamp into the signature is what makes it tamper-evident: an
// attacker who replays a captured body cannot slide the timestamp forward to
// escape the replay window without invalidating the signature.
//
// The body here MUST be the exact bytes written to the wire. Do not re-marshal
// the payload for signing — jsonb normalizes key order, so a re-render is not
// byte-identical to what is sent, and the receiver would compute a different
// digest over what it actually received (migration 0038 flags this too).
func SigningString(ts int64, body []byte) []byte {
	prefix := strconv.FormatInt(ts, 10)
	out := make([]byte, 0, len(prefix)+1+len(body))
	out = append(out, prefix...)
	out = append(out, '.')
	out = append(out, body...)
	return out
}

// Sign returns the lowercase hex HMAC-SHA256 of SigningString(ts, body) under
// the webhook's shared secret — the value of the Tandem-Signature header.
func Sign(secret string, ts int64, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(SigningString(ts, body))
	return hex.EncodeToString(mac.Sum(nil))
}

// Verify recomputes the signature and compares it in CONSTANT TIME. It is the
// reference implementation of what a receiver must do, and the shape any
// receiver should copy.
//
// # Receiver verification (pseudocode — any language)
//
//	ts   = int(headers["Tandem-Timestamp"])
//	sig  = headers["Tandem-Signature"]
//	body = raw request bytes            // NOT a re-serialized parse of the JSON
//
//	// 1. replay window — reject stale/forward-dated attempts
//	if abs(now_unix() - ts) > 60: reject(400)
//
//	// 2. recompute over "<ts>.<body>"
//	expected = hex(hmac_sha256(key=secret, msg=str(ts) + "." + body))
//
//	// 3. TIMING-SAFE compare — never ==, never strcmp
//	//    Go:      hmac.Equal(a, b)  /  subtle.ConstantTimeCompare(a, b) == 1
//	//    Python:  hmac.compare_digest(a, b)
//	//    Node:    crypto.timingSafeEqual(Buffer, Buffer)
//	//    Ruby:    Rack::Utils.secure_compare
//	// A byte-by-byte comparison leaks, through response timing, how many
//	// leading bytes of a guess were right, which turns forging a signature
//	// from a 2^256 search into a few thousand probes.
//	if not timing_safe_equal(expected, sig): reject(401)
//
//	// 4. dedupe on Tandem-Delivery-Id — retries reuse it
//	if already_processed(headers["Tandem-Delivery-Id"]): return 200
//
// Reply 2xx to acknowledge. Anything else (or a timeout past 5s) is retried on
// the 1m / 10m / 1h schedule, then dead-lettered.
func Verify(secret string, ts int64, body []byte, signature string) bool {
	want, err := hex.DecodeString(Sign(secret, ts, body))
	if err != nil {
		return false
	}
	got, err := hex.DecodeString(signature)
	if err != nil {
		return false
	}
	// hmac.Equal is crypto/subtle.ConstantTimeCompare under the hood: its run
	// time does not depend on where the first differing byte is.
	return hmac.Equal(want, got)
}

// VerifyWithin is Verify plus the replay-window check, against the supplied
// clock reading. Kept separate from Verify so a caller can test the two
// failure modes independently.
func VerifyWithin(secret string, ts int64, body []byte, signature string, now time.Time, window time.Duration) bool {
	skew := now.Unix() - ts
	if skew < 0 {
		skew = -skew
	}
	if time.Duration(skew)*time.Second > window {
		return false
	}
	return Verify(secret, ts, body, signature)
}
