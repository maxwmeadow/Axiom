package cluster

import (
	"strings"

	"axiom.local/archd/internal/db"
)

// NameCluster picks a human-readable name for a cluster from its member files.
//
// Strategy: find the first path depth where the files DIVERGE, then use the
// most-common component at that depth. When all files share the same directory,
// fall back to the dominant CamelCase/snake_case filename prefix so that
// sub-clusters within a flat directory get distinct names.
func NameCluster(files []db.File) string {
	if len(files) == 0 {
		return "Unknown"
	}
	if len(files) == 1 {
		parts := strings.Split(files[0].RelPath, "/")
		if len(parts) >= 2 {
			return parts[len(parts)-2]
		}
		name := parts[len(parts)-1]
		if dot := strings.LastIndex(name, "."); dot > 0 {
			name = name[:dot]
		}
		return name
	}

	allParts := make([][]string, len(files))
	minLen := len(strings.Split(files[0].RelPath, "/"))
	for i, f := range files {
		allParts[i] = strings.Split(f.RelPath, "/")
		if l := len(allParts[i]); l < minLen {
			minLen = l
		}
	}

	divergeDepth := -1
	for depth := 0; depth < minLen-1; depth++ {
		first := allParts[0][depth]
		same := true
		for _, p := range allParts[1:] {
			if p[depth] != first {
				same = false
				break
			}
		}
		if !same {
			divergeDepth = depth
			break
		}
	}

	if divergeDepth == -1 {
		// All files share the same directory — try filename prefix first.
		if name := dominantFilenamePrefix(allParts); name != "" {
			return name
		}
		p := allParts[0]
		if len(p) >= 2 {
			return p[len(p)-2]
		}
		return stripExt(p[0])
	}

	return mostCommonAt(allParts, divergeDepth, minLen)
}

func dominantFilenamePrefix(allParts [][]string) string {
	freq := make(map[string]int)
	for _, parts := range allParts {
		head := CamelHead(parts[len(parts)-1])
		if head != "" {
			freq[head]++
		}
	}
	best, bestCount := "", 0
	for h, c := range freq {
		if c > bestCount || (c == bestCount && h < best) {
			bestCount = c
			best = h
		}
	}
	if bestCount >= 2 {
		return best
	}
	return ""
}

// CamelHead extracts the leading CamelCase or snake_case word from a filename.
// "BiomeClassifier.cs" → "Biome", "chunk_manager.py" → "chunk",
// "WorldMap.cs" → "World", "FractalNoise.cs" → "Fractal".
func CamelHead(filename string) string {
	// Strip extension
	name := filename
	if dot := strings.LastIndex(name, "."); dot > 0 {
		name = name[:dot]
	}
	if len(name) == 0 {
		return ""
	}
	// snake_case / kebab-case: split on the first _ or - after at least 3 chars.
	// Preserve original capitalization (WorkGiver_X → "WorkGiver", haul-job → "haul").
	firstSep := -1
	for i, c := range name {
		if c == '_' || c == '-' {
			firstSep = i
			break
		}
	}
	if firstSep >= 3 {
		return name[:firstSep]
	}
	// CamelCase: find transition from lower to upper
	for i := 1; i < len(name); i++ {
		if name[i] >= 'A' && name[i] <= 'Z' {
			if i >= 3 {
				return name[:i]
			}
			// Short first segment — include the second word for a more useful name
			for j := i + 1; j < len(name); j++ {
				if name[j] >= 'A' && name[j] <= 'Z' {
					return name[:j]
				}
			}
			return name[:i]
		}
	}
	// Whole filename is a single word — return it lowercase
	return strings.ToLower(stripExt(name))
}

func mostCommonAt(allParts [][]string, depth, minLen int) string {
	freq := make(map[string]int)
	for _, p := range allParts {
		if depth < len(p)-1 {
			freq[p[depth]]++
		}
	}
	best, bestCount := "Cluster", 0
	for name, count := range freq {
		if count > bestCount || (count == bestCount && name < best) {
			bestCount = count
			best = name
		}
	}
	return best
}

// CamelTail extracts the trailing CamelCase word from a filename stem.
// Works across all naming conventions:
//
//	PascalCase:  "HaulJobDriver.cs"    → "Driver"
//	kebab-case:  "haul-job-driver.py"  → "Driver"
//	snake_case:  "haul_job_driver.go"  → "Driver"
//	mixed:       "JobDriver_MineTile.cs"→ "Tile"
//
// This is the counterpart to CamelHead and catches the *Controller, *Service,
// *Repository, *Driver suffix patterns common across all language ecosystems.
func CamelTail(filename string) string {
	name := filename
	if dot := strings.LastIndex(name, "."); dot > 0 {
		name = name[:dot]
	}
	// For snake_case and kebab-case, look at the segment after the last separator.
	// Both _ and - act as word boundaries; whichever comes last wins.
	lastSep := -1
	for i, c := range name {
		if c == '_' || c == '-' {
			lastSep = i
		}
	}
	if lastSep >= 0 {
		seg := name[lastSep+1:]
		if len(seg) >= 3 {
			// Normalize: uppercase the first letter so "driver" == "Driver".
			if seg[0] >= 'a' && seg[0] <= 'z' {
				seg = strings.ToUpper(seg[:1]) + seg[1:]
			}
			return seg
		}
		// Suffix too short (e.g. "_v2") — fall through to CamelCase scan.
	}
	if len(name) == 0 {
		return ""
	}
	// CamelCase: scan backwards for the last uppercase letter starting ≥3 chars.
	for i := len(name) - 1; i > 0; i-- {
		if name[i] >= 'A' && name[i] <= 'Z' {
			if tail := name[i:]; len(tail) >= 3 {
				return tail
			}
		}
	}
	return strings.ToLower(name)
}

func stripExt(name string) string {
	if dot := strings.LastIndex(name, "."); dot > 0 {
		return name[:dot]
	}
	return name
}
