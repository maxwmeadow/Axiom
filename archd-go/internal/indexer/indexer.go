// Package indexer orchestrates the full file walk for a root directory:
// parses each file, writes symbols and import edges, then runs Louvain clustering.
// On subsequent runs it only re-parses files whose mtime has changed.
package indexer

import (
	"database/sql"
	"fmt"
	"io/fs"
	"log"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/google/uuid"

	"axiom.local/archd/internal/cluster"
	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
	"axiom.local/archd/internal/parser"
)

var skipDirs = map[string]bool{
	"node_modules": true,
	".git":         true,
	".idea":        true,
	".vscode":      true,
	"dist":         true,
	"build":        true,
	"out":          true,
	".next":        true,
	"__pycache__":  true,
	"vendor":       true,
	"target":       true, // Rust/Maven
}

var supportedExts = map[string]bool{
	".ts": true, ".tsx": true, ".js": true, ".mjs": true,
	".jsx": true, ".py": true, ".go": true, ".rs": true, ".cs": true,
	".cpp": true, ".cc": true, ".cxx": true, ".hpp": true, ".hxx": true, ".rb": true, ".java": true,
}

// IndexRoot walks the root directory and indexes all source files.
// After parsing, runs Louvain clustering and assigns files to cluster systems.
// ignoredPaths is a list of absolute path globs (e.g. "C:\proj\Library\**") to skip.
func IndexRoot(sqlDB *sql.DB, h *hub.Hub, root db.Root, ignoredPaths []string) error {
	log.Printf("[indexer] IndexRoot called: root=%s ignoredPaths=%v", root.Path, ignoredPaths)

	// Build a set of normalised absolute directory paths to skip.
	ignoredAbsDirs := make(map[string]bool)
	for _, p := range ignoredPaths {
		native := filepath.FromSlash(p)
		native = strings.TrimSuffix(native, string(filepath.Separator)+"**")
		native = strings.TrimSuffix(native, "/**")
		clean := filepath.Clean(native)
		if clean != "" && clean != "." {
			key := strings.ToLower(clean)
			ignoredAbsDirs[key] = true
			log.Printf("[indexer] will ignore: %q (key=%q)", p, key)
		}
	}
	isIgnored := func(absPath string) bool {
		key := strings.ToLower(absPath)
		hit := ignoredAbsDirs[key]
		if hit {
			log.Printf("[indexer] skipping dir: %s", absPath)
		}
		return hit
	}

	// Collect all candidate file paths first so we can report progress.
	var paths []string
	if err := filepath.WalkDir(root.Path, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable dirs
		}
		if d.IsDir() {
			if skipDirs[d.Name()] || strings.HasPrefix(d.Name(), ".") || isIgnored(path) {
				return filepath.SkipDir
			}
			return nil
		}
		if supportedExts[strings.ToLower(filepath.Ext(path))] {
			paths = append(paths, path)
		}
		return nil
	}); err != nil {
		return err
	}

	total := len(paths)
	log.Printf("[indexer] root %s — %d source files after ignore filtering", root.Path, total)

	// Map relPath → existing file record (for deduplication / position preservation).
	existing, err := buildExistingMap(sqlDB, root.ID)
	if err != nil {
		return err
	}

	// Parse files concurrently using a worker pool sized to GOMAXPROCS.
	// rawCallsMap collects unresolved calls keyed by fileID; resolved after all files are indexed.
	var rawCallsMap sync.Map
	workers := runtime.GOMAXPROCS(0)
	jobs := make(chan string, workers*2)
	var wg sync.WaitGroup
	var indexed atomic.Int32

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for absPath := range jobs {
				relPath, _ := filepath.Rel(root.Path, absPath)
				relPath = filepath.ToSlash(relPath)
				if err := indexOneFile(sqlDB, root, relPath, absPath, existing, &rawCallsMap); err != nil {
					log.Printf("indexer: skip %s: %v", relPath, err)
				}
				n := int(indexed.Add(1))
				if n%50 == 0 || n == total {
					h.BroadcastIndexingProgress(n, total)
				}
			}
		}()
	}

	for _, p := range paths {
		jobs <- p
	}
	close(jobs)
	wg.Wait()

	// Build import dependencies after all file IDs are known.
	if err := buildImportDependencies(sqlDB, root); err != nil {
		log.Printf("indexer: build dependencies: %v", err)
	}

	// Resolve raw calls → call_graph entries using import edges + symbol table.
	if err := buildCallGraph(sqlDB, root, &rawCallsMap); err != nil {
		log.Printf("indexer: build call graph: %v", err)
	}

	// Cluster files by import topology and assign to systems.
	if err := clusterAndAssign(sqlDB, root); err != nil {
		log.Printf("indexer: cluster: %v", err)
	}

	if err := db.MarkRootIndexed(sqlDB, root.ID); err != nil {
		log.Printf("indexer: mark indexed: %v", err)
	}

	h.BroadcastIndexingComplete(root.WorkspaceID)
	return nil
}

