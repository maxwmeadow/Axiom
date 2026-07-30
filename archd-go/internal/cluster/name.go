package cluster

import (
	"sort"
	"strings"
	"unicode"

	"axiom.local/archd/internal/db"
)

// NameCluster chooses a label from the semantic tokens already used by the
// community detector. Directory components are intentionally unavailable here:
// a system may be stored anywhere without changing its identity or label.
func NameCluster(files []db.File, vectors map[string]FileVec) string {
	if len(files) == 0 {
		return "Unknown"
	}

	scores := make(map[string]float64)
	for _, file := range files {
		for token, weight := range vectors[file.ID] {
			scores[token] += weight
		}
	}
	if len(scores) > 0 {
		tokens := make([]string, 0, len(scores))
		for token := range scores {
			tokens = append(tokens, token)
		}
		sort.Slice(tokens, func(i, j int) bool {
			if scores[tokens[i]] == scores[tokens[j]] {
				return tokens[i] < tokens[j]
			}
			return scores[tokens[i]] > scores[tokens[j]]
		})
		return titleToken(tokens[0])
	}

	// Sparse files may have no symbols. Fall back to a deterministic filename,
	// never its directory, so moving the file cannot rename the system.
	stems := make([]string, 0, len(files))
	for _, file := range files {
		stems = append(stems, filenameBase(file.RelPath))
	}
	sort.Strings(stems)
	if stems[0] == "" {
		return "Unknown"
	}
	return titleToken(stems[0])
}

func titleToken(token string) string {
	runes := []rune(strings.TrimSpace(token))
	if len(runes) == 0 {
		return "Unknown"
	}
	runes[0] = unicode.ToUpper(runes[0])
	return string(runes)
}
