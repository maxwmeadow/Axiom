// Package db — typed CRUD operations over the SQLite schema.
// All public functions take a *sql.DB directly (caller manages the connection).
package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ─── Models ───────────────────────────────────────────────────────────────────

type Workspace struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	OpenedAt int64  `json:"openedAt"`
}

type Root struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	Path        string `json:"path"`
	IndexedAt   *int64 `json:"indexedAt"`
}

type System struct {
	ID          string   `json:"id"`
	WorkspaceID string   `json:"workspaceId"`
	Name        string   `json:"name"`
	ParentID    *string  `json:"parentId"`
	Source      string   `json:"source"` // 'directory'|'user'|'agent'
	Color       *string  `json:"color"`
	Description *string  `json:"description"`
	AgentNotes  *string  `json:"agentNotes"`
	Depth       int      `json:"depth"`
	PositionX   float64  `json:"positionX"`
	PositionY   float64  `json:"positionY"`
	Width       *float64 `json:"width"`
	Height      *float64 `json:"height"`
	CreatedAt   int64    `json:"createdAt"`
	UpdatedAt   int64    `json:"updatedAt"`
}

type File struct {
	ID         string   `json:"id"`
	RootID     string   `json:"rootId"`
	Path       string   `json:"path"`
	RelPath    string   `json:"relPath"`
	Language   string   `json:"language"`
	SystemID   *string  `json:"systemId"`
	LineCount  int      `json:"lineCount"`
	ChurnScore float64  `json:"churnScore"`
	PositionX  float64  `json:"positionX"`
	PositionY  float64  `json:"positionY"`
	Width      *float64 `json:"width"`
	Height     *float64 `json:"height"`
	IndexedAt  int64    `json:"indexedAt"`
}

type Symbol struct {
	ID        string `json:"id"`
	FileID    string `json:"fileId"`
	Name      string `json:"name"`
	Kind      string `json:"kind"` // 'function'|'class'|'interface'|'type'|'variable'|'method'
	LineStart int    `json:"lineStart"`
	LineEnd   int    `json:"lineEnd"`
}

type Dependency struct {
	ID             string `json:"id"`
	WorkspaceID    string `json:"workspaceId"`
	Src            string `json:"src"`
	Dst            string `json:"dst"`
	SrcType        string `json:"srcType"` // 'file'|'system'|'infra'
	DstType        string `json:"dstType"`
	DependencyType string `json:"dependencyType"` // 'IMPORTS'|'CALLS'|'DEPENDS_ON'|'READS_DB'|'CONTAINS'
	Weight         int    `json:"weight"`
	CreatedBy      string `json:"createdBy"`
}

type InfraNode struct {
	ID          string          `json:"id"`
	WorkspaceID string          `json:"workspaceId"`
	Name        string          `json:"name"`
	InfraType   string          `json:"infraType"`
	Config      json.RawMessage `json:"config,omitempty"`
	PositionX   float64         `json:"positionX"`
	PositionY   float64         `json:"positionY"`
}

type ClassificationJob struct {
	ID              string `json:"id"`
	WorkspaceID     string `json:"workspaceId"`
	Status          string `json:"status"`
	TotalFiles      int    `json:"totalFiles"`
	ClassifiedFiles int    `json:"classifiedFiles"`
	Strategy        string `json:"strategy"`
	CreatedAt       int64  `json:"createdAt"`
	CompletedAt     *int64 `json:"completedAt"`
}

type ClassificationAssignment struct {
	ID             int64   `json:"id"`
	JobID          string  `json:"jobId"`
	FileID         string  `json:"fileId"`
	ProposedSystem string  `json:"proposedSystem"`
	ParentSystem   *string `json:"parentSystem"`
	Confidence     float64 `json:"confidence"`
	AgentReasoning *string `json:"agentReasoning"`
	Status         string  `json:"status"`
}

// BatchFile is the agent-facing view of a file used in classification batches.
type BatchFile struct {
	File
	Imports    []string `json:"imports"`
	ImportedBy []string `json:"importedBy"`
	Preview    string   `json:"preview"`
}

type CanvasSnapshot struct {
	WorkspaceID  string       `json:"workspaceId"`
	Systems      []System     `json:"systems"`
	Files        []File       `json:"files"`
	InfraNodes   []InfraNode  `json:"infraNodes"`
	Dependencies []Dependency `json:"dependencies"`
}

// ─── Workspaces ───────────────────────────────────────────────────────────────

func DeleteWorkspace(db *sql.DB, id string) error {
	_, err := db.Exec(`DELETE FROM workspaces WHERE id = ?`, id)
	return err
}

