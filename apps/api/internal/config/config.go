package config

import (
	"fmt"
	"os"
)

type Config struct {
	SupabaseURL string
	SupabaseKey string // service role key
	JWTSecret   string
	Port        string
	WebDistPath string
	ImageDir    string
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
		SupabaseURL: supabaseURL,
		SupabaseKey: supabaseKey,
		JWTSecret:   jwtSecret,
		Port:        port,
		WebDistPath: webDist,
		ImageDir:    imageDir,
	}, nil
}
