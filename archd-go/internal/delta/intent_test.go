package delta

import "testing"

func TestExactDispatchedPathMakesCorroboratedAgentClaimMatched(t *testing.T) {
	claims := []Claim{{
		ID: "claim", Actor: ActorAgent, TS: 20, Title: "Auth gained 1 file",
		Corroborated: true,
		Evidence:     []Evidence{{Kind: "file.created", Label: "src/auth/token.go"}},
	}}
	intents := []Intent{{
		ID: "dispatch:plan", DispatchedAt: 10,
		Kind: "file", Name: "Token", DeclaredPath: "src/auth/token.go",
	}}
	got := ClassifyRealization(claims, intents)
	if got[0].RealizationState != RealizationMatched || len(got[0].IntentIDs) != 1 {
		t.Fatalf("exact indexed path should be MATCHED: %#v", got[0])
	}
}

func TestUniqueDispatchedPathSuffixIsExplicitlyFlexed(t *testing.T) {
	claim := Claim{
		ID: "claim", Actor: ActorAgent, TS: 20, Corroborated: true,
		Evidence: []Evidence{{Kind: "file.created", Label: "packages/auth/src/token.go"}},
	}
	got := ClassifyRealization([]Claim{claim}, []Intent{{
		ID: "dispatch", DispatchedAt: 10, Kind: "file", DeclaredPath: "src/token.go",
	}})
	if got[0].RealizationState != RealizationFlexed {
		t.Fatalf("direct relocated path should be FLEXED: %#v", got[0])
	}
	if len(got[0].RealizationEvidence) != 1 ||
		got[0].RealizationEvidence[0].Kind != "realization.flexed" {
		t.Fatalf("FLEXED requires explicit promotion evidence: %#v", got[0])
	}
}

func TestUnmatchedPriorIntentIsDriftedButMissingIntentIsUnknown(t *testing.T) {
	claim := Claim{
		ID: "claim", Actor: ActorAgent, TS: 20, Corroborated: true,
		Evidence: []Evidence{{Kind: "file.created", Label: "src/auth/token.go"}},
	}
	for name, fixture := range map[string]struct {
		intents []Intent
		want    RealizationState
	}{
		"none": {want: RealizationUnknown},
		"late": {
			intents: []Intent{{ID: "late", DispatchedAt: 30, Kind: "file", DeclaredPath: "src/auth/token.go"}},
			want:    RealizationUnknown,
		},
		"different": {
			intents: []Intent{{ID: "other", DispatchedAt: 10, Kind: "file", DeclaredPath: "src/billing/invoice.go"}},
			want:    RealizationDrifted,
		},
	} {
		t.Run(name, func(t *testing.T) {
			got := ClassifyRealization([]Claim{claim}, fixture.intents)
			if got[0].RealizationState != fixture.want {
				t.Fatalf("want %s: %#v", fixture.want, got[0])
			}
		})
	}
}

func TestUncorroboratedAgentMappingCannotBecomeMatched(t *testing.T) {
	claim := Claim{
		ID: "claim", Actor: ActorAgent, TS: 20,
		Evidence: []Evidence{{Kind: "agent.reported", Label: "src/auth/token.go"}},
	}
	got := ClassifyRealization([]Claim{claim}, []Intent{{
		ID: "dispatch", DispatchedAt: 10, Kind: "file", DeclaredPath: "src/auth/token.go",
	}})
	if got[0].RealizationState != RealizationUnknown || len(got[0].IntentIDs) != 0 {
		t.Fatalf("an agent report without index corroboration is at best UNKNOWN: %#v", got[0])
	}
}

func TestHumanClaimsAreNotJudgedAgainstAgentIntent(t *testing.T) {
	got := ClassifyRealization([]Claim{{
		ID: "claim", Actor: ActorHuman, TS: 20, Title: "Manual refactor", Corroborated: true,
	}}, nil)
	if got[0].RealizationState != "" {
		t.Fatalf("human work should not be labeled against agent intent: %#v", got[0])
	}
}
