// Package delta turns the raw structural journal into the Morning Delta: the
// architectural diff of everything that happened while you were away.
//
// The defining rule is NET EFFECT, not event history. A journal is a log of
// moves; a delta is a statement about how the architecture is different now.
// An agent that creates a scratch file and deletes it again changed nothing,
// and reporting that churn would train you to stop trusting the delta. So
// create+delete cancels, add+remove cancels, and repeated saves collapse to
// one changed file.
//
// This package is deliberately pure: it takes journal rows and returns a
// summary. It never reads the live graph, so a delta describing a file that
// no longer exists still renders correctly.
package delta

import (
	"encoding/json"
	"sort"

	"axiom.local/archd/internal/db"
)

// Change classifications in the delta.
const (
	ChangeCreated = "created"
	ChangeUpdated = "updated"
	ChangeDeleted = "deleted"
	ChangeAdded   = "added"
	ChangeRemoved = "removed"
)

// Actor attribution. A file touched by both in the same window reports "both"
// rather than silently crediting whoever wrote last.
const (
	ActorHuman = "human"
	ActorAgent = "agent"
	ActorBoth  = "both"
)

// FileChange is one file's net change across the delta window.
type FileChange struct {
	ID         string `json:"id"`
	RelPath    string `json:"relPath"`
	Change     string `json:"change"`
	Actor      string `json:"actor"`
	Saves      int    `json:"saves"`
	TS         int64  `json:"ts"`
	SystemID   string `json:"systemId,omitempty"`
	SystemName string `json:"systemName,omitempty"`
	Language   string `json:"language,omitempty"`
	SessionID  string `json:"sessionId,omitempty"`
}

// EdgeChange is one relationship's net change.
//
// Cross reports whether the relationship crossed a real system boundary at the
// time it changed. An endpoint with no system is UNCLASSIFIED, not a different
// system — a file the classifier has not placed yet has no boundary to cross,
// and treating its empty ID as "some other system" reports drift that does not
// exist.
type EdgeChange struct {
	SrcID        string `json:"srcId"`
	DstID        string `json:"dstId"`
	SrcLabel     string `json:"srcLabel"`
	DstLabel     string `json:"dstLabel"`
	Change       string `json:"change"`
	Relationship string `json:"relationship"`
	CallerSymbol string `json:"callerSymbol,omitempty"`
	CalleeSymbol string `json:"calleeSymbol,omitempty"`
	SrcSystemID  string `json:"srcSystemId,omitempty"`
	DstSystemID  string `json:"dstSystemId,omitempty"`
	SrcSystem    string `json:"srcSystem,omitempty"`
	DstSystem    string `json:"dstSystem,omitempty"`
	Cross        bool   `json:"cross"`
	// Unclassified marks an endpoint with no system yet, so no boundary claim
	// can be made about it either way.
	Unclassified bool   `json:"unclassified"`
	Actor        string `json:"actor"`
	TS           int64  `json:"ts"`
	SessionID    string `json:"sessionId,omitempty"`
}

// displaySystem prefers the captured system name and falls back to its ID so
// an unnamed or since-renamed system still labels the edge.
func displaySystem(id, name string) string {
	if name != "" {
		return name
	}
	return id
}

// SystemChange is a net change to the system tree itself — the coarsest and
// most consequential kind of drift.
type SystemChange struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Change    string `json:"change"`
	Actor     string `json:"actor"`
	TS        int64  `json:"ts"`
	SessionID string `json:"sessionId,omitempty"`
}

// Counts is the headline the delta banner reads from.
type Counts struct {
	FilesCreated   int `json:"filesCreated"`
	FilesUpdated   int `json:"filesUpdated"`
	FilesDeleted   int `json:"filesDeleted"`
	EdgesAdded     int `json:"edgesAdded"`
	EdgesRemoved   int `json:"edgesRemoved"`
	SystemsAdded   int `json:"systemsAdded"`
	SystemsRemoved int `json:"systemsRemoved"`
	CrossBoundary  int `json:"crossBoundary"`
	AgentFiles     int `json:"agentFiles"`
	HumanFiles     int `json:"humanFiles"`
}

// Summary is the whole Morning Delta.
//
// Files/Edges/Systems are the raw net changes; Claims is the reviewable view
// built over them. The UI reads Claims — the raw collections remain because
// they are what marks the canvas and what any future consumer (MCP, export)
// would want unaggregated.
type Summary struct {
	RootID  string         `json:"rootId,omitempty"`
	Branch  string         `json:"branch,omitempty"`
	Since   int64          `json:"since"`
	Until   int64          `json:"until"`
	Files   []FileChange   `json:"files"`
	Edges   []EdgeChange   `json:"edges"`
	Systems []SystemChange `json:"systems"`
	Claims  []Claim        `json:"claims"`
	// Sessions are the agents' own accounts of the work in this window.
	Sessions []db.WorkSession `json:"sessions"`
	Counts   Counts           `json:"counts"`
	Empty    bool             `json:"empty"`
}

