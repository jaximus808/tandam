package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Publishing a baseline to the metrics history (TDM-94 / migration 0040).
//
// WHY THIS EXISTS. Without it a baseline is a JSON file in
// cmd/loadtest/baselines/, and a directory of files is not a history: comparing
// two runs means opening both and reading percentages out of prose, and comparing
// twenty is nobody's afternoon. POSTing the same bytes to the API turns them into
// rows the /metrics page charts, so "did the 64-agent ceiling move" is a glance
// rather than an investigation.
//
// The file is STILL written to disk first and publishing never blocks it: the
// local baseline is the durable artifact (it lives in git next to the code that
// produced it), and the API is a convenience view. A publish failure is a warning,
// not a non-zero exit — a network hiccup must not make a clean 30-minute run look
// like a failed one.

// publishTokenEnv is where the credential comes from. A personal access token
// (tdm_pat_…), because this is a CLI with no browser and no cookie jar; the
// server's owner gate accepts it via OptionalUser.
const publishTokenEnv = "TANDEM_PAT"

// publishResults POSTs a results file to POST /api/metrics/loadtest.
//
// base is the API root — the same -api the run measured, because the run history
// belongs with the instance it describes. It reads the bytes back from the file it
// just wrote rather than re-marshalling `results`, so what is stored is byte-identical
// to the durable baseline: if the two ever disagreed, the file would be right and
// nobody would know which one they were looking at.
func publishResults(base, path string, timeout time.Duration) error {
	token := strings.TrimSpace(os.Getenv(publishTokenEnv))
	if token == "" {
		return fmt.Errorf("%s is not set — the metrics history is owner-gated and needs a personal access token (create one at /me)", publishTokenEnv)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("reading %s: %w", path, err)
	}

	url := strings.TrimRight(base, "/") + "/api/metrics/loadtest"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	client := &http.Client{Timeout: timeout}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	// Bounded read: the response is a small JSON ack, and an error body from a
	// proxy could be anything.
	msg, _ := io.ReadAll(io.LimitReader(res.Body, 4<<10))

	switch res.StatusCode {
	case http.StatusOK:
		return nil
	case http.StatusNotFound:
		// The gate 404s the whole subtree when METRICS_OWNER_EMAILS is unset, so
		// this is far more likely to be "not configured" than "wrong path".
		return fmt.Errorf("the target has no metrics history endpoint — METRICS_OWNER_EMAILS is probably unset on %s", base)
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("%s rejected the token (%s): %s", base, res.Status, strings.TrimSpace(string(msg)))
	default:
		return fmt.Errorf("%s: %s", res.Status, strings.TrimSpace(string(msg)))
	}
}
