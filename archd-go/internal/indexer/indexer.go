// Package indexer orchestrates the full file walk for a root directory:
// parses each file, writes symbols and import edges, then runs Louvain clustering.
// On subsequent runs it only re-parses files whose mtime has changed.
package indexer

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"axiom.local/archd/internal/activity"
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

var livingTraceCounter atomic.Uint64

func nextLivingTraceID() string {
	return fmt.Sprintf("L%06d", livingTraceCounter.Add(1))
}

var sourceExts = map[string]bool{
	".ts": true, ".tsx": true, ".js": true, ".mjs": true, ".cjs": true,
	".jsx": true, ".py": true, ".go": true, ".rs": true, ".cs": true,
	".cpp": true, ".cc": true, ".cxx": true, ".hpp": true, ".hxx": true, ".rb": true, ".java": true,
}

var documentExts = map[string]bool{
	".md": true, ".mdx": true, ".txt": true, ".rst": true, ".adoc": true,
}

// IsSupportedSourceFile is the single file-admission contract shared by the
// initial index, reconciliation, and the live watcher. The watcher used to own
// a shorter copy of this table, so files could exist after a cold index but
// silently stop updating during the same session.
func IsSupportedSourceFile(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return sourceExts[ext] || documentExts[ext]
}

// IsDocumentationFile marks readable repository context that belongs in the
// Documents library, never in clustering or on the architecture Floor.
func IsDocumentationFile(path string) bool {
	return documentExts[strings.ToLower(filepath.Ext(path))]
}

// ClassifierVersion invalidates persisted inferred systems when the membership
// contract changes. Version 4 removes documentation from architectural
// clustering while keeping it indexed for the Documents library.
const ClassifierVersion = 4

// IndexRoot walks the root directory and indexes all source files.
// After parsing, runs Louvain clustering and assigns files to cluster systems.
// ignoredPaths is a list of absolute path globs (e.g. "C:\proj\Library\**") to skip.
func IndexRoot(sqlDB *sql.DB, h *hub.Hub, root db.Root, ignoredPaths []string) error {
	log.Printf("[indexer] IndexRoot called: root=%s ignoredPaths=%v", root.Path, ignoredPaths)

	paths, err := collectSourcePaths(root, ignoredPaths)
	if err != nil {
		return err
	}

	total := len(paths)
	log.Printf("[indexer] root %s - %d source files after ignore filtering", root.Path, total)

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

	// Cluster files by import topology and assign to systems. The initial
	// index establishes the baseline, so its systems are not drift.
	if err := clusterAndAssign(sqlDB, root, false); err != nil {
		log.Printf("indexer: cluster: %v", err)
	}

	if err := db.MarkRootIndexed(sqlDB, root.ID, ClassifierVersion); err != nil {
		log.Printf("indexer: mark indexed: %v", err)
	}

	h.BroadcastIndexingComplete(root.WorkspaceID)
	return nil
}

// ClusterOnly rebuilds derived semantic evidence from the already-indexed
// files, then runs classification. Persisted imports/calls may have been
// produced by an older resolver, so classifying them without this refresh can
// turn a connected project into an arbitrary graph of isolated files.
func ClusterOnly(sqlDB *sql.DB, root db.Root) error {
	if err := rebuildSemanticEvidence(sqlDB, root); err != nil {
		return fmt.Errorf("rebuild semantic evidence: %w", err)
	}
	// A classifier-contract migration reshapes systems wholesale. That is a
	// change in how Axiom reads the code, not a change in the code, so it must
	// never appear in the user's delta as if their agents did it.
	if err := clusterAndAssign(sqlDB, root, false); err != nil {
		return err
	}
	return db.MarkRootClassifierVersion(sqlDB, root.ID, ClassifierVersion)
}

func rebuildSemanticEvidence(sqlDB *sql.DB, root db.Root) error {
	if err := buildImportDependencies(sqlDB, root); err != nil {
		return err
	}
	return rebuildAllCallGraph(sqlDB, root)
}

func rebuildAllCallGraph(sqlDB *sql.DB, root db.Root) error {
	files, err := db.GetFilesByRoot(sqlDB, root.ID)
	if err != nil {
		return err
	}
	var rawCalls sync.Map
	for _, file := range files {
		result, err := parser.ParseFile(file.Path, file.RelPath)
		if err != nil {
			return fmt.Errorf("parse %s: %w", file.RelPath, err)
		}
		// Store empty call sets too, so evidence removed since the old index is
		// removed from call_graph rather than surviving the migration.
		rawCalls.Store(file.ID, result.Calls)
	}
	return buildCallGraph(sqlDB, root, &rawCalls)
}

func projectFileDependencies(sqlDB *sql.DB, rootID string) ([]db.Dependency, error) {
	all, err := db.GetDependenciesByRoot(sqlDB, rootID)
	if err != nil {
		return nil, err
	}
	result := make([]db.Dependency, 0, len(all))
	for _, dep := range all {
		if dep.SrcType == "file" && dep.DstType == "file" && dep.DependencyType == "IMPORTS" {
			result = append(result, dep)
		}
	}
	return result, nil
}