// ClusterOnly runs just the clustering pass without re-parsing any files.
// Used on project re-open when the files are already indexed but no systems exist yet.
func ClusterOnly(sqlDB *sql.DB, root db.Root) error {
	return clusterAndAssign(sqlDB, root)
}

// ReindexFile re-parses a single file and updates its symbols and edges.
// Called by the watcher on file change events.
func ReindexFile(sqlDB *sql.DB, h *hub.Hub, root db.Root, absPath string) error {
	relPath, _ := filepath.Rel(root.Path, absPath)
	relPath = filepath.ToSlash(relPath)
	existing, _ := buildExistingMap(sqlDB, root.ID)
	if err := indexOneFile(sqlDB, root, relPath, absPath, existing, nil); err != nil {
		return err
	}
	// Rebuild dependencies for this file only
	if err := rebuildDependenciesForFile(sqlDB, root, relPath); err != nil {
		log.Printf("indexer: rebuild dependencies for %s: %v", relPath, err)
	}
	// Broadcast a patch with the updated file
	file, err := db.GetFileByRelPath(sqlDB, root.ID, relPath)
	if err == nil && file != nil {
		h.BroadcastPatch(map[string]any{
			"type":    "file:updated",
			"payload": file,
		})
	}
	return nil
}

// ─── Internals ────────────────────────────────────────────────────────────────

func indexOneFile(sqlDB *sql.DB, root db.Root, relPath, absPath string, existing map[string]db.File, rawCallsMap *sync.Map) error {
	result, err := parser.ParseFile(absPath, relPath)
	if err != nil {
		return err
	}

	var fileID string
	if prev, ok := existing[relPath]; ok {
		fileID = prev.ID
	} else {
		fileID = uuid.New().String()
	}

	f := db.File{
		ID:        fileID,
		RootID:    root.ID,
		Path:      absPath,
		RelPath:   relPath,
		Language:  result.Language,
		SystemID:  nil, // assigned after clustering
		LineCount: result.LineCount,
	}
	if err := db.UpsertFile(sqlDB, f); err != nil {
		return err
	}

	syms := result.Symbols
	for i := range syms {
		syms[i].FileID = fileID
	}
	if err := db.UpsertSymbols(sqlDB, fileID, syms); err != nil {
		return err
	}

	if err := db.UpsertVarRefs(sqlDB, fileID, aggregateVarRefs(fileID, result.VarRefs)); err != nil {
		return err
	}

	if rawCallsMap != nil && len(result.Calls) > 0 {
		rawCallsMap.Store(fileID, result.Calls)
	}
	return nil
}

// aggregateVarRefs prepares parser var refs for storage: def/param/write are
// kept per-occurrence; reads are collapsed to one row per variable (count =
// number of reads, line = first read) so the table stays small. Single-char
// read-only names are dropped as noise, but names that are also defined/written
// are always kept.
func aggregateVarRefs(fileID string, refs []parser.VarRef) []db.VarRefRow {
	var out []db.VarRefRow
	type readAgg struct {
		line, count     int
		enclosingSymbol string
	}
	reads := make(map[string]*readAgg)
	nonRead := make(map[string]bool)

	for _, r := range refs {
		if r.Kind == "read" {
			a := reads[r.Name]
			if a == nil {
				reads[r.Name] = &readAgg{line: r.Line, count: 1, enclosingSymbol: r.EnclosingSymbol}
			} else {
				a.count++
			}
			continue
		}
		nonRead[r.Name] = true
		out = append(out, db.VarRefRow{
			FileID:          fileID,
			Variable:        r.Name,
			Kind:            r.Kind,
			Line:            r.Line,
			Count:           1,
			EnclosingSymbol: r.EnclosingSymbol,
		})
	}
	for name, a := range reads {
		if len(name) < 2 && !nonRead[name] {
			continue // single-char pure-read (loop counters etc.) — noise
		}
		out = append(out, db.VarRefRow{
			FileID:          fileID,
			Variable:        name,
			Kind:            "read",
			Line:            a.line,
			Count:           a.count,
			EnclosingSymbol: a.enclosingSymbol,
		})
	}
	return out
}

