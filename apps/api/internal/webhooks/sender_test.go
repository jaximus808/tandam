package webhooks

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/google/uuid"
)

// The SSRF blocklist, as a table. These are the ranges a webhook URL must never
// be able to reach: the cloud metadata endpoint above all, plus everything else
// that is "inside".
func TestIsBlockedIP(t *testing.T) {
	blocked := []string{
		"127.0.0.1", "127.1.2.3", "::1", // loopback
		"10.0.0.1", "172.16.5.4", "192.168.1.1", // RFC1918
		"169.254.169.254",    // AWS/GCP/Azure instance metadata — the prize
		"169.254.0.1",        // link-local generally
		"fe80::1",            // IPv6 link-local
		"fd00::1", "fc00::1", // IPv6 unique-local
		"100.64.0.1", "100.127.255.255", // carrier-grade NAT
		"0.0.0.0", "::", // unspecified
		"224.0.0.1", "ff02::1", // multicast
		"::ffff:127.0.0.1",       // IPv4-mapped loopback — the classic bypass
		"::ffff:169.254.169.254", // IPv4-mapped metadata
		"198.18.0.1",             // benchmarking range
	}
	for _, s := range blocked {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("test bug: %q is not an IP", s)
		}
		if !IsBlockedIP(ip) {
			t.Errorf("IsBlockedIP(%s) = false, want true", s)
		}
	}

	allowed := []string{
		"1.1.1.1", "8.8.8.8", "93.184.216.34", // ordinary public v4
		"2606:4700:4700::1111", // ordinary public v6
		"100.128.0.1",          // just outside CGNAT
		"172.32.0.1",           // just outside RFC1918
	}
	for _, s := range allowed {
		ip := net.ParseIP(s)
		if IsBlockedIP(ip) {
			t.Errorf("IsBlockedIP(%s) = true, want false — this is a legitimate public target", s)
		}
	}

	if !IsBlockedIP(nil) {
		t.Error("IsBlockedIP(nil) must fail closed")
	}
}

// The guard runs in the dialer, so it applies to the resolved address — a URL
// pointing at loopback is refused even though the scheme and syntax are fine.
func TestSendBlocksPrivateTarget(t *testing.T) {
	s := NewSender() // production posture: guard on
	att := s.Send(context.Background(), "http://127.0.0.1:9/hook", "secret",
		uuid.New(), EventTaskApproved, []byte(`{}`), time.Now())

	if att.OK {
		t.Fatal("delivery to loopback succeeded")
	}
	if att.Retryable {
		t.Error("a blocked target must be non-retryable — retrying just re-probes the internal network")
	}
	if att.Err == "" {
		t.Error("expected an error describing the block")
	}
}

// Schemes other than http(s) never reach the network at all.
func TestSendRejectsNonHTTPSchemes(t *testing.T) {
	s := NewSender()
	for _, target := range []string{
		"file:///etc/passwd",
		"gopher://127.0.0.1:11211/_stats",
		"ftp://example.com/x",
		"://nonsense",
		"https://", // no host
	} {
		att := s.Send(context.Background(), target, "secret", uuid.New(),
			EventTaskApproved, []byte(`{}`), time.Now())
		if att.OK || att.Retryable || att.Err == "" {
			t.Errorf("target %q: got %+v, want a non-retryable rejection", target, att)
		}
	}
}

// The per-attempt timeout is the documented 5s, and it is a real deadline on
// the client (a receiver that hangs must not pin a worker slot indefinitely).
func TestRequestTimeoutIsFiveSeconds(t *testing.T) {
	if RequestTimeout != 5*time.Second {
		t.Errorf("RequestTimeout = %s, want 5s", RequestTimeout)
	}
	if got := NewSender().client.Timeout; got != RequestTimeout {
		t.Errorf("http.Client.Timeout = %s, want %s", got, RequestTimeout)
	}
}

// Redirects must not be followed — CheckRedirect returns ErrUseLastResponse so
// the 30x itself comes back rather than a second request to wherever it points.
func TestSenderDoesNotFollowRedirects(t *testing.T) {
	if NewSender().client.CheckRedirect == nil {
		t.Fatal("CheckRedirect is nil — the client would follow redirects into the private network")
	}
}

func TestMaxResponseBytesIsTwoKB(t *testing.T) {
	if MaxResponseBytes != 2048 {
		t.Errorf("MaxResponseBytes = %d, want 2048 (2 KB)", MaxResponseBytes)
	}
}
