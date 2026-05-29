package config

import (
	"fmt"
	"os"
	"time"
)

const defaultJWTTokenTTL = 24 * time.Hour

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
		Port:           port,
		WebDistPath:    webDist,
		ImageDir:       imageDir,
		GoogleClientID: os.Getenv("GOOGLE_CLIENT_ID"),
		CookieSecure:   os.Getenv("COOKIE_SECURE") == "true",
	}, nil
}