// buildCallGraph resolves raw parser calls into call trace connections between project files.
//
// Resolution strategy (language-agnostic, works for any codebase):
//
//  1. Build an inverted symbol index: functionName → []fileID that define it.
//     Any name NOT in this index is a built-in, stdlib, or external call — naturally filtered.
//
//  2. Unique match (high confidence): exactly one project file defines the name → record the call.
//
//  3. Ambiguous match: multiple files define the same name → use import/using relationships as a
//     tiebreaker. If imports narrow it to one file, record that. Otherwise skip to avoid noise.
//
// This deliberately avoids language-specific logic so it extends to any language Axiom supports.
func buildCallGraph(sqlDB *sql.DB, root db.Root, rawCallsMap *sync.Map) error {
	rawCalls := make(map[string][]parser.RawCall)
	rawCallsMap.Range(func(k, v any) bool {
		rawCalls[k.(string)] = v.([]parser.RawCall)
		return true
	})
	log.Printf("[callgraph] raw call sites collected from %d files", len(rawCalls))
	if len(rawCalls) == 0 {
		return nil
	}

	// ── Step 1: Build inverted symbol index ──────────────────────────────────
	// symbolToFiles[name] = all project files that define a symbol with that name.
	// Names absent from this map are external/stdlib and are silently skipped.
	rows, err := sqlDB.Query(`
		SELECT f.id, s.name
		FROM symbols s
		JOIN files f ON f.id = s.file_id
		JOIN roots r ON r.id = f.root_id
		WHERE r.id = ?`, root.ID)
	if err != nil {
		return err
	}
	symbolToFiles := make(map[string][]string) // name → []fileID
	for rows.Next() {
		var fileID, symName string
		if err := rows.Scan(&fileID, &symName); err != nil {
			rows.Close()
			return err
		}
		symbolToFiles[symName] = append(symbolToFiles[symName], fileID)
	}
	rows.Close()
	log.Printf("[callgraph] symbol index: %d unique names across project", len(symbolToFiles))

	// Log a sample of indexed symbol names so we can compare against raw call names.
	sampleIdx := 0
	for name, fileIDs := range symbolToFiles {
		log.Printf("[callgraph] symbol sample: %q defined in %d file(s)", name, len(fileIDs))
		sampleIdx++
		if sampleIdx >= 15 {
			break
		}
	}

	// ── Step 2: Build import map as tiebreaker for ambiguous names ───────────
	// Only used when multiple files define the same symbol name.
	deps, err := db.GetDependencies(sqlDB, root.WorkspaceID)
	if err != nil {
		return err
	}
	fileImports := make(map[string]map[string]bool) // callerFileID → set of imported fileIDs
	for _, dep := range deps {
		if dep.SrcType == "file" && dep.DstType == "file" && dep.DependencyType == "IMPORTS" {
			if fileImports[dep.Src] == nil {
				fileImports[dep.Src] = make(map[string]bool)
			}
			fileImports[dep.Src][dep.Dst] = true
		}
	}

	// Log a sample of call names that have NO match in the symbol index.
	missCount := 0
	for _, calls := range rawCalls {
		for _, call := range calls {
			if _, found := symbolToFiles[call.CalleeName]; !found {
				if missCount < 10 {
					log.Printf("[callgraph] unresolved call (not in symbol index): %q", call.CalleeName)
				}
				missCount++
			}
		}
	}
	log.Printf("[callgraph] %d call sites have no matching project symbol", missCount)

	// ── Step 3: Resolve each call site ───────────────────────────────────────
	type callKey struct{ callerSym, calleeFile, calleeSym string }
	totalTraces := 0

	for callerFileID, calls := range rawCalls {
		counts := make(map[callKey]int)
		imported := fileImports[callerFileID] // may be nil — that's fine

		for _, call := range calls {
			candidates := symbolToFiles[call.CalleeName]
			if len(candidates) == 0 {
				continue // not a project symbol — built-in or external
			}

			// Remove self-calls. Allocate a new slice — candidates shares its
			// backing array with the symbolToFiles map value, so filtering
			// in place (candidates[:0]) would corrupt the shared index.
			filtered := make([]string, 0, len(candidates))
			for _, fid := range candidates {
				if fid != callerFileID {
					filtered = append(filtered, fid)
				}
			}
			if len(filtered) == 0 {
				continue
			}

			var resolved []string
			switch len(filtered) {
			case 1:
				// Unique match — only one project file defines this name.
				resolved = filtered
			default:
				// Ambiguous — try to narrow using import relationships.
				if len(imported) > 0 {
					for _, fid := range filtered {
						if imported[fid] {
							resolved = append(resolved, fid)
						}
					}
				}
				// If imports don't narrow it to one file, skip to avoid noise.
				if len(resolved) != 1 {
					resolved = nil
				}
			}

			for _, calleeFileID := range resolved {
				counts[callKey{call.CallerSymbol, calleeFileID, call.CalleeName}]++
			}
		}

		if len(counts) == 0 {
			continue
		}
		callTraces := make([]db.CallEdge, 0, len(counts))
		for key, count := range counts {
			callTraces = append(callTraces, db.CallEdge{
				CallerFile:   callerFileID,
				CallerSymbol: key.callerSym,
				CalleeFile:   key.calleeFile,
				CalleeSymbol: key.calleeSym,
				CallCount:    count,
			})
		}
		totalTraces += len(callTraces)
		if err := db.UpsertCallEdges(sqlDB, callerFileID, callTraces); err != nil {
			log.Printf("indexer: upsert call traces for %s: %v", callerFileID, err)
		}
	}
	log.Printf("[callgraph] resolved %d call traces across %d files", totalTraces, len(rawCalls))
	return nil
}