func UpsertWorkspace(db *sql.DB, w Workspace) error {
	_, err := db.Exec(`
		INSERT INTO workspaces (id, name, opened_at)
		VALUES (?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, opened_at=excluded.opened_at`,
		w.ID, w.Name, w.OpenedAt)
	return err
}

func GetWorkspace(db *sql.DB, id string) (*Workspace, error) {
	w := &Workspace{}
	err := db.QueryRow(`SELECT id, name, opened_at FROM workspaces WHERE id = ?`, id).
		Scan(&w.ID, &w.Name, &w.OpenedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return w, err
}

// ─── Roots ────────────────────────────────────────────────────────────────────

func UpsertRoot(db *sql.DB, r Root) error {
	_, err := db.Exec(`
		INSERT INTO roots (id, workspace_id, path, indexed_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET path=excluded.path`,
		r.ID, r.WorkspaceID, r.Path, r.IndexedAt)
	return err
}

func GetRoots(db *sql.DB, workspaceID string) ([]Root, error) {
	rows, err := db.Query(`SELECT id, workspace_id, path, indexed_at FROM roots WHERE workspace_id = ?`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var roots []Root
	for rows.Next() {
		var r Root
		if err := rows.Scan(&r.ID, &r.WorkspaceID, &r.Path, &r.IndexedAt); err != nil {
			return nil, err
		}
		roots = append(roots, r)
	}
	return roots, rows.Err()
}

func MarkRootIndexed(db *sql.DB, rootID string) error {
	now := time.Now().UnixMilli()
	_, err := db.Exec(`UPDATE roots SET indexed_at = ? WHERE id = ?`, now, rootID)
	return err
}

// ─── Systems ──────────────────────────────────────────────────────────────────

func UpsertSystem(db *sql.DB, s System) error {
	if s.ID == "" {
		s.ID = uuid.New().String()
	}
	now := time.Now().UnixMilli()
	if s.CreatedAt == 0 {
		s.CreatedAt = now
	}
	s.UpdatedAt = now
	_, err := db.Exec(`
		INSERT INTO systems
			(id, workspace_id, name, parent_id, source, color, description, agent_notes,
			 depth, position_x, position_y, width, height, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			name=excluded.name, parent_id=excluded.parent_id, source=excluded.source,
			color=excluded.color, description=excluded.description,
			agent_notes=excluded.agent_notes, depth=excluded.depth,
			position_x=excluded.position_x, position_y=excluded.position_y,
			width=excluded.width, height=excluded.height,
			updated_at=excluded.updated_at`,
		s.ID, s.WorkspaceID, s.Name, s.ParentID, s.Source, s.Color,
		s.Description, s.AgentNotes, s.Depth,
		s.PositionX, s.PositionY, s.Width, s.Height, s.CreatedAt, s.UpdatedAt)
	return err
}

func GetSystems(db *sql.DB, workspaceID string) ([]System, error) {
	rows, err := db.Query(`
		SELECT id, workspace_id, name, parent_id, source, color, description, agent_notes,
		       depth, position_x, position_y, width, height, created_at, updated_at
		FROM systems WHERE workspace_id = ? ORDER BY depth ASC, name ASC`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var systems []System
	for rows.Next() {
		var s System
		if err := rows.Scan(
			&s.ID, &s.WorkspaceID, &s.Name, &s.ParentID, &s.Source, &s.Color,
			&s.Description, &s.AgentNotes, &s.Depth,
			&s.PositionX, &s.PositionY, &s.Width, &s.Height, &s.CreatedAt, &s.UpdatedAt,
		); err != nil {
			return nil, err
		}
		systems = append(systems, s)
	}
	return systems, rows.Err()
}

func GetSystem(db *sql.DB, id string) (*System, error) {
	s := &System{}
	err := db.QueryRow(`
		SELECT id, workspace_id, name, parent_id, source, color, description, agent_notes,
		       depth, position_x, position_y, width, height, created_at, updated_at
		FROM systems WHERE id = ?`, id).Scan(
		&s.ID, &s.WorkspaceID, &s.Name, &s.ParentID, &s.Source, &s.Color,
		&s.Description, &s.AgentNotes, &s.Depth,
		&s.PositionX, &s.PositionY, &s.Width, &s.Height, &s.CreatedAt, &s.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return s, err
}

func DeleteSystem(db *sql.DB, id string) error {
	_, err := db.Exec(`DELETE FROM systems WHERE id = ?`, id)
	return err
}

// DeleteDirectorySystemsByWorkspace deletes auto-generated (source='directory') systems
// for a workspace so stale entries are removed before re-indexing.
// User-created systems (source='user') and agent systems are preserved.
func DeleteDirectorySystemsByWorkspace(db *sql.DB, workspaceID string) error {
	_, err := db.Exec(`DELETE FROM systems WHERE workspace_id=? AND source='directory'`, workspaceID)
	return err
}

// DeleteSystemsBySource deletes all systems with the given source value for a workspace.
func DeleteSystemsBySource(db *sql.DB, workspaceID, source string) error {
	_, err := db.Exec(`DELETE FROM systems WHERE workspace_id=? AND source=?`, workspaceID, source)
	return err
}

func UpdateSystemPosition(db *sql.DB, id string, x, y float64) error {
	_, err := db.Exec(`UPDATE systems SET position_x=?, position_y=? WHERE id=?`, x, y, id)
	return err
}

// GetOrCreateSystemByName returns an existing system with the given name and parent in the workspace,
// or creates a new one. Uses INSERT OR IGNORE + SELECT so it is safe under concurrent callers.
func GetOrCreateSystemByName(db *sql.DB, workspaceID, name, source string, parentID *string) (System, error) {
	depth := 0
	if parentID != nil {
		parent, perr := GetSystem(db, *parentID)
		if perr == nil && parent != nil {
			depth = parent.Depth + 1
		}
	}
	now := time.Now().UnixMilli()
	newID := uuid.New().String()

	// Attempt insert; the unique index on (workspace_id, COALESCE(parent_id,''), name)
	// silently ignores the insert if a row already exists — no race condition.
	_, err := db.Exec(`
		INSERT OR IGNORE INTO systems
			(id, workspace_id, name, parent_id, source, depth, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		newID, workspaceID, name, parentID, source, depth, now, now)
	if err != nil {
		return System{}, err
	}

	// Always SELECT the canonical row (could be the one we just inserted or a pre-existing one).
	var s System
	var selectErr error
	if parentID == nil {
		selectErr = db.QueryRow(`
			SELECT id, workspace_id, name, parent_id, source, color, description, agent_notes,
			       depth, position_x, position_y, created_at, updated_at
			FROM systems WHERE workspace_id=? AND name=? AND parent_id IS NULL
			LIMIT 1`, workspaceID, name).Scan(
			&s.ID, &s.WorkspaceID, &s.Name, &s.ParentID, &s.Source, &s.Color,
			&s.Description, &s.AgentNotes, &s.Depth,
			&s.PositionX, &s.PositionY, &s.CreatedAt, &s.UpdatedAt)
	} else {
		selectErr = db.QueryRow(`
			SELECT id, workspace_id, name, parent_id, source, color, description, agent_notes,
			       depth, position_x, position_y, created_at, updated_at
			FROM systems WHERE workspace_id=? AND name=? AND parent_id=?
			LIMIT 1`, workspaceID, name, *parentID).Scan(
			&s.ID, &s.WorkspaceID, &s.Name, &s.ParentID, &s.Source, &s.Color,
			&s.Description, &s.AgentNotes, &s.Depth,
			&s.PositionX, &s.PositionY, &s.CreatedAt, &s.UpdatedAt)
	}
	return s, selectErr
}

// ─── Files ────────────────────────────────────────────────────────────────────

func UpsertFile(db *sql.DB, f File) error {
	if f.ID == "" {
		f.ID = uuid.New().String()
	}
	if f.IndexedAt == 0 {
		f.IndexedAt = time.Now().UnixMilli()
	}
	_, err := db.Exec(`
		INSERT INTO files
			(id, root_id, path, rel_path, language, system_id, line_count,
			 churn_score, position_x, position_y, indexed_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(root_id, rel_path) DO UPDATE SET
			path=excluded.path, language=excluded.language, system_id=excluded.system_id,
			line_count=excluded.line_count, churn_score=excluded.churn_score,
			indexed_at=excluded.indexed_at
		-- width and height are intentionally NOT updated here so user resizes survive re-indexing`,
		f.ID, f.RootID, f.Path, f.RelPath, f.Language, f.SystemID, f.LineCount,
		f.ChurnScore, f.PositionX, f.PositionY, f.IndexedAt)
	return err
}

func GetFiles(db *sql.DB, workspaceID string) ([]File, error) {
	rows, err := db.Query(`
		SELECT f.id, f.root_id, f.path, f.rel_path, f.language, f.system_id,
		       f.line_count, f.churn_score, f.position_x, f.position_y, f.width, f.height, f.indexed_at
		FROM files f
		JOIN roots r ON r.id = f.root_id
		WHERE r.workspace_id = ?
		ORDER BY f.rel_path`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanFiles(rows)
}

func GetFilesByRoot(db *sql.DB, rootID string) ([]File, error) {
	rows, err := db.Query(`
		SELECT id, root_id, path, rel_path, language, system_id,
		       line_count, churn_score, position_x, position_y, width, height, indexed_at
		FROM files WHERE root_id = ? ORDER BY rel_path`, rootID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanFiles(rows)
}

func GetFileByRelPath(db *sql.DB, rootID, relPath string) (*File, error) {
	rows, err := db.Query(`
		SELECT id, root_id, path, rel_path, language, system_id,
		       line_count, churn_score, position_x, position_y, width, height, indexed_at
		FROM files WHERE root_id=? AND rel_path=?`, rootID, relPath)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	files, err := scanFiles(rows)
	if err != nil || len(files) == 0 {
		return nil, err
	}
	return &files[0], nil
}

// FindFileByIDOrPath resolves a file reference that may be a file ID, an exact
// relative path, or a path suffix (agents often pass "payment.py" or
// "services/payment.py" for "src/services/payment.py"). Backslashes are
// normalized. Returns nil without error when nothing matches.
func FindFileByIDOrPath(db *sql.DB, workspaceID, ref string) (*File, error) {
	const selectCols = `
		SELECT f.id, f.root_id, f.path, f.rel_path, f.language, f.system_id,
		       f.line_count, f.churn_score, f.position_x, f.position_y, f.width, f.height, f.indexed_at
		FROM files f
		JOIN roots r ON r.id = f.root_id
		WHERE r.workspace_id = ?`

	query := func(clause string, args ...any) ([]File, error) {
		rows, err := db.Query(selectCols+clause, append([]any{workspaceID}, args...)...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		return scanFiles(rows)
	}

	// 1. Exact ID.
	files, err := query(` AND f.id = ?`, ref)
	if err != nil {
		return nil, err
	}
	if len(files) > 0 {
		return &files[0], nil
	}

	// 2. Exact relative path (normalized to forward slashes).
	norm := strings.ReplaceAll(ref, "\\", "/")
	files, err = query(` AND f.rel_path = ?`, norm)
	if err != nil {
		return nil, err
	}
	if len(files) > 0 {
		return &files[0], nil
	}

	// 3. Suffix match on a path-segment boundary; prefer the shortest rel_path
	// (the closest match to the given suffix) when several files match.
	files, err = query(` AND f.rel_path LIKE ? ORDER BY LENGTH(f.rel_path) ASC`, "%/"+norm)
	if err != nil {
		return nil, err
	}
	if len(files) > 0 {
		return &files[0], nil
	}
	return nil, nil
}

func AssignFileToSystem(db *sql.DB, fileID, systemID string) error {
	_, err := db.Exec(`UPDATE files SET system_id=? WHERE id=?`, systemID, fileID)
	return err
}

func UpdateFilePosition(db *sql.DB, id string, x, y float64) error {
	_, err := db.Exec(`UPDATE files SET position_x=?, position_y=? WHERE id=?`, x, y, id)
	return err
}

func UpdateFileSize(db *sql.DB, id string, w, h float64) error {
	_, err := db.Exec(`UPDATE files SET width=?, height=? WHERE id=?`, w, h, id)
	return err
}

func DeleteFilesByRoot(db *sql.DB, rootID string) error {
	_, err := db.Exec(`DELETE FROM files WHERE root_id=?`, rootID)
	return err
}

// DeleteFilesByWorkspace deletes all files for every root belonging to a workspace.
// Used before re-indexing to wipe stale rows from prior runs (which may have used different root IDs).
func DeleteFilesByWorkspace(db *sql.DB, workspaceID string) error {
	_, err := db.Exec(`DELETE FROM files WHERE root_id IN (SELECT id FROM roots WHERE workspace_id=?)`, workspaceID)
	return err
}

func scanFiles(rows *sql.Rows) ([]File, error) {
	var files []File
	for rows.Next() {
		var f File
		if err := rows.Scan(
			&f.ID, &f.RootID, &f.Path, &f.RelPath, &f.Language, &f.SystemID,
			&f.LineCount, &f.ChurnScore, &f.PositionX, &f.PositionY, &f.Width, &f.Height, &f.IndexedAt,
		); err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	return files, rows.Err()
}

// ─── Symbols ──────────────────────────────────────────────────────────────────

func UpsertSymbols(db *sql.DB, fileID string, symbols []Symbol) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err := tx.Exec(`DELETE FROM symbols WHERE file_id=?`, fileID); err != nil {
		return err
	}
	for _, s := range symbols {
		if s.ID == "" {
			s.ID = uuid.New().String()
		}
		if _, err := tx.Exec(`
			INSERT INTO symbols (id, file_id, name, kind, line_start, line_end)
			VALUES (?,?,?,?,?,?)`,
			s.ID, fileID, s.Name, s.Kind, s.LineStart, s.LineEnd); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// VarRefRow is a stored variable reference. For kind 'read', one row
// aggregates all reads of a variable in a file (Count>1, Line = first read).
type VarRefRow struct {
	FileID          string `json:"fileId"`
	Variable        string `json:"variable"`
	Kind            string `json:"kind"`
	Line            int    `json:"line"`
	Count           int    `json:"count"`
	EnclosingSymbol string `json:"enclosingSymbol"`
}

// UpsertVarRefs replaces a file's variable references. def/param/write rows are
// stored per-occurrence; 'read' rows are aggregated to one per (variable) with
// a count, since reads dominate and per-occurrence storage would explode the
// table (the data-flow API re-parses for exact read lines on demand).
func UpsertVarRefs(db *sql.DB, fileID string, refs []VarRefRow) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err := tx.Exec(`DELETE FROM variable_refs WHERE file_id=?`, fileID); err != nil {
		return err
	}
	stmt, err := tx.Prepare(`
		INSERT INTO variable_refs (file_id, variable, kind, line, count, enclosing_symbol)
		VALUES (?,?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, r := range refs {
		if _, err := stmt.Exec(fileID, r.Variable, r.Kind, r.Line, r.Count, r.EnclosingSymbol); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// VariableFileHit summarizes one file's involvement with a variable.
type VariableFileHit struct {
	FileID   string `json:"fileId"`
	RelPath  string `json:"relPath"`
	Path     string `json:"-"` // absolute path, for on-demand re-parsing
	Language string `json:"language"`
	Defs     int    `json:"defs"`
	Params   int    `json:"params"`
	Writes   int    `json:"writes"`
	Reads    int    `json:"reads"`
}

// GetVariableFileHits returns every file in the workspace that references the
// named variable, with per-kind counts, most-written first. This is the
// candidate set the data-flow API re-parses for exact lines.
func GetVariableFileHits(db *sql.DB, workspaceID, variable string) ([]VariableFileHit, error) {
	rows, err := db.Query(`
		SELECT f.id, f.rel_path, f.path, f.language,
		       SUM(CASE WHEN vr.kind='def'   THEN vr.count ELSE 0 END) AS defs,
		       SUM(CASE WHEN vr.kind='param' THEN vr.count ELSE 0 END) AS params,
		       SUM(CASE WHEN vr.kind='write' THEN vr.count ELSE 0 END) AS writes,
		       SUM(CASE WHEN vr.kind='read'  THEN vr.count ELSE 0 END) AS reads
		FROM variable_refs vr
		JOIN files f ON f.id = vr.file_id
		JOIN roots r ON r.id = f.root_id
		WHERE r.workspace_id = ? AND vr.variable = ?
		GROUP BY f.id
		ORDER BY writes DESC, defs DESC, reads DESC`, workspaceID, variable)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var hits []VariableFileHit
	for rows.Next() {
		var h VariableFileHit
		if err := rows.Scan(&h.FileID, &h.RelPath, &h.Path, &h.Language, &h.Defs, &h.Params, &h.Writes, &h.Reads); err != nil {
			return nil, err
		}
		hits = append(hits, h)
	}
	return hits, rows.Err()
}

// ─── Investigation captures (Phase 8) ──────────────────────────────────────────

// InvestigationMeta is the list-view summary of a saved investigation (no events).
type InvestigationMeta struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Commit     string `json:"commit"`
	Branch     string `json:"branch"`
	CreatedAt  int64  `json:"createdAt"`
	DurationMs int64  `json:"durationMs"`
	EventCount int    `json:"eventCount"`
}

// SaveInvestigation persists a captured investigation. `data` is the full
// AxiomTrace JSON document.
func SaveInvestigation(db *sql.DB, id, workspaceID, name, commit, branch string, createdAt, durationMs int64, eventCount int, data []byte) error {
	_, err := db.Exec(`
		INSERT OR REPLACE INTO investigations
		  (id, workspace_id, name, commit_sha, branch, created_at, duration_ms, event_count, data)
		VALUES (?,?,?,?,?,?,?,?,?)`,
		id, workspaceID, name, commit, branch, createdAt, durationMs, eventCount, string(data))
	return err
}

// ListInvestigations returns saved investigations for a workspace, newest first.
func ListInvestigations(db *sql.DB, workspaceID string) ([]InvestigationMeta, error) {
	rows, err := db.Query(`
		SELECT id, name, commit_sha, branch, created_at, duration_ms, event_count
		FROM investigations WHERE workspace_id=? ORDER BY created_at DESC`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]InvestigationMeta, 0)
	for rows.Next() {
		var m InvestigationMeta
		if err := rows.Scan(&m.ID, &m.Name, &m.Commit, &m.Branch, &m.CreatedAt, &m.DurationMs, &m.EventCount); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// GetInvestigation returns the full AxiomTrace JSON for one investigation, or
// nil if not found.
func GetInvestigation(db *sql.DB, id string) (json.RawMessage, error) {
	var data string
	err := db.QueryRow(`SELECT data FROM investigations WHERE id=?`, id).Scan(&data)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return json.RawMessage(data), nil
}

// DeleteInvestigation removes a saved investigation.
func DeleteInvestigation(db *sql.DB, id string) error {
	_, err := db.Exec(`DELETE FROM investigations WHERE id=?`, id)
	return err
}

func GetSymbolsByFile(db *sql.DB, fileID string) ([]Symbol, error) {
	rows, err := db.Query(`
		SELECT id, file_id, name, kind, line_start, line_end
		FROM symbols WHERE file_id=? ORDER BY line_start`, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var symbols []Symbol
	for rows.Next() {
		var s Symbol
		if err := rows.Scan(&s.ID, &s.FileID, &s.Name, &s.Kind, &s.LineStart, &s.LineEnd); err != nil {
			return nil, err
		}
		symbols = append(symbols, s)
	}
	return symbols, rows.Err()
}

// GetSymbolsByRoot returns all symbols for every file in a root, keyed by file ID.
// Single query instead of one-per-file for efficient bulk use during clustering.
func GetSymbolsByRoot(sqlDB *sql.DB, rootID string) (map[string][]Symbol, error) {
	rows, err := sqlDB.Query(`
		SELECT s.id, s.file_id, s.name, s.kind, s.line_start, s.line_end
		FROM symbols s
		JOIN files f ON s.file_id = f.id
		WHERE f.root_id = ?`, rootID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string][]Symbol)
	for rows.Next() {
		var s Symbol
		if err := rows.Scan(&s.ID, &s.FileID, &s.Name, &s.Kind, &s.LineStart, &s.LineEnd); err != nil {
			return nil, err
		}
		result[s.FileID] = append(result[s.FileID], s)
	}
	return result, rows.Err()
}

// ─── Dependencies ─────────────────────────────────────────────────────────────

func UpsertDependency(db *sql.DB, d Dependency) error {
	if d.ID == "" {
		d.ID = uuid.New().String()
	}
	if d.Weight == 0 {
		d.Weight = 1
	}
	if d.CreatedBy == "" {
		d.CreatedBy = "parser"
	}
	_, err := db.Exec(`
		INSERT INTO dependencies (id, workspace_id, src, dst, src_type, dst_type, dependency_type, weight, created_by)
		VALUES (?,?,?,?,?,?,?,?,?)
		ON CONFLICT(src, dst, dependency_type) DO UPDATE SET weight=weight+1`,
		d.ID, d.WorkspaceID, d.Src, d.Dst, d.SrcType, d.DstType, d.DependencyType, d.Weight, d.CreatedBy)
	return err
}

func GetDependencies(db *sql.DB, workspaceID string) ([]Dependency, error) {
	rows, err := db.Query(`
		SELECT id, workspace_id, src, dst, src_type, dst_type, dependency_type, weight, created_by
		FROM dependencies WHERE workspace_id=?`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var deps []Dependency
	for rows.Next() {
		var d Dependency
		if err := rows.Scan(
			&d.ID, &d.WorkspaceID, &d.Src, &d.Dst,
			&d.SrcType, &d.DstType, &d.DependencyType, &d.Weight, &d.CreatedBy,
		); err != nil {
			return nil, err
		}
		deps = append(deps, d)
	}
	return deps, rows.Err()
}

func DeleteDependenciesByFile(db *sql.DB, fileID string) error {
	_, err := db.Exec(`DELETE FROM dependencies WHERE src=? OR dst=?`, fileID, fileID)
	return err
}

// ─── Infra ────────────────────────────────────────────────────────────────────

func UpsertInfraNode(db *sql.DB, n InfraNode) error {
	if n.ID == "" {
		n.ID = uuid.New().String()
	}
	_, err := db.Exec(`
		INSERT INTO infra_nodes (id, workspace_id, name, infra_type, config, position_x, position_y)
		VALUES (?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			name=excluded.name, infra_type=excluded.infra_type,
			config=excluded.config, position_x=excluded.position_x, position_y=excluded.position_y`,
		n.ID, n.WorkspaceID, n.Name, n.InfraType, n.Config, n.PositionX, n.PositionY)
	return err
}

func GetInfraNodes(db *sql.DB, workspaceID string) ([]InfraNode, error) {
	rows, err := db.Query(`
		SELECT id, workspace_id, name, infra_type, config, position_x, position_y
		FROM infra_nodes WHERE workspace_id=?`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var nodes []InfraNode
	for rows.Next() {
		var n InfraNode
		if err := rows.Scan(
			&n.ID, &n.WorkspaceID, &n.Name, &n.InfraType, &n.Config, &n.PositionX, &n.PositionY,
		); err != nil {
			return nil, err
		}
		nodes = append(nodes, n)
	}
	return nodes, rows.Err()
}

// ─── Canvas snapshot ──────────────────────────────────────────────────────────

func GetCanvasSnapshot(db *sql.DB, workspaceID string) (*CanvasSnapshot, error) {
	systems, err := GetSystems(db, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("get systems: %w", err)
	}
	files, err := GetFiles(db, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("get files: %w", err)
	}
	infra, err := GetInfraNodes(db, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("get infra: %w", err)
	}
	dependencies, err := GetDependencies(db, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("get dependencies: %w", err)
	}
	return &CanvasSnapshot{
		WorkspaceID:  workspaceID,
		Systems:      systems,
		Files:        files,
		InfraNodes:   infra,
		Dependencies: dependencies,
	}, nil
}

// ─── Classification ───────────────────────────────────────────────────────────

func CreateClassificationJob(db *sql.DB, workspaceID, strategy string) (ClassificationJob, error) {
	var count int
	if err := db.QueryRow(`
		SELECT COUNT(*) FROM files f
		JOIN roots r ON r.id = f.root_id
		WHERE r.workspace_id=?`, workspaceID).Scan(&count); err != nil {
		return ClassificationJob{}, err
	}
	job := ClassificationJob{
		ID:          uuid.New().String(),
		WorkspaceID: workspaceID,
		Status:      "pending",
		TotalFiles:  count,
		Strategy:    strategy,
		CreatedAt:   time.Now().UnixMilli(),
	}
	_, err := db.Exec(`
		INSERT INTO classification_jobs
			(id, workspace_id, status, total_files, classified_files, strategy, created_at)
		VALUES (?,?,?,?,0,?,?)`,
		job.ID, job.WorkspaceID, job.Status, job.TotalFiles, job.Strategy, job.CreatedAt)
	return job, err
}

func GetClassificationJob(db *sql.DB, jobID string) (*ClassificationJob, error) {
	job := &ClassificationJob{}
	err := db.QueryRow(`
		SELECT id, workspace_id, status, total_files, classified_files, strategy, created_at, completed_at
		FROM classification_jobs WHERE id=?`, jobID).Scan(
		&job.ID, &job.WorkspaceID, &job.Status, &job.TotalFiles, &job.ClassifiedFiles,
		&job.Strategy, &job.CreatedAt, &job.CompletedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return job, err
}

// GetNextClassificationBatch returns files that have not yet been proposed in this job,
// ordered by import cluster connectivity (files with most dependencies first).
func GetNextClassificationBatch(db *sql.DB, jobID, workspaceID string, batchSize int) ([]BatchFile, error) {
	if batchSize <= 0 {
		batchSize = 15
	}
	rows, err := db.Query(`
		SELECT f.id, f.root_id, f.path, f.rel_path, f.language, f.system_id,
		       f.line_count, f.churn_score, f.position_x, f.position_y, f.indexed_at
		FROM files f
		JOIN roots r ON r.id = f.root_id
		WHERE r.workspace_id = ?
		  AND f.id NOT IN (
			  SELECT file_id FROM classification_assignments WHERE job_id = ?
			)
		ORDER BY (
			SELECT COUNT(*) FROM dependencies d WHERE d.src = f.id OR d.dst = f.id
		) DESC
		LIMIT ?`, workspaceID, jobID, batchSize)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	files, err := scanFiles(rows)
	if err != nil {
		return nil, err
	}
	batch := make([]BatchFile, 0, len(files))
	for _, f := range files {
		bf := BatchFile{File: f}
		// gather immediate import dependencies for context
		bf.Imports, _ = getImportTargets(db, f.ID)
		bf.ImportedBy, _ = getImportSources(db, f.ID)
		batch = append(batch, bf)
	}
	return batch, nil
}

func getImportTargets(db *sql.DB, fileID string) ([]string, error) {
	rows, err := db.Query(`
		SELECT f.rel_path FROM dependencies d
		JOIN files f ON f.id = d.dst
		WHERE d.src=? AND d.dependency_type='IMPORTS'`, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanStringColumn(rows)
}

func getImportSources(db *sql.DB, fileID string) ([]string, error) {
	rows, err := db.Query(`
		SELECT f.rel_path FROM dependencies d
		JOIN files f ON f.id = d.src
		WHERE d.dst=? AND d.dependency_type='IMPORTS'`, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanStringColumn(rows)
}

func scanStringColumn(rows *sql.Rows) ([]string, error) {
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// SubmitClassificationAssignments persists agent proposals for a batch.
// For each assignment, it finds or creates the proposed system and updates the file.
func SubmitClassificationAssignments(db *sql.DB, jobID string, assignments []ClassificationAssignment) error {
	job, err := GetClassificationJob(db, jobID)
	if err != nil || job == nil {
		return fmt.Errorf("job not found: %s", jobID)
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	for _, a := range assignments {
		if a.JobID == "" {
			a.JobID = jobID
		}
		// Resolve or create the target system
		sys, serr := GetOrCreateSystemByName(db, job.WorkspaceID, a.ProposedSystem, "agent", a.ParentSystem)
		if serr != nil {
			return fmt.Errorf("resolve system %q: %w", a.ProposedSystem, serr)
		}
		// Assign the file to the system
		if _, err := tx.Exec(`UPDATE files SET system_id=? WHERE id=?`, sys.ID, a.FileID); err != nil {
			return err
		}
		// Record the proposal
		if _, err := tx.Exec(`
			INSERT INTO classification_assignments
				(job_id, file_id, proposed_system, parent_system, confidence, agent_reasoning, status)
			VALUES (?,?,?,?,?,?,?)`,
			a.JobID, a.FileID, a.ProposedSystem, a.ParentSystem,
			a.Confidence, a.AgentReasoning, "accepted"); err != nil {
			return err
		}
	}
	// Update classified_files count
	if _, err := tx.Exec(`
		UPDATE classification_jobs
		SET classified_files = (
			SELECT COUNT(*) FROM classification_assignments WHERE job_id=? AND status='accepted'
		),
		status = CASE
			WHEN (SELECT COUNT(*) FROM classification_assignments WHERE job_id=? AND status='accepted')
			     >= total_files THEN 'complete'
			ELSE 'running'
		END,
		completed_at = CASE
			WHEN (SELECT COUNT(*) FROM classification_assignments WHERE job_id=? AND status='accepted')
			     >= total_files THEN ?
			ELSE completed_at
		END
		WHERE id=?`,
		jobID, jobID, jobID, time.Now().UnixMilli(), jobID); err != nil {
		return err
	}
	return tx.Commit()
}

// ─── Call graph ───────────────────────────────────────────────────────────────

type CallEdge struct {
	CallerFile   string `json:"callerFile"`
	CallerSymbol string `json:"callerSymbol"`
	CalleeFile   string `json:"calleeFile"`
	CalleeSymbol string `json:"calleeSymbol"`
	CallCount    int    `json:"callCount"`
}

func UpsertCallEdges(db *sql.DB, fileID string, calls []CallEdge) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err := tx.Exec(`DELETE FROM call_graph WHERE caller_file=?`, fileID); err != nil {
		return err
	}
	for _, c := range calls {
		if _, err := tx.Exec(`
			INSERT INTO call_graph (caller_file, caller_symbol, callee_file, callee_symbol, call_count)
			VALUES (?,?,?,?,?)`,
			c.CallerFile, c.CallerSymbol, c.CalleeFile, c.CalleeSymbol, c.CallCount); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// GetCallPath returns the symbol-level call path from callerFile to calleeFile.
// It does a BFS up to maxDepth hops through the call_graph table.
func GetCallPath(db *sql.DB, fromFileID, toFileID string, maxDepth int) ([]CallEdge, error) {
	if maxDepth <= 0 {
		maxDepth = 6
	}
	type state struct {
		fileID string
		path   []CallEdge
	}
	visited := map[string]bool{fromFileID: true}
	queue := []state{{fileID: fromFileID, path: nil}}
	for depth := 0; depth < maxDepth && len(queue) > 0; depth++ {
		next := queue[:0]
		for _, s := range queue {
			rows, err := db.Query(`
				SELECT caller_file, caller_symbol, callee_file, callee_symbol, call_count
				FROM call_graph WHERE caller_file=?`, s.fileID)
			if err != nil {
				return nil, err
			}
			for rows.Next() {
				var e CallEdge
				if err := rows.Scan(&e.CallerFile, &e.CallerSymbol, &e.CalleeFile, &e.CalleeSymbol, &e.CallCount); err != nil {
					rows.Close()
					return nil, err
				}
				newPath := append(append([]CallEdge{}, s.path...), e)
				if e.CalleeFile == toFileID {
					rows.Close()
					return newPath, nil
				}
				if !visited[e.CalleeFile] {
					visited[e.CalleeFile] = true
					next = append(next, state{fileID: e.CalleeFile, path: newPath})
				}
			}
			rows.Close()
		}
		queue = next
	}
	return []CallEdge{}, nil // no path found
}

// ─── Utilities ────────────────────────────────────────────────────────────────

// PlaceholderN returns a comma-separated list of n SQLite placeholders: ?,?,?...
func PlaceholderN(n int) string {
	s := make([]string, n)
	for i := range s {
		s[i] = "?"
	}
	return strings.Join(s, ",")
}
