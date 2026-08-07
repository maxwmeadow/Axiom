package db

import (
	"database/sql"
	"encoding/json"
	"time"
)

// Work sessions are the bidirectional half of the Morning Delta: the agent
// writes what it intended INTO the map, instead of leaving the map to guess
// meaning from topology it cannot interpret.
//
// An owner key identifies one MCP client process. Starting new work closes
// only that owner's forgotten session, so independent agents remain visible
// and attributable while they work in parallel.

func encodeStringList(values []string) (string, error) {
	if values == nil {
		values = []string{}
	}
	encoded, err := json.Marshal(values)
	return string(encoded), err
}

func decodeStringList(raw string) []string {
	values := []string{}
	_ = json.Unmarshal([]byte(raw), &values)
	return values
}

func scanWorkSession(scanner interface{ Scan(...any) error }) (WorkSession, error) {
	var session WorkSession
	var notes, focusSystems, focusFiles string
	err := scanner.Scan(
		&session.ID, &session.WorkspaceID, &session.RootID, &session.Branch,
		&session.OwnerKey, &session.Agent,
		&session.Goal, &session.Summary, &notes, &focusSystems, &focusFiles,
		&session.StartedAt, &session.EndedAt,
	)
	if err != nil {
		return session, err
	}
	session.Notes = []SessionNote{}
	_ = json.Unmarshal([]byte(notes), &session.Notes)
	session.FocusSystemIDs = decodeStringList(focusSystems)
	session.FocusFileIDs = decodeStringList(focusFiles)
	return session, nil
}

const workSessionColumns = `
	id, workspace_id,
	COALESCE(root_id, (
		SELECT r.id FROM roots r WHERE r.workspace_id=work_sessions.workspace_id
		ORDER BY r.is_primary DESC, r.is_active DESC, r.path LIMIT 1
	), ''),
	COALESCE(branch, (
		SELECT r.branch FROM roots r WHERE r.workspace_id=work_sessions.workspace_id
		ORDER BY r.is_primary DESC, r.is_active DESC, r.path LIMIT 1
	), ''),
	owner_key, agent, goal, summary, notes,
	focus_system_ids, focus_file_ids, started_at, ended_at`

// StartWorkSession opens a session, closing only a session left open by the
// same owner. Empty owner keys retain the original single-client behavior for
// older API callers.
func StartWorkSession(db *sql.DB, session WorkSession) (WorkSession, error) {
	now := time.Now().UnixMilli()
	if session.StartedAt == 0 {
		session.StartedAt = now
	}
	if session.Notes == nil {
		session.Notes = []SessionNote{}
	}
	session.RootID, session.Branch = completeHistoryIdentity(
		db, session.WorkspaceID, session.RootID, session.Branch,
	)
	notes, err := json.Marshal(session.Notes)
	if err != nil {
		return session, err
	}
	focusSystems, err := encodeStringList(session.FocusSystemIDs)
	if err != nil {
		return session, err
	}
	focusFiles, err := encodeStringList(session.FocusFileIDs)
	if err != nil {
		return session, err
	}

	tx, err := db.Begin()
	if err != nil {
		return session, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`
		UPDATE work_sessions SET ended_at = ?
		WHERE workspace_id = ? AND owner_key = ? AND ended_at = 0`,
		now, session.WorkspaceID, session.OwnerKey); err != nil {
		return session, err
	}
	if _, err := tx.Exec(`
		INSERT INTO work_sessions (
			id, workspace_id, root_id, branch, owner_key, agent, goal, summary, notes,
			focus_system_ids, focus_file_ids, started_at, ended_at
		) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`,
		session.ID, session.WorkspaceID,
		nullableHistoryIdentity(session.RootID), nullableHistoryIdentity(session.Branch),
		session.OwnerKey, session.Agent,
		session.Goal, session.Summary, string(notes), focusSystems, focusFiles,
		session.StartedAt); err != nil {
		return session, err
	}
	return session, tx.Commit()
}

