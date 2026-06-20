package forms

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// coerceToType coerces an arbitrary scalar to a sheet COLUMN type
// (text|number|date|checkbox). Shared by the submit resolver and compile's
// literal check so author-time and runtime agree on what's coercible.
func coerceToType(v any, typ string) (any, error) {
	switch typ {
	case "number":
		return toFloat(v)
	case "checkbox":
		return toBool(v)
	case "date":
		return toDate(v)
	default: // "text" and anything unknown
		return toStringScalar(v), nil
	}
}

func toFloat(v any) (float64, error) {
	switch n := v.(type) {
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) {
			return 0, fmt.Errorf("not a finite number")
		}
		return n, nil
	case float32:
		return float64(n), nil
	case int:
		return float64(n), nil
	case int64:
		return float64(n), nil
	case json.Number:
		f, err := n.Float64()
		if err != nil {
			return 0, fmt.Errorf("%q is not a number", n.String())
		}
		return f, nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
		if err != nil || math.IsNaN(f) {
			return 0, fmt.Errorf("%q is not a number", n)
		}
		return f, nil
	case bool:
		return 0, fmt.Errorf("a checkbox value is not a number")
	case nil:
		return 0, fmt.Errorf("missing number")
	default:
		return 0, fmt.Errorf("cannot use %T as a number", v)
	}
}

func toBool(v any) (bool, error) {
	switch b := v.(type) {
	case bool:
		return b, nil
	case float64:
		return b != 0, nil
	case string:
		switch strings.ToLower(strings.TrimSpace(b)) {
		case "true", "1", "yes":
			return true, nil
		case "false", "0", "no", "":
			return false, nil
		}
		return false, fmt.Errorf("%q is not a yes/no value", b)
	case nil:
		return false, nil
	default:
		return false, fmt.Errorf("cannot use %T as a checkbox", v)
	}
}

// toDate normalizes a value to an ISO YYYY-MM-DD string. Accepts a bare date or
// any RFC3339 timestamp.
func toDate(v any) (string, error) {
	s := strings.TrimSpace(toStringScalar(v))
	if s == "" {
		return "", fmt.Errorf("missing date")
	}
	for _, layout := range []string{"2006-01-02", time.RFC3339, time.RFC3339Nano, "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.Format("2006-01-02"), nil
		}
	}
	return "", fmt.Errorf("%q is not a valid date (expected YYYY-MM-DD)", s)
}

// toStringScalar renders a scalar without the float formatting surprises
// (620 → "620", not "620.000000").
func toStringScalar(v any) string {
	switch s := v.(type) {
	case nil:
		return ""
	case string:
		return s
	case float64:
		return strconv.FormatFloat(s, 'f', -1, 64)
	case bool:
		if s {
			return "true"
		}
		return "false"
	case json.Number:
		return s.String()
	default:
		return fmt.Sprintf("%v", v)
	}
}

// literalValue decodes a stored literal (json.RawMessage) into a Go scalar
// (string | float64 | bool).
func literalValue(raw json.RawMessage) (any, error) {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, fmt.Errorf("invalid literal: %w", err)
	}
	return v, nil
}

// coerceFieldValue validates+coerces a submitted value against a FIELD type
// (text|number|date|select|checkbox), enforcing select membership. Taking type +
// options (rather than a struct) lets both the resolver (store.FormField) and
// compile (forms.Field) share it.
func coerceFieldValue(typ string, options []string, v any) (any, error) {
	switch typ {
	case "select":
		s := toStringScalar(v)
		for _, o := range options {
			if o == s {
				return s, nil
			}
		}
		return nil, fmt.Errorf("%q is not one of the allowed options", s)
	case "number":
		return toFloat(v)
	case "checkbox":
		return toBool(v)
	case "date":
		return toDate(v)
	default:
		return toStringScalar(v), nil
	}
}
