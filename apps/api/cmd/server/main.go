package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/agentcanvas/api/internal/api"
	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/config"
	"github.com/agentcanvas/api/internal/maps"
	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/ws"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	if err := os.MkdirAll(cfg.ImageDir, 0755); err != nil {
		log.Fatalf("image dir: %v", err)
	}

	db, err := store.NewSupabase(cfg.SupabaseURL, cfg.SupabaseKey)
	if err != nil {
		log.Fatalf("supabase: %v", err)
	}
	defer db.Close()

	authSvc := auth.NewService(cfg.JWTSecret, cfg.JWTTokenTTL)

	var googleVerifier *auth.GoogleVerifier
	if cfg.GoogleClientID != "" {
		googleVerifier, err = auth.NewGoogleVerifier(context.Background(), cfg.GoogleClientID)
		if err != nil {
			log.Fatalf("google verifier: %v", err)
		}
		log.Printf("google sign-in enabled")
	} else {
		log.Printf("GOOGLE_CLIENT_ID not set — google sign-in disabled")
	}

	hub := ws.NewHub()
	go hub.Run()

	var mapsReg *maps.Registry
	if dir := os.Getenv("MAPS_DIR"); dir != "" {
		mapsReg, err = maps.LoadFromDir(dir)
	} else {
		mapsReg, err = maps.LoadEmbedded()
	}
	if err != nil {
		log.Fatalf("maps registry: %v", err)
	}
	log.Printf("loaded %d map presets: %v", len(mapsReg.IDs()), mapsReg.IDs())

	router := api.NewRouter(db, hub, authSvc, googleVerifier, cfg.CookieSecure, mapsReg, cfg.WebDistPath, cfg.ImageDir)

	srv := &http.Server{
		Addr:    fmt.Sprintf(":%s", cfg.Port),
		Handler: router,
		// WriteTimeout is intentionally NOT set: it would kill long-lived
		// WebSocket upgrades (gorilla hijacks the conn but Go still enforces
		// the server-level timeout against the response). The per-message
		// deadlines in ws/client.go cover slow WS peers; ReadHeaderTimeout +
		// IdleTimeout cover slowloris on plain HTTP.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	serverErr := make(chan error, 1)
	go func() {
		log.Printf("AgentCanvas API listening on %s", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-serverErr:
		log.Fatalf("server: %v", err)
	case sig := <-stop:
		log.Printf("received %s, shutting down…", sig)
	}

	// Give in-flight requests up to 15s to finish before forcing the close.
	// WebSocket connections are sent a close frame by hub.Shutdown so clients
	// can reconnect cleanly instead of dropping mid-frame.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	hub.Shutdown()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("graceful shutdown: %v (forcing close)", err)
		_ = srv.Close()
	}
	log.Printf("bye")
}