// minClusterFiles is the minimum number of files a cluster must have
// before we attempt to sub-cluster it further.
const minClusterFiles = 4

// maxClusterDepth is the maximum system nesting depth (0-indexed).
// Files are assigned at whatever level recursion stops.
const maxClusterDepth = 4

// clusterAndAssign runs hierarchical multi-signal clustering on the indexed files.
// It builds TF-IDF vectors and git co-change scores once, then recursively
// subdivides large clusters using all signals combined.
func clusterAndAssign(sqlDB *sql.DB, root db.Root) error {
	log.Printf("[cluster] clusterAndAssign START workspace=%s root=%s", root.WorkspaceID, root.Path)

	if err := db.DeleteSystemsBySource(sqlDB, root.WorkspaceID, "cluster"); err != nil {
		return fmt.Errorf("delete stale clusters: %w", err)
	}
	log.Printf("[cluster] deleted stale cluster systems")

	files, err := db.GetFilesByRoot(sqlDB, root.ID)
	if err != nil {
		return err
	}
	log.Printf("[cluster] got %d files for root", len(files))
	if len(files) == 0 {
		log.Printf("[cluster] no files — skipping clustering")
		return nil
	}

	dependencies, err := db.GetDependencies(sqlDB, root.WorkspaceID)
	if err != nil {
		return err
	}
	log.Printf("[cluster] got %d dependencies", len(dependencies))

	// Build TF-IDF vectors from all symbols (single bulk query).
	fileSymbols, err := db.GetSymbolsByRoot(sqlDB, root.ID)
	if err != nil {
		log.Printf("[indexer] symbols load error (TF-IDF disabled): %v", err)
		fileSymbols = nil
	}
	var tfidf map[string]cluster.FileVec
	if fileSymbols != nil {
		tfidf = cluster.BuildTFIDF(files, fileSymbols)
		log.Printf("[cluster] TF-IDF built for %d files", len(tfidf))
	} else {
		log.Printf("[cluster] TF-IDF disabled (no symbols)")
	}

	// Build co-change matrix from git history (skipped gracefully if git unavailable).
	cochange := cluster.BuildCochange(root.Path, files)
	log.Printf("[cluster] co-change matrix: %d pairs", len(cochange))

	// Sample first few file paths for debugging.
	sampleN := 5
	if len(files) < sampleN {
		sampleN = len(files)
	}
	for i := 0; i < sampleN; i++ {
		log.Printf("[cluster]   sample file[%d]: %s", i, files[i].RelPath)
	}

	input := cluster.ClusterInput{
		Files:        files,
		Dependencies: dependencies,
		TFIDF:        tfidf,
		Cochange:     cochange,
	}

	assigned, err := clusterLevel(sqlDB, root, input, nil, map[string]struct{}{}, 0)
	if err != nil {
		return err
	}
	log.Printf("[cluster] clusterAndAssign DONE: %d/%d files assigned to systems", assigned, len(files))
	return nil
}