// ActiveWorkSessionID returns the newest open session. It exists for legacy
// callers that do not identify a session; new parallel-aware callers should
// use a session ID or ActiveWorkSessionIDForRootEntities.
func ActiveWorkSessionID(db *sql.DB, workspaceID string) string {
	return ActiveWorkSessionIDForRoot(db, workspaceID, "")
}

func ActiveWorkSessionIDForRoot(db *sql.DB, workspaceID, rootID string) string {
	rootID = effectiveRootID(db, workspaceID, rootID)
	var id string
	err := db.QueryRow(`
		SELECT ws.id FROM work_sessions ws
		WHERE ws.workspace_id = ? AND ws.ended_at = 0
		  AND COALESCE(ws.root_id, (
		      SELECT r.id FROM roots r WHERE r.workspace_id=ws.workspace_id
		      ORDER BY r.is_primary DESC, r.is_active DESC, r.path LIMIT 1
		  ), '') = ?
		ORDER BY ws.started_at DESC LIMIT 1`, workspaceID, rootID).Scan(&id)
	if err != nil {
		return ""
	}
	return id
}

// ActiveWorkSessionIDForEntities attributes a structural event to exactly one
// open session. A focused entity match wins. With one open session the legacy
// implicit attribution remains useful; with multiple unmatched or overlapping
// sessions it returns empty rather than claiming the wrong agent did the work.
func ActiveWorkSessionIDForEntities(db *sql.DB, workspaceID string, entityIDs ...string) string {
	return ActiveWorkSessionIDForRootEntities(db, workspaceID, "", entityIDs...)
}

func ActiveWorkSessionIDForRootEntities(
	db *sql.DB,
	workspaceID string,
	rootID string,
	entityIDs ...string,
) string {
	rootID = effectiveRootID(db, workspaceID, rootID)
	sessions, err := GetActiveWorkSessions(db, workspaceID)
	if err != nil || len(sessions) == 0 {
		return ""
	}
	wanted := make(map[string]struct{}, len(entityIDs))
	for _, id := range entityIDs {
		if id != "" {
			wanted[id] = struct{}{}
		}
	}
	matches := make([]string, 0, 1)
	rootSessions := make([]string, 0, 1)
	for _, session := range sessions {
		if session.RootID != rootID {
			continue
		}
		rootSessions = append(rootSessions, session.ID)
		matched := false
		for _, id := range append(session.FocusSystemIDs, session.FocusFileIDs...) {
			if _, ok := wanted[id]; ok {
				matched = true
				break
			}
		}
		if matched {
			matches = append(matches, session.ID)
		}
	}
	if len(matches) == 1 {
		return matches[0]
	}
	if len(matches) == 0 && len(rootSessions) == 1 {
		return rootSessions[0]
	}
	return ""
}

func GetWorkSession(db *sql.DB, workspaceID, sessionID string) (WorkSession, error) {
	return scanWorkSession(db.QueryRow(`
		SELECT `+workSessionColumns+`
		FROM work_sessions WHERE workspace_id = ? AND id = ?`,
		workspaceID, sessionID))
}

