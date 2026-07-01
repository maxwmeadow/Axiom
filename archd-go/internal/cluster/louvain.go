// Package cluster implements multi-signal community detection for codebase files.
// Louvain Phase 1 (local greedy moves) runs on a combined similarity graph
// built from four signals: import topology, directory proximity, naming
// conventions, TF-IDF semantic similarity, and git co-change history.
package cluster

import (
	"sort"
	"strings"

	"axiom.local/archd/internal/db"
)

// ClusterInput bundles all signals used by the clustering pipeline.
// TFIDF and Cochange are optional — pass nil to disable either signal.
type ClusterInput struct {
	Files        []db.File
	Dependencies []db.Dependency
	TFIDF        map[string]FileVec       // fileID → TF-IDF vector
	Cochange     map[CochangePair]float64 // sorted pair → Ochiai score
}

// Signal weights. Naming and co-change are strongest; imports are demoted
// because import topology alone is too weak for sub-system discovery.
const (
	wNaming   = 3.0
	wTFIDF    = 2.0
	wCochange = 1.5 // supplementary — commit-size normalised, but can still be noisy
	wImport   = 0.5
	wDir      = 0.3

	tfidfMinSim = 0.10 // cosine similarity threshold below which no edge is added
)

type graph struct {
	nodes   []string
	nodeIdx map[string]int
	adj     []map[int]float64
	degree  []float64
	totalW  float64
}

func buildGraph(input ClusterInput) *graph {
	// Sort files by ID for deterministic node ordering across runs.
	sorted := make([]db.File, len(input.Files))
	copy(sorted, input.Files)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].ID < sorted[j].ID })

	g := &graph{nodeIdx: make(map[string]int, len(sorted))}
	for _, f := range sorted {
		g.nodeIdx[f.ID] = len(g.nodes)
		g.nodes = append(g.nodes, f.ID)
	}
	n := len(g.nodes)
	g.adj = make([]map[int]float64, n)
	for i := range g.adj {
		g.adj[i] = make(map[int]float64)
	}
	g.degree = make([]float64, n)

	addEdge := func(a, b int, w float64) {
		if a == b || w <= 0 {
			return
		}
		g.adj[a][b] += w
		g.adj[b][a] += w
		g.degree[a] += w
		g.degree[b] += w
		g.totalW += w
	}

	// ── Signal 1: Import dependencies (downweighted — topology alone is weak) ──
	for _, d := range input.Dependencies {
		if d.DependencyType != "IMPORTS" {
			continue
		}
		ai, aok := g.nodeIdx[d.Src]
		bi, bok := g.nodeIdx[d.Dst]
		if !aok || !bok {
			continue
		}
		addEdge(ai, bi, wImport)
	}

	// ── Signal 2: Directory proximity (ties files with no imports to neighbors) ─
	byDir := make(map[string][]int)
	for _, f := range sorted {
		dir := "__root__"
		if idx := strings.LastIndex(f.RelPath, "/"); idx >= 0 {
			dir = f.RelPath[:idx]
		}
		byDir[dir] = append(byDir[dir], g.nodeIdx[f.ID])
	}
	for _, members := range byDir {
		for i := 0; i < len(members); i++ {
			for j := i + 1; j < len(members); j++ {
				addEdge(members[i], members[j], wDir)
			}
		}
	}

	// ── Signal 3: Naming prefix (CamelCase head match is a strong developer signal)
	byHead := make(map[string][]int)
	for _, f := range sorted {
		head := CamelHead(filenameBase(f.RelPath))
		if head != "" {
			byHead[head] = append(byHead[head], g.nodeIdx[f.ID])
		}
	}
	for _, members := range byHead {
		for i := 0; i < len(members); i++ {
			for j := i + 1; j < len(members); j++ {
				addEdge(members[i], members[j], wNaming)
			}
		}
	}

	// ── Signal 4: TF-IDF semantic similarity ──────────────────────────────────
	if input.TFIDF != nil {
		for i := 0; i < len(sorted); i++ {
			vi := input.TFIDF[sorted[i].ID]
			for j := i + 1; j < len(sorted); j++ {
				vj := input.TFIDF[sorted[j].ID]
				if sim := CosineSim(vi, vj); sim >= tfidfMinSim {
					addEdge(g.nodeIdx[sorted[i].ID], g.nodeIdx[sorted[j].ID], sim*wTFIDF)
				}
			}
		}
	}

	// ── Signal 5: Git co-change (Ochiai-normalised) ───────────────────────────
	if input.Cochange != nil {
		for pair, score := range input.Cochange {
			ai, aok := g.nodeIdx[pair[0]]
			bi, bok := g.nodeIdx[pair[1]]
			if !aok || !bok {
				continue
			}
			addEdge(ai, bi, score*wCochange)
		}
	}

	return g
}

// Cluster runs Louvain Phase 1 on the combined multi-signal graph and returns
// a map from file ID to cluster ID (0-based integer).
func Cluster(input ClusterInput) map[string]int {
	if len(input.Files) == 0 {
		return nil
	}

	g := buildGraph(input)
	n := len(g.nodes)

	if g.totalW == 0 {
		result := make(map[string]int, n)
		for i, id := range g.nodes {
			result[id] = i
		}
		return result
	}

	twoM := 2 * g.totalW

	// Initialise: each node is its own community.
	comm := make([]int, n)
	for i := range comm {
		comm[i] = i
	}
	// sigTot[c] = sum of all node degrees in community c.
	sigTot := make([]float64, n)
	copy(sigTot, g.degree)

	for improved := true; improved; {
		improved = false
		for i := 0; i < n; i++ {
			ci := comm[i]
			ki := g.degree[i]

			// Weight from node i to its own community.
			var kiCi float64
			for j, w := range g.adj[i] {
				if comm[j] == ci {
					kiCi += w
				}
			}

			// Aggregate edge weights from i to each neighbouring community.
			neighborComms := make(map[int]float64)
			for j, w := range g.adj[i] {
				if cj := comm[j]; cj != ci {
					neighborComms[cj] += w
				}
			}

			// ΔQ for removing i from ci (paired with an insertion gain below).
			removeGain := -kiCi/twoM + ki*(sigTot[ci]-ki)/(twoM*twoM)

			bestGain := 0.0
			bestComm := ci
			for cj, kiCj := range neighborComms {
				insertGain := kiCj/twoM - ki*sigTot[cj]/(twoM*twoM)
				net := removeGain + insertGain
				// Deterministic tiebreak: prefer lower community ID.
				if net > bestGain || (net == bestGain && cj < bestComm) {
					bestGain = net
					bestComm = cj
				}
			}

			if bestComm != ci {
				sigTot[ci] -= ki
				sigTot[bestComm] += ki
				comm[i] = bestComm
				improved = true
			}
		}
	}

	// Normalise to consecutive 0-based cluster IDs.
	remap := make(map[int]int)
	nextID := 0
	result := make(map[string]int, n)
	for i, nodeID := range g.nodes {
		c := comm[i]
		if _, ok := remap[c]; !ok {
			remap[c] = nextID
			nextID++
		}
		result[nodeID] = remap[c]
	}
	return result
}