// fileDetail is the JSON the indexer writes on file events.
type fileDetail struct {
	Language   string `json:"language,omitempty"`
	SystemID   string `json:"systemId,omitempty"`
	SystemName string `json:"systemName,omitempty"`
}

// edgeDetail is the JSON the indexer writes on relationship events. IDs decide
// whether a boundary was crossed; names are for display only, since a system
// can be renamed after the fact.
type edgeDetail struct {
	Relationship  string `json:"relationship,omitempty"`
	CallerSymbol  string `json:"callerSymbol,omitempty"`
	CalleeSymbol  string `json:"calleeSymbol,omitempty"`
	SrcSystem     string `json:"srcSystem,omitempty"`
	DstSystem     string `json:"dstSystem,omitempty"`
	SrcSystemName string `json:"srcSystemName,omitempty"`
	DstSystemName string `json:"dstSystemName,omitempty"`
}

// mergeActor accumulates attribution across an entity's events.
func mergeActor(current, next string) string {
	if current == "" {
		return next
	}
	if current == next {
		return current
	}
	return ActorBoth
}

// mergeSession keeps narration honest when a net change contains work from
// more than one declared session. A single claim cannot truthfully display
// either agent's words as the explanation for both, so conflict is sticky and
// the public session ID remains empty.
func mergeSession(current string, conflict bool, next string) (string, bool) {
	if next == "" {
		return current, conflict
	}
	if conflict {
		return "", true
	}
	if current == "" || current == next {
		return next, false
	}
	return "", true
}

type fileState struct {
	FileChange
	created         bool
	deleted         bool
	updated         bool
	sessionConflict bool
}

type edgeState struct {
	EdgeChange
	added           bool
	removed         bool
	sessionConflict bool
}

type systemState struct {
	SystemChange
	created         bool
	deleted         bool
	sessionConflict bool
}

func edgeKey(ev db.StructuralEvent, detail edgeDetail) string {
	return ev.SubjectID + "\x00" + ev.ObjectID + "\x00" + detail.Relationship +
		"\x00" + detail.CallerSymbol + "\x00" + detail.CalleeSymbol
}

