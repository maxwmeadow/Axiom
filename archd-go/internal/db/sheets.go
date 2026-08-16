// Sheets, annotations, and the canvas→agent outbox (UML_UX_PLAN.md U1 + U-C).
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

type Sheet struct {
	ID          string          `json:"id"`
	WorkspaceID string          `json:"workspaceId"`
	Name        string          `json:"name"`
	Purpose     *string         `json:"purpose"`
	Kind        string          `json:"kind"`
	Folder      string          `json:"folder"`
	CreatedBy   string          `json:"createdBy"`
	Revision    int             `json:"revision"`
	Viewport    json.RawMessage `json:"viewport,omitempty"`
	CreatedAt   int64           `json:"createdAt"`
	UpdatedAt   int64           `json:"updatedAt"`
}

// SheetElement references exactly one model element (concrete nullable FKs).
// A nil ref with a non-empty Label is a tombstone.
type SheetElement struct {
	ID             string          `json:"id"`
	SheetID        string          `json:"sheetId"`
	SystemID       *string         `json:"systemId"`
	FileID         *string         `json:"fileId"`
	InfraID        *string         `json:"infraId"`
	SymbolRef      *string         `json:"symbolRef"`
	Label          string          `json:"label"`
	PositionX      float64         `json:"positionX"`
	PositionY      float64         `json:"positionY"`
	ParentSystemID *string         `json:"parentSystemId"`
	Width          *float64        `json:"width"`
	Height         *float64        `json:"height"`
	Scale          float64         `json:"scale"`
	Emphasis       json.RawMessage `json:"emphasis,omitempty"`
	DesignMetadata json.RawMessage `json:"designMetadata,omitempty"`
	TombstoneAck   int             `json:"tombstoneAck"`
	Ghost          int             `json:"ghost"`
	AddedBy        string          `json:"addedBy"`
}

// Tombstoned reports whether the referenced element no longer exists.
func (e SheetElement) Tombstoned() bool {
	return e.SystemID == nil && e.FileID == nil && e.InfraID == nil && e.SymbolRef == nil
}

type Annotation struct {
	ID          string   `json:"id"`
	WorkspaceID string   `json:"workspaceId"`
	SheetID     *string  `json:"sheetId"`
	TargetType  *string  `json:"targetType"`
	TargetID    *string  `json:"targetId"`
	Body        string   `json:"body"`
	Kind        string   `json:"kind"`
	Author      string   `json:"author"`
	PositionX   *float64 `json:"positionX"`
	PositionY   *float64 `json:"positionY"`
	CreatedAt   int64    `json:"createdAt"`
}

type CanvasMessage struct {
	ID                 string  `json:"id"`
	WorkspaceID        string  `json:"workspaceId"`
	SheetID            *string `json:"sheetId"`
	Note               string  `json:"note"`
	Selection          string  `json:"selection"`     // json array of durable refs
	ChangeSummary      string  `json:"changeSummary"` // 12-verb semantic summary
	SheetContext       string  `json:"sheetContext"`  // resolved Sheet + live Floor context at send time
	BuildSpec          string  `json:"buildSpec"`     // approved planned increment at send time
	Status             string  `json:"status"`
	DeliveredTo        *string `json:"deliveredTo"`
	AnswerAnnotationID *string `json:"answerAnnotationId"`
	CreatedAt          int64   `json:"createdAt"`
	DeliveredAt        *int64  `json:"deliveredAt"`
	AnsweredAt         *int64  `json:"answeredAt"`
}

// ─── Sheets ───────────────────────────────────────────────────────────────────

// SheetNameTaken reports whether another sheet in the workspace already carries
// this name. Two sheets with the same name are indistinguishable in the rail,
// in dispatch history, and in anything an agent reads back - so the name is an
// identity, not a label. Comparison ignores case and surrounding space because
// "First Increment" and "first increment " are the same sheet to a human.
func SheetNameTaken(db *sql.DB, workspaceID, name, excludeID string) (bool, error) {
	var count int
	err := db.QueryRow(`
		SELECT COUNT(*) FROM sheets
		WHERE workspace_id = ?
		  AND id != ?
		  AND LOWER(TRIM(name)) = LOWER(TRIM(?))`,
		workspaceID, excludeID, name).Scan(&count)
	return count > 0, err
}