func symbolNameSet(symbols []db.Symbol) map[string]struct{} {
	result := make(map[string]struct{}, len(symbols))
	for _, symbol := range symbols {
		result[symbol.Name] = struct{}{}
	}
	return result
}

func symbolResolutionChanged(before, after []db.Symbol) bool {
	left := symbolNameSet(before)
	right := symbolNameSet(after)
	if len(left) != len(right) {
		return true
	}
	for name := range left {
		if _, exists := right[name]; !exists {
			return true
		}
	}
	return false
}

func symbolHashesByName(symbols []db.Symbol) map[string][]string {
	result := make(map[string][]string)
	for _, symbol := range symbols {
		if symbol.Kind != "function" && symbol.Kind != "method" {
			continue
		}
		result[symbol.Name] = append(result[symbol.Name], symbol.BodyHash)
	}
	for name := range result {
		sort.Strings(result[name])
	}
	return result
}

// changedSymbolTouches returns stable file+symbol identities for functions
// whose definitions actually changed. Relationship updates use this evidence
// instead of promoting every retained call after any file write.
func changedSymbolTouches(fileID string, before, after []db.Symbol, contentChanged bool) map[string]struct{} {
	left := symbolHashesByName(before)
	right := symbolHashesByName(after)
	names := make(map[string]struct{}, len(left)+len(right))
	for name := range left {
		names[name] = struct{}{}
	}
	for name := range right {
		names[name] = struct{}{}
	}
	result := make(map[string]struct{})
	for name := range names {
		if !slices.Equal(left[name], right[name]) {
			result[touchedSymbolKey(fileID, name)] = struct{}{}
		}
	}
	// Calls outside a named function carry an empty CallerSymbol. They have no
	// symbol body to hash, so a real file edit is the narrowest available proof.
	if contentChanged {
		result[touchedSymbolKey(fileID, "")] = struct{}{}
	}
	return result
}