// clusterLevel is the three-tier hierarchical clustering entry point.
//
// Tier 1 — Directory structure: if files span multiple non-trivial directories,
//
//	use directory as the primary grouping (most reliable signal).
//
// Tier 2 — Naming prefix: within a flat directory, group by CamelCase/snake_case
//
//	filename prefix. Residuals are assigned to the nearest group via TF-IDF.
//
// Tier 3 — Louvain fallback: when neither directory nor naming gives structure,
//
//	run multi-signal Louvain (TF-IDF + imports + co-change).
//
// TFIDF and Cochange are built once at the top level and passed through all
// recursive calls unchanged; only Files is narrowed at each level.
func clusterLevel(sqlDB *sql.DB, root db.Root, input cluster.ClusterInput, parentID *string, ancestorNames map[string]struct{}, depth int) (int, error) {
	files := input.Files
	if len(files) == 0 {
		return 0, nil
	}

	log.Printf("[cluster] clusterLevel depth=%d files=%d parentID=%v", depth, len(files), parentID != nil)

	// Too small to subdivide or at depth cap — assign directly to parent.
	if (len(files) < minClusterFiles && parentID != nil) || depth >= maxClusterDepth {
		log.Printf("[cluster] depth=%d: too small (%d files) or at depth cap — assigning directly to parent", depth, len(files))
		return assignAll(sqlDB, files, parentID)
	}

	// ── Tier 1: Directory structure ───────────────────────────────────────────
	dirGroups := groupByDirectory(files)
	log.Printf("[cluster] depth=%d: dir groups=%d meaningful=%v", depth, len(dirGroups), isMeaningfulDirSplit(dirGroups))
	if isMeaningfulDirSplit(dirGroups) {
		// Merge directories that share the same base name (e.g. src/auth/ and
		// lib/auth/ both become "auth"). This is correct — they belong together.
		// However if ALL directories collapse to the same base name (e.g. every
		// path ends in /Editor/), len(named)==1 and we have no new structure —
		// fall through to naming/Louvain instead of creating a wasteful same-name chain.
		named := make(map[string][]db.File, len(dirGroups))
		for dir, members := range dirGroups {
			named[dirBaseName(dir)] = append(named[dirBaseName(dir)], members...)
		}
		if len(named) >= 2 {
			log.Printf("[cluster] depth=%d dir-split: %d groups from %d files", depth, len(named), len(files))
			return applyGroupClustering(sqlDB, root, named, input, parentID, ancestorNames, depth)
		}
		log.Printf("[cluster] depth=%d: dir names collapsed to %d unique base names — falling through", depth, len(named))
		// All directories share the same base name — fall through.
	}

	// ── Tier 2: Naming prefix ─────────────────────────────────────────────────
	prefixGroups, residuals := groupByPrefix(files)
	if len(prefixGroups) >= 2 {
		// Assign each residual to the TF-IDF nearest prefix group (or parent if none).
		for _, rf := range residuals {
			if g := nearestPrefixGroup(rf, prefixGroups, input.TFIDF); g != "" {
				prefixGroups[g] = append(prefixGroups[g], rf)
			} else if parentID != nil {
				if err := db.AssignFileToSystem(sqlDB, rf.ID, *parentID); err != nil {
					log.Printf("indexer: assign residual %s: %v", rf.RelPath, err)
				}
			}
		}
		log.Printf("[cluster] depth=%d prefix-split: %d groups, %d residuals from %d files",
			depth, len(prefixGroups), len(residuals), len(files))
		return applyGroupClustering(sqlDB, root, prefixGroups, input, parentID, ancestorNames, depth)
	}

	// ── Tier 2b: Suffix grouping (*Controller, *Service, *Driver, etc.) ──────
	// Only fires when: ≥1 shared suffix group exists AND there are residuals
	// (files that don't share the suffix), meaning a real split is present.
	// Residuals stay as direct files of the parent — they're the base/core files.
	suffixGroups, suffixResiduals := groupBySuffix(files)
	// For a single suffix group, require it to cover ≥60% of files — this catches
	// dominant-pattern groups like *Driver (9/12) while ignoring thin splits like
	// *Manager (2/8) or *Definition (2/7) where Louvain produces better clusters.
	// Two or more suffix groups always qualify (e.g. *Controller + *Service in MVC).
	totalInSuffixGroups := 0
	for _, m := range suffixGroups {
		totalInSuffixGroups += len(m)
	}
	dominantSuffix := len(suffixGroups) == 1 &&
		totalInSuffixGroups*100 >= len(files)*60 &&
		len(suffixResiduals) > 0 &&
		parentID != nil
	if len(suffixGroups) >= 2 || dominantSuffix {
		for _, rf := range suffixResiduals {
			if parentID != nil {
				if err := db.AssignFileToSystem(sqlDB, rf.ID, *parentID); err != nil {
					log.Printf("indexer: assign suffix-residual %s: %v", rf.RelPath, err)
				}
			}
		}
		log.Printf("[cluster] depth=%d suffix-split: %d groups, %d residuals from %d files",
			depth, len(suffixGroups), len(suffixResiduals), len(files))
		return applyGroupClustering(sqlDB, root, suffixGroups, input, parentID, ancestorNames, depth)
	}

	// ── Tier 3: Louvain fallback ──────────────────────────────────────────────
	return clusterByLouvain(sqlDB, root, input, parentID, ancestorNames, depth)
}

