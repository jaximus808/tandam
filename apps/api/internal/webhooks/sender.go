package webhooks

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"syscall"
	"time"

	"github.com/google/uuid"
)

// RequestTimeout is the per-attempt deadline: connect + TLS + write + read the
// (truncated) response. A receiver that needs longer than this should
// acknowledge fast and work asynchronously.
const RequestTimeout = 5 * time.Second

// MaxResponseBytes caps how much of a response body is stored on the delivery
// row. Enough to see an error message in the UI's delivery detail view; small
// enough that a hostile endpoint streaming gigabytes can't fill the table.
const MaxResponseBytes = 2 << 10 // 2 KB

// ErrBlockedTarget is returned when a webhook URL resolves to an address the
// worker refuses to connect to. It is NON-RETRYABLE: the target is a
// configuration problem, and retrying it just re-probes the internal network.
var ErrBlockedTarget = errors.New("webhook target blocked")

// Sender performs one signed delivery attempt.
//
// SSRF POSTURE (migration 0038 leaves this to the worker; the url CHECK is only
// a typo guard). A webhook URL is attacker-influenced input — whoever can edit a
// canvas's config picks the host this server connects to — so the sender:
//
//   - accepts only http/https schemes;
//   - refuses to connect to loopback, private (RFC1918 + fc00::/7), link-local
//     (which covers the 169.254.169.254 cloud metadata endpoint),
//     carrier-grade-NAT, unspecified, and multicast addresses. The check runs in
//     the dialer's Control hook, i.e. AFTER DNS resolution, on the concrete IP
//     about to be connected — so a hostname that resolves to 127.0.0.1, and a
//     DNS-rebinding host that answers publicly once and privately on the next
//     lookup, are both caught. A pre-flight resolve-then-check would not be:
//     that is a TOCTOU window by construction;
//   - never follows redirects (a 30x to an internal address is the classic SSRF
//     bypass), and reports the 3xx itself as a non-retryable failure;
//   - bounds every attempt with RequestTimeout and reads at most
//     MaxResponseBytes back.
type Sender struct {
	client *http.Client
	// allowPrivateTargets disables the address guard. TESTS AND LOCAL DEV ONLY —
	// httptest servers live on 127.0.0.1. Never set in production.
	allowPrivateTargets bool
}

// SenderOption customizes NewSender.
type SenderOption func(*Sender)

// WithAllowPrivateTargets permits deliveries to loopback/private addresses.
// Test-and-local-dev escape hatch; leaving it off is the production posture.
func WithAllowPrivateTargets(allow bool) SenderOption {
	return func(s *Sender) { s.allowPrivateTargets = allow }
}

// NewSender builds the delivery HTTP client: guarded dialer, no redirects,
// hard timeout.
func NewSender(opts ...SenderOption) *Sender {
	s := &Sender{}
	for _, opt := range opts {
		opt(s)
	}
	dialer := &net.Dialer{
		Timeout:   RequestTimeout,
		KeepAlive: 30 * time.Second,
		// Control runs once the address is resolved and immediately before
		// connect(2) — the only place the guard cannot be raced by DNS.
		Control: func(network, address string, _ syscall.RawConn) error {
			if s.allowPrivateTargets {
				return nil
			}
			return checkDialAddress(network, address)
		},
	}
	s.client = &http.Client{
		Timeout: RequestTimeout,
		Transport: &http.Transport{
			DialContext:           dialer.DialContext,
			TLSHandshakeTimeout:   RequestTimeout,
			ResponseHeaderTimeout: RequestTimeout,
			// Deliveries go to many different hosts and are infrequent; a small
			// idle pool avoids holding connections open to arbitrary endpoints.
			MaxIdleConns:        16,
			MaxIdleConnsPerHost: 2,
			IdleConnTimeout:     30 * time.Second,
		},
		// Do not follow redirects: a 30x into the private network is the
		// standard way around an egress filter. The 3xx comes back as the
		// response and is classified as a permanent failure.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return s
}

// Attempt is one delivery attempt's outcome.
//
// Retryable separates "the endpoint might work later" (timeouts, 5xx, 429) from
// "this will never work" (bad URL, blocked target, 4xx, redirect). The worker
// dead-letters a non-retryable attempt immediately rather than burning the
// retry budget on it.
type Attempt struct {
	StatusCode int    // 0 when no response was received
	Body       string // response body, truncated to MaxResponseBytes
	Err        string // transport-level failure, "" if a response arrived
	OK         bool   // 2xx
	Retryable  bool
}

// Send signs and posts body to target. body is written to the wire verbatim and
// is the exact byte sequence covered by the signature (see SigningString).
func (s *Sender) Send(ctx context.Context, target, secret string, deliveryID uuid.UUID, eventType string, body []byte, now time.Time) Attempt {
	if err := validateTargetURL(target); err != nil {
		return Attempt{Err: err.Error(), Retryable: false}
	}

	ts := now.Unix()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return Attempt{Err: fmt.Sprintf("build request: %v", err), Retryable: false}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Tandem-Webhooks/1")
	req.Header.Set(HeaderDeliveryID, deliveryID.String())
	req.Header.Set(HeaderEvent, eventType)
	req.Header.Set(HeaderTimestamp, fmt.Sprint(ts))
	req.Header.Set(HeaderSignature, Sign(secret, ts, body))

	resp, err := s.client.Do(req)
	if err != nil {
		return Attempt{
			Err: sanitizeTransportError(err),
			// A blocked address is a config problem, not a blip.
			Retryable: !errors.Is(err, ErrBlockedTarget),
		}
	}
	defer resp.Body.Close()

	// Read at most MaxResponseBytes; a hostile endpoint cannot make us buffer
	// more than that regardless of Content-Length.
	buf, _ := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBytes))

	a := Attempt{StatusCode: resp.StatusCode, Body: string(buf)}
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		a.OK = true
	case resp.StatusCode >= 300 && resp.StatusCode < 400:
		// Redirects are deliberately not followed (see CheckRedirect).
		a.Err = fmt.Sprintf("redirect not followed (%d → %s)", resp.StatusCode, resp.Header.Get("Location"))
	case resp.StatusCode == http.StatusRequestTimeout ||
		resp.StatusCode == http.StatusTooManyRequests:
		a.Retryable = true
	case resp.StatusCode >= 500:
		a.Retryable = true
	}
	return a
}