// ReindexFile re-parses a single file and updates its symbols and edges.
// Called by the watcher on file change events.
func ReindexFile(sqlDB *sql.DB, h *hub.Hub, root db.Root, absPath string) error {
	traceID := nextLivingTraceID()
	relPath, _ := filepath.Rel(root.Path, absPath)
	relPath = filepath.ToSlash(relPath)
	existing, _ := buildExistingMap(sqlDB, root.ID)

	// Snapshot the pre-edit state for activity weighting (live edit tracking).
	var prev *db.File
	var prevSyms []db.Symbol
	if p, ok := existing[relPath]; ok {
		prev = &p
		prevSyms, _ = db.GetSymbolsByFile(sqlDB, p.ID)
	}
	beforeDeps, err := projectFileDependencies(sqlDB, root.ID)
	if err != nil {
		return err
	}
	beforeCalls, err := db.GetCallEdgesByRoot(sqlDB, root.ID)
	if err != nil {
		return err
	}

	if err := indexOneFile(sqlDB, root, relPath, absPath, existing, nil); err != nil {
		return err
	}
	file, err := db.GetFileByRelPath(sqlDB, root.ID, relPath)
	if err != nil || file == nil {
		return err
	}
	newSyms, _ := db.GetSymbolsByFile(sqlDB, file.ID)
	actor, contentChanged := recordActivity(sqlDB, root.WorkspaceID, prev, prevSyms, file, absPath)
	resolutionChanged := prev == nil || symbolResolutionChanged(prevSyms, newSyms)

	// A new file can satisfy imports that were previously external/unresolved.
	// Existing-file edits only need their own outgoing import set rebuilt.
	if prev == nil {
		if err := buildImportDependencies(sqlDB, root); err != nil {
			log.Printf("indexer: rebuild project dependencies after creating %s: %v", relPath, err)
		}
	} else if err := rebuildDependenciesForFile(sqlDB, root, relPath); err != nil {
		log.Printf("indexer: rebuild dependencies for %s: %v", relPath, err)
	}

	// Adding/removing a symbol can change resolution for callers anywhere in
	// the project. A body-only change keeps topology stable and only requires
	// the edited caller's raw call sites to be refreshed.
	if resolutionChanged {
		if err := rebuildAllCallGraph(sqlDB, root); err != nil {
			log.Printf("indexer: rebuild project call graph after %s: %v", relPath, err)
		}
	} else if err := rebuildCallGraphForFile(sqlDB, root, *file); err != nil {
		log.Printf("indexer: rebuild call graph for %s: %v", relPath, err)
	}

	afterDeps, err := projectFileDependencies(sqlDB, root.ID)
	if err != nil {
		return err
	}
	afterCalls, err := db.GetCallEdgesByRoot(sqlDB, root.ID)
	if err != nil {
		return err
	}
	touchedSymbols := changedSymbolTouches(file.ID, prevSyms, newSyms, contentChanged)
	relationships := diffRelationshipChanges(
		beforeDeps, afterDeps, beforeCalls, afterCalls, touchedSymbols,
	)
	for i := range relationships {
		relationships[i].TraceID = traceID
		relationships[i].OriginID = file.ID
	}
	touchedNames := make([]string, 0, len(touchedSymbols))
	for key := range touchedSymbols {
		_, name, _ := strings.Cut(key, "\x00")
		if name == "" {
			name = "<module>"
		}
		touchedNames = append(touchedNames, name)
	}
	sort.Strings(touchedNames)

	// Reconcile planned UML elements against the new reality - this is how
	// the user's drawn boxes turn green as the agent builds them.
	if changed, err := db.ReconcilePlanned(sqlDB, root.WorkspaceID); err == nil {
		for _, p := range changed {
			log.Printf("[planned] %q → %s (%s)", p.Name, p.Status, p.DeclaredPath)
			h.BroadcastPatch(map[string]any{"type": "planned:upserted", "payload": p})
		}
	}

	// Broadcast with the churn display value freshly ranked against the
	// workspace so the canvas heat border moves live.
	if norm, err := normalizedChurn(sqlDB, root.WorkspaceID, file.ID); err == nil {
		file.ChurnScore = norm
	}
	change := "updated"
	if prev == nil {
		change = "created"
	}

	// Journal the same facts we are about to broadcast, so the Morning Delta
	// can show this change to a user who was not watching. A pure no-op save
	// (unchanged content) is not an architectural fact and is not journaled.
	if actor == "" {
		actor = activity.ActorFor(root.WorkspaceID)
	}
	if contentChanged || prev == nil {
		labeler := newSystemLabeler(sqlDB, root)
		kind := db.EventFileUpdated
		if prev == nil {
			kind = db.EventFileCreated
		}
		journalFileChange(sqlDB, root, labeler, file, kind, actor, traceID)
		journalRelationships(sqlDB, root, labeler, relationships, actor, traceID)
	}

	h.BroadcastPatch(map[string]any{
		"type": "file:updated",
		"payload": FileUpdatePatch{
			File: file, Change: change, Animate: contentChanged || prev == nil, TraceID: traceID,
		},
	})
	log.Printf(
		"[living-flow] stage=backend-save trace=%s file=%s change=%s contentChanged=%t touched=%v relationships=%d",
		traceID, relPath, change, contentChanged, touchedNames, len(relationships),
	)
	for _, relationship := range relationships {
		log.Printf(
			"[living-flow] stage=backend-emit trace=%s origin=%s relationship=%s/%s semantic=%s->%s caller=%q callee=%q animate=%t",
			traceID, relationship.OriginID, relationship.Relationship, relationship.Change,
			relationship.Src, relationship.Dst,
			relationship.CallerSymbol, relationship.CalleeSymbol, relationship.Animate,
		)
		h.BroadcastPatch(map[string]any{
			"type": "relationship:changed", "payload": relationship,
		})
	}
	return nil
}

// RemoveFile removes one watcher-deleted source file and broadcasts the
// relationship exits before the file tombstone, allowing the renderer to draw
// red directional pulses while both endpoints still exist on the Floor.
func RemoveFile(sqlDB *sql.DB, h *hub.Hub, root db.Root, absPath string) error {
	traceID := nextLivingTraceID()
	relPath, _ := filepath.Rel(root.Path, absPath)
	relPath = filepath.ToSlash(relPath)
	file, err := db.GetFileByRelPath(sqlDB, root.ID, relPath)
	if err != nil || file == nil {
		return err
	}

	beforeDeps, err := projectFileDependencies(sqlDB, root.ID)
	if err != nil {
		return err
	}
	beforeCalls, err := db.GetCallEdgesByRoot(sqlDB, root.ID)
	if err != nil {
		return err
	}

	// Capture labels while the file and its membership still exist - the
	// journal has to be able to describe what was lost after it is gone.
	labeler := newSystemLabeler(sqlDB, root)
	lostSystemID, lostSystemName := labeler.systemOf(file.ID)

	if err := db.DeleteFileByID(sqlDB, file.ID); err != nil {
		return err
	}
	if err := buildImportDependencies(sqlDB, root); err != nil {
		return fmt.Errorf("rebuild imports after deleting %s: %w", relPath, err)
	}
	if err := rebuildAllCallGraph(sqlDB, root); err != nil {
		return fmt.Errorf("rebuild calls after deleting %s: %w", relPath, err)
	}
	afterDeps, err := projectFileDependencies(sqlDB, root.ID)
	if err != nil {
		return err
	}
	afterCalls, err := db.GetCallEdgesByRoot(sqlDB, root.ID)
	if err != nil {
		return err
	}

	relationships := diffRelationshipChanges(
		beforeDeps, afterDeps, beforeCalls, afterCalls, nil,
	)
	log.Printf(
		"[living-flow] stage=backend-delete trace=%s file=%s relationships=%d",
		traceID, relPath, len(relationships),
	)
	for i := range relationships {
		relationships[i].TraceID = traceID
		relationships[i].OriginID = file.ID
	}

	actor := activity.ActorFor(root.WorkspaceID)
	journalRelationships(sqlDB, root, labeler, relationships, actor, traceID)
	journalFileDeleted(sqlDB, root, lostSystemID, lostSystemName, file, actor, traceID)

	for _, relationship := range relationships {
		log.Printf(
			"[living-flow] stage=backend-emit trace=%s origin=%s relationship=%s/%s semantic=%s->%s caller=%q callee=%q animate=%t",
			traceID, relationship.OriginID, relationship.Relationship, relationship.Change,
			relationship.Src, relationship.Dst,
			relationship.CallerSymbol, relationship.CalleeSymbol, relationship.Animate,
		)
		h.BroadcastPatch(map[string]any{
			"type": "relationship:changed", "payload": relationship,
		})
	}
	h.BroadcastPatch(map[string]any{
		"type": "file:deleted",
		"payload": FileDeletePatch{
			ID: file.ID, RelPath: file.RelPath, TraceID: traceID,
		},
	})
	return nil
}