// clusterByLouvain runs multi-signal Louvain with merge-before-recurse naming.
// Used only when directory and naming signals both fail to find structure.
func clusterByLouvain(sqlDB *sql.DB, root db.Root, input cluster.ClusterInput, parentID *string, ancestorNames map[string]struct{}, depth int) (int, error) {
	clusterMap := cluster.Cluster(input)

	rawGroups := make(map[int][]db.File)
	for _, f := range input.Files {
		rawGroups[clusterMap[f.ID]] = append(rawGroups[clusterMap[f.ID]], f)
	}

	if len(rawGroups) <= 1 && parentID != nil {
		return assignAll(sqlDB, input.Files, parentID)
	}

	merged := make(map[string][]db.File)
	for _, members := range rawGroups {
		name := cluster.NameCluster(members)
		merged[name] = append(merged[name], members...)
	}

	if len(merged) <= 1 && parentID != nil {
		return assignAll(sqlDB, input.Files, parentID)
	}

	log.Printf("[cluster] depth=%d louvain: %d groups from %d files", depth, len(merged), len(input.Files))
	return applyGroupClustering(sqlDB, root, merged, input, parentID, ancestorNames, depth)
}

// ─── Clustering helpers ────────────────────────────────────────────────────────

// groupByDirectory groups files by their immediate parent directory path.
func groupByDirectory(files []db.File) map[string][]db.File {
	groups := make(map[string][]db.File)
	for _, f := range files {
		dir := ""
		if idx := strings.LastIndex(f.RelPath, "/"); idx >= 0 {
			dir = f.RelPath[:idx]
		}
		groups[dir] = append(groups[dir], f)
	}
	return groups
}

// isMeaningfulDirSplit returns true if at least 2 directories each hold >= 2 files.
func isMeaningfulDirSplit(groups map[string][]db.File) bool {
	n := 0
	for _, members := range groups {
		if len(members) >= 2 {
			if n++; n >= 2 {
				return true
			}
		}
	}
	return false
}

// dirBaseName returns the last path component of a directory.
func dirBaseName(dir string) string {
	if dir == "" {
		return "Root"
	}
	if idx := strings.LastIndex(dir, "/"); idx >= 0 {
		return dir[idx+1:]
	}
	return dir
}

// groupByPrefix groups files by CamelCase/snake_case filename prefix.
// Files whose prefix is unique (appears in only 1 file) are returned as residuals.
func groupByPrefix(files []db.File) (groups map[string][]db.File, residuals []db.File) {
	byHead := make(map[string][]db.File)
	for _, f := range files {
		head := cluster.CamelHead(fileBaseName(f.RelPath))
		if head != "" {
			byHead[head] = append(byHead[head], f)
		} else {
			residuals = append(residuals, f)
		}
	}
	groups = make(map[string][]db.File)
	for head, members := range byHead {
		if len(members) >= 2 {
			groups[head] = members
		} else {
			residuals = append(residuals, members...)
		}
	}
	return
}

// fileBaseName returns the filename without directory path or extension.
func fileBaseName(relPath string) string {
	base := relPath
	if idx := strings.LastIndex(base, "/"); idx >= 0 {
		base = base[idx+1:]
	}
	if idx := strings.LastIndex(base, "."); idx >= 0 {
		base = base[:idx]
	}
	return base
}

// groupBySuffix groups files by CamelCase/snake_case/kebab-case filename suffix (CamelTail).
// Files whose suffix is unique (appears in only 1 file) are returned as residuals.
func groupBySuffix(files []db.File) (groups map[string][]db.File, residuals []db.File) {
	byTail := make(map[string][]db.File)
	for _, f := range files {
		tail := cluster.CamelTail(fileBaseName(f.RelPath))
		if tail != "" {
			byTail[tail] = append(byTail[tail], f)
		} else {
			residuals = append(residuals, f)
		}
	}
	groups = make(map[string][]db.File)
	for tail, members := range byTail {
		if len(members) >= 2 {
			groups[tail] = members
		} else {
			residuals = append(residuals, members...)
		}
	}
	return
}

// nearestPrefixGroup returns the prefix group name most similar to f by TF-IDF
// cosine similarity, or "" if nothing exceeds the minimum threshold.
func nearestPrefixGroup(f db.File, groups map[string][]db.File, tfidf map[string]cluster.FileVec) string {
	if tfidf == nil {
		return ""
	}
	fv := tfidf[f.ID]
	if len(fv) == 0 {
		return ""
	}
	best, bestSim := "", 0.05
	for name, members := range groups {
		var sum float64
		for _, m := range members {
			sum += cluster.CosineSim(fv, tfidf[m.ID])
		}
		if avg := sum / float64(len(members)); avg > bestSim {
			bestSim = avg
			best = name
		}
	}
	return best
}

