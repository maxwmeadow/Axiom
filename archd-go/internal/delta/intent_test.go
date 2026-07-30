package delta

import "testing"

func TestDispatchedPathMakesMatchingAgentClaimExpected(t *testing.T) {
	claims := []Claim{{
		ID: "claim", Actor: ActorAgent, TS: 20, Title: "Auth gained 1 file",
		Evidence: []Evidence{{Kind: "file.created", Label: "src/auth/token.go"}},
	}}
	intents := []Intent{{
		ID: "dispatch:plan", DispatchedAt: 10,
		Kind: "file", Name: "Token", DeclaredPath: "auth/token.go",
	}}
	got := ClassifyIntentDrift(claims, intents)
	if got[0].IntentStatus != "expected" || len(got[0].IntentIDs) != 1 {
		t.Fatalf("matching dispatched path should be expected: %#v", got[0])
	}
}

func TestUndispatchedOrLateIntentCannotExplainAgentDrift(t *testing.T) {
	claim := Claim{
		ID: "claim", Actor: ActorAgent, TS: 20, Title: "Auth gained 1 file",
		Evidence: []Evidence{{Kind: "file.created", Label: "src/auth/token.go"}},
	}
	for name, intents := range map[string][]Intent{
		"none": nil,
		"late": {{
			ID: "late", DispatchedAt: 30, Kind: "file", DeclaredPath: "src/auth/token.go",
		}},
		"different": {{
			ID: "other", DispatchedAt: 10, Kind: "file", DeclaredPath: "src/billing/invoice.go",
		}},
	} {
		t.Run(name, func(t *testing.T) {
			got := ClassifyIntentDrift([]Claim{claim}, intents)
			if got[0].IntentStatus != "unexpected" {
				t.Fatalf("unmatched agent work is drift: %#v", got[0])
			}
		})
	}
}

func TestHumanClaimsAreNotJudgedAgainstAgentIntent(t *testing.T) {
	got := ClassifyIntentDrift([]Claim{{
		ID: "claim", Actor: ActorHuman, TS: 20, Title: "Manual refactor",
	}}, nil)
	if got[0].IntentStatus != "" {
		t.Fatalf("human work should not be labeled agent drift: %#v", got[0])
	}
}
