package db

import (
	"database/sql"
	"time"
)

// The structural journal is the durable memory behind Morning Delta. Live
// choreography (graph:patch) is transient - it only reaches a renderer that
// happened to be watching. The journal answers the question you ask when you
// were NOT watching: "what did my agents change while I was away?"
//
// It is deliberately denormalized. A journal row must survive the deletion of
// the file it describes, so it carries its own labels and holds no foreign
// keys into the semantic tables.

// Structural event kinds.
const (
	EventFileCreated   = "file.created"
	EventFileUpdated   = "file.updated"
	EventFileDeleted   = "file.deleted"
	EventEdgeAdded     = "edge.added"
	EventEdgeRemoved   = "edge.removed"
	EventSystemCreated = "system.created"
	EventSystemDeleted = "system.deleted"
	EventFileAssigned  = "file.assigned"
)

// updateCollapseWindowMs mirrors the activity burst window: repeated saves of
// one file by one actor inside this window are one journal row, so a
// save-on-keystroke editor cannot flood the delta.
const updateCollapseWindowMs = 5 * 60 * 1000

// journalRetentionMs bounds the journal. A delta older than this is history,
// not something anyone is going to review.
const journalRetentionMs = 30 * 24 * 60 * 60 * 1000

// StructuralEvent is one durable fact about how the architecture changed.
// Labels are captured at write time; IDs are for correlation only and may
// point at rows that no longer exist.
type StructuralEvent struct {
	ID           int64  `json:"id"`
	WorkspaceID  string `json:"workspaceId"`
	RootID       string `json:"rootId"`
	Branch       string `json:"branch"`
	TS           int64  `json:"ts"`
	Actor        string `json:"actor"` // 'human'|'agent'
	TraceID      string `json:"traceId,omitempty"`
	Kind         string `json:"kind"`
	SubjectID    string `json:"subjectId,omitempty"`
	SubjectLabel string `json:"subjectLabel,omitempty"`
	ObjectID     string `json:"objectId,omitempty"`
	ObjectLabel  string `json:"objectLabel,omitempty"`
	Detail       string `json:"detail,omitempty"` // JSON blob, kind-specific
	Count        int    `json:"count"`
	// SessionID links this change to the work an agent declared it was doing.
	// Empty means nobody narrated it - which is itself worth surfacing.
	SessionID string `json:"sessionId,omitempty"`
}

// A WorkSession is an agent's own account of what it set out to do.
//
// Structural facts alone are true but thin: "Handlers now depends on Record"
// says the topology moved without saying why anyone moved it. Axiom is meant
// to be bidirectional, so the agent doing the work writes its intent INTO the
// map rather than leaving the map to infer meaning it cannot know. Claims are
// then read under the goal that produced them.
//
// Narration is always optional. An un-narrated change still appears; it is
// just marked as unexplained, which is a useful thing to notice.
type WorkSession struct {
	ID             string        `json:"id"`
	WorkspaceID    string        `json:"workspaceId"`
	RootID         string        `json:"rootId"`
	Branch         string        `json:"branch"`
	OwnerKey       string        `json:"-"`
	Agent          string        `json:"agent,omitempty"`
	Goal           string        `json:"goal"`
	Summary        string        `json:"summary,omitempty"`
	Notes          []SessionNote `json:"notes"`
	FocusSystemIDs []string      `json:"focusSystemIds"`
	FocusFileIDs   []string      `json:"focusFileIds"`
	StartedAt      int64         `json:"startedAt"`
	EndedAt        int64         `json:"endedAt"`
}

// SessionNote is a running remark an agent leaves while working.
type SessionNote struct {
	TS   int64  `json:"ts"`
	Text string `json:"text"`
}