// assignAll assigns every file to sysID (if non-nil) and returns the count.
func assignAll(sqlDB *sql.DB, files []db.File, sysID *string) (int, error) {
	if sysID == nil {
		return 0, nil
	}
	for _, f := range files {
		if err := db.AssignFileToSystem(sqlDB, f.ID, *sysID); err != nil {
			log.Printf("indexer: assign %s: %v", f.RelPath, err)
		}
	}
	return len(files), nil
}

// applyGroupClustering creates one system per named group and recurses into
// groups that are large enough for further subdivision.
func applyGroupClustering(sqlDB *sql.DB, root db.Root, groups map[string][]db.File, input cluster.ClusterInput, parentID *string, ancestorNames map[string]struct{}, depth int) (int, error) {
	// Sort names for deterministic system creation order.
	names := make([]string, 0, len(groups))
	for n := range groups {
		names = append(names, n)
	}
	sort.Strings(names)

	total := 0
	for _, name := range names {
		members := groups[name]
		if len(members) == 0 {
			continue
		}
		// A single-file group is not worth its own system node — assign to parent.
		if len(members) < 2 && parentID != nil {
			n, _ := assignAll(sqlDB, members, parentID)
			total += n
			continue
		}
		// A group named the same as any ancestor creates uninformative nesting
		// (e.g. World > World, Editor > Pawn > Editor). Fold into parent instead.
		if _, forbidden := ancestorNames[name]; forbidden && parentID != nil {
			n, _ := assignAll(sqlDB, members, parentID)
			total += n
			continue
		}
		sysID := uuid.New().String()
		if err := db.UpsertSystem(sqlDB, db.System{
			ID:          sysID,
			WorkspaceID: root.WorkspaceID,
			Name:        name,
			ParentID:    parentID,
			Source:      "cluster",
			Depth:       depth,
		}); err != nil {
			return total, fmt.Errorf("upsert system %q depth %d: %w", name, depth, err)
		}

		if len(members) >= minClusterFiles && depth+1 < maxClusterDepth {
			// Build a new ancestor set that includes the current system name.
			childAncestors := make(map[string]struct{}, len(ancestorNames)+1)
			for k := range ancestorNames {
				childAncestors[k] = struct{}{}
			}
			childAncestors[name] = struct{}{}
			subInput := cluster.ClusterInput{
				Files:        members,
				Dependencies: input.Dependencies,
				TFIDF:        input.TFIDF,
				Cochange:     input.Cochange,
			}
			n, err := clusterLevel(sqlDB, root, subInput, &sysID, childAncestors, depth+1)
			total += n
			if err != nil {
				return total, err
			}
		} else {
			n, _ := assignAll(sqlDB, members, &sysID)
			total += n
		}
	}
	return total, nil
}

func buildExistingMap(sqlDB *sql.DB, rootID string) (map[string]db.File, error) {
	files, err := db.GetFilesByRoot(sqlDB, rootID)
	if err != nil {
		return nil, err
	}
	m := make(map[string]db.File, len(files))
	for _, f := range files {
		m[f.RelPath] = f
	}
	return m, nil
}

// buildImportDependencies scans all files for a root and creates IMPORTS dependencies.
// Called once after initial indexing when all file IDs are known.
// C# files use namespace-based resolution; all others use relative path resolution.
func buildImportDependencies(sqlDB *sql.DB, root db.Root) error {
	files, err := db.GetFilesByRoot(sqlDB, root.ID)
	if err != nil {
		return err
	}

	// Build relPath → fileID index for path-based import resolution (JS/TS/Go/Python).
	relToID := make(map[string]string, len(files))
	for _, f := range files {
		relToID[f.RelPath] = f.ID
		noExt := strings.TrimSuffix(f.RelPath, filepath.Ext(f.RelPath))
		relToID[noExt] = f.ID
	}

	// For C# files: first pass to build namespace → []fileID map.
	csNsToIDs := buildCSharpNamespaceMap(files)
	log.Printf("[indexer] C# namespace map: %d namespaces", len(csNsToIDs))

	for _, f := range files {
		if strings.HasSuffix(strings.ToLower(f.RelPath), ".cs") {
			if err := buildCSharpDependenciesForFile(sqlDB, root, f, csNsToIDs); err != nil {
				log.Printf("indexer: cs dependencies for %s: %v", f.RelPath, err)
			}
		} else {
			if err := rebuildDependenciesForFileWithIndex(sqlDB, root, f, relToID); err != nil {
				log.Printf("indexer: dependencies for %s: %v", f.RelPath, err)
			}
		}
	}
	return nil
}