// ValidateTargetURL is the config-time half of the target guard: the cheap,
// purely syntactic checks the sender runs before every attempt, exposed so the
// webhook CONFIG handler can reject an unusable URL at save time instead of
// letting the human discover it in the dead-letter list an hour later.
//
// It deliberately stops short of the IP-level guard (IsBlockedIP, wired into the
// dialer's Control hook). Resolving DNS at save time would be security theatre:
// a name that resolves publicly now can resolve to 169.254.169.254 at delivery
// time, so the check that matters has to happen per-attempt, and it does.
func ValidateTargetURL(raw string) error { return validateTargetURL(raw) }

// validateTargetURL rejects anything that isn't a plain absolute http(s) URL
// with a host, before any network activity.
func validateTargetURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("%w: unparseable url", ErrBlockedTarget)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("%w: scheme %q not allowed", ErrBlockedTarget, u.Scheme)
	}
	if u.Host == "" {
		return fmt.Errorf("%w: url has no host", ErrBlockedTarget)
	}
	return nil
}

// checkDialAddress is the dialer Control hook: it sees the resolved IP the
// connection is about to be made to.
func checkDialAddress(network, address string) error {
	switch network {
	case "tcp", "tcp4", "tcp6":
	default:
		return fmt.Errorf("%w: network %q not allowed", ErrBlockedTarget, network)
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("%w: unparseable address %q", ErrBlockedTarget, address)
	}
	ip := net.ParseIP(host)
	if ip == nil {
		// Control is called post-resolution, so a non-IP here means something
		// unexpected — fail closed.
		return fmt.Errorf("%w: unresolved address %q", ErrBlockedTarget, address)
	}
	if IsBlockedIP(ip) {
		return fmt.Errorf("%w: %s is a private/link-local/loopback address", ErrBlockedTarget, ip)
	}
	return nil
}

// IsBlockedIP reports whether ip is in a range the delivery worker refuses to
// connect to. Exported so the guard is unit-testable against a table of
// addresses rather than only through a live dial.
func IsBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	// Normalize IPv4-mapped IPv6 (::ffff:127.0.0.1) to its v4 form so the v4
	// range checks below actually apply to it.
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	switch {
	case ip.IsLoopback(), // 127.0.0.0/8, ::1
		ip.IsPrivate(),            // RFC1918, fc00::/7
		ip.IsLinkLocalUnicast(),   // 169.254.0.0/16 (incl. 169.254.169.254 metadata), fe80::/10
		ip.IsLinkLocalMulticast(), //
		ip.IsInterfaceLocalMulticast(),
		ip.IsMulticast(),
		ip.IsUnspecified(): // 0.0.0.0, ::
		return true
	}
	// Carrier-grade NAT, 100.64.0.0/10 — routable-looking but internal.
	if v4 := ip.To4(); v4 != nil && v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 {
		return true
	}
	// IPv4 benchmarking (198.18.0.0/15) and "this host on this network"
	// (0.0.0.0/8) are likewise never legitimate webhook targets.
	if v4 := ip.To4(); v4 != nil && (v4[0] == 0 || (v4[0] == 198 && (v4[1] == 18 || v4[1] == 19))) {
		return true
	}
	return false
}

// sanitizeTransportError renders a transport failure for the delivery log.
// url.Error stringifies as `Post "https://host/path": …`, which would put the
// full target (possibly carrying a token in the query string) into a column the
// UI renders — so the URL is stripped and only the cause is kept.
func sanitizeTransportError(err error) string {
	var uerr *url.Error
	if errors.As(err, &uerr) && uerr.Err != nil {
		return uerr.Err.Error()
	}
	return err.Error()
}
