// Sheets, annotations, and the canvas→agent outbox (UML_UX_PLAN.md U1 + U-C).
package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
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
	ID          string          `json:"id"`
	SheetID     string          `json:"sheetId"`
	SystemID    *string         `json:"systemId"`
	FileID      *string         `json:"fileId"`
	InfraID     *string         `json:"infraId"`
	SymbolRef   *string         `json:"symbolRef"`
	Label       string          `json:"label"`
	PositionX   float64         `json:"positionX"`
	PositionY   float64         `json:"positionY"`
	Width       *float64        `json:"width"`
	Height      *float64        `json:"height"`
	Emphasis    json.RawMessage `json:"emphasis,omitempty"`
	TombstoneAck int            `json:"tombstoneAck"`
	Ghost       int             `json:"ghost"`
	AddedBy     string          `json:"addedBy"`
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
	Status             string  `json:"status"`
	DeliveredTo        *string `json:"deliveredTo"`
	AnswerAnnotationID *string `json:"answerAnnotationId"`
	CreatedAt          int64   `json:"createdAt"`
	DeliveredAt        *int64  `json:"deliveredAt"`
	AnsweredAt         *int64  `json:"answeredAt"`
}

// ─── Sheets ───────────────────────────────────────────────────────────────────

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
	_, err := db.Exec(`
		INSERT INTO sheet_elements
			(id, sheet_id, system_id, file_id, infra_id, symbol_ref, label,
			 position_x, position_y, width, height, emphasis, ghost, added_by)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		e.ID, e.SheetID, e.SystemID, e.FileID, e.InfraID, e.SymbolRef, e.Label,
		e.PositionX, e.PositionY, e.Width, e.Height, nullableJSON(e.Emphasis), e.Ghost, e.AddedBy)
	if err == nil {
		_ = TouchSheet(db, e.SheetID)
	}
	return err
}

func GetSheetElements(db *sql.DB, sheetID string) ([]SheetElement, error) {
	rows, err := db.Query(`
		SELECT id, sheet_id, system_id, file_id, infra_id, symbol_ref, label,
		       position_x, position_y, width, height, emphasis, tombstone_ack, ghost, added_by
		FROM sheet_elements WHERE sheet_id=?`, sheetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SheetElement
	for rows.Next() {
		var e SheetElement
		var emph sql.NullString
		if err := rows.Scan(&e.ID, &e.SheetID, &e.SystemID, &e.FileID, &e.InfraID,
			&e.SymbolRef, &e.Label, &e.PositionX, &e.PositionY, &e.Width, &e.Height,
			&emph, &e.TombstoneAck, &e.Ghost, &e.AddedBy); err != nil {
			return nil, err
		}
		if emph.Valid {
			e.Emphasis = json.RawMessage(emph.String)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func RemoveSheetElement(db *sql.DB, id string) error {
	var sheetID string
	if err := db.QueryRow(`SELECT sheet_id FROM sheet_elements WHERE id=?`, id).Scan(&sheetID); err != nil {
		return err
	}
	if _, err := db.Exec(`DELETE FROM sheet_elements WHERE id=?`, id); err != nil {
		return err
	}
	return TouchSheet(db, sheetID)
}

func UpdateSheetElementPosition(db *sql.DB, id string, x, y float64) error {
	_, err := db.Exec(`UPDATE sheet_elements SET position_x=?, position_y=? WHERE id=?`, x, y, id)
	return err
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
		                           change_summary, status, created_at)
		VALUES (?,?,?,?,?,?,?,?)`,
		m.ID, m.WorkspaceID, m.SheetID, m.Note, m.Selection, m.ChangeSummary,
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
		SELECT id, workspace_id, sheet_id, note, selection, change_summary, status,
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
			&m.ChangeSummary, &m.Status, &m.DeliveredTo, &m.AnswerAnnotationID,
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
		SELECT id, workspace_id, sheet_id, note, selection, change_summary, status,
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
		&m.ChangeSummary, &m.Status, &m.DeliveredTo, &m.AnswerAnnotationID,
		&m.CreatedAt, &m.DeliveredAt, &m.AnsweredAt); err != nil {
		return nil, err
	}
	return &m, nil
}