// recordActivity turns one watcher-detected save into a weighted edit burst
// (see internal/activity). No-op saves (unchanged content hash) are dropped.
func recordActivity(sqlDB *sql.DB, workspaceID string, prev *db.File, prevSyms []db.Symbol, file *db.File, absPath string) (actor string, contentChanged bool) {
	raw, err := os.ReadFile(absPath)
	if err != nil {
		return "", false
	}
	sum := sha256.Sum256(raw)
	hash := hex.EncodeToString(sum[:])

	prevHash, prevLines, prevScore := "", 0, 0.0
	var prevAt int64
	if prev != nil {
		prevHash, prevLines = prev.ContentHash, prev.LineCount
		prevScore, prevAt = prev.ActivityScore, prev.ActivityAt
	}
	if hash == prevHash {
		return "", false // formatter/editor no-op save - not activity
	}

	newSyms, _ := db.GetSymbolsByFile(sqlDB, file.ID)
	symDelta := diffSymbols(prevSyms, newSyms)
	linesDelta := file.LineCount - prevLines
	if linesDelta < 0 {
		linesDelta = -linesDelta
	}
	actor = activity.ActorFor(workspaceID)
	weight := activity.Weight(linesDelta, symDelta, true, actor)

	newScore, now, err := activity.RecordBurst(sqlDB, workspaceID, file.ID, actor, weight, linesDelta, symDelta, prevScore, prevAt)
	if err != nil {
		log.Printf("indexer: record activity for %s: %v", file.RelPath, err)
		return actor, true
	}
	if err := db.UpdateFileActivity(sqlDB, file.ID, newScore, now, hash); err != nil {
		log.Printf("indexer: persist activity for %s: %v", file.RelPath, err)
		return actor, true
	}
	file.ActivityScore, file.ActivityAt, file.ContentHash = newScore, now, hash
	log.Printf("[activity] %s burst: actor=%s weight=%.2f (Δlines=%d Δsymbols=%d) score=%.2f",
		file.RelPath, actor, weight, linesDelta, symDelta, newScore)
	return actor, true
}

// diffSymbols counts added, removed, and moved symbols between two parses.
// Keyed by name+kind; a surviving symbol whose line span changed counts once.
func diffSymbols(before, after []db.Symbol) int {
	key := func(s db.Symbol) string { return s.Kind + "\x00" + s.Name }
	old := make(map[string][2]int, len(before))
	for _, s := range before {
		old[key(s)] = [2]int{s.LineStart, s.LineEnd}
	}
	delta := 0
	seen := make(map[string]bool, len(after))
	for _, s := range after {
		k := key(s)
		seen[k] = true
		if span, ok := old[k]; !ok {
			delta++ // added
		} else if span[0] != s.LineStart || span[1] != s.LineEnd {
			delta++ // moved/resized - its body changed or code shifted through it
		}
	}
	for k := range old {
		if !seen[k] {
			delta++ // removed
		}
	}
	return delta
}

// normalizedChurn ranks one file's decayed activity against the workspace.
func normalizedChurn(sqlDB *sql.DB, workspaceID, fileID string) (float64, error) {
	files, err := db.GetFiles(sqlDB, workspaceID)
	if err != nil {
		return 0, err
	}
	entries := make([]activity.ScoreEntry, len(files))
	for i, f := range files {
		entries[i] = activity.ScoreEntry{ID: f.ID, Score: f.ActivityScore, AtMs: f.ActivityAt}
	}
	return activity.Normalize(entries, time.Now().UnixMilli())[fileID], nil
}

