package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/agentcanvas/api/internal/api"
	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/config"
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

	authSvc := auth.NewService(cfg.JWTSecret)
	hub := ws.NewHub()
	go hub.Run()

	router := api.NewRouter(db, hub, authSvc, cfg.WebDistPath, cfg.ImageDir)

	addr := fmt.Sprintf(":%s", cfg.Port)
	log.Printf("AgentCanvas API listening on %s", addr)
	if err := http.ListenAndServe(addr, router); err != nil {
		log.Fatalf("server: %v", err)
	}
}
