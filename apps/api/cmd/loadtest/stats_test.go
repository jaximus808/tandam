package main

import (
	"testing"
	"time"
)

func ms(n int) time.Duration { return time.Duration(n) * time.Millisecond }

func TestPercentileEmpty(t *testing.T) {
	if got := percentile(nil, 50); got != 0 {
		t.Fatalf("empty samples: got %v, want 0", got)
	}
}

func TestPercentileSingleSample(t *testing.T) {
	s := []time.Duration{ms(7)}
	for _, p := range []float64{0, 50, 95, 99, 100} {
		if got := percentile(s, p); got != ms(7) {
			t.Fatalf("p%v of single sample: got %v, want 7ms", p, got)
		}
	}
}

func TestPercentileNearestRank(t *testing.T) {
	// 1..100 ms, unsorted on purpose — percentile must sort a copy.
	s := make([]time.Duration, 0, 100)
	for i := 100; i >= 1; i-- {
		s = append(s, ms(i))
	}
	cases := []struct {
		p    float64
		want time.Duration
	}{
		{50, ms(50)},   // ceil(0.50*100) = 50th
		{95, ms(95)},   // ceil(0.95*100) = 95th
		{99, ms(99)},   // ceil(0.99*100) = 99th
		{100, ms(100)}, // max
		{0, ms(1)},     // min
	}
	for _, c := range cases {
		if got := percentile(s, c.p); got != c.want {
			t.Fatalf("p%v: got %v, want %v", c.p, got, c.want)
		}
	}
	// Input must be untouched (sorted copy, not in place).
	if s[0] != ms(100) {
		t.Fatal("percentile mutated its input")
	}
}

func TestPercentileSmallSet(t *testing.T) {
	s := []time.Duration{ms(10), ms(20), ms(30), ms(40)}
	if got := percentile(s, 50); got != ms(20) { // ceil(0.5*4)=2nd
		t.Fatalf("p50 of 4: got %v, want 20ms", got)
	}
	if got := percentile(s, 99); got != ms(40) { // ceil(0.99*4)=4th
		t.Fatalf("p99 of 4: got %v, want 40ms", got)
	}
}

func TestRecorderTallies(t *testing.T) {
	r := newRecorder()
	r.observe(opList, ms(5))
	r.observe(opList, ms(6))
	r.observe(opClaimWin, ms(7))
	r.observe(opClaimLoss, ms(8))
	r.observe(opComplete, ms(9))
	r.attempt(claimWon)
	r.attempt(claimLost)
	r.attempt(claimStale)

	c := r.counts()
	if c.Lists != 2 || c.Completed != 1 {
		t.Fatalf("observe tallies wrong: %+v", c)
	}
	if c.ClaimsWon != 1 || c.ClaimsLost409 != 1 || c.ClaimsLostStale != 1 || c.ClaimAttempts != 3 {
		t.Fatalf("attempt tallies wrong: %+v", c)
	}
	if n := len(r.samples(opClaimWin)); n != 1 {
		t.Fatalf("claim_win samples: got %d, want 1", n)
	}
}