func CreateSheet(db *sql.DB, s *Sheet) error {
	if s.ID == "" {
		s.ID = uuid.New().String()
	}
	if s.Kind == "" {
		s.Kind = "structure"
	}
	if s.CreatedBy == "" {
		s.CreatedBy = "user"
	}
	now := time.Now().UnixMilli()
	s.CreatedAt, s.UpdatedAt, s.Revision = now, now, 1
	_, err := db.Exec(`
		INSERT INTO sheets (id, workspace_id, name, purpose, kind, folder, created_by,
		                    revision, viewport, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		s.ID, s.WorkspaceID, s.Name, s.Purpose, s.Kind, s.Folder, s.CreatedBy,
		s.Revision, nullableJSON(s.Viewport), s.CreatedAt, s.UpdatedAt)
	return err
}

func GetSheets(db *sql.DB, workspaceID string) ([]Sheet, error) {
	rows, err := db.Query(`
		SELECT id, workspace_id, name, purpose, kind, folder, created_by,
		       revision, viewport, created_at, updated_at
		FROM sheets WHERE workspace_id=? ORDER BY folder, name`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Sheet
	for rows.Next() {
		var s Sheet
		var vp sql.NullString
		if err := rows.Scan(&s.ID, &s.WorkspaceID, &s.Name, &s.Purpose, &s.Kind,
			&s.Folder, &s.CreatedBy, &s.Revision, &vp, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, err
		}
		if vp.Valid {
			s.Viewport = json.RawMessage(vp.String)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func GetSheet(db *sql.DB, id string) (*Sheet, error) {
	var s Sheet
	var vp sql.NullString
	err := db.QueryRow(`
		SELECT id, workspace_id, name, purpose, kind, folder, created_by,
		       revision, viewport, created_at, updated_at
		FROM sheets WHERE id=?`, id).Scan(&s.ID, &s.WorkspaceID, &s.Name, &s.Purpose,
		&s.Kind, &s.Folder, &s.CreatedBy, &s.Revision, &vp, &s.CreatedAt, &s.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if vp.Valid {
		s.Viewport = json.RawMessage(vp.String)
	}
	return &s, nil
}

// UpdateSheet updates mutable fields and bumps revision + updated_at.
func UpdateSheet(db *sql.DB, id string, name, purpose, folder *string, viewport json.RawMessage) error {
	now := time.Now().UnixMilli()
	_, err := db.Exec(`
		UPDATE sheets SET
			name    = COALESCE(?, name),
			purpose = COALESCE(?, purpose),
			folder  = COALESCE(?, folder),
			viewport = COALESCE(?, viewport),
			revision = revision + 1,
			updated_at = ?
		WHERE id = ?`,
		name, purpose, folder, nullableJSON(viewport), now, id)
	return err
}

func DeleteSheet(db *sql.DB, id string) error {
	_, err := db.Exec(`DELETE FROM sheets WHERE id=?`, id)
	return err
}

// TouchSheet bumps revision/updated_at (called on membership/annotation change).
func TouchSheet(db *sql.DB, id string) error {
	_, err := db.Exec(`UPDATE sheets SET revision=revision+1, updated_at=? WHERE id=?`,
		time.Now().UnixMilli(), id)
	return err
}

// ─── Sheet elements ───────────────────────────────────────────────────────────

func AddSheetElement(db *sql.DB, e *SheetElement) error {
	refs := 0
	for _, p := range []*string{e.SystemID, e.FileID, e.InfraID, e.SymbolRef} {
		if p != nil {
			refs++
		}
	}
	if refs != 1 {
		return fmt.Errorf("sheet element must reference exactly one of system/file/infra/symbol")
	}
	if e.ID == "" {
		e.ID = uuid.New().String()
	}
	if e.AddedBy == "" {
		e.AddedBy = "user"
	}
	if len(e.DesignMetadata) == 0 {
		e.DesignMetadata = json.RawMessage(`{"version":1}`)
	}
	if !json.Valid(e.DesignMetadata) || strings.TrimSpace(string(e.DesignMetadata))[0] != '{' {
		return fmt.Errorf("design metadata must be a JSON object")
	}
	e.Scale = normalizedScale(e.Scale)
	_, err := db.Exec(`
		INSERT INTO sheet_elements
			(id, sheet_id, system_id, file_id, infra_id, symbol_ref, label,
			 position_x, position_y, parent_system_id, width, height, scale, emphasis, design_metadata, ghost, added_by)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		e.ID, e.SheetID, e.SystemID, e.FileID, e.InfraID, e.SymbolRef, e.Label,
		e.PositionX, e.PositionY, e.ParentSystemID, e.Width, e.Height, e.Scale, nullableJSON(e.Emphasis), nullableJSON(e.DesignMetadata), e.Ghost, e.AddedBy)
	if err == nil {
		_ = TouchSheet(db, e.SheetID)
	}
	return err
}