// AppendWorkSessionNoteByID records a running remark on a specific open
// session, which is required when several agents share one workspace.
func AppendWorkSessionNoteByID(db *sql.DB, workspaceID, sessionID, text string) error {
	var raw string
	if err := db.QueryRow(`
		SELECT notes FROM work_sessions
		WHERE workspace_id = ? AND id = ? AND ended_at = 0`,
		workspaceID, sessionID).Scan(&raw); err != nil {
		return err
	}
	notes := []SessionNote{}
	_ = json.Unmarshal([]byte(raw), &notes)
	notes = append(notes, SessionNote{TS: time.Now().UnixMilli(), Text: text})
	encoded, err := json.Marshal(notes)
	if err != nil {
		return err
	}
	result, err := db.Exec(`
		UPDATE work_sessions SET notes = ?
		WHERE workspace_id = ? AND id = ? AND ended_at = 0`,
		string(encoded), workspaceID, sessionID)
	if err != nil {
		return err
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// AppendWorkSessionNote is the legacy newest-session wrapper.
func AppendWorkSessionNote(db *sql.DB, workspaceID, text string) error {
	id := ActiveWorkSessionID(db, workspaceID)
	if id == "" {
		return sql.ErrNoRows
	}
	return AppendWorkSessionNoteByID(db, workspaceID, id, text)
}

func FinishWorkSessionByID(db *sql.DB, workspaceID, sessionID, summary string) error {
	result, err := db.Exec(`
		UPDATE work_sessions SET summary = ?, ended_at = ?
		WHERE workspace_id = ? AND id = ? AND ended_at = 0`,
		summary, time.Now().UnixMilli(), workspaceID, sessionID)
	if err != nil {
		return err
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// FinishWorkSession is the legacy newest-session wrapper.
func FinishWorkSession(db *sql.DB, workspaceID, summary string) (string, error) {
	id := ActiveWorkSessionID(db, workspaceID)
	if id == "" {
		return "", sql.ErrNoRows
	}
	return id, FinishWorkSessionByID(db, workspaceID, id, summary)
}

func GetActiveWorkSessions(db *sql.DB, workspaceID string) ([]WorkSession, error) {
	return getWorkSessions(db, workspaceID, `
		workspace_id = ? AND ended_at = 0`, workspaceID)
}

func GetActiveWorkSessionsForRoot(
	db *sql.DB,
	workspaceID, rootID, branch string,
) ([]WorkSession, error) {
	rootID, branch = completeHistoryIdentity(db, workspaceID, rootID, branch)
	return getWorkSessions(db, workspaceID, `
		workspace_id = ? AND ended_at = 0
		AND COALESCE(root_id, (
			SELECT r.id FROM roots r WHERE r.workspace_id=work_sessions.workspace_id
			ORDER BY r.is_primary DESC, r.is_active DESC, r.path LIMIT 1
		), '') = ?
		AND COALESCE(branch, (
			SELECT r.branch FROM roots r WHERE r.workspace_id=work_sessions.workspace_id
			ORDER BY r.is_primary DESC, r.is_active DESC, r.path LIMIT 1
		), '') = ?`, workspaceID, rootID, branch)
}

// GetWorkSessions returns sessions that overlap the delta window: anything
// still open, or anything that ran after the user last reviewed.
func GetWorkSessions(db *sql.DB, workspaceID string, since int64) ([]WorkSession, error) {
	return getWorkSessions(db, workspaceID, `
		workspace_id = ? AND (ended_at = 0 OR ended_at > ?)`, workspaceID, since)
}

func GetWorkSessionsForRoot(
	db *sql.DB,
	workspaceID, rootID, branch string,
	since int64,
) ([]WorkSession, error) {
	rootID, branch = completeHistoryIdentity(db, workspaceID, rootID, branch)
	return getWorkSessions(db, workspaceID, `
		workspace_id = ? AND (ended_at = 0 OR ended_at > ?)
		AND COALESCE(root_id, (
			SELECT r.id FROM roots r WHERE r.workspace_id=work_sessions.workspace_id
			ORDER BY r.is_primary DESC, r.is_active DESC, r.path LIMIT 1
		), '') = ?
		AND COALESCE(branch, (
			SELECT r.branch FROM roots r WHERE r.workspace_id=work_sessions.workspace_id
			ORDER BY r.is_primary DESC, r.is_active DESC, r.path LIMIT 1
		), '') = ?`, workspaceID, since, rootID, branch)
}

func getWorkSessions(db *sql.DB, workspaceID, where string, args ...any) ([]WorkSession, error) {
	rows, err := db.Query(`
		SELECT `+workSessionColumns+`
		FROM work_sessions WHERE `+where+`
		ORDER BY started_at ASC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	sessions := []WorkSession{}
	for rows.Next() {
		session, err := scanWorkSession(rows)
		if err != nil {
			return nil, err
		}
		sessions = append(sessions, session)
	}
	return sessions, rows.Err()
}
