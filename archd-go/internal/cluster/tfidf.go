package cluster

import (
	"math"
	"strings"
	"unicode"

	"axiom.local/archd/internal/db"
)

// FileVec is a sparse TF-IDF vector for a single file.
type FileVec map[string]float64

// BuildTFIDF computes TF-IDF vectors from authored filenames and parsed symbol
// names. Directory components are deliberately excluded: names are semantic
// vocabulary, while folder placement is only storage location.
// fileSymbols maps fileID → []db.Symbol.
func BuildTFIDF(files []db.File, fileSymbols map[string][]db.Symbol) map[string]FileVec {
	const filenameZoneWeight = 3

	// Collect semantic tokens per file from authored filenames and parser output.
	fileTokens := make(map[string][]string, len(files))
	for _, f := range files {
		var tokens []string
		base := filenameBase(f.RelPath)
		if !isGenericFilename(base) {
			nameTokens := tokenizeIdent(base)
			for i := 0; i < filenameZoneWeight; i++ {
				tokens = append(tokens, nameTokens...)
			}
		}
		for _, s := range fileSymbols[f.ID] {
			tokens = append(tokens, tokenizeIdent(s.Name)...)
		}
		fileTokens[f.ID] = tokens
	}

	// Document frequency: how many files contain each word
	df := make(map[string]int)
	for _, tokens := range fileTokens {
		seen := make(map[string]bool)
		for _, t := range tokens {
			if !seen[t] {
				df[t]++
				seen[t] = true
			}
		}
	}

	N := float64(len(files))

	// Compute TF-IDF vector per file
	vecs := make(map[string]FileVec, len(files))
	for _, f := range files {
		tokens := fileTokens[f.ID]
		if len(tokens) == 0 {
			vecs[f.ID] = FileVec{}
			continue
		}
		tf := make(map[string]float64)
		for _, t := range tokens {
			tf[t]++
		}
		total := float64(len(tokens))
		vec := make(FileVec, len(tf))
		for word, count := range tf {
			// Smoothed IDF to avoid zero for words in all documents
			idf := math.Log(N/float64(df[word]+1) + 1)
			vec[word] = (count / total) * idf
		}
		vecs[f.ID] = vec
	}
	return vecs
}

// CosineSim returns the cosine similarity between two sparse TF-IDF vectors.
func CosineSim(a, b FileVec) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	var dot, normA, normB float64
	for w, wa := range a {
		normA += wa * wa
		if wb, ok := b[w]; ok {
			dot += wa * wb
		}
	}
	for _, wb := range b {
		normB += wb * wb
	}
	if normA == 0 || normB == 0 {
		return 0
	}
	return dot / (math.Sqrt(normA) * math.Sqrt(normB))
}

// tokenizeIdent splits a CamelCase or snake_case identifier into lowercase
// words, filtering short words and stop words.
func tokenizeIdent(s string) []string {
	var words []string
	var cur strings.Builder
	flush := func() {
		w := strings.ToLower(cur.String())
		cur.Reset()
		if len(w) >= 3 && !isTFIDFStopWord(w) {
			words = append(words, w)
		}
	}
	runes := []rune(s)
	for i, r := range runes {
		switch {
		case r == '_' || r == '-' || r == '.' || r == '/' || r == ' ':
			flush()
		case i > 0 && unicode.IsUpper(r) && unicode.IsLower(runes[i-1]):
			flush()
			cur.WriteRune(r)
		default:
			cur.WriteRune(r)
		}
	}
	flush()
	return words
}

// filenameBase returns the file's base name without directory path or extension.
func filenameBase(relPath string) string {
	base := relPath
	if idx := strings.LastIndex(base, "/"); idx >= 0 {
		base = base[idx+1:]
	}
	if idx := strings.LastIndex(base, "."); idx >= 0 {
		base = base[:idx]
	}
	return base
}

func isGenericFilename(base string) bool {
	switch strings.ToLower(base) {
	case "", "__init__", "index", "mod":
		return true
	default:
		return false
	}
}

// tfidfStopWords are words that carry no clustering signal.
// Generic programming verbs and short conjunctions only — domain words
// (manager, controller, etc.) are left in because their IDF naturally
// down-weights them when ubiquitous, and they DO signal clusters when rare.
var tfidfStopWords = map[string]bool{
	"get": true, "set": true, "new": true, "add": true, "all": true,
	"has": true, "can": true, "the": true, "and": true, "for": true,
	"not": true, "nil": true, "err": true, "var": true, "let": true,
	"try": true, "run": true, "use": true, "may": true, "put": true,
}

func isTFIDFStopWord(w string) bool {
	return tfidfStopWords[w]
}