// buildCSharpNamespaceMap parses all C# files and maps namespace → []fileID.
// Multiple files can declare the same namespace (partial classes, etc.).
func buildCSharpNamespaceMap(files []db.File) map[string][]string {
	nsToIDs := make(map[string][]string)
	for _, f := range files {
		if !strings.HasSuffix(strings.ToLower(f.RelPath), ".cs") {
			continue
		}
		result, err := parser.ParseFile(f.Path, f.RelPath)
		if err != nil || result == nil {
			continue
		}
		for _, imp := range result.Imports {
			if strings.HasPrefix(imp, "#ns:") {
				ns := strings.TrimPrefix(imp, "#ns:")
				nsToIDs[ns] = append(nsToIDs[ns], f.ID)
			}
		}
	}
	return nsToIDs
}

// buildCSharpDependenciesForFile creates IMPORTS dependencies for a single C# file
// by resolving its using directives against the namespace→fileID map.
func buildCSharpDependenciesForFile(sqlDB *sql.DB, root db.Root, f db.File, nsToIDs map[string][]string) error {
	result, err := parser.ParseFile(f.Path, f.RelPath)
	if err != nil {
		return err
	}
	if err := db.DeleteDependenciesByFile(sqlDB, f.ID); err != nil {
		return err
	}
	for _, imp := range result.Imports {
		if strings.HasPrefix(imp, "#ns:") {
			continue // own namespace declaration, not a dependency
		}
		dstIDs, ok := nsToIDs[imp]
		if !ok {
			continue // external namespace — no matching file in the project
		}
		for _, dstID := range dstIDs {
			if dstID == f.ID {
				continue // skip self-reference
			}
			d := db.Dependency{
				WorkspaceID:    root.WorkspaceID,
				Src:            f.ID,
				Dst:            dstID,
				SrcType:        "file",
				DstType:        "file",
				DependencyType: "IMPORTS",
				CreatedBy:      "parser",
			}
			if err := db.UpsertDependency(sqlDB, d); err != nil {
				log.Printf("indexer: upsert cs dependency %s→ns:%s: %v", f.RelPath, imp, err)
			}
		}
	}
	return nil
}

func rebuildDependenciesForFile(sqlDB *sql.DB, root db.Root, relPath string) error {
	files, err := db.GetFilesByRoot(sqlDB, root.ID)
	if err != nil {
		return err
	}
	f, err := db.GetFileByRelPath(sqlDB, root.ID, relPath)
	if err != nil || f == nil {
		return err
	}
	if strings.HasSuffix(strings.ToLower(relPath), ".cs") {
		csNsToIDs := buildCSharpNamespaceMap(files)
		return buildCSharpDependenciesForFile(sqlDB, root, *f, csNsToIDs)
	}
	relToID := make(map[string]string, len(files))
	for _, f := range files {
		relToID[f.RelPath] = f.ID
		noExt := strings.TrimSuffix(f.RelPath, filepath.Ext(f.RelPath))
		relToID[noExt] = f.ID
	}
	return rebuildDependenciesForFileWithIndex(sqlDB, root, *f, relToID)
}

func rebuildDependenciesForFileWithIndex(sqlDB *sql.DB, root db.Root, f db.File, relToID map[string]string) error {
	result, err := parser.ParseFile(f.Path, f.RelPath)
	if err != nil {
		return err
	}
	if err := db.DeleteDependenciesByFile(sqlDB, f.ID); err != nil {
		return err
	}
	for _, imp := range result.Imports {
		dstID, ok := relToID[imp]
		if !ok {
			// try with common extensions
			for _, ext := range []string{".ts", ".tsx", ".js", ".jsx", ".py", ".go"} {
				if id, found := relToID[imp+ext]; found {
					dstID = id
					ok = true
					break
				}
			}
		}
		if !ok {
			continue // external module — skip
		}
		d := db.Dependency{
			WorkspaceID:    root.WorkspaceID,
			Src:            f.ID,
			Dst:            dstID,
			SrcType:        "file",
			DstType:        "file",
			DependencyType: "IMPORTS",
			CreatedBy:      "parser",
		}
		if err := db.UpsertDependency(sqlDB, d); err != nil {
			log.Printf("indexer: upsert dependency %s→%s: %v", f.RelPath, imp, err)
		}
	}
	return nil
}
