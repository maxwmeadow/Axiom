package delta

import (
	"encoding/json"
	"path"
	"strings"
	"unicode"
	"unicode/utf8"
)

type RealizationState string

const (
	RealizationMatched RealizationState = "MATCHED"
	RealizationFlexed  RealizationState = "FLEXED"
	RealizationDrifted RealizationState = "DRIFTED"
	RealizationMissing RealizationState = "MISSING"
	RealizationUnknown RealizationState = "UNKNOWN"
)

// Intent is one planned node frozen into a dispatched canvas message.
type Intent struct {
	ID           string
	DispatchedAt int64
	Kind         string
	Name         string
	DeclaredPath string
	Source       string
	Target       string
	Metadata     json.RawMessage
}

func normalizedIntentPath(value string) string {
	value = strings.ToLower(strings.TrimSpace(strings.ReplaceAll(value, "\\", "/")))
	return strings.TrimPrefix(path.Clean("/"+value), "/")
}

func wordContains(value, candidate string) bool {
	value = strings.ToLower(value)
	candidate = strings.ToLower(strings.TrimSpace(candidate))
	if candidate == "" {
		return false
	}
	start := 0
	for {
		index := strings.Index(value[start:], candidate)
		if index < 0 {
			return false
		}
		index += start
		before, _ := utf8.DecodeLastRuneInString(value[:index])
		beforeOK := index == 0 || !unicode.IsLetter(before)
		after := index + len(candidate)
		afterRune, _ := utf8.DecodeRuneInString(value[after:])
		afterOK := after == len(value) || !unicode.IsLetter(afterRune)
		if beforeOK && afterOK {
			return true
		}
		start = index + 1
	}
}

type intentMatchQuality int

const (
	intentNoMatch intentMatchQuality = iota
	intentFlexedMatch
	intentExactMatch
)

func intentMatchesClaim(intent Intent, claim Claim) (intentMatchQuality, string) {
	declaredPath := normalizedIntentPath(intent.DeclaredPath)
	for _, evidence := range claim.Evidence {
		labelPath := normalizedIntentPath(evidence.Label)
		if declaredPath != "" && labelPath == declaredPath {
			return intentExactMatch, "indexed evidence uses the exact dispatched path"
		}
		if declaredPath != "" && strings.HasSuffix(labelPath, "/"+declaredPath) {
			return intentFlexedMatch, "indexed evidence directly preserves the dispatched path suffix"
		}
		if declaredPath != "" &&
			strings.Contains(strings.ToLower(strings.ReplaceAll(evidence.Detail, "\\", "/")), declaredPath) {
			return intentFlexedMatch, "indexed evidence directly references the dispatched path"
		}
	}
	if intent.Kind == "edge" {
		source := normalizedIntentPath(strings.TrimPrefix(intent.Source, "planned://"))
		target := normalizedIntentPath(strings.TrimPrefix(intent.Target, "planned://"))
		for _, evidence := range claim.Evidence {
			detail := strings.ToLower(strings.ReplaceAll(evidence.Detail, "\\", "/"))
			if source != "" && target != "" &&
				strings.Contains(detail, path.Base(source)) &&
				strings.Contains(detail, path.Base(target)) {
				return intentFlexedMatch, "indexed edge evidence contains both dispatched endpoints"
			}
		}
		return intentNoMatch, ""
	}
	// System intent has no file path to reconcile. Its exact authored name is
	// still durable in the dispatch snapshot and appears in system claims.
	if intent.Kind == "system" && wordContains(claim.Title, intent.Name) {
		return intentExactMatch, "indexed system claim contains the dispatched system name"
	}
	return intentNoMatch, ""
}

// ClassifyRealization compares indexed agent work to immutable dispatched
// intent. MATCHED requires an exact direct match. FLEXED is deliberately
// narrower than "similar": only a direct path relocation or edge endpoint
// match qualifies, and the underlying claim must still be index-corroborated.
// A report or narration without indexed structural evidence is at best UNKNOWN.
func ClassifyRealization(claims []Claim, intents []Intent) []Claim {
	classified := make([]Claim, len(claims))
	copy(classified, claims)
	for index := range classified {
		claim := &classified[index]
		if claim.Actor != ActorAgent && claim.Actor != ActorBoth {
			continue
		}
		if !claim.Corroborated {
			claim.RealizationState = RealizationUnknown
			claim.RealizationEvidence = append(claim.RealizationEvidence, Evidence{
				Kind:  "realization.uncorroborated",
				Label: "agent mapping was not confirmed by indexed structural evidence",
			})
			continue
		}
		hasPriorIntent := false
		best := intentNoMatch
		bestDetail := ""
		for _, intent := range intents {
			if intent.DispatchedAt > claim.TS {
				continue
			}
			hasPriorIntent = true
			quality, detail := intentMatchesClaim(intent, *claim)
			if quality == intentNoMatch {
				continue
			}
			claim.IntentIDs = append(claim.IntentIDs, intent.ID)
			if quality > best {
				best = quality
				bestDetail = detail
			}
		}
		switch {
		case best == intentExactMatch:
			claim.RealizationState = RealizationMatched
			claim.RealizationEvidence = append(claim.RealizationEvidence, Evidence{
				Kind: "realization.matched", Label: bestDetail,
			})
		case best == intentFlexedMatch:
			claim.RealizationState = RealizationFlexed
			claim.RealizationEvidence = append(claim.RealizationEvidence, Evidence{
				Kind: "realization.flexed", Label: bestDetail,
			})
		case hasPriorIntent:
			claim.RealizationState = RealizationDrifted
			claim.RealizationEvidence = append(claim.RealizationEvidence, Evidence{
				Kind:  "realization.drifted",
				Label: "indexed agent change does not match any prior dispatched intent",
			})
		default:
			claim.RealizationState = RealizationUnknown
			claim.RealizationEvidence = append(claim.RealizationEvidence, Evidence{
				Kind:  "realization.unknown",
				Label: "no prior dispatched intent is available for comparison",
			})
		}
	}
	return classified
}

// ClassifyIntentDrift preserves the legacy command-deck aggregate without
// leaking the removed binary status into API JSON. Its "unexpected" count
// historically combined DRIFTED and UNKNOWN; the review API does not.
func ClassifyIntentDrift(claims []Claim, intents []Intent) []Claim {
	classified := ClassifyRealization(claims, intents)
	for index := range classified {
		switch classified[index].RealizationState {
		case RealizationMatched, RealizationFlexed:
			classified[index].IntentStatus = "expected"
		case RealizationDrifted, RealizationUnknown:
			classified[index].IntentStatus = "unexpected"
		}
	}
	return classified
}
