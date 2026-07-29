package main

import (
	"errors"
	"math/rand"
	"sync"
	"testing"
	"time"
)

func ms(n float64) time.Duration { return time.Duration(n * float64(time.Millisecond)) }

// A known distribution pins the percentile definition: 1..100ms shuffled gives
// exactly p50=50, p95=95, p99=99, max=100 under nearest-rank. This is the same
// definition internal/metrics uses, which is what makes the client-side and
// server-side columns of a results file comparable at all.
func TestPercentileKnownDistribution(t *testing.T) {
	var samples []time.Duration
	for _, v := range rand.Perm(100) {
		samples = append(samples, ms(float64(v+1)))
	}
	for _, tc := range []struct {
		p    float64
		want float64
	}{{50, 50}, {95, 95}, {99, 99}, {100, 100}, {0, 1}} {
		if got := durMS(percentile(samples, tc.p)); got != tc.want {
			t.Errorf("p%v = %v, want %v", tc.p, got, tc.want)
		}
	}
}

// Nearest-rank, not interpolating: 99 fast samples and one outlier leave p99 on
// the fast band and only max on the outlier.
func TestPercentileSkewed(t *testing.T) {
	samples := make([]time.Duration, 0, 100)
	for i := 0; i < 99; i++ {
		samples = append(samples, ms(1))
	}
	samples = append(samples, ms(900))
	if got := durMS(percentile(samples, 99)); got != 1 {
		t.Errorf("p99 = %v, want 1", got)
	}
	if got := durMS(percentile(samples, 100)); got != 900 {
		t.Errorf("max = %v, want 900", got)
	}
}

func TestPercentileEmptyAndSingle(t *testing.T) {
	if got := percentile(nil, 95); got != 0 {
		t.Errorf("empty p95 = %v, want 0", got)
	}
	one := []time.Duration{ms(7)}
	for _, p := range []float64{0, 50, 95, 100} {
		if got := durMS(percentile(one, p)); got != 7 {
			t.Errorf("single-sample p%v = %v, want 7", p, got)
		}
	}
}

func TestPercentileDoesNotMutateInput(t *testing.T) {
	in := []time.Duration{ms(3), ms(1), ms(2)}
	_ = percentile(in, 50)
	if in[0] != ms(3) || in[1] != ms(1) || in[2] != ms(2) {
		t.Fatalf("percentile reordered its input: %v", in)
	}
}

// Errors must NOT enter the latency series. A 30s timeout folded into p95 would
// turn an availability problem into a latency problem and hide both.
func TestRecorderErrorsExcludedFromPercentiles(t *testing.T) {
	rec := newRecorder()
	for i := 0; i < 10; i++ {
		rec.observe(opClaim, ms(10))
	}
	rec.fail(opClaim, "a0", errors.New("connection reset"))
	rec.fail(opClaim, "a1", errors.New("i/o timeout"))

	st := rec.snapshot()[opClaim]
	if st.Count != 10 {
		t.Errorf("count = %d, want 10 successes only", st.Count)
	}
	if st.Errors != 2 {
		t.Errorf("errors = %d, want 2", st.Errors)
	}
	if st.P95MS != 10 || st.MaxMS != 10 {
		t.Errorf("p95/max = %v/%v, want 10/10 — a failed call must not move latency", st.P95MS, st.MaxMS)
	}
	if got := rec.errorCount(); got != 2 {
		t.Errorf("errorCount = %d, want 2", got)
	}
	if samples := rec.errSamples(); len(samples) != 2 || samples[0].Op != opClaim || samples[0].Agent != "a0" {
		t.Errorf("error samples = %+v, want the two failures with their agents", samples)
	}
}

func TestRecorderErrSamplesAreCapped(t *testing.T) {
	rec := newRecorder()
	for i := 0; i < maxErrSamples*3; i++ {
		rec.fail(opQueueList, "a", errors.New("boom"))
	}
	if got := len(rec.errSamples()); got != maxErrSamples {
		t.Errorf("kept %d samples, want the %d cap", got, maxErrSamples)
	}
	if got := rec.errorCount(); got != maxErrSamples*3 {
		t.Errorf("errorCount = %d, want every failure counted even when the sample list is full", got)
	}
}

// An unavailable op must survive into the snapshot with zero samples and the
// flag set — "the endpoint isn't there" has to be distinguishable from "fast".
func TestRecorderUnavailable(t *testing.T) {
	rec := newRecorder()
	rec.markUnavailable(opContextGet, "not served by this build")
	rec.markUnavailable(opContextGet, "second discovery is a no-op")

	if !rec.isUnavailable(opContextGet) {
		t.Fatal("isUnavailable = false after markUnavailable")
	}
	if rec.isUnavailable(opQueueList) {
		t.Error("an untouched op reported unavailable")
	}
	st := rec.snapshot()[opContextGet]
	if !st.Unavailable || st.Count != 0 {
		t.Errorf("snapshot = %+v, want unavailable with no samples", st)
	}
	if st.Note == "" {
		t.Error("unavailable op lost its explanation")
	}
}

func TestRecorderSuccessCountAcrossOps(t *testing.T) {
	rec := newRecorder()
	rec.observe(opClaim, ms(1))
	rec.observe(opClaim, ms(1))
	rec.observe(opQueueList, ms(1))
	rec.observe(opSeedBatch, ms(1)) // harness op, not a task op
	if got := rec.successCount(taskOps...); got != 3 {
		t.Errorf("successCount(taskOps) = %d, want 3 (seed_batch is harness traffic)", got)
	}
}

// Run with -race: the recorder is written by every agent goroutine and read by
// the abort guard at the same time.
func TestRecorderConcurrent(t *testing.T) {
	rec := newRecorder()
	const workers, per = 16, 200
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < per; i++ {
				rec.observe(opClaim, ms(float64(i%20+1)))
				rec.fail(opTaskGet, "a", errors.New("x"))
			}
		}()
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 200; i++ {
			rec.snapshot()
			rec.successCount(taskOps...)
			rec.isUnavailable(opContextGet)
		}
	}()
	wg.Wait()
	<-done

	snap := rec.snapshot()
	if snap[opClaim].Count != workers*per {
		t.Errorf("claim count = %d, want %d", snap[opClaim].Count, workers*per)
	}
	if snap[opTaskGet].Errors != workers*per {
		t.Errorf("task_get errors = %d, want %d", snap[opTaskGet].Errors, workers*per)
	}
}

// Latencies are rounded so two baselines diff on real change, not float noise.
func TestDurMSRounding(t *testing.T) {
	if got := durMS(time.Duration(1234567)); got != 1.235 {
		t.Errorf("durMS(1.234567ms) = %v, want 1.235", got)
	}
}
