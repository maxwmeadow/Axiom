package cluster

import (
	"bufio"
	"log"
	"math"
	"os/exec"
	"path/filepath"
	"strings"

	"axiom.local/archd/internal/db"
)

// CochangePair is a canonical (lexicographically sorted) pair of file IDs.
type CochangePair = [2]string

// BuildCochange mines git history under rootPath and returns Ochiai-normalized
// co-change scores between file pairs, weighted by inverse commit size.
//
// Commit-size weighting: each co-occurrence contributes 1/commitSize instead of 1.
// A 3-file commit contributes 0.33 per pair; a 50-file commit contributes 0.02.
// This makes large "sweep" commits (refactors, auto-formatting) contribute very
// little, while small focused commits - which reveal true architectural coupling -
// dominate. Returns nil if git is unavailable or there is no history.
func BuildCochange(rootPath string, files []db.File) map[CochangePair]float64 {
	relToID := make(map[string]string, len(files))
	for _, f := range files {
		relToID[f.RelPath] = f.ID
	}

	cmd := exec.Command("git", "-C", rootPath, "log",
		"--name-only", "--pretty=format:---COMMIT---", "--diff-filter=AM")
	out, err := cmd.Output()
	if err != nil {
		log.Printf("[cochange] git unavailable at %s: %v", rootPath, err)
		return nil
	}

	// rawPairs and commitCount are float64 because contributions are fractional.
	rawPairs := make(map[CochangePair]float64)
	commitCount := make(map[string]float64, len(files))
	var batch []string

	flush := func() {
		n := len(batch)
		if n == 0 {
			return
		}
		w := 1.0 / float64(n) // commit-size weight
		for i := 0; i < n; i++ {
			commitCount[batch[i]] += w
			for j := i + 1; j < n; j++ {
				a, b := batch[i], batch[j]
				if a > b {
					a, b = b, a
				}
				rawPairs[CochangePair{a, b}] += w
			}
		}
		batch = batch[:0]
	}

	totalCommits, totalFiles := 0, 0
	sc := bufio.NewScanner(strings.NewReader(string(out)))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "---COMMIT---" {
			totalFiles += len(batch)
			totalCommits++
			flush()
			continue
		}
		if line == "" {
			continue
		}
		rel := filepath.ToSlash(line)
		if id, ok := relToID[rel]; ok {
			batch = append(batch, id)
		}
	}
	totalFiles += len(batch)
	totalCommits++
	flush()

	if len(rawPairs) == 0 {
		log.Printf("[cochange] no co-change pairs found in %s", rootPath)
		return nil
	}

	if totalCommits > 0 {
		avg := float64(totalFiles) / float64(totalCommits)
		log.Printf("[cochange] %d commits, avg %.1f files/commit - large-commit noise %.0f%%",
			totalCommits, avg, math.Max(0, (avg-3)/avg*100))
	}

	// Ochiai coefficient: cochange(A,B) / sqrt(commits(A) * commits(B))
	scores := make(map[CochangePair]float64, len(rawPairs))
	for pair, count := range rawPairs {
		ca := commitCount[pair[0]]
		cb := commitCount[pair[1]]
		if ca > 0 && cb > 0 {
			scores[pair] = count / math.Sqrt(ca*cb)
		}
	}
	log.Printf("[cochange] %d co-change pairs across %d files with history",
		len(scores), len(commitCount))
	return scores
}
