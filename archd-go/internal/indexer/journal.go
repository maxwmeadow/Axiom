package indexer

import (
	"database/sql"
	"encoding/json"
	"log"

	"axiom.local/archd/internal/activity"
	"axiom.local/archd/internal/db"
)

// Journaling runs alongside the live broadcast, not instead of it. A
// graph:patch only reaches a renderer that is currently attached; the journal
// is what lets you close Axiom, let agents work overnight, and still be shown
// the architectural diff in the morning.
//
// Journal failures never fail an index. Losing a delta row is a degraded
// review experience; failing the reindex would corrupt the live map.

// systemLabeler resolves file → owning system for journal detail, using one
// query per save rather than one per relationship.
type systemLabeler struct {
	fileSystem map[string]string // file ID → system ID
	filePath   map[string]string // file ID → rel path
	systemName map[string]string // system ID → display name
}

func newSystemLabeler(sqlDB *sql.DB, root db.Root) *systemLabeler {
	labeler := &systemLabeler{
		fileSystem: map[string]string{},
		filePath:   map[string]string{},
		systemName: map[string]string{},
	}
	files, err := db.GetFilesByRoot(sqlDB, root.ID)
	if err != nil {
		return labeler
	}
	for _, file := range files {
		labeler.filePath[file.ID] = file.RelPath
		if file.SystemID != nil {
			labeler.fileSystem[file.ID] = *file.SystemID
		}
	}
	systems, err := db.GetSystems(sqlDB, root.WorkspaceID)
	if err != nil {
		return labeler
	}
	for _, system := range systems {
		labeler.systemName[system.ID] = system.Name
	}
	return labeler
}

func (l *systemLabeler) systemOf(fileID string) (id, name string) {
	id = l.fileSystem[fileID]
	return id, l.systemName[id]
}

// pathOf labels a relationship endpoint. An endpoint deleted in this same save
// is already absent from the snapshot, so it falls back to its ID rather than
// dropping the event.
func (l *systemLabeler) pathOf(fileID string) string {
	if path, ok := l.filePath[fileID]; ok {
		return path
	}
	return fileID
}

func encodeDetail(detail map[string]string) string {
	for key, value := range detail {
		if value == "" {
			delete(detail, key)
		}
	}
	if len(detail) == 0 {
		return ""
	}
	encoded, err := json.Marshal(detail)
	if err != nil {
		return ""
	}
	return string(encoded)
}

// recordEvent stamps every journal row with whatever work an agent has
// declared it is doing, so the delta can present changes under their stated
// intent instead of as bare topology. An empty session is normal: it means
// nobody narrated this change, which is itself worth surfacing.
func recordEvent(sqlDB *sql.DB, ev db.StructuralEvent) {
	if ev.SessionID == "" {
		entityIDs := []string{ev.SubjectID, ev.ObjectID}
		if ev.Detail != "" {
			var detail map[string]any
			if json.Unmarshal([]byte(ev.Detail), &detail) == nil {
				for _, key := range []string{
					"systemId", "srcSystem", "dstSystem",
					"srcSystemId", "dstSystemId",
				} {
					if id, ok := detail[key].(string); ok && id != "" {
						entityIDs = append(entityIDs, id)
					}
				}
			}
		}
		ev.SessionID = db.ActiveWorkSessionIDForRootEntities(
			sqlDB, ev.WorkspaceID, ev.RootID, entityIDs...,
		)
	}
	if err := db.RecordStructuralEvent(sqlDB, ev); err != nil {
		log.Printf("journal: record %s %s: %v", ev.Kind, ev.SubjectLabel, err)
	}
}

func recordRootEvent(sqlDB *sql.DB, root db.Root, ev db.StructuralEvent) {
	ev.WorkspaceID = root.WorkspaceID
	ev.RootID = root.ID
	ev.Branch = root.Branch
	recordEvent(sqlDB, ev)
}