// Aggregate folds journal events (oldest first) into the net architectural
// diff for the window.
func Aggregate(events []db.StructuralEvent, since, until int64) Summary {
	files := map[string]*fileState{}
	fileOrder := []string{}
	edges := map[string]*edgeState{}
	edgeOrder := []string{}
	systems := map[string]*systemState{}
	systemOrder := []string{}

	for _, ev := range events {
		switch ev.Kind {
		case db.EventFileCreated, db.EventFileUpdated, db.EventFileDeleted:
			state, ok := files[ev.SubjectID]
			if !ok {
				state = &fileState{}
				files[ev.SubjectID] = state
				fileOrder = append(fileOrder, ev.SubjectID)
			}
			var detail fileDetail
			_ = json.Unmarshal([]byte(ev.Detail), &detail)

			state.ID = ev.SubjectID
			state.RelPath = ev.SubjectLabel
			state.Actor = mergeActor(state.Actor, ev.Actor)
			state.TS = ev.TS
			state.SessionID, state.sessionConflict = mergeSession(
				state.SessionID, state.sessionConflict, ev.SessionID,
			)
			if detail.Language != "" {
				state.Language = detail.Language
			}
			// A delete carries no membership; keep the last known system so a
			// removed file still reports which system lost it.
			if detail.SystemID != "" || ev.Kind != db.EventFileDeleted {
				state.SystemID = detail.SystemID
				state.SystemName = detail.SystemName
			}

			switch ev.Kind {
			case db.EventFileCreated:
				state.created = true
				// A path recreated after deletion is a net edit, not a ghost.
				state.deleted = false
			case db.EventFileUpdated:
				state.updated = true
				state.Saves += max(ev.Count, 1)
			case db.EventFileDeleted:
				state.deleted = true
			}

		case db.EventEdgeAdded, db.EventEdgeRemoved:
			var detail edgeDetail
			_ = json.Unmarshal([]byte(ev.Detail), &detail)
			key := edgeKey(ev, detail)
			state, ok := edges[key]
			if !ok {
				state = &edgeState{}
				edges[key] = state
				edgeOrder = append(edgeOrder, key)
			}
			state.SrcID = ev.SubjectID
			state.DstID = ev.ObjectID
			state.SrcLabel = ev.SubjectLabel
			state.DstLabel = ev.ObjectLabel
			state.Relationship = detail.Relationship
			state.CallerSymbol = detail.CallerSymbol
			state.CalleeSymbol = detail.CalleeSymbol
			state.SrcSystemID = detail.SrcSystem
			state.DstSystemID = detail.DstSystem
			state.SrcSystem = displaySystem(detail.SrcSystem, detail.SrcSystemName)
			state.DstSystem = displaySystem(detail.DstSystem, detail.DstSystemName)
			state.Unclassified = detail.SrcSystem == "" || detail.DstSystem == ""
			state.Cross = !state.Unclassified && detail.SrcSystem != detail.DstSystem
			state.Actor = mergeActor(state.Actor, ev.Actor)
			state.TS = ev.TS
			state.SessionID, state.sessionConflict = mergeSession(
				state.SessionID, state.sessionConflict, ev.SessionID,
			)
			if ev.Kind == db.EventEdgeAdded {
				state.added = true
			} else {
				state.removed = true
			}

		case db.EventSystemCreated, db.EventSystemDeleted:
			state, ok := systems[ev.SubjectID]
			if !ok {
				state = &systemState{}
				systems[ev.SubjectID] = state
				systemOrder = append(systemOrder, ev.SubjectID)
			}
			state.ID = ev.SubjectID
			state.Name = ev.SubjectLabel
			state.Actor = mergeActor(state.Actor, ev.Actor)
			state.TS = ev.TS
			state.SessionID, state.sessionConflict = mergeSession(
				state.SessionID, state.sessionConflict, ev.SessionID,
			)
			if ev.Kind == db.EventSystemCreated {
				state.created = true
				state.deleted = false
			} else {
				state.deleted = true
			}
		}
	}

	summary := Summary{
		Since:    since,
		Until:    until,
		Files:    []FileChange{},
		Edges:    []EdgeChange{},
		Systems:  []SystemChange{},
		Claims:   []Claim{},
		Sessions: []db.WorkSession{},
	}

	for _, id := range fileOrder {
		state := files[id]
		switch {
		// Created then deleted inside the window: the architecture is
		// unchanged, so the delta must stay silent about it.
		case state.created && state.deleted:
			continue
		case state.created:
			state.Change = ChangeCreated
			summary.Counts.FilesCreated++
		case state.deleted:
			state.Change = ChangeDeleted
			summary.Counts.FilesDeleted++
		case state.updated:
			state.Change = ChangeUpdated
			summary.Counts.FilesUpdated++
		default:
			continue
		}
		switch state.Actor {
		case ActorAgent:
			summary.Counts.AgentFiles++
		case ActorHuman:
			summary.Counts.HumanFiles++
		case ActorBoth:
			summary.Counts.AgentFiles++
			summary.Counts.HumanFiles++
		}
		summary.Files = append(summary.Files, state.FileChange)
	}

	for _, key := range edgeOrder {
		state := edges[key]
		switch {
		// Wired then unwired (or the reverse): net-zero topology churn.
		case state.added && state.removed:
			continue
		case state.added:
			state.Change = ChangeAdded
			summary.Counts.EdgesAdded++
		case state.removed:
			state.Change = ChangeRemoved
			summary.Counts.EdgesRemoved++
		default:
			continue
		}
		if state.Cross {
			summary.Counts.CrossBoundary++
		}
		summary.Edges = append(summary.Edges, state.EdgeChange)
	}

	for _, id := range systemOrder {
		state := systems[id]
		switch {
		case state.created && state.deleted:
			continue
		case state.created:
			state.Change = ChangeCreated
			summary.Counts.SystemsAdded++
		case state.deleted:
			state.Change = ChangeDeleted
			summary.Counts.SystemsRemoved++
		default:
			continue
		}
		summary.Systems = append(summary.Systems, state.SystemChange)
	}

	// Newest first: the delta reads as "here is what just happened".
	sort.SliceStable(summary.Files, func(i, j int) bool {
		return summary.Files[i].TS > summary.Files[j].TS
	})
	// Cross-boundary edges lead — they are the drift worth reviewing.
	sort.SliceStable(summary.Edges, func(i, j int) bool {
		if summary.Edges[i].Cross != summary.Edges[j].Cross {
			return summary.Edges[i].Cross
		}
		return summary.Edges[i].TS > summary.Edges[j].TS
	})
	sort.SliceStable(summary.Systems, func(i, j int) bool {
		return summary.Systems[i].TS > summary.Systems[j].TS
	})

	summary.Empty = len(summary.Files) == 0 &&
		len(summary.Edges) == 0 && len(summary.Systems) == 0
	return summary
}