// RecordStructuralEvent appends one event. Repeated file updates by the same
// actor collapse into the previous row within the burst window.
func RecordStructuralEvent(db *sql.DB, ev StructuralEvent) error {
	if ev.TS == 0 {
		ev.TS = time.Now().UnixMilli()
	}
	if ev.Actor == "" {
		ev.Actor = "human"
	}
	ev.RootID, ev.Branch = completeHistoryIdentity(
		db, ev.WorkspaceID, ev.RootID, ev.Branch,
	)

	if ev.Kind == EventFileUpdated {
		res, err := db.Exec(`
			UPDATE structural_events
			SET ts = ?, count = count + 1, trace_id = ?
			WHERE id = (
				SELECT id FROM structural_events
				WHERE workspace_id = ? AND kind = ? AND subject_id = ? AND actor = ?
					AND session_id = ?
					AND COALESCE(root_id, '') = COALESCE(?, '')
					AND COALESCE(branch, '') = COALESCE(?, '')
					AND ts >= ?
				ORDER BY ts DESC LIMIT 1
			)`,
			ev.TS, ev.TraceID,
			ev.WorkspaceID, ev.Kind, ev.SubjectID, ev.Actor, ev.SessionID,
			nullableHistoryIdentity(ev.RootID), nullableHistoryIdentity(ev.Branch),
			ev.TS-updateCollapseWindowMs)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			return nil
		}
	}

	_, err := db.Exec(`
		INSERT INTO structural_events
			(workspace_id, root_id, branch, ts, actor, trace_id, kind,
			 subject_id, subject_label, object_id, object_label, detail, count, session_id)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
		ev.WorkspaceID, nullableHistoryIdentity(ev.RootID), nullableHistoryIdentity(ev.Branch),
		ev.TS, ev.Actor, ev.TraceID, ev.Kind,
		ev.SubjectID, ev.SubjectLabel, ev.ObjectID, ev.ObjectLabel, ev.Detail, ev.SessionID)
	return err
}

// GetStructuralEvents returns every event strictly newer than since, oldest
// first - replay order, so the delta can be scrubbed through the same living
// choreography that would have animated it live.
func GetStructuralEvents(db *sql.DB, workspaceID string, since int64) ([]StructuralEvent, error) {
	return getStructuralEvents(db, workspaceID, "", "", since, false)
}

// GetStructuralEventsForRoot returns only history written by one worktree on
// one branch. Legacy NULL rows participate only in the primary root's current
// branch, preserving old single-root deltas without rewriting history.
func GetStructuralEventsForRoot(
	db *sql.DB,
	workspaceID, rootID, branch string,
	since int64,
) ([]StructuralEvent, error) {
	rootID, branch = completeHistoryIdentity(db, workspaceID, rootID, branch)
	return getStructuralEvents(db, workspaceID, rootID, branch, since, true)
}

func getStructuralEvents(
	db *sql.DB,
	workspaceID, rootID, branch string,
	since int64,
	scoped bool,
) ([]StructuralEvent, error) {
	scope := 0
	if scoped {
		scope = 1
	}
	rows, err := db.Query(`
		SELECT id, workspace_id, effective_root_id, effective_branch,
		       ts, actor, trace_id, kind, subject_id, subject_label,
		       object_id, object_label, detail, count, session_id
		FROM (
			SELECT se.*,
			       COALESCE(se.root_id, (
			           SELECT r.id FROM roots r WHERE r.workspace_id=se.workspace_id
			           ORDER BY r.is_primary DESC, r.is_active DESC, r.path LIMIT 1
			       ), '') AS effective_root_id,
			       COALESCE(se.branch, (
			           SELECT r.branch FROM roots r WHERE r.workspace_id=se.workspace_id
			           ORDER BY r.is_primary DESC, r.is_active DESC, r.path LIMIT 1
			       ), '') AS effective_branch
			FROM structural_events se
			WHERE se.workspace_id = ? AND se.ts > ?
		) scoped_events
		WHERE ? = 0 OR (effective_root_id = ? AND effective_branch = ?)
		ORDER BY ts ASC, id ASC`, workspaceID, since, scope, rootID, branch)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	events := []StructuralEvent{}
	for rows.Next() {
		var ev StructuralEvent
		if err := rows.Scan(
			&ev.ID, &ev.WorkspaceID, &ev.RootID, &ev.Branch,
			&ev.TS, &ev.Actor, &ev.TraceID, &ev.Kind,
			&ev.SubjectID, &ev.SubjectLabel, &ev.ObjectID, &ev.ObjectLabel,
			&ev.Detail, &ev.Count, &ev.SessionID,
		); err != nil {
			return nil, err
		}
		events = append(events, ev)
	}
	return events, rows.Err()
}

// GetDeltaReviewedAt returns the watermark the user last acknowledged. Zero
// means the workspace has never been reviewed, in which case the caller
// decides the window (opening a fresh project must not present its entire
// index as an overnight delta).
func GetDeltaReviewedAt(db *sql.DB, workspaceID string) (int64, error) {
	return GetDeltaReviewedAtForRoot(db, workspaceID, "")
}

// GetDeltaReviewedAtForRoot reads a worktree's independent watermark. A NULL
// primary-root value falls back to the pre-migration workspace watermark;
// secondary roots correctly begin unreviewed.
func GetDeltaReviewedAtForRoot(db *sql.DB, workspaceID, rootID string) (int64, error) {
	rootID = effectiveRootID(db, workspaceID, rootID)
	if rootID == "" {
		return getLegacyDeltaReviewedAt(db, workspaceID)
	}
	var at sql.NullInt64
	err := db.QueryRow(`
		SELECT CASE
			WHEN r.delta_reviewed_at IS NOT NULL THEN r.delta_reviewed_at
			WHEN r.id = (
				SELECT primary_root.id FROM roots primary_root
				WHERE primary_root.workspace_id=r.workspace_id
				ORDER BY primary_root.is_primary DESC,
				         primary_root.is_active DESC,
				         primary_root.path
				LIMIT 1
			) THEN w.delta_reviewed_at
			ELSE 0
		END
		FROM roots r JOIN workspaces w ON w.id=r.workspace_id
		WHERE r.workspace_id=? AND r.id=?`, workspaceID, rootID).Scan(&at)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return at.Int64, nil
}

func getLegacyDeltaReviewedAt(db *sql.DB, workspaceID string) (int64, error) {
	var at sql.NullInt64
	err := db.QueryRow(
		`SELECT delta_reviewed_at FROM workspaces WHERE id = ?`, workspaceID,
	).Scan(&at)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return at.Int64, nil
}

// SetDeltaReviewedAt advances the watermark. It never moves backwards, so a
// late-arriving acknowledgement cannot resurrect an already-reviewed delta.
func SetDeltaReviewedAt(db *sql.DB, workspaceID string, at int64) error {
	return SetDeltaReviewedAtForRoot(db, workspaceID, "", at)
}

func SetDeltaReviewedAtForRoot(db *sql.DB, workspaceID, rootID string, at int64) error {
	rootID = effectiveRootID(db, workspaceID, rootID)
	if rootID == "" {
		_, err := db.Exec(`
			UPDATE workspaces SET delta_reviewed_at = ?
			WHERE id = ? AND delta_reviewed_at < ?`, at, workspaceID, at)
		return err
	}
	_, err := db.Exec(`
		UPDATE roots SET delta_reviewed_at = ?
		WHERE workspace_id = ? AND id = ?
		  AND COALESCE(
			delta_reviewed_at,
			CASE WHEN id = (
				SELECT primary_root.id FROM roots primary_root
				WHERE primary_root.workspace_id=roots.workspace_id
				ORDER BY primary_root.is_primary DESC,
				         primary_root.is_active DESC,
				         primary_root.path
				LIMIT 1
			) THEN (
				SELECT delta_reviewed_at FROM workspaces
				WHERE workspaces.id=roots.workspace_id
			) ELSE 0 END,
			0
		  ) < ?`, at, workspaceID, rootID, at)
	return err
}

// PruneStructuralEvents drops journal rows past the retention horizon.
func PruneStructuralEvents(db *sql.DB, workspaceID string, nowMs int64) error {
	if nowMs == 0 {
		nowMs = time.Now().UnixMilli()
	}
	_, err := db.Exec(
		`DELETE FROM structural_events WHERE workspace_id = ? AND ts < ?`,
		workspaceID, nowMs-journalRetentionMs)
	return err
}

// SaveDeltaSnapshot stores the exact system graph paired with a delta's
// returned `until` timestamp. Snapshot data is opaque to the DB package; the
// delta package owns its schema.
func SaveDeltaSnapshot(db *sql.DB, workspaceID string, at int64, snapshot string) error {
	_, err := db.Exec(`
		INSERT INTO delta_snapshots(workspace_id, at, snapshot)
		VALUES(?,?,?)
		ON CONFLICT(workspace_id, at) DO UPDATE SET snapshot=excluded.snapshot`,
		workspaceID, at, snapshot)
	return err
}

func SaveDeltaSnapshotForRoot(
	db *sql.DB,
	workspaceID, rootID, branch string,
	at int64,
	snapshot string,
) error {
	rootID, branch = completeHistoryIdentity(db, workspaceID, rootID, branch)
	if rootID == "" {
		return SaveDeltaSnapshot(db, workspaceID, at, snapshot)
	}
	_, err := db.Exec(`
		INSERT INTO root_delta_snapshots(root_id, branch, at, snapshot)
		VALUES(?,?,?,?)
		ON CONFLICT(root_id, branch, at) DO UPDATE SET snapshot=excluded.snapshot`,
		rootID, branch, at, snapshot)
	return err
}

func GetDeltaSnapshot(db *sql.DB, workspaceID string, at int64) (string, error) {
	var snapshot string
	err := db.QueryRow(
		`SELECT snapshot FROM delta_snapshots WHERE workspace_id=? AND at=?`,
		workspaceID, at,
	).Scan(&snapshot)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return snapshot, err
}

func GetDeltaSnapshotForRoot(
	db *sql.DB,
	workspaceID, rootID, branch string,
	at int64,
) (string, error) {
	rootID, branch = completeHistoryIdentity(db, workspaceID, rootID, branch)
	if rootID == "" {
		return GetDeltaSnapshot(db, workspaceID, at)
	}
	var snapshot string
	err := db.QueryRow(`
		SELECT snapshot FROM root_delta_snapshots
		WHERE root_id=? AND branch=? AND at=?`, rootID, branch, at).Scan(&snapshot)
	if err == nil {
		return snapshot, nil
	}
	if err != sql.ErrNoRows {
		return "", err
	}
	if effectiveRootID(db, workspaceID, "") == rootID {
		return GetDeltaSnapshot(db, workspaceID, at)
	}
	return "", nil
}

func PruneDeltaSnapshots(db *sql.DB, workspaceID string, nowMs int64) error {
	if nowMs == 0 {
		nowMs = time.Now().UnixMilli()
	}
	_, err := db.Exec(
		`DELETE FROM delta_snapshots WHERE workspace_id=? AND at < ?`,
		workspaceID, nowMs-journalRetentionMs)
	return err
}

func PruneDeltaSnapshotsForRoot(
	db *sql.DB,
	workspaceID, rootID string,
	nowMs int64,
) error {
	rootID = effectiveRootID(db, workspaceID, rootID)
	if rootID == "" {
		return PruneDeltaSnapshots(db, workspaceID, nowMs)
	}
	if nowMs == 0 {
		nowMs = time.Now().UnixMilli()
	}
	if effectiveRootID(db, workspaceID, "") == rootID {
		if err := PruneDeltaSnapshots(db, workspaceID, nowMs); err != nil {
			return err
		}
	}
	_, err := db.Exec(
		`DELETE FROM root_delta_snapshots WHERE root_id=? AND at < ?`,
		rootID, nowMs-journalRetentionMs)
	return err
}
