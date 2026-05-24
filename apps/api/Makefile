.PHONY: build run migrate tidy

build:
	go build -o bin/server ./cmd/server

run:
	go run ./cmd/server

tidy:
	go mod tidy

# Apply migrations (requires DATABASE_URL env var)
migrate:
	psql "$(DATABASE_URL)" -f ../../migrations/0001_initial_schema.sql
	psql "$(DATABASE_URL)" -f ../../migrations/0002_add_canvas_indexes.sql
