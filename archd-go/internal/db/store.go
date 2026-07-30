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

	"axiom.local/archd/internal/activity"
)

// ─── Models ───────────────────────────────────────────────────────────────────

type Workspace struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	OpenedAt int64  `json:"openedAt"`
}

type Root struct {
	ID                         string   `json:"id"`
	WorkspaceID                string   `json:"workspaceId"`
	Path                       string   `json:"path"`
	IndexedAt                  *int64   `json:"indexedAt"`
	ClassifierVersion          int      `json:"classifierVersion"`
	IgnoredPaths               []string `json:"ignoredPaths"`
	SourceBoundariesReviewedAt *int64   `json:"sourceBoundariesReviewedAt"`
}

type System struct {
	ID          string   `json:"id"`
	WorkspaceID string   `json:"workspaceId"`
	Name        string   `json:"name"`
	ParentID    *string  `json:"parentId"`
	Source      string   `json:"source"` // 'cluster'|'user'|'agent' ('directory' is legacy auto-owned)
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
	ID       string  `json:"id"`
	RootID   string  `json:"rootId"`
	Path     string  `json:"path"`
	RelPath  string  `json:"relPath"`
	Language string  `json:"language"`
	SystemID *string `json:"systemId"`
	// ChurnScore is the DISPLAY value: the 0..1 percentile rank of this file's
	// decayed activity within the workspace, computed on read (snapshot) or on
	// burst (live patch). Not persisted as-is.
	ChurnScore float64 `json:"churnScore"`
	// ActivityScore/ActivityAt are the raw decayed-score anchor pair persisted
	// by the activity engine (internal/activity). ContentHash detects
	// no-op saves so formatters never register as activity.
	ActivityScore float64 `json:"activityScore"`
	ActivityAt    int64   `json:"activityAt"`
	ContentHash   string  `json:"-"`
	// Shape is the inferred semantic role (''=plain box | 'class' | 'cylinder'
	// data store | 'hexagon' service); ShapeOverride wins when set;
	// DisplayName is the class-first title for shape='class'.
	Shape         string   `json:"shape"`
	ShapeOverride string   `json:"shapeOverride"`
	DisplayName   string   `json:"displayName"`
	LineCount     int      `json:"lineCount"`
	PositionX     float64  `json:"positionX"`
	PositionY     float64  `json:"positionY"`
	Width         *float64 `json:"width"`
	Height        *float64 `json:"height"`
	IndexedAt     int64    `json:"indexedAt"`
}

type Symbol struct {
	ID        string `json:"id"`
	FileID    string `json:"fileId"`
	Name      string `json:"name"`
	Kind      string `json:"kind"` // 'function'|'class'|'interface'|'type'|'variable'|'method'
	LineStart int    `json:"lineStart"`
	LineEnd   int    `json:"lineEnd"`
	BodyHash  string `json:"-"`
}

type Dependency struct {
	ID             string  `json:"id"`
	WorkspaceID    string  `json:"workspaceId"`
	Src            string  `json:"src"`
	Dst            string  `json:"dst"`
	SrcType        string  `json:"srcType"` // 'file'|'system'|'infra'
	DstType        string  `json:"dstType"`
	DependencyType string  `json:"dependencyType"` // 'IMPORTS'|'CALLS'|'DEPENDS_ON'|... + infra kinds ('READS'|'WRITES'|'PUBLISHES'|...)
	Weight         int     `json:"weight"`
	CreatedBy      string  `json:"createdBy"`
	Evidence       *string `json:"evidence,omitempty"` // file:line justifying the edge (infra edges)
}

