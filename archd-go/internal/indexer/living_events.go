package indexer

import (
	"sort"

	"axiom.local/archd/internal/db"
)

// FileUpdatePatch preserves the semantic file payload and tells the Living
// Canvas whether the watcher proved a real content change.
type FileUpdatePatch struct {
	File    *db.File `json:"file"`
	Change  string   `json:"change"` // created|updated
	Animate bool     `json:"animate"`
	TraceID string   `json:"traceId,omitempty"`
}

// FileDeletePatch is a tombstone: the renderer keeps the existing card just
// long enough to perform its red exit before removing it from local state.
type FileDeletePatch struct {
	ID      string `json:"id"`
	RelPath string `json:"relPath"`
	TraceID string `json:"traceId,omitempty"`
}

// RelationshipChange is a transient, directional description of a real
// cross-file relationship mutation. CALLS carries symbol names; IMPORTS uses
// only the file endpoints. Dependency is included for semantic store updates.
type RelationshipChange struct {
	Src          string         `json:"src"`
	Dst          string         `json:"dst"`
	OriginID     string         `json:"originId,omitempty"`
	Relationship string         `json:"relationship"` // CALLS|IMPORTS
	Change       string         `json:"change"`       // added|updated|removed
	CallerSymbol string         `json:"callerSymbol,omitempty"`
	CalleeSymbol string         `json:"calleeSymbol,omitempty"`
	CallCount    int            `json:"callCount,omitempty"`
	Animate      bool           `json:"animate"`
	Dependency   *db.Dependency `json:"dependency,omitempty"`
	DependencyID string         `json:"dependencyId,omitempty"`
	TraceID      string         `json:"traceId,omitempty"`
}

func dependencyKey(dep db.Dependency) string {
	return dep.Src + "\x00" + dep.Dst + "\x00" + dep.DependencyType
}

func callKey(edge db.CallEdge) string {
	return edge.CallerFile + "\x00" + edge.CallerSymbol + "\x00" +
		edge.CalleeFile + "\x00" + edge.CalleeSymbol
}

func relationshipPair(src, dst string) string {
	return src + "\x00" + dst
}

func touchedSymbolKey(fileID, symbol string) string {
	return fileID + "\x00" + symbol
}

func relationshipTouchesChangedSymbol(edge db.CallEdge, touchedSymbols map[string]struct{}) bool {
	if len(touchedSymbols) == 0 {
		return false
	}
	_, callerChanged := touchedSymbols[touchedSymbolKey(edge.CallerFile, edge.CallerSymbol)]
	_, calleeChanged := touchedSymbols[touchedSymbolKey(edge.CalleeFile, edge.CalleeSymbol)]
	return callerChanged || calleeChanged
}

// diffRelationshipChanges describes both static import and resolved function
// call changes. Retained call edges emit "updated" only when one of their
// participating symbols changed, so an unrelated edit cannot spray false
// relationship activity across every outgoing edge in the file.
// IMPORTS for a pair with a CALLS event are suppressed to avoid drawing two
// coincident pulses for the same code change.
func diffRelationshipChanges(
	beforeDeps, afterDeps []db.Dependency,
	beforeCalls, afterCalls []db.CallEdge,
	touchedSymbols map[string]struct{},
) []RelationshipChange {
	beforeCallByKey := make(map[string]db.CallEdge, len(beforeCalls))
	afterCallByKey := make(map[string]db.CallEdge, len(afterCalls))
	for _, edge := range beforeCalls {
		beforeCallByKey[callKey(edge)] = edge
	}
	for _, edge := range afterCalls {
		afterCallByKey[callKey(edge)] = edge
	}

	var changes []RelationshipChange
	callPairs := make(map[string]bool)
	for key, edge := range afterCallByKey {
		before, existed := beforeCallByKey[key]
		change := ""
		switch {
		case !existed:
			change = "added"
		case before.CallCount != edge.CallCount || relationshipTouchesChangedSymbol(edge, touchedSymbols):
			change = "updated"
		}
		if change == "" {
			continue
		}
		callPairs[relationshipPair(edge.CallerFile, edge.CalleeFile)] = true
		changes = append(changes, RelationshipChange{
			Src: edge.CallerFile, Dst: edge.CalleeFile,
			Relationship: "CALLS", Change: change,
			CallerSymbol: edge.CallerSymbol, CalleeSymbol: edge.CalleeSymbol,
			CallCount: edge.CallCount, Animate: true,
		})
	}
	for key, edge := range beforeCallByKey {
		if _, exists := afterCallByKey[key]; exists {
			continue
		}
		callPairs[relationshipPair(edge.CallerFile, edge.CalleeFile)] = true
		changes = append(changes, RelationshipChange{
			Src: edge.CallerFile, Dst: edge.CalleeFile,
			Relationship: "CALLS", Change: "removed",
			CallerSymbol: edge.CallerSymbol, CalleeSymbol: edge.CalleeSymbol,
			CallCount: edge.CallCount, Animate: true,
		})
	}

	beforeDepByKey := make(map[string]db.Dependency, len(beforeDeps))
	afterDepByKey := make(map[string]db.Dependency, len(afterDeps))
	for _, dep := range beforeDeps {
		beforeDepByKey[dependencyKey(dep)] = dep
	}
	for _, dep := range afterDeps {
		afterDepByKey[dependencyKey(dep)] = dep
	}
	for key, dep := range afterDepByKey {
		if _, exists := beforeDepByKey[key]; exists {
			continue
		}
		copy := dep
		changes = append(changes, RelationshipChange{
			Src: dep.Src, Dst: dep.Dst, Relationship: dep.DependencyType,
			Change: "added", Dependency: &copy,
			Animate: !callPairs[relationshipPair(dep.Src, dep.Dst)],
		})
	}
	for key, dep := range beforeDepByKey {
		if _, exists := afterDepByKey[key]; exists {
			continue
		}
		changes = append(changes, RelationshipChange{
			Src: dep.Src, Dst: dep.Dst, Relationship: dep.DependencyType,
			Change: "removed", DependencyID: dep.ID,
			Animate: !callPairs[relationshipPair(dep.Src, dep.Dst)],
		})
	}

	sort.Slice(changes, func(i, j int) bool {
		left := changes[i].Src + "\x00" + changes[i].Dst + "\x00" +
			changes[i].Relationship + "\x00" + changes[i].CallerSymbol + "\x00" + changes[i].Change
		right := changes[j].Src + "\x00" + changes[j].Dst + "\x00" +
			changes[j].Relationship + "\x00" + changes[j].CallerSymbol + "\x00" + changes[j].Change
		return left < right
	})
	return changes
}