func GetSheetElements(db *sql.DB, sheetID string) ([]SheetElement, error) {
	rows, err := db.Query(`
		SELECT id, sheet_id, system_id, file_id, infra_id, symbol_ref, label,
		       position_x, position_y, parent_system_id, width, height, scale, emphasis, design_metadata, tombstone_ack, ghost, added_by
		FROM sheet_elements WHERE sheet_id=?`, sheetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SheetElement
	for rows.Next() {
		var e SheetElement
		var emph, design sql.NullString
		if err := rows.Scan(&e.ID, &e.SheetID, &e.SystemID, &e.FileID, &e.InfraID,
			&e.SymbolRef, &e.Label, &e.PositionX, &e.PositionY, &e.ParentSystemID, &e.Width, &e.Height, &e.Scale,
			&emph, &design, &e.TombstoneAck, &e.Ghost, &e.AddedBy); err != nil {
			return nil, err
		}
		if emph.Valid {
			e.Emphasis = json.RawMessage(emph.String)
		}
		if design.Valid {
			e.DesignMetadata = json.RawMessage(design.String)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func RemoveSheetElement(db *sql.DB, id string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var sheetID string
	var systemID, fileID, infraID sql.NullString
	if err := tx.QueryRow(`
		SELECT sheet_id,system_id,file_id,infra_id FROM sheet_elements WHERE id=?`,
		id,
	).Scan(&sheetID, &systemID, &fileID, &infraID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM sheet_elements WHERE id=?`, id); err != nil {
		return err
	}
	nodeID := systemID.String
	if nodeID == "" {
		nodeID = fileID.String
	}
	if nodeID == "" {
		nodeID = infraID.String
	}
	if nodeID != "" {
		if _, err := tx.Exec(`DELETE FROM sheet_layouts WHERE sheet_id=? AND node_id=?`, sheetID, nodeID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`UPDATE sheets SET revision=revision+1,updated_at=? WHERE id=?`, time.Now().UnixMilli(), sheetID); err != nil {
		return err
	}
	return tx.Commit()
}

func UpdateSheetElementPosition(db *sql.DB, id string, x, y float64) error {
	_, err := db.Exec(`UPDATE sheet_elements SET position_x=?, position_y=? WHERE id=?`, x, y, id)
	return err
}

func UpdateSheetElementParent(db *sql.DB, id string, parentSystemID *string) error {
	var x, y float64
	if err := db.QueryRow(`SELECT position_x, position_y FROM sheet_elements WHERE id=?`, id).Scan(&x, &y); err != nil {
		return err
	}
	return UpdateSheetElementLayout(db, id, x, y, parentSystemID, nil, nil, nil)
}

func UpdateSheetElementDesignMetadata(db *sql.DB, sheetID, id string, metadata json.RawMessage) error {
	if len(metadata) == 0 {
		metadata = json.RawMessage(`{"version":1}`)
	}
	if !json.Valid(metadata) || strings.TrimSpace(string(metadata))[0] != '{' {
		return fmt.Errorf("design metadata must be a JSON object")
	}
	result, err := db.Exec(`UPDATE sheet_elements SET design_metadata=? WHERE id=? AND sheet_id=?`, string(metadata), id, sheetID)
	if err != nil {
		return err
	}
	updated, err := result.RowsAffected()
	if err != nil || updated != 1 {
		return fmt.Errorf("sheet element not found")
	}
	return TouchSheet(db, sheetID)
}

func ValidateSheetParent(db *sql.DB, sheetID string, parentSystemID *string) error {
	if parentSystemID == nil {
		return nil
	}
	sheet, err := GetSheet(db, sheetID)
	if err != nil || sheet == nil {
		return fmt.Errorf("sheet not found")
	}
	if strings.HasPrefix(*parentSystemID, "planned:") {
		parent, err := GetPlannedNode(db, strings.TrimPrefix(*parentSystemID, "planned:"))
		if err != nil || parent == nil || parent.SheetID != sheetID || !plannedNodeCanContain(*parent) {
			return fmt.Errorf("planned parent system is not in this sheet")
		}
		return nil
	}
	parent, err := GetSystem(db, *parentSystemID)
	if err == nil && parent != nil && parent.WorkspaceID == sheet.WorkspaceID {
		return nil
	}
	infra, infraErr := GetInfraNode(db, *parentSystemID)
	if infraErr == nil && infra != nil && infra.WorkspaceID == sheet.WorkspaceID && infra.Category == "platform" {
		return nil
	}
	return fmt.Errorf("layout parent is not a container in this sheet workspace")
}

func plannedNodeCanContain(node PlannedNode) bool {
	if node.Kind == "system" {
		return true
	}
	if node.Kind != "infra" {
		return false
	}
	var metadata struct {
		Category     string   `json:"category"`
		Capabilities []string `json:"capabilities"`
	}
	if json.Unmarshal(node.Metadata, &metadata) != nil {
		return false
	}
	if metadata.Category == "platform" {
		return true
	}
	for _, capability := range metadata.Capabilities {
		if capability == "container" {
			return true
		}
	}
	return false
}

type sheetParentQueryer interface {
	Query(query string, args ...any) (*sql.Rows, error)
}

func buildSheetParentMap(q sheetParentQueryer, sheetID string) (map[string]*string, error) {
	parents := make(map[string]*string)
	rows, err := q.Query(`SELECT s.id, s.parent_id FROM systems s
		JOIN sheets sh ON sh.workspace_id=s.workspace_id WHERE sh.id=?`, sheetID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var child string
		var parent *string
		if err := rows.Scan(&child, &parent); err != nil {
			rows.Close()
			return nil, err
		}
		parents[child] = parent
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	rows, err = q.Query(`SELECT system_id, parent_system_id FROM sheet_elements
		WHERE sheet_id=? AND system_id IS NOT NULL`, sheetID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var child string
		var parent *string
		if err := rows.Scan(&child, &parent); err != nil {
			rows.Close()
			return nil, err
		}
		parents[child] = parent
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	rows, err = q.Query(`SELECT 'planned:' || id, parent_system_id FROM planned_nodes WHERE sheet_id=?`, sheetID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var child string
		var parent *string
		if err := rows.Scan(&child, &parent); err != nil {
			rows.Close()
			return nil, err
		}
		parents[child] = parent
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	return parents, nil
}

func validateSheetParentGraph(parents map[string]*string) error {
	for child := range parents {
		seen := map[string]bool{child: true}
		current := child
		for {
			parent, exists := parents[current]
			if !exists || parent == nil {
				break
			}
			if seen[*parent] {
				return fmt.Errorf("sheet containment cycle involving %s", child)
			}
			seen[*parent] = true
			current = *parent
		}
	}
	return nil
}

func validateSheetChildParent(db *sql.DB, sheetID, childID string, parentSystemID *string) error {
	if err := ValidateSheetParent(db, sheetID, parentSystemID); err != nil {
		return err
	}
	parents, err := buildSheetParentMap(db, sheetID)
	if err != nil {
		return err
	}
	parents[childID] = parentSystemID
	return validateSheetParentGraph(parents)
}

func ValidateSheetElementParent(db *sql.DB, sheetID, elementID string, parentSystemID *string) error {
	var childSystemID *string
	if err := db.QueryRow(`SELECT system_id FROM sheet_elements WHERE id=? AND sheet_id=?`, elementID, sheetID).Scan(&childSystemID); err != nil {
		return fmt.Errorf("sheet element not found")
	}
	if childSystemID == nil {
		return ValidateSheetParent(db, sheetID, parentSystemID)
	}
	return validateSheetChildParent(db, sheetID, *childSystemID, parentSystemID)
}

// ValidatePlannedParent applies the same unified live/planned containment rules
// while preventing a planned container from becoming its own descendant.
func ValidatePlannedParent(db *sql.DB, plannedID string, parentSystemID *string) error {
	node, err := GetPlannedNode(db, plannedID)
	if err != nil || node == nil {
		return fmt.Errorf("planned node not found")
	}
	if !plannedNodeCanContain(*node) {
		return ValidateSheetParent(db, node.SheetID, parentSystemID)
	}
	return validateSheetChildParent(db, node.SheetID, "planned:"+plannedID, parentSystemID)
}

// UpdateSheetElementLayout atomically persists the two properties that define
// UpdateSheetElementLayout atomically persists the two properties that define
// a sheet-local layout override. They must never be observed half-updated.
func UpdateSheetElementLayout(db *sql.DB, id string, x, y float64, parentSystemID *string, width, height, scale *float64) error {
	var sheetID string
	if err := db.QueryRow(`SELECT sheet_id FROM sheet_elements WHERE id=?`, id).Scan(&sheetID); err != nil {
		return err
	}
	return UpdateSheetLayouts(db, sheetID, []SheetLayoutUpdate{{
		Kind: "element", ID: id, X: x, Y: y, ParentSystemID: parentSystemID,
		Width: width, Height: height, Scale: scale,
	}})
}

type SheetLayoutUpdate struct {
	Kind           string   `json:"kind"`
	ID             string   `json:"id"`
	X              float64  `json:"x"`
	Y              float64  `json:"y"`
	ParentSystemID *string  `json:"parentSystemId"`
	Width          *float64 `json:"width"`
	Height         *float64 `json:"height"`
	Scale          *float64 `json:"scale"`
}

// UpdateSheetLayouts commits a lasso/group transform as one Sheet revision.
func UpdateSheetLayouts(db *sql.DB, sheetID string, updates []SheetLayoutUpdate) error {
	if len(updates) == 0 {
		return fmt.Errorf("at least one layout is required")
	}
	for _, update := range updates {
		if update.Kind != "element" && update.Kind != "planned" {
			return fmt.Errorf("invalid layout kind %q", update.Kind)
		}
		if update.Scale != nil && *update.Scale <= 0 {
			return fmt.Errorf("scale must be positive")
		}
		if err := ValidateSheetParent(db, sheetID, update.ParentSystemID); err != nil {
			return err
		}
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, update := range updates {
		var result sql.Result
		if update.Kind == "element" {
			result, err = tx.Exec(`UPDATE sheet_elements SET position_x=?, position_y=?, parent_system_id=?,
				width=COALESCE(?,width), height=COALESCE(?,height), scale=COALESCE(?,scale)
				WHERE id=? AND sheet_id=?`, update.X, update.Y, update.ParentSystemID, update.Width, update.Height, update.Scale, update.ID, sheetID)
		} else {
			result, err = tx.Exec(`UPDATE planned_nodes SET position_x=?, position_y=?, parent_system_id=?,
				width=COALESCE(?,width), height=COALESCE(?,height), scale=COALESCE(?,scale)
				WHERE id=? AND sheet_id=?`, update.X, update.Y, update.ParentSystemID, update.Width, update.Height, update.Scale, update.ID, sheetID)
		}
		if err != nil {
			return err
		}
		if count, err := result.RowsAffected(); err != nil || count != 1 {
			if err != nil {
				return err
			}
			return fmt.Errorf("layout target %s:%s not found", update.Kind, update.ID)
		}
	}
	parents, err := buildSheetParentMap(tx, sheetID)
	if err != nil {
		return err
	}
	if err := validateSheetParentGraph(parents); err != nil {
		return err
	}
	if _, err = tx.Exec(`UPDATE sheets SET revision=revision+1, updated_at=? WHERE id=?`, time.Now().UnixMilli(), sheetID); err != nil {
		return err
	}
	return tx.Commit()
}

func normalizedScale(scale float64) float64 {
	if scale <= 0 {
		return 1
	}
	return scale
}

// ─── Annotations ──────────────────────────────────────────────────────────────

func CreateAnnotation(db *sql.DB, a *Annotation) error {
	if a.ID == "" {
		a.ID = uuid.New().String()
	}
	if a.Kind == "" {
		a.Kind = "note"
	}
	if a.Author == "" {
		a.Author = "user"
	}
	a.CreatedAt = time.Now().UnixMilli()
	_, err := db.Exec(`
		INSERT INTO annotations (id, workspace_id, sheet_id, target_type, target_id,
		                         body, kind, author, position_x, position_y, created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		a.ID, a.WorkspaceID, a.SheetID, a.TargetType, a.TargetID,
		a.Body, a.Kind, a.Author, a.PositionX, a.PositionY, a.CreatedAt)
	if err == nil && a.SheetID != nil {
		_ = TouchSheet(db, *a.SheetID)
	}
	return err
}

func GetAnnotations(db *sql.DB, workspaceID string, sheetID *string) ([]Annotation, error) {
	q := `SELECT id, workspace_id, sheet_id, target_type, target_id, body, kind, author,
	             position_x, position_y, created_at
	      FROM annotations WHERE workspace_id=?`
	args := []any{workspaceID}
	if sheetID != nil {
		q += ` AND sheet_id=?`
		args = append(args, *sheetID)
	}
	rows, err := db.Query(q+` ORDER BY created_at`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Annotation
	for rows.Next() {
		var a Annotation
		if err := rows.Scan(&a.ID, &a.WorkspaceID, &a.SheetID, &a.TargetType, &a.TargetID,
			&a.Body, &a.Kind, &a.Author, &a.PositionX, &a.PositionY, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func DeleteAnnotation(db *sql.DB, id string) error {
	_, err := db.Exec(`DELETE FROM annotations WHERE id=?`, id)
	return err
}

// ─── Canvas outbox ────────────────────────────────────────────────────────────

func EnqueueCanvasMessage(db *sql.DB, m *CanvasMessage) error {
	if m.ID == "" {
		m.ID = uuid.New().String()
	}
	if m.Selection == "" {
		m.Selection = "[]"
	}
	m.Status = "queued"
	m.CreatedAt = time.Now().UnixMilli()
	_, err := db.Exec(`
		INSERT INTO canvas_outbox (id, workspace_id, sheet_id, note, selection,
		                           change_summary, sheet_context, build_spec, status, created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?)`,
		m.ID, m.WorkspaceID, m.SheetID, m.Note, m.Selection, m.ChangeSummary, m.SheetContext, m.BuildSpec,
		m.Status, m.CreatedAt)
	return err
}

// CountQueuedCanvasMessages powers the piggyback trailer on tool responses.
func CountQueuedCanvasMessages(db *sql.DB, workspaceID string) (int, error) {
	var n int
	err := db.QueryRow(`SELECT COUNT(*) FROM canvas_outbox WHERE workspace_id=? AND status='queued'`,
		workspaceID).Scan(&n)
	return n, err
}

// DrainCanvasMessages returns queued messages and marks them delivered.
func DrainCanvasMessages(db *sql.DB, workspaceID, deliveredTo string) ([]CanvasMessage, error) {
	msgs, err := listCanvasMessages(db, workspaceID, "queued")
	if err != nil || len(msgs) == 0 {
		return msgs, err
	}
	now := time.Now().UnixMilli()
	for i := range msgs {
		if _, err := db.Exec(`
			UPDATE canvas_outbox SET status='delivered', delivered_to=?, delivered_at=?
			WHERE id=?`, deliveredTo, now, msgs[i].ID); err != nil {
			return nil, err
		}
		msgs[i].Status = "delivered"
		msgs[i].DeliveredTo = &deliveredTo
		msgs[i].DeliveredAt = &now
	}
	return msgs, nil
}

func listCanvasMessages(db *sql.DB, workspaceID, status string) ([]CanvasMessage, error) {
	rows, err := db.Query(`
		SELECT id, workspace_id, sheet_id, note, selection, change_summary, sheet_context, build_spec, status,
		       delivered_to, answer_annotation_id, created_at, delivered_at, answered_at
		FROM canvas_outbox WHERE workspace_id=? AND status=? ORDER BY created_at`,
		workspaceID, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CanvasMessage
	for rows.Next() {
		var m CanvasMessage
		if err := rows.Scan(&m.ID, &m.WorkspaceID, &m.SheetID, &m.Note, &m.Selection,
			&m.ChangeSummary, &m.SheetContext, &m.BuildSpec, &m.Status, &m.DeliveredTo, &m.AnswerAnnotationID,
			&m.CreatedAt, &m.DeliveredAt, &m.AnsweredAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// GetCanvasMessages returns the durable dispatch history regardless of
// delivery state. Morning Delta uses immutable Sheet snapshots from this
// history to decide whether an architectural claim was expected or drift.
func GetCanvasMessages(db *sql.DB, workspaceID string) ([]CanvasMessage, error) {
	rows, err := db.Query(`
		SELECT id, workspace_id, sheet_id, note, selection, change_summary, sheet_context, build_spec, status,
		       delivered_to, answer_annotation_id, created_at, delivered_at, answered_at
		FROM canvas_outbox WHERE workspace_id=? ORDER BY created_at`,
		workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CanvasMessage
	for rows.Next() {
		var m CanvasMessage
		if err := rows.Scan(&m.ID, &m.WorkspaceID, &m.SheetID, &m.Note, &m.Selection,
			&m.ChangeSummary, &m.SheetContext, &m.BuildSpec, &m.Status, &m.DeliveredTo, &m.AnswerAnnotationID,
			&m.CreatedAt, &m.DeliveredAt, &m.AnsweredAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// AnswerCanvasMessage threads an agent reply annotation onto a message.
func AnswerCanvasMessage(db *sql.DB, msgID, annotationID string) error {
	_, err := db.Exec(`
		UPDATE canvas_outbox SET status='answered', answer_annotation_id=?, answered_at=?
		WHERE id=?`, annotationID, time.Now().UnixMilli(), msgID)
	return err
}

// GetCanvasMessage fetches one message by id.
func GetCanvasMessage(db *sql.DB, id string) (*CanvasMessage, error) {
	rows, err := db.Query(`
		SELECT id, workspace_id, sheet_id, note, selection, change_summary, sheet_context, build_spec, status,
		       delivered_to, answer_annotation_id, created_at, delivered_at, answered_at
		FROM canvas_outbox WHERE id=?`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, nil
	}
	var m CanvasMessage
	if err := rows.Scan(&m.ID, &m.WorkspaceID, &m.SheetID, &m.Note, &m.Selection,
		&m.ChangeSummary, &m.SheetContext, &m.BuildSpec, &m.Status, &m.DeliveredTo, &m.AnswerAnnotationID,
		&m.CreatedAt, &m.DeliveredAt, &m.AnsweredAt); err != nil {
		return nil, err
	}
	return &m, nil
}
