package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/agentcanvas/api/internal/metrics"
)

const defaultJWTTokenTTL = 24 * time.Hour

// defaultClaimTTL is how long an 'executing' task claim is honored before a
// new claimer may atomically take it over (lazy expiry — no background
// sweeper). Override with CLAIM_TTL_MINUTES; 0 disables expiry entirely.
const defaultClaimTTL = 15 * time.Minute

type Config struct {
	SupabaseURL string
	SupabaseKey string // service role key
	JWTSecret   string
	JWTTokenTTL time.Duration
	Port        string
	WebDistPath string
	ImageDir    string

	// GoogleClientID enables Google sign-in. Optional — if empty, auth routes
	// return 503 and the rest of the app runs normally.
	GoogleClientID string
	// CookieSecure marks the session cookie Secure. Leave false in local dev
	// (http); set COOKIE_SECURE=true in production (https behind Caddy).
	CookieSecure bool

	// PublicBaseURL is the externally-reachable origin (e.g.
	// https://tandemcanvas.com), used as the OAuth issuer + to build the
	// authorization-server metadata URLs. Empty → the OAuth handlers derive it
	// per-request from the Host / X-Forwarded-Proto headers (fine for local dev).
	PublicBaseURL string

	// ClaimTTL is how long an 'executing' task claim is honored before it is
	// considered stuck and becomes atomically claimable by the next
	// task_start (lazy expiry, evaluated at claim time — no sweeper job).
	// 0 disables expiry (claims are held until released/completed).
	ClaimTTL time.Duration

	// WebhooksEnabled starts the outbound-webhook delivery worker (migration
	// 0038 / internal/webhooks). Defaults to enabled — set
	// WEBHOOKS_ENABLED=false to keep the loop off, e.g. before 0038 has been
	// applied, or on a second process that shouldn't also drain the queue.
	WebhooksEnabled bool

	// WebhooksAllowPrivateTargets disables the delivery worker's SSRF guard
	// (webhooks.IsBlockedIP, wired into the dialer's Control hook), letting
	// deliveries reach loopback / RFC1918 / link-local addresses.
	//
	// LOCAL DEV ONLY, and off unless TANDEM_WEBHOOKS_ALLOW_PRIVATE is exactly
	// "1" or "true". It exists so the `tandem-local` container can deliver to a
	// `tandem-mcp listen` running on the host (http://host.docker.internal:8787),
	// which the guard otherwise refuses non-retryably. Setting it in production
	// turns every canvas's webhook config into an internal-network port scanner
	// — including the 169.254.169.254 cloud metadata endpoint. Never set it there.
	WebhooksAllowPrivateTargets bool

	// MetricsEnabled registers GET /api/metrics — in-memory per-route and
	// per-op latency percentiles, task-queue counters (claims, claim conflicts,
	// TTL takeovers), webhook delivery outcomes and the connected-client gauge.
	// Aggregates only: no canvas ids, names or payloads, which is why the
	// endpoint is open.
	//
	// Defaults to enabled. METRICS_ENABLED=false switches the whole subsystem
	// off, not just the endpoint: the registry is never created, the latency
	// middleware becomes a pass-through, and every counter call in the hub, the
	// webhook worker and the handlers is a nil-receiver no-op. Nothing is
	// recorded-but-hidden.
	MetricsEnabled bool

	// MetricsSnapshotInterval is how often the collector persists a scrape of the
	// in-memory registry into metrics_snapshots (migration 0040 / TDM-94), turning
	// the live snapshot into a series that survives restarts.
	//
	// Defaults to metrics.DefaultSnapshotInterval (60s), chosen against the
	// registry's 300s percentile window — see the constant's doc. Set
	// METRICS_SNAPSHOT_INTERVAL_SECONDS=0 to keep the endpoint and the live
	// numbers but persist nothing (the reads still work; they just return whatever
	// history already exists). Implies nothing about MetricsEnabled: with metrics
	// off there is no registry to scrape and the collector is never built.
	MetricsSnapshotInterval time.Duration

	// MetricsRetentionDays is how long persisted snapshots are kept; the collector
	// prunes older rows hourly. Defaults to 30 days (see 0040 for the sizing
	// argument). METRICS_RETENTION_DAYS=0 disables pruning entirely — history then
	// grows without bound, which is a legitimate choice for a tiny local database
	// or an operator pruning out of band, so it is honoured rather than corrected.
	MetricsRetentionDays int
}