type InfraNode struct {
	ID          string          `json:"id"`
	WorkspaceID string          `json:"workspaceId"`
	Name        string          `json:"name"`
	InfraType   string          `json:"infraType"` // DEPRECATED — superseded by Category/Provider/Service
	Category    string          `json:"category"`  // 'database'|'cache'|'queue'|... (registry.Categories)
	Provider    string          `json:"provider"`  // 'aws'|'openai'|'generic'|...
	Service     string          `json:"service"`   // registry id 'aws/rds'; '' = unassigned generic
	Subtype     string          `json:"subtype"`   // category-specific ('sql'|'document'|'kv'|...)
	Status      string          `json:"status"`    // 'proposed'|'confirmed'|'dismissed'
	DetectedBy  json.RawMessage `json:"detectedBy,omitempty"`
	Config      json.RawMessage `json:"config,omitempty"`
	PositionX   float64         `json:"positionX"`
	PositionY   float64         `json:"positionY"`
}

type CanvasSnapshot struct {
	WorkspaceID  string        `json:"workspaceId"`
	Systems      []System      `json:"systems"`
	Files        []File        `json:"files"`
	InfraNodes   []InfraNode   `json:"infraNodes"`
	Dependencies []Dependency  `json:"dependencies"`
	FloorLayouts []FloorLayout `json:"floorLayouts"`
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
	ignoredJSON, err := json.Marshal(r.IgnoredPaths)
	if err != nil {
		return fmt.Errorf("encode ignored paths: %w", err)
	}
	_, err = db.Exec(`
		INSERT INTO roots
			(id, workspace_id, path, indexed_at, classifier_version,
			 ignored_paths_json, source_boundaries_reviewed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			path=excluded.path,
			ignored_paths_json=excluded.ignored_paths_json,
			source_boundaries_reviewed_at=COALESCE(
				excluded.source_boundaries_reviewed_at,
				roots.source_boundaries_reviewed_at
			)`,
		r.ID, r.WorkspaceID, r.Path, r.IndexedAt, r.ClassifierVersion,
		string(ignoredJSON), r.SourceBoundariesReviewedAt)
	return err
}

func GetRoots(db *sql.DB, workspaceID string) ([]Root, error) {
	rows, err := db.Query(`
		SELECT id, workspace_id, path, indexed_at, classifier_version,
		       ignored_paths_json, source_boundaries_reviewed_at
		FROM roots WHERE workspace_id = ?`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var roots []Root
	for rows.Next() {
		var r Root
		var ignoredJSON string
		if err := rows.Scan(
			&r.ID, &r.WorkspaceID, &r.Path, &r.IndexedAt, &r.ClassifierVersion,
			&ignoredJSON, &r.SourceBoundariesReviewedAt,
		); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(ignoredJSON), &r.IgnoredPaths); err != nil {
			return nil, fmt.Errorf("decode ignored paths for root %s: %w", r.ID, err)
		}
		roots = append(roots, r)
	}
	return roots, rows.Err()
}

func MarkRootIndexed(db *sql.DB, rootID string, classifierVersion int) error {
	now := time.Now().UnixMilli()
	_, err := db.Exec(`UPDATE roots SET indexed_at = ?, classifier_version = ? WHERE id = ?`, now, classifierVersion, rootID)
	return err
}

