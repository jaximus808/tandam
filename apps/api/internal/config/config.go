package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
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

	// MetricsEnabled registers GET /api/metrics (in-memory per-route latency
	// aggregates; no canvas data). Defaults to enabled — set
	// METRICS_ENABLED=false to hide the endpoint. Latencies are recorded either
	// way; only registration of the read endpoint is gated.
	MetricsEnabled bool
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

	return &Config{
		SupabaseURL:    supabaseURL,
		SupabaseKey:    supabaseKey,
		JWTSecret:      jwtSecret,
		JWTTokenTTL:    jwtTTL,
		ClaimTTL:       claimTTL,
		Port:           port,
		WebDistPath:    webDist,
		ImageDir:       imageDir,
		GoogleClientID: os.Getenv("GOOGLE_CLIENT_ID"),
		CookieSecure:   os.Getenv("COOKIE_SECURE") == "true",
		PublicBaseURL:  strings.TrimRight(os.Getenv("PUBLIC_BASE_URL"), "/"),
		MetricsEnabled: os.Getenv("METRICS_ENABLED") != "false",
	}, nil
}