func Load() (*Config, error) {
	supabaseURL := os.Getenv("SUPABASE_URL")
	if supabaseURL == "" {
		return nil, fmt.Errorf("SUPABASE_URL is required (e.g. https://abcdef.supabase.co)")
	}

	supabaseKey := os.Getenv("SUPABASE_KEY")
	if supabaseKey == "" {
		return nil, fmt.Errorf("SUPABASE_KEY is required (use the service_role key)")
	}

	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		return nil, fmt.Errorf("JWT_SECRET is required")
	}

	jwtTTL := defaultJWTTokenTTL
	if raw := os.Getenv("JWT_TOKEN_TTL"); raw != "" {
		parsed, err := time.ParseDuration(raw)
		if err != nil {
			return nil, fmt.Errorf("JWT_TOKEN_TTL: %w (expected Go duration, e.g. 24h, 30m, 7d→use 168h)", err)
		}
		if parsed <= 0 {
			return nil, fmt.Errorf("JWT_TOKEN_TTL must be positive, got %s", parsed)
		}
		jwtTTL = parsed
	}

	claimTTL := defaultClaimTTL
	if raw := os.Getenv("CLAIM_TTL_MINUTES"); raw != "" {
		mins, err := strconv.Atoi(raw)
		if err != nil {
			return nil, fmt.Errorf("CLAIM_TTL_MINUTES: %w (expected whole minutes, e.g. 15; 0 disables claim expiry)", err)
		}
		if mins < 0 {
			return nil, fmt.Errorf("CLAIM_TTL_MINUTES must be >= 0, got %d", mins)
		}
		claimTTL = time.Duration(mins) * time.Minute
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "7891"
	}

	webDist := os.Getenv("WEB_DIST_PATH")
	if webDist == "" {
		webDist = "../../apps/web/dist"
	}

	imageDir := os.Getenv("IMAGE_DIR")
	if imageDir == "" {
		imageDir = "./canvas-images"
	}

	// Metrics persistence (TDM-94). Both are "0 means off" rather than "0 means
	// default", so the off switch is reachable without a second flag.
	snapshotInterval := metrics.DefaultSnapshotInterval
	if raw := os.Getenv("METRICS_SNAPSHOT_INTERVAL_SECONDS"); raw != "" {
		secs, err := strconv.Atoi(raw)
		if err != nil {
			return nil, fmt.Errorf("METRICS_SNAPSHOT_INTERVAL_SECONDS: %w (expected whole seconds, e.g. 60; 0 disables persistence)", err)
		}
		if secs < 0 {
			return nil, fmt.Errorf("METRICS_SNAPSHOT_INTERVAL_SECONDS must be >= 0, got %d", secs)
		}
		snapshotInterval = time.Duration(secs) * time.Second
	}

	retentionDays := int(metrics.DefaultRetention / (24 * time.Hour))
	if raw := os.Getenv("METRICS_RETENTION_DAYS"); raw != "" {
		days, err := strconv.Atoi(raw)
		if err != nil {
			return nil, fmt.Errorf("METRICS_RETENTION_DAYS: %w (expected whole days, e.g. 30; 0 disables pruning)", err)
		}
		if days < 0 {
			return nil, fmt.Errorf("METRICS_RETENTION_DAYS must be >= 0, got %d", days)
		}
		retentionDays = days
	}

	return &Config{
		SupabaseURL:     supabaseURL,
		SupabaseKey:     supabaseKey,
		JWTSecret:       jwtSecret,
		JWTTokenTTL:     jwtTTL,
		ClaimTTL:        claimTTL,
		Port:            port,
		WebDistPath:     webDist,
		ImageDir:        imageDir,
		GoogleClientID:  os.Getenv("GOOGLE_CLIENT_ID"),
		CookieSecure:    os.Getenv("COOKIE_SECURE") == "true",
		PublicBaseURL:   strings.TrimRight(os.Getenv("PUBLIC_BASE_URL"), "/"),
		MetricsEnabled:  os.Getenv("METRICS_ENABLED") != "false",
		WebhooksEnabled: os.Getenv("WEBHOOKS_ENABLED") != "false",

		MetricsSnapshotInterval: snapshotInterval,
		MetricsRetentionDays:    retentionDays,

		WebhooksAllowPrivateTargets: envOptIn("TANDEM_WEBHOOKS_ALLOW_PRIVATE"),
	}, nil
}

// envOptIn reads a flag that turns an UNSAFE behaviour on. Only "1" and "true"
// count; anything else (including "yes", "TRUE", or an unset var) leaves the
// safe default in place.
//
// Deliberately stricter than the `!= "false"` flags above: those are opt-OUTs of
// a safe default, where being lenient costs nothing. This is an opt-IN to an
// unsafe one, so a typo has to fail closed.
func envOptIn(name string) bool {
	switch strings.TrimSpace(os.Getenv(name)) {
	case "1", "true":
		return true
	default:
		return false
	}
}
