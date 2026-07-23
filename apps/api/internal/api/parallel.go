package api

import "sync"

// batchConcurrency bounds how many per-item store calls a batch handler runs at
// once. Each item is 1–2 Supabase REST round-trips; the old serial loop made an
// N-item batch 2N sequential round-trips — seconds of wall-clock over the MCP
// path for a routine 20-item bulk edit. Running the items concurrently collapses
// that to ~ceil(N/batchConcurrency) waves while capping simultaneous connections
// to Supabase so a large batch can't exhaust PostgREST's pool. 8 sits well under
// the default limits and already turns the common 10–30 item batch into 2–4 waves.
const batchConcurrency = 8

// runBatch invokes fn for each index in [0,n) with bounded concurrency and
// returns the first error observed (remaining items still run to completion;
// their results are ignored). On error the caller returns 500 without a body,
// matching the old serial loop where a mid-batch failure aborted with 500 and
// left the already-processed items applied — so partial application on error is
// the pre-existing contract, not a new one.
//
// fn is called from multiple goroutines, so it must be safe to run concurrently:
// in practice each call touches a distinct element id and the only shared write
// is the canvas version bump, which Postgres serializes at the row level. fn must
// NOT touch the http.ResponseWriter — the caller writes the response once, after
// runBatch returns, keeping 400-vs-500 selection on the request goroutine.
func runBatch(n int, fn func(i int) error) error {
	if n <= 0 {
		return nil
	}
	sem := make(chan struct{}, batchConcurrency)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error
	for i := 0; i < n; i++ {
		wg.Add(1)
		sem <- struct{}{} // blocks once batchConcurrency workers are in flight
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			if err := fn(i); err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()
	return firstErr
}
