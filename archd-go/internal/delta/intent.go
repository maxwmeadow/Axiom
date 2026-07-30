package delta

import (
	"path"
	"strings"
	"unicode"
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
		beforeOK := index == 0 || !unicode.IsLetter(rune(value[index-1]))
		after := index + len(candidate)
		afterOK := after == len(value) || !unicode.IsLetter(rune(value[after]))
		if beforeOK && afterOK {
			return true
		}
		start = index + 1
	}
}

func intentMatchesClaim(intent Intent, claim Claim) bool {
	declaredPath := normalizedIntentPath(intent.DeclaredPath)
	for _, evidence := range claim.Evidence {
		labelPath := normalizedIntentPath(evidence.Label)
		if declaredPath != "" &&
			(labelPath == declaredPath || strings.HasSuffix(labelPath, "/"+declaredPath)) {
			return true
		}
		if declaredPath != "" &&
			strings.Contains(strings.ToLower(strings.ReplaceAll(evidence.Detail, "\\", "/")), declaredPath) {
			return true
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
				return true
			}
		}
		return false
	}
	// System intent has no file path to reconcile. Its exact authored name is
	// still durable in the dispatch snapshot and appears in system claims.
	return intent.Kind == "system" && wordContains(claim.Title, intent.Name)
}

// ClassifyIntentDrift marks agent claims expected only when at least one
// matching intent was dispatched before the change happened. Everything else
// from an agent is explicit drift; human work is not judged against an agent
// work order.
func ClassifyIntentDrift(claims []Claim, intents []Intent) []Claim {
	classified := make([]Claim, len(claims))
	copy(classified, claims)
	for index := range classified {
		claim := &classified[index]
		if claim.Actor != ActorAgent && claim.Actor != ActorBoth {
			continue
		}
		for _, intent := range intents {
			if intent.DispatchedAt > claim.TS || !intentMatchesClaim(intent, *claim) {
				continue
			}
			claim.IntentStatus = "expected"
			claim.IntentIDs = append(claim.IntentIDs, intent.ID)
		}
		if claim.IntentStatus == "" {
			claim.IntentStatus = "unexpected"
		}
	}
	return classified
}
