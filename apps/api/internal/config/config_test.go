package config

import (
	"os"
	"testing"
)

// setRequired sets the three vars Load() refuses to start without, so a test can
// focus on one optional flag.
func setRequired(t *testing.T) {
	t.Helper()
	t.Setenv("SUPABASE_URL", "https://example.supabase.co")
	t.Setenv("SUPABASE_KEY", "service-role-key")
	t.Setenv("JWT_SECRET", "secret")
}

// TANDEM_WEBHOOKS_ALLOW_PRIVATE turns off the webhook delivery worker's SSRF
// guard, so it has to fail closed: only the two documented values enable it, and
// anything ambiguous leaves prod's posture alone.
func TestWebhooksAllowPrivateTargetsIsStrictOptIn(t *testing.T) {
	cases := []struct {
		raw  string
		want bool
	}{
		{"1", true},
		{"true", true},
		{" true ", true}, // whitespace from a docker env file is not a typo
		{"", false},      // unset — the default, and the only prod-safe value
		{"0", false},
		{"false", false},
		{"TRUE", false}, // case-sensitive on purpose: an opt-in to an unsafe
		{"yes", false},  // behaviour should not have fuzzy spellings
		{"maybe", false},
	}
	for _, tc := range cases {
		t.Run("value="+tc.raw, func(t *testing.T) {
			setRequired(t)
			t.Setenv("TANDEM_WEBHOOKS_ALLOW_PRIVATE", tc.raw)

			cfg, err := Load()
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if cfg.WebhooksAllowPrivateTargets != tc.want {
				t.Errorf("WebhooksAllowPrivateTargets = %v for %q, want %v",
					cfg.WebhooksAllowPrivateTargets, tc.raw, tc.want)
			}
		})
	}
}

// The flag is absent from the environment entirely, not merely empty — the case
// every real deployment other than local dev is in.
func TestWebhooksAllowPrivateTargetsDefaultsOff(t *testing.T) {
	setRequired(t)
	// t.Setenv records the pre-test value and restores it on cleanup; unsetting
	// afterwards gives a genuinely absent var without leaking it out of the test.
	t.Setenv("TANDEM_WEBHOOKS_ALLOW_PRIVATE", "")
	if err := os.Unsetenv("TANDEM_WEBHOOKS_ALLOW_PRIVATE"); err != nil {
		t.Fatalf("unset: %v", err)
	}

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.WebhooksAllowPrivateTargets {
		t.Error("the SSRF guard must be ON when TANDEM_WEBHOOKS_ALLOW_PRIVATE is unset")
	}
}