// journalFileChange records one file's net change for the Morning Delta.
func journalFileChange(
	sqlDB *sql.DB, root db.Root, labeler *systemLabeler,
	file *db.File, kind, actor, traceID string,
) {
	systemID, systemName := labeler.systemOf(file.ID)
	recordRootEvent(sqlDB, root, db.StructuralEvent{
		Actor:        actor,
		TraceID:      traceID,
		Kind:         kind,
		SubjectID:    file.ID,
		SubjectLabel: file.RelPath,
		Detail: encodeDetail(map[string]string{
			"language":   file.Language,
			"systemId":   systemID,
			"systemName": systemName,
		}),
	})
}

// journalFileDeleted records a tombstone. The label and last known system are
// captured here because the file row is already gone by review time.
func journalFileDeleted(
	sqlDB *sql.DB, root db.Root, systemID, systemName string,
	file *db.File, actor, traceID string,
) {
	recordRootEvent(sqlDB, root, db.StructuralEvent{
		Actor:        actor,
		TraceID:      traceID,
		Kind:         db.EventFileDeleted,
		SubjectID:    file.ID,
		SubjectLabel: file.RelPath,
		Detail: encodeDetail(map[string]string{
			"language":   file.Language,
			"systemId":   systemID,
			"systemName": systemName,
		}),
	})
}

// journalSystemPlan records births and deaths in the system tree. A system
// appearing or disappearing is the coarsest drift there is, so it is recorded
// even though the classifier - not a person - performed the move.
func journalSystemPlan(
	sqlDB *sql.DB, root db.Root,
	before []db.System, after []db.System, removedIDs []string,
) {
	existing := make(map[string]db.System, len(before))
	for _, system := range before {
		existing[system.ID] = system
	}
	actor := activity.ActorFor(root.WorkspaceID)

	for _, system := range after {
		if _, known := existing[system.ID]; known {
			continue
		}
		recordRootEvent(sqlDB, root, db.StructuralEvent{
			Actor:        actor,
			Kind:         db.EventSystemCreated,
			SubjectID:    system.ID,
			SubjectLabel: system.Name,
		})
	}
	for _, id := range removedIDs {
		system, known := existing[id]
		if !known {
			continue
		}
		recordRootEvent(sqlDB, root, db.StructuralEvent{
			Actor:        actor,
			Kind:         db.EventSystemDeleted,
			SubjectID:    system.ID,
			SubjectLabel: system.Name,
		})
	}
}

// journalRelationships records topology changes. "updated" relationships are
// deliberately skipped: an edge that already existed and still exists is not
// an architectural difference, however much its body churned.
func journalRelationships(
	sqlDB *sql.DB, root db.Root, labeler *systemLabeler,
	relationships []RelationshipChange, actor, traceID string,
) {
	for _, relationship := range relationships {
		var kind string
		switch relationship.Change {
		case "added":
			kind = db.EventEdgeAdded
		case "removed":
			kind = db.EventEdgeRemoved
		default:
			continue
		}
		srcSystem, srcSystemName := labeler.systemOf(relationship.Src)
		dstSystem, dstSystemName := labeler.systemOf(relationship.Dst)
		recordRootEvent(sqlDB, root, db.StructuralEvent{
			Actor:        actor,
			TraceID:      traceID,
			Kind:         kind,
			SubjectID:    relationship.Src,
			SubjectLabel: labeler.pathOf(relationship.Src),
			ObjectID:     relationship.Dst,
			ObjectLabel:  labeler.pathOf(relationship.Dst),
			Detail: encodeDetail(map[string]string{
				"relationship":  relationship.Relationship,
				"callerSymbol":  relationship.CallerSymbol,
				"calleeSymbol":  relationship.CalleeSymbol,
				"srcSystem":     srcSystem,
				"dstSystem":     dstSystem,
				"srcSystemName": srcSystemName,
				"dstSystemName": dstSystemName,
			}),
		})
	}
}