func MarkRootClassifierVersion(db *sql.DB, rootID string, classifierVersion int) error {
	_, err := db.Exec(`UPDATE roots SET classifier_version = ? WHERE id = ?`, classifierVersion, rootID)
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

// FileSystemAssignment is one semantic ownership change produced by the
// clustering planner. A nil SystemID deliberately leaves the file visible at
// the Floor root until the classifier has a credible group for it.
type FileSystemAssignment struct {
	FileID   string
	SystemID *string
}

// ApplyClusterPlan commits one complete auto-classification reconciliation.
//
// Cluster systems use stable IDs, so the conflict path intentionally updates
// only classifier-owned fields. Authored color, notes, geometry, and creation
// time survive every live recluster. Files are moved before stale systems are
// removed, preventing ON DELETE SET NULL from producing an observable partial
// state. The whole plan is transactional so snapshots can never see half of a
// new architecture.
func ApplyClusterPlan(
	db *sql.DB,
	workspaceID string,
	systems []System,
	assignments []FileSystemAssignment,
	staleSystemIDs []string,
) (err error) {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	now := time.Now().UnixMilli()
	for _, system := range systems {
		createdAt := system.CreatedAt
		if createdAt == 0 {
			createdAt = now
		}
		if _, err = tx.Exec(`
			INSERT INTO systems
				(id, workspace_id, name, parent_id, source, color, description, agent_notes,
				 depth, position_x, position_y, width, height, created_at, updated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
			ON CONFLICT(id) DO UPDATE SET
				name=excluded.name,
				parent_id=excluded.parent_id,
				source='cluster',
				depth=excluded.depth,
				updated_at=excluded.updated_at
			WHERE systems.source IN ('cluster','directory')`,
			system.ID, workspaceID, system.Name, system.ParentID, "cluster",
			system.Color, system.Description, system.AgentNotes, system.Depth,
			system.PositionX, system.PositionY, system.Width, system.Height,
			createdAt, now,
		); err != nil {
			return fmt.Errorf("upsert cluster system %q: %w", system.Name, err)
		}
	}

	layoutChanged := false
	for _, assignment := range assignments {
		// A prior classifier can leave root/part-of layout containment that
		// contradicts semantic ownership. Remove only those contradictory
		// semantic layouts; hosted_by is deliberately visual-only and survives.
		result, deleteErr := tx.Exec(`
			DELETE FROM floor_layouts
			WHERE workspace_id=? AND node_type='file' AND node_id=?
			  AND containment_kind IN ('root','part_of')
			  AND COALESCE(
				CASE
					WHEN containment_kind='part_of' AND parent_node_type='system'
					THEN parent_node_id
					ELSE ''
				END,
				''
			  ) <> COALESCE(?, '')`,
			workspaceID, assignment.FileID, assignment.SystemID,
		)
		if deleteErr != nil {
			return fmt.Errorf("reconcile clustered file layout %s: %w", assignment.FileID, deleteErr)
		}
		if affected, affectedErr := result.RowsAffected(); affectedErr == nil && affected > 0 {
			layoutChanged = true
		}

		if _, err = tx.Exec(`
			UPDATE files
			SET system_id=?
			WHERE id=? AND root_id IN (
				SELECT id FROM roots WHERE workspace_id=?
			)
			AND (
				system_id IS NULL OR system_id IN (
					SELECT id FROM systems WHERE source IN ('cluster','directory')
				)
			)`,
			assignment.SystemID, assignment.FileID, workspaceID,
		); err != nil {
			return fmt.Errorf("assign clustered file %s: %w", assignment.FileID, err)
		}
	}

	for _, id := range staleSystemIDs {
		result, deleteErr := tx.Exec(`
			DELETE FROM systems
			WHERE id=? AND workspace_id=? AND source IN ('cluster','directory')`,
			id, workspaceID,
		)
		if deleteErr != nil {
			return fmt.Errorf("delete stale cluster system %s: %w", id, deleteErr)
		}
		if affected, affectedErr := result.RowsAffected(); affectedErr == nil && affected > 0 {
			layoutChanged = true
		}
	}

	if layoutChanged {
		if _, err = tx.Exec(`
			INSERT INTO floor_layout_revisions(workspace_id,revision) VALUES(?,1)
			ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1`,
			workspaceID,
		); err != nil {
			return fmt.Errorf("advance floor layout revision: %w", err)
		}
	}

	if err = tx.Commit(); err != nil {
		return err
	}
	return nil
}

func UpdateSystemPosition(db *sql.DB, id string, x, y float64) error {
	_, err := db.Exec(`UPDATE systems SET position_x=?, position_y=? WHERE id=?`, x, y, id)
	return err
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
			 churn_score, shape, display_name, position_x, position_y, indexed_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(root_id, rel_path) DO UPDATE SET
			path=excluded.path, language=excluded.language,
			system_id=COALESCE(excluded.system_id, files.system_id),
			line_count=excluded.line_count,
			shape=excluded.shape, display_name=excluded.display_name,
			indexed_at=excluded.indexed_at
		-- width/height are NOT updated so user resizes survive re-indexing.
		-- system_id COALESCEs so a watcher re-parse (which passes nil) never
		-- unassigns a file from its system.
		-- churn_score/activity_* are owned by the activity engine and never
		-- touched here.`,
		f.ID, f.RootID, f.Path, f.RelPath, f.Language, f.SystemID, f.LineCount,
		f.ChurnScore, f.Shape, f.DisplayName, f.PositionX, f.PositionY, f.IndexedAt)
	return err
}

// UpdateFileActivity persists the raw decayed-score anchor + content hash.
func UpdateFileActivity(db *sql.DB, fileID string, score float64, atMs int64, contentHash string) error {
	_, err := db.Exec(`UPDATE files SET activity_score=?, activity_at=?, content_hash=? WHERE id=?`,
		score, atMs, contentHash, fileID)
	return err
}

func GetFiles(db *sql.DB, workspaceID string) ([]File, error) {
	rows, err := db.Query(`
		SELECT f.id, f.root_id, f.path, f.rel_path, f.language, f.system_id,
		       f.line_count, f.churn_score, f.activity_score, f.activity_at, f.content_hash,
		       f.shape, f.shape_override, f.display_name,
		       f.position_x, f.position_y, f.width, f.height, f.indexed_at
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
		       line_count, churn_score, activity_score, activity_at, content_hash,
		       shape, shape_override, display_name,
		       position_x, position_y, width, height, indexed_at
		FROM files WHERE root_id = ? ORDER BY rel_path`, rootID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanFiles(rows)
}

func GetFileByID(db *sql.DB, id string) (*File, error) {
	rows, err := db.Query(`
		SELECT id, root_id, path, rel_path, language, system_id,
		       line_count, churn_score, activity_score, activity_at, content_hash,
		       shape, shape_override, display_name,
		       position_x, position_y, width, height, indexed_at
		FROM files WHERE id=?`, id)
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

func GetFileByRelPath(db *sql.DB, rootID, relPath string) (*File, error) {
	rows, err := db.Query(`
		SELECT id, root_id, path, rel_path, language, system_id,
		       line_count, churn_score, activity_score, activity_at, content_hash,
		       shape, shape_override, display_name,
		       position_x, position_y, width, height, indexed_at
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
		       f.line_count, f.churn_score, f.activity_score, f.activity_at, f.content_hash,
		       f.shape, f.shape_override, f.display_name,
		       f.position_x, f.position_y, f.width, f.height, f.indexed_at
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

// DeleteFileByID removes one live file and every relationship that is not
// protected by a foreign-key cascade. Symbols, call_graph rows, variable refs,
// and Floor geometry are cascaded/triggered by the files delete; generic
// dependencies intentionally use polymorphic IDs and therefore need an
// explicit sweep in the same transaction.
func DeleteFileByID(db *sql.DB, fileID string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err := tx.Exec(`DELETE FROM dependencies WHERE src=? OR dst=?`, fileID, fileID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM files WHERE id=?`, fileID); err != nil {
		return err
	}
	return tx.Commit()
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
			&f.LineCount, &f.ChurnScore, &f.ActivityScore, &f.ActivityAt, &f.ContentHash,
			&f.Shape, &f.ShapeOverride, &f.DisplayName,
			&f.PositionX, &f.PositionY, &f.Width, &f.Height, &f.IndexedAt,
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
			INSERT INTO symbols (id, file_id, name, kind, line_start, line_end, body_hash)
			VALUES (?,?,?,?,?,?,?)`,
			s.ID, fileID, s.Name, s.Kind, s.LineStart, s.LineEnd, s.BodyHash); err != nil {
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
		SELECT id, file_id, name, kind, line_start, line_end, body_hash
		FROM symbols WHERE file_id=? ORDER BY line_start`, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var symbols []Symbol
	for rows.Next() {
		var s Symbol
		if err := rows.Scan(&s.ID, &s.FileID, &s.Name, &s.Kind, &s.LineStart, &s.LineEnd, &s.BodyHash); err != nil {
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
		SELECT s.id, s.file_id, s.name, s.kind, s.line_start, s.line_end, s.body_hash
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
		if err := rows.Scan(&s.ID, &s.FileID, &s.Name, &s.Kind, &s.LineStart, &s.LineEnd, &s.BodyHash); err != nil {
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
		INSERT INTO dependencies (id, workspace_id, src, dst, src_type, dst_type, dependency_type, weight, created_by, evidence)
		VALUES (?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(src, dst, dependency_type) DO UPDATE SET
			weight=weight+1, evidence=COALESCE(excluded.evidence, evidence)`,
		d.ID, d.WorkspaceID, d.Src, d.Dst, d.SrcType, d.DstType, d.DependencyType, d.Weight, d.CreatedBy, d.Evidence)
	return err
}

func GetDependencies(db *sql.DB, workspaceID string) ([]Dependency, error) {
	rows, err := db.Query(`
		SELECT id, workspace_id, src, dst, src_type, dst_type, dependency_type, weight, created_by, evidence
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
			&d.SrcType, &d.DstType, &d.DependencyType, &d.Weight, &d.CreatedBy, &d.Evidence,
		); err != nil {
			return nil, err
		}
		deps = append(deps, d)
	}
	return deps, rows.Err()
}

// GetOutgoingDependenciesByFile returns the authored relationships whose
// source is one file. Live reindexing diffs this set before/after a parse; it
// must not include inbound edges, which are owned by other source files.
func GetOutgoingDependenciesByFile(db *sql.DB, workspaceID, fileID string) ([]Dependency, error) {
	rows, err := db.Query(`
		SELECT id, workspace_id, src, dst, src_type, dst_type, dependency_type, weight, created_by, evidence
		FROM dependencies WHERE workspace_id=? AND src=?`, workspaceID, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var deps []Dependency
	for rows.Next() {
		var d Dependency
		if err := rows.Scan(
			&d.ID, &d.WorkspaceID, &d.Src, &d.Dst,
			&d.SrcType, &d.DstType, &d.DependencyType, &d.Weight, &d.CreatedBy, &d.Evidence,
		); err != nil {
			return nil, err
		}
		deps = append(deps, d)
	}
	return deps, rows.Err()
}

// DeleteDependency removes a single edge by id.
func DeleteDependency(db *sql.DB, id string) error {
	_, err := db.Exec(`DELETE FROM dependencies WHERE id=?`, id)
	return err
}

// DeleteOutgoingDependenciesByFile clears only relationships authored by the
// file being reparsed. Inbound edges belong to their own source files and must
// survive a target-file edit.
func DeleteOutgoingDependenciesByFile(db *sql.DB, fileID string) error {
	_, err := db.Exec(`DELETE FROM dependencies WHERE src=?`, fileID)
	return err
}

func DeleteDependenciesByFile(db *sql.DB, fileID string) error {
	_, err := db.Exec(`DELETE FROM dependencies WHERE src=? OR dst=?`, fileID, fileID)
	return err
}

// ─── Infra ────────────────────────────────────────────────────────────────────

const infraCols = `id, workspace_id, name, infra_type, category, provider, service,
       subtype, status, detected_by, config, position_x, position_y`

func scanInfraNode(row interface{ Scan(...any) error }) (InfraNode, error) {
	var n InfraNode
	var detected, config sql.NullString
	err := row.Scan(
		&n.ID, &n.WorkspaceID, &n.Name, &n.InfraType, &n.Category, &n.Provider,
		&n.Service, &n.Subtype, &n.Status, &detected, &config, &n.PositionX, &n.PositionY)
	if detected.Valid {
		n.DetectedBy = json.RawMessage(detected.String)
	}
	if config.Valid {
		n.Config = json.RawMessage(config.String)
	}
	return n, err
}

// UpsertInfraNode normalizes defaults on the caller's struct (pointer) so API
// responses and WebSocket broadcasts carry exactly what was persisted.
func UpsertInfraNode(db *sql.DB, n *InfraNode) error {
	if n.ID == "" {
		n.ID = uuid.New().String()
	}
	if n.Category == "" {
		n.Category = "api"
	}
	if n.Provider == "" {
		n.Provider = "generic"
	}
	if n.Status == "" {
		n.Status = "confirmed"
	}
	_, err := db.Exec(`
		INSERT INTO infra_nodes
			(id, workspace_id, name, infra_type, category, provider, service,
			 subtype, status, detected_by, config, position_x, position_y)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			name=excluded.name, infra_type=excluded.infra_type,
			category=excluded.category, provider=excluded.provider,
			service=excluded.service, subtype=excluded.subtype,
			status=excluded.status, detected_by=excluded.detected_by,
			config=excluded.config, position_x=excluded.position_x, position_y=excluded.position_y`,
		n.ID, n.WorkspaceID, n.Name, n.InfraType, n.Category, n.Provider, n.Service,
		n.Subtype, n.Status, nullableJSON(n.DetectedBy), nullableJSON(n.Config), n.PositionX, n.PositionY)
	return err
}

// nullableJSON stores empty RawMessage as NULL instead of "".
func nullableJSON(m json.RawMessage) any {
	if len(m) == 0 {
		return nil
	}
	return string(m)
}

func GetInfraNodes(db *sql.DB, workspaceID string) ([]InfraNode, error) {
	rows, err := db.Query(`SELECT `+infraCols+` FROM infra_nodes WHERE workspace_id=?`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var nodes []InfraNode
	for rows.Next() {
		n, err := scanInfraNode(rows)
		if err != nil {
			return nil, err
		}
		nodes = append(nodes, n)
	}
	return nodes, rows.Err()
}

func GetInfraNode(db *sql.DB, id string) (*InfraNode, error) {
	n, err := scanInfraNode(db.QueryRow(`SELECT `+infraCols+` FROM infra_nodes WHERE id=?`, id))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &n, nil
}

// DeleteInfraNode removes the node; its edges are cleaned by the
// deps_cleanup_on_infra_delete trigger.
func DeleteInfraNode(db *sql.DB, id string) error {
	_, err := db.Exec(`DELETE FROM infra_nodes WHERE id=?`, id)
	return err
}

func UpdateInfraPosition(db *sql.DB, id string, x, y float64) error {
	_, err := db.Exec(`UPDATE infra_nodes SET position_x=?, position_y=? WHERE id=?`, x, y, id)
	return err
}

// UpdateInfraStatus resolves a proposal ('confirmed' | 'dismissed').
func UpdateInfraStatus(db *sql.DB, id, status string) error {
	_, err := db.Exec(`UPDATE infra_nodes SET status=? WHERE id=?`, status, id)
	return err
}

// GetInfraEdges returns all dependencies touching infra nodes in a workspace.
func GetInfraEdges(db *sql.DB, workspaceID string) ([]Dependency, error) {
	rows, err := db.Query(`
		SELECT id, workspace_id, src, dst, src_type, dst_type, dependency_type, weight, created_by, evidence
		FROM dependencies
		WHERE workspace_id=? AND (src_type='infra' OR dst_type='infra')`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var deps []Dependency
	for rows.Next() {
		var d Dependency
		if err := rows.Scan(
			&d.ID, &d.WorkspaceID, &d.Src, &d.Dst,
			&d.SrcType, &d.DstType, &d.DependencyType, &d.Weight, &d.CreatedBy, &d.Evidence,
		); err != nil {
			return nil, err
		}
		deps = append(deps, d)
	}
	return deps, rows.Err()
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
	// churn_score display value = percentile rank of the decayed live-activity
	// score within this workspace (activity engine), computed at read time.
	entries := make([]activity.ScoreEntry, len(files))
	for i, f := range files {
		entries[i] = activity.ScoreEntry{ID: f.ID, Score: f.ActivityScore, AtMs: f.ActivityAt}
	}
	norm := activity.Normalize(entries, time.Now().UnixMilli())
	for i := range files {
		files[i].ChurnScore = norm[files[i].ID]
	}
	infra, err := GetInfraNodes(db, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("get infra: %w", err)
	}
	dependencies, err := GetDependencies(db, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("get dependencies: %w", err)
	}
	layouts, err := GetFloorLayouts(db, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("get floor layouts: %w", err)
	}
	return &CanvasSnapshot{
		WorkspaceID:  workspaceID,
		Systems:      systems,
		Files:        files,
		InfraNodes:   infra,
		Dependencies: dependencies,
		FloorLayouts: layouts,
	}, nil
}

// ─── Call graph ───────────────────────────────────────────────────────────────

type CallEdge struct {
	CallerFile   string `json:"callerFile"`
	CallerSymbol string `json:"callerSymbol"`
	CalleeFile   string `json:"calleeFile"`
	CalleeSymbol string `json:"calleeSymbol"`
	CallCount    int    `json:"callCount"`
}

func GetCallEdgesByCaller(db *sql.DB, fileID string) ([]CallEdge, error) {
	rows, err := db.Query(`
		SELECT caller_file, caller_symbol, callee_file, callee_symbol, call_count
		FROM call_graph WHERE caller_file=?`, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var edges []CallEdge
	for rows.Next() {
		var edge CallEdge
		if err := rows.Scan(
			&edge.CallerFile, &edge.CallerSymbol,
			&edge.CalleeFile, &edge.CalleeSymbol, &edge.CallCount,
		); err != nil {
			return nil, err
		}
		edges = append(edges, edge)
	}
	return edges, rows.Err()
}

func GetCallEdgesByFile(db *sql.DB, fileID string) ([]CallEdge, error) {
	rows, err := db.Query(`
		SELECT caller_file, caller_symbol, callee_file, callee_symbol, call_count
		FROM call_graph WHERE caller_file=? OR callee_file=?`, fileID, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var edges []CallEdge
	for rows.Next() {
		var edge CallEdge
		if err := rows.Scan(
			&edge.CallerFile, &edge.CallerSymbol,
			&edge.CalleeFile, &edge.CalleeSymbol, &edge.CallCount,
		); err != nil {
			return nil, err
		}
		edges = append(edges, edge)
	}
	return edges, rows.Err()
}

// GetCallEdgesByRoot returns the resolved project call graph in one snapshot.
// Live reindexing diffs this set when a symbol addition/removal can change
// callers outside the file that triggered the watcher event.
func GetCallEdgesByRoot(db *sql.DB, rootID string) ([]CallEdge, error) {
	rows, err := db.Query(`
		SELECT cg.caller_file, cg.caller_symbol, cg.callee_file, cg.callee_symbol, cg.call_count
		FROM call_graph cg
		JOIN files caller ON caller.id = cg.caller_file
		WHERE caller.root_id=?`, rootID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var edges []CallEdge
	for rows.Next() {
		var edge CallEdge
		if err := rows.Scan(
			&edge.CallerFile, &edge.CallerSymbol,
			&edge.CalleeFile, &edge.CalleeSymbol, &edge.CallCount,
		); err != nil {
			return nil, err
		}
		edges = append(edges, edge)
	}
	return edges, rows.Err()
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