// ─── Shape inference (UML_UX_PLAN.md Rev 2b: shape = semantic role) ────────────
//
// Shape is what a node IS, not where it came from. Inferred each parse;
// files.shape_override (user/agent) always wins at display time. Guardrail:
// when unsure, it's a plain box - a wrong box is invisible, a wrong cylinder
// is a lie.

// Shape is only inferred from STRUCTURE the parser proved (the symbol table)
// - never from filename/path heuristics; guessing "cylinder" off a directory
// name is exactly the dumb-tool behavior Axiom exists to replace. Cylinder/
// hexagon exist on live files only via explicit shape_override (user/agent),
// where they are declared, not guessed.
func inferShape(relPath string, symbols []db.Symbol) (shape, displayName string) {
	base := strings.ToLower(relPath)
	if i := strings.LastIndex(base, "/"); i >= 0 {
		base = base[i+1:]
	}
	if i := strings.Index(base, "."); i > 0 {
		base = base[:i]
	}
	baseNorm := strings.NewReplacer("_", "", "-", "").Replace(base)

	// class-first: exactly one class, or a class whose name ≈ filename.
	var classes []db.Symbol
	for _, s := range symbols {
		if strings.EqualFold(s.Kind, "class") {
			classes = append(classes, s)
		}
	}
	classFirst := ""
	if len(classes) == 1 {
		classFirst = classes[0].Name
	} else {
		for _, c := range classes {
			if strings.EqualFold(strings.NewReplacer("_", "", "-", "").Replace(c.Name), baseNorm) {
				classFirst = c.Name
				break
			}
		}
	}

	if classFirst != "" {
		return "class", classFirst
	}
	return "", ""
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

	shape, displayName := inferShape(relPath, result.Symbols)
	f := db.File{
		ID:          fileID,
		RootID:      root.ID,
		Path:        absPath,
		RelPath:     relPath,
		Language:    result.Language,
		SystemID:    nil, // assigned after clustering
		LineCount:   result.LineCount,
		Shape:       shape,
		DisplayName: displayName,
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
			continue // single-char pure-read (loop counters etc.) - noise
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
//     Any name NOT in this index is a built-in, stdlib, or external call - naturally filtered.
//
//  2. Unique match (high confidence): exactly one project file defines the name → record the call.
//
//  3. Ambiguous match: multiple files define the same name → use import/using relationships as a
//     tiebreaker. If imports narrow it to one file, record that. Otherwise skip to avoid noise.
//
// This deliberately avoids language-specific logic so it extends to any language Axiom supports.
func rebuildCallGraphForFile(sqlDB *sql.DB, root db.Root, file db.File) error {
	result, err := parser.ParseFile(file.Path, file.RelPath)
	if err != nil {
		return err
	}
	var rawCalls sync.Map
	// Store even an empty slice: removing the final call from a function must
	// clear the previous caller rows and emit a red relationship delta.
	rawCalls.Store(file.ID, result.Calls)
	return buildCallGraph(sqlDB, root, &rawCalls)
}

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
		imported := fileImports[callerFileID] // may be nil - that's fine

		for _, call := range calls {
			candidates := symbolToFiles[call.CalleeName]
			if len(candidates) == 0 {
				continue // not a project symbol - built-in or external
			}

			// Remove self-calls. Allocate a new slice - candidates shares its
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
				// Unique match - only one project file defines this name.
				resolved = filtered
			default:
				// Ambiguous - try to narrow using import relationships.
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

// liveClusterMinFiles keeps a lone new file visible at the Floor root. One
// file is not enough evidence for an architectural system; the next write
// burst can classify it once semantic relationship evidence exists.
const liveClusterMinFiles = 2

type clusterPlan struct {
	systems            map[string]db.System
	assignments        map[string]*string
	protectedSystemIDs map[string]struct{}
}

func newClusterPlan(files []db.File, protectedSystemIDs map[string]struct{}) *clusterPlan {
	assignments := make(map[string]*string, len(files))
	for _, file := range files {
		assignments[file.ID] = nil
	}
	return &clusterPlan{
		systems:            make(map[string]db.System),
		assignments:        assignments,
		protectedSystemIDs: protectedSystemIDs,
	}
}

func (p *clusterPlan) assign(files []db.File, systemID *string) int {
	for _, file := range files {
		p.assignments[file.ID] = systemID
	}
	if systemID == nil {
		return 0
	}
	return len(files)
}

func stableClusterSystemID(workspaceID string, parentID *string, name string) string {
	parent := "root"
	if parentID != nil {
		parent = *parentID
	}
	canonical := strings.ToLower(strings.TrimSpace(name))
	sum := sha256.Sum256([]byte(workspaceID + "\x00" + parent + "\x00" + canonical))
	return "cluster_" + hex.EncodeToString(sum[:12])
}

// clusterScope separates classifier-owned reality from authored intent.
// A file is eligible only when it is unassigned or every system in its
// ancestry is classifier-owned. A cluster nested under a user/agent system is
// protected together with that authored boundary.
func clusterScope(files []db.File, systems []db.System) (managed []db.File, pruneableSystemIDs map[string]struct{}) {
	byID := make(map[string]db.System, len(systems))
	for _, system := range systems {
		byID[system.ID] = system
	}

	autoMemo := make(map[string]bool, len(systems))
	var isAutoSystem func(string, map[string]struct{}) bool
	isAutoSystem = func(id string, visiting map[string]struct{}) bool {
		if value, ok := autoMemo[id]; ok {
			return value
		}
		system, ok := byID[id]
		if !ok || (system.Source != "cluster" && system.Source != "directory") {
			autoMemo[id] = false
			return false
		}
		if _, cycle := visiting[id]; cycle {
			autoMemo[id] = false
			return false
		}
		if system.ParentID == nil {
			autoMemo[id] = true
			return true
		}
		visiting[id] = struct{}{}
		auto := isAutoSystem(*system.ParentID, visiting)
		delete(visiting, id)
		autoMemo[id] = auto
		return auto
	}

	pruneableSystemIDs = make(map[string]struct{})
	for _, system := range systems {
		if isAutoSystem(system.ID, make(map[string]struct{})) {
			pruneableSystemIDs[system.ID] = struct{}{}
		}
	}

	for _, file := range files {
		if IsDocumentationFile(file.RelPath) {
			continue
		}
		if file.SystemID == nil || isAutoSystem(*file.SystemID, make(map[string]struct{})) {
			managed = append(managed, file)
		}
	}
	return managed, pruneableSystemIDs
}

// ClusterLive runs only when a watcher burst introduced unclassified files and
// there is enough evidence to form a useful group. Ordinary edits never
// reshuffle an already-classified architecture.
func ClusterLive(sqlDB *sql.DB, root db.Root) (bool, error) {
	files, err := db.GetFilesByRoot(sqlDB, root.ID)
	if err != nil {
		return false, err
	}
	systems, err := db.GetSystems(sqlDB, root.WorkspaceID)
	if err != nil {
		return false, err
	}
	managed, _ := clusterScope(files, systems)
	hasUnclassified := false
	for _, file := range managed {
		if file.SystemID == nil {
			hasUnclassified = true
			break
		}
	}
	if !hasUnclassified || len(managed) < liveClusterMinFiles {
		return false, nil
	}
	// Live re-clustering happens because real new code arrived, so a system
	// born here is genuine architectural drift worth reviewing.
	if err := clusterAndAssign(sqlDB, root, true); err != nil {
		return false, err
	}
	return true, nil
}

// clusterAndAssign runs hierarchical multi-signal clustering on the indexed files.
// It builds TF-IDF vectors and git co-change scores once, then recursively
// subdivides large clusters using all signals combined.
// journalDrift is false for baseline and migration passes, which reshape
// systems wholesale for reasons that have nothing to do with the user's code.
func clusterAndAssign(sqlDB *sql.DB, root db.Root, journalDrift bool) error {
	log.Printf("[cluster] clusterAndAssign START workspace=%s root=%s", root.WorkspaceID, root.Path)

	files, err := db.GetFilesByRoot(sqlDB, root.ID)
	if err != nil {
		return err
	}
	for i := range files {
		if !IsDocumentationFile(files[i].RelPath) || files[i].SystemID == nil {
			continue
		}
		if err := db.ClearFileSystem(sqlDB, files[i].ID); err != nil {
			return fmt.Errorf("detach document %s from architecture: %w", files[i].RelPath, err)
		}
		files[i].SystemID = nil
	}
	systems, err := db.GetSystems(sqlDB, root.WorkspaceID)
	if err != nil {
		return err
	}
	managedFiles, pruneableSystemIDs := clusterScope(files, systems)
	log.Printf("[cluster] got %d files for root (%d classifier-managed)", len(files), len(managedFiles))

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
		tfidf = cluster.BuildTFIDF(managedFiles, fileSymbols)
		log.Printf("[cluster] TF-IDF built for %d files", len(tfidf))
	} else {
		log.Printf("[cluster] TF-IDF disabled (no symbols)")
	}

	// Build co-change matrix from git history (skipped gracefully if git unavailable).
	cochange := cluster.BuildCochange(root.Path, managedFiles)
	log.Printf("[cluster] co-change matrix: %d pairs", len(cochange))

	// Sample first few file paths for debugging.
	sampleN := 5
	if len(managedFiles) < sampleN {
		sampleN = len(managedFiles)
	}
	for i := 0; i < sampleN; i++ {
		log.Printf("[cluster]   sample file[%d]: %s", i, managedFiles[i].RelPath)
	}

	input := cluster.ClusterInput{
		Files:        managedFiles,
		Dependencies: dependencies,
		TFIDF:        tfidf,
		Cochange:     cochange,
	}

	protectedSystemIDs := make(map[string]struct{})
	for _, system := range systems {
		if _, pruneable := pruneableSystemIDs[system.ID]; !pruneable {
			protectedSystemIDs[system.ID] = struct{}{}
		}
	}
	plan := newClusterPlan(managedFiles, protectedSystemIDs)
	assigned, err := clusterLevel(plan, root, input, nil, map[string]struct{}{}, 0)
	if err != nil {
		return err
	}

	plannedSystems := make([]db.System, 0, len(plan.systems))
	for _, system := range plan.systems {
		plannedSystems = append(plannedSystems, system)
		delete(pruneableSystemIDs, system.ID)
	}
	sort.Slice(plannedSystems, func(i, j int) bool {
		if plannedSystems[i].Depth != plannedSystems[j].Depth {
			return plannedSystems[i].Depth < plannedSystems[j].Depth
		}
		if plannedSystems[i].Name != plannedSystems[j].Name {
			return plannedSystems[i].Name < plannedSystems[j].Name
		}
		return plannedSystems[i].ID < plannedSystems[j].ID
	})

	assignments := make([]db.FileSystemAssignment, 0, len(plan.assignments))
	for fileID, systemID := range plan.assignments {
		assignments = append(assignments, db.FileSystemAssignment{FileID: fileID, SystemID: systemID})
	}
	sort.Slice(assignments, func(i, j int) bool { return assignments[i].FileID < assignments[j].FileID })

	staleSystemIDs := make([]string, 0, len(pruneableSystemIDs))
	for id := range pruneableSystemIDs {
		staleSystemIDs = append(staleSystemIDs, id)
	}
	sort.Strings(staleSystemIDs)

	if err := db.ApplyClusterPlan(sqlDB, root.WorkspaceID, plannedSystems, assignments, staleSystemIDs); err != nil {
		return fmt.Errorf("apply cluster plan: %w", err)
	}
	if journalDrift {
		journalSystemPlan(sqlDB, root, systems, plannedSystems, staleSystemIDs)
	}
	log.Printf("[cluster] clusterAndAssign DONE: %d/%d managed files assigned, %d stable systems, %d stale removed",
		assigned, len(managedFiles), len(plannedSystems), len(staleSystemIDs))
	return nil
}

// clusterLevel recursively discovers semantic communities from dependency
// topology, symbol similarity, and git co-change. Filesystem directories are
// deliberately absent: moving files cannot alter architectural membership.
func clusterLevel(plan *clusterPlan, root db.Root, input cluster.ClusterInput, parentID *string, ancestorNames map[string]struct{}, depth int) (int, error) {
	files := input.Files
	if len(files) == 0 {
		return 0, nil
	}

	log.Printf("[cluster] clusterLevel depth=%d files=%d parentID=%v", depth, len(files), parentID != nil)

	// Too small to subdivide or at depth cap - assign directly to parent.
	if (len(files) < minClusterFiles && parentID != nil) || depth >= maxClusterDepth {
		log.Printf("[cluster] depth=%d: too small (%d files) or at depth cap - assigning directly to parent", depth, len(files))
		return assignAll(plan, files, parentID)
	}

	return clusterByLouvain(plan, root, input, parentID, ancestorNames, depth)
}

// clusterByLouvain runs semantic Louvain and names each resulting community
// without allowing naming collisions to merge distinct communities.
func clusterByLouvain(plan *clusterPlan, root db.Root, input cluster.ClusterInput, parentID *string, ancestorNames map[string]struct{}, depth int) (int, error) {
	clusterMap := cluster.Cluster(input)

	rawGroups := make(map[int][]db.File)
	for _, f := range input.Files {
		rawGroups[clusterMap[f.ID]] = append(rawGroups[clusterMap[f.ID]], f)
	}

	if len(rawGroups) <= 1 && parentID != nil {
		return assignAll(plan, input.Files, parentID)
	}

	groupIDs := make([]int, 0, len(rawGroups))
	for groupID := range rawGroups {
		groupIDs = append(groupIDs, groupID)
	}
	sort.Ints(groupIDs)
	named := make(map[string][]db.File, len(rawGroups))
	nameCounts := make(map[string]int)
	for _, groupID := range groupIDs {
		members := rawGroups[groupID]
		baseName := cluster.NameCluster(members, input.TFIDF)
		nameCounts[baseName]++
		name := baseName
		if nameCounts[baseName] > 1 {
			name = fmt.Sprintf("%s %d", baseName, nameCounts[baseName])
		}
		named[name] = members
	}

	if len(named) <= 1 && parentID != nil {
		return assignAll(plan, input.Files, parentID)
	}

	log.Printf("[cluster] depth=%d louvain: %d groups from %d files", depth, len(named), len(input.Files))
	return applyGroupClustering(plan, root, named, input, parentID, ancestorNames, depth)
}

// ─── Clustering helpers ────────────────────────────────────────────────────────

// assignAll records every assignment in the in-memory plan. Database writes
// happen only after the complete hierarchy has been computed.
func assignAll(plan *clusterPlan, files []db.File, sysID *string) (int, error) {
	return plan.assign(files, sysID), nil
}

// applyGroupClustering creates one system per named group and recurses into
// groups that are large enough for further subdivision.
func applyGroupClustering(plan *clusterPlan, root db.Root, groups map[string][]db.File, input cluster.ClusterInput, parentID *string, ancestorNames map[string]struct{}, depth int) (int, error) {
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
		// A single file is not architectural evidence. Keep it directly in the
		// current scope (or at the Floor root) instead of inventing a system.
		if len(members) < 2 {
			n, _ := assignAll(plan, members, parentID)
			total += n
			continue
		}
		// A group named the same as any ancestor creates uninformative nesting
		// (e.g. World > World, Editor > Pawn > Editor). Fold into parent instead.
		if _, forbidden := ancestorNames[name]; forbidden && parentID != nil {
			n, _ := assignAll(plan, members, parentID)
			total += n
			continue
		}
		sysID := stableClusterSystemID(root.WorkspaceID, parentID, name)
		if _, protected := plan.protectedSystemIDs[sysID]; protected {
			// A user confirmed this exact inferred boundary. New matching files
			// may join it, but the classifier can never rewrite or prune it.
			n, _ := assignAll(plan, members, &sysID)
			total += n
			continue
		}
		plan.systems[sysID] = db.System{
			ID:          sysID,
			WorkspaceID: root.WorkspaceID,
			Name:        name,
			ParentID:    parentID,
			Source:      "cluster",
			Depth:       depth,
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
			n, err := clusterLevel(plan, root, subInput, &sysID, childAncestors, depth+1)
			total += n
			if err != nil {
				return total, err
			}
		} else {
			n, _ := assignAll(plan, members, &sysID)
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
	relToID := buildImportPathIndex(files)

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
	if err := db.DeleteOutgoingDependenciesByFile(sqlDB, f.ID); err != nil {
		return err
	}
	for _, imp := range result.Imports {
		if strings.HasPrefix(imp, "#ns:") {
			continue // own namespace declaration, not a dependency
		}
		dstIDs, ok := nsToIDs[imp]
		if !ok {
			continue // external namespace - no matching file in the project
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
	relToID := buildImportPathIndex(files)
	return rebuildDependenciesForFileWithIndex(sqlDB, root, *f, relToID)
}

func buildImportPathIndex(files []db.File) map[string]string {
	index := make(map[string]string, len(files)*4)
	for _, file := range files {
		relPath := filepath.ToSlash(filepath.Clean(file.RelPath))
		noExt := strings.TrimSuffix(relPath, filepath.Ext(relPath))
		index[relPath] = file.ID
		index[noExt] = file.ID

		if strings.EqualFold(filepath.Ext(relPath), ".py") {
			modulePath := noExt
			if strings.EqualFold(filepath.Base(noExt), "__init__") {
				modulePath = filepath.ToSlash(filepath.Dir(noExt))
				if modulePath == "." {
					modulePath = ""
				}
			}
			if modulePath != "" {
				index[modulePath] = file.ID
				index[strings.ReplaceAll(modulePath, "/", ".")] = file.ID
			}
		}
	}
	return index
}

func resolveImportFileID(file db.File, imported string, index map[string]string) (string, bool) {
	spec := strings.TrimSpace(imported)
	if spec == "" {
		return "", false
	}

	if strings.EqualFold(file.Language, "python") ||
		strings.EqualFold(filepath.Ext(file.RelPath), ".py") {
		if strings.HasPrefix(spec, ".") {
			dots := 0
			for dots < len(spec) && spec[dots] == '.' {
				dots++
			}
			base := filepath.ToSlash(filepath.Dir(file.RelPath))
			for level := 1; level < dots; level++ {
				base = filepath.ToSlash(filepath.Dir(base))
			}
			remainder := strings.ReplaceAll(spec[dots:], ".", "/")
			spec = filepath.ToSlash(filepath.Clean(filepath.Join(base, remainder)))
		} else {
			spec = strings.ReplaceAll(spec, ".", "/")
		}
	}

	candidate := filepath.ToSlash(filepath.Clean(spec))
	if id, ok := index[candidate]; ok {
		return id, true
	}
	for _, ext := range []string{".ts", ".tsx", ".js", ".jsx", ".py", ".go"} {
		if id, ok := index[candidate+ext]; ok {
			return id, true
		}
	}
	return "", false
}

func rebuildDependenciesForFileWithIndex(sqlDB *sql.DB, root db.Root, f db.File, relToID map[string]string) error {
	result, err := parser.ParseFile(f.Path, f.RelPath)
	if err != nil {
		return err
	}
	if err := db.DeleteOutgoingDependenciesByFile(sqlDB, f.ID); err != nil {
		return err
	}
	for _, imp := range result.Imports {
		dstID, ok := resolveImportFileID(f, imp, relToID)
		if !ok || dstID == f.ID {
			continue // external module - skip
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
