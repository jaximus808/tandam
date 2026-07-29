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

	// Embed Go's tzdata so time.LoadLocation works in any container, regardless
	// of whether the base image ships system tzdata. Needed for per-event IANA
	// timezones in the .ics export.
	_ "time/tzdata"

	"github.com/agentcanvas/api/internal/api"
	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/config"
	"github.com/agentcanvas/api/internal/maps"
	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/webhooks"
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

	db, err := store.NewSupabase(cfg.SupabaseURL, cfg.SupabaseKey, store.WithClaimTTL(cfg.ClaimTTL))
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

	// Outbound-webhook delivery worker (TDM-36 / migration 0038). Same shape as
	// the hub above: a goroutine started at boot, stopped by cancelling its
	// context during graceful shutdown. It owns all outbound HTTP for webhooks —
	// request handlers only ever enqueue (webhooks.Emitter), so a slow or dead
	// receiver can never slow a canvas mutation.
	// The Emitter is the request-path half: handlers hand it task-lifecycle
	// events (TDM-37) and it enqueues one delivery row per subscribed webhook.
	// It stays nil when webhooks are off, which makes every emit in the handlers
	// a no-op — nothing is enqueued that no worker would ever drain.
	webhookCtx, stopWebhooks := context.WithCancel(context.Background())
	defer stopWebhooks()
	var emitter *webhooks.Emitter
	if cfg.WebhooksEnabled {
		emitter = webhooks.NewEmitter(db)
		go webhooks.NewWorker(db).Run(webhookCtx)
	} else {
		log.Printf("WEBHOOKS_ENABLED=false — outbound webhook delivery worker disabled")
	}

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

	router := api.NewRouter(db, hub, authSvc, googleVerifier, cfg.CookieSecure, mapsReg, cfg.WebDistPath, cfg.ImageDir, cfg.PublicBaseURL, cfg.MetricsEnabled, emitter)

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
	stopWebhooks()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("graceful shutdown: %v (forcing close)", err)
		_ = srv.Close()
	}
	log.Printf("bye")
}
