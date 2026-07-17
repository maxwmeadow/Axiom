// Planned elements — authored UML for code that doesn't exist yet
// (UML_UX_PLAN.md REVISION 2). CRUD + reconciliation against reality.
package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// PlannedMember is one declared function/method in a planned node.
type PlannedMember struct {
	Signature string `json:"signature"`        // "login(email, password)"
	Intent    string `json:"intent,omitempty"` // one-line description
	Realized  bool   `json:"realized"`         // set by reconciliation
}

type PlannedNode struct {
	ID             string          `json:"id"`
	SheetID        string          `json:"sheetId"`
	WorkspaceID    string          `json:"workspaceId"`
	Kind           string          `json:"kind"`
	Name           string          `json:"name"`
	DeclaredPath   string          `json:"declaredPath"`
	Members        json.RawMessage `json:"members"`  // []PlannedMember
	Metadata       json.RawMessage `json:"metadata"` // versioned kind-specific UML metadata
	Status         string          `json:"status"`
	RealizedFileID *string         `json:"realizedFileId"`
	Notes          string          `json:"notes"`
	Shape          string          `json:"shape"` // ''=kind default | 'box'|'folder'|'cylinder'|'hexagon'
	Color          string          `json:"color"` // curated accent hex; '' = default
	PositionX      float64         `json:"positionX"`
	PositionY      float64         `json:"positionY"`
	Width          *float64        `json:"width"`
	Height         *float64        `json:"height"`
	Scale          float64         `json:"scale"`
	ParentSystemID *string         `json:"parentSystemId"`
	CreatedBy      string          `json:"createdBy"`
	CreatedAt      int64           `json:"createdAt"`
}

type PlannedEdge struct {
	ID          string  `json:"id"`
	SheetID     string  `json:"sheetId"`
	WorkspaceID string  `json:"workspaceId"`
	Kind        string  `json:"kind"`
	SrcPlanned  *string `json:"srcPlanned"`
	SrcLive     *string `json:"srcLive"`
	DstPlanned  *string `json:"dstPlanned"`
	DstLive     *string `json:"dstLive"`
	Note        string  `json:"note"`
}

const plannedCols = `id, sheet_id, workspace_id, kind, name, declared_path, members, metadata,
       status, realized_file_id, notes, shape, color, position_x, position_y, width, height, scale, parent_system_id, created_by, created_at`

func UpsertPlannedNode(db *sql.DB, n *PlannedNode) error {
	if n.ID == "" {
		n.ID = uuid.New().String()
	}
	if n.Kind == "" {
		n.Kind = "class"
	}
	if n.Status == "" {
		n.Status = "planned"
	}
	if len(n.Members) == 0 {
		n.Members = json.RawMessage("[]")
	}
	if len(n.Metadata) == 0 {
		n.Metadata = json.RawMessage(`{"version":1}`)
	}
	if !json.Valid(n.Metadata) || strings.TrimSpace(string(n.Metadata))[0] != '{' {
		return fmt.Errorf("planned node metadata must be a JSON object")
	}
	if n.CreatedBy == "" {
		n.CreatedBy = "user"
	}
	if n.CreatedAt == 0 {
		n.CreatedAt = time.Now().UnixMilli()
	}
	n.Scale = normalizedScale(n.Scale)
	_, err := db.Exec(`
		INSERT INTO planned_nodes (`+plannedCols+`)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			kind=excluded.kind, name=excluded.name, declared_path=excluded.declared_path,
			members=excluded.members, metadata=excluded.metadata, status=excluded.status,
			realized_file_id=excluded.realized_file_id, notes=excluded.notes,
			shape=excluded.shape, color=excluded.color,
			position_x=excluded.position_x, position_y=excluded.position_y,
			width=excluded.width, height=excluded.height, scale=excluded.scale,
			parent_system_id=excluded.parent_system_id`,
		n.ID, n.SheetID, n.WorkspaceID, n.Kind, n.Name, n.DeclaredPath, string(n.Members), string(n.Metadata),
		n.Status, n.RealizedFileID, n.Notes, n.Shape, n.Color, n.PositionX, n.PositionY, n.Width, n.Height, n.Scale, n.ParentSystemID, n.CreatedBy, n.CreatedAt)
	if err == nil {
		_ = TouchSheet(db, n.SheetID)
	}
	return err
}

func scanPlanned(rows *sql.Rows) ([]PlannedNode, error) {
	var out []PlannedNode
	for rows.Next() {
		var n PlannedNode
		var members, metadata string
		if err := rows.Scan(&n.ID, &n.SheetID, &n.WorkspaceID, &n.Kind, &n.Name,
			&n.DeclaredPath, &members, &metadata, &n.Status, &n.RealizedFileID, &n.Notes,
			&n.Shape, &n.Color, &n.PositionX, &n.PositionY, &n.Width, &n.Height, &n.Scale, &n.ParentSystemID, &n.CreatedBy, &n.CreatedAt); err != nil {
			return nil, err
		}
		n.Members = json.RawMessage(members)
		n.Metadata = json.RawMessage(metadata)
		out = append(out, n)
	}
	return out, rows.Err()
}

func GetPlannedNodes(db *sql.DB, sheetID string) ([]PlannedNode, error) {
	rows, err := db.Query(`SELECT `+plannedCols+` FROM planned_nodes WHERE sheet_id=?`, sheetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanPlanned(rows)
}

func GetPlannedNode(db *sql.DB, id string) (*PlannedNode, error) {
	rows, err := db.Query(`SELECT `+plannedCols+` FROM planned_nodes WHERE id=?`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	nodes, err := scanPlanned(rows)
	if err != nil || len(nodes) == 0 {
		return nil, err
	}
	return &nodes[0], nil
}

// GetOpenPlannedNodes returns unrealized planned nodes across all sheets —
// the reconciliation working set.
func GetOpenPlannedNodes(db *sql.DB, workspaceID string) ([]PlannedNode, error) {
	rows, err := db.Query(`SELECT `+plannedCols+` FROM planned_nodes
		WHERE workspace_id=? AND status IN ('planned','partial')`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanPlanned(rows)
}

func DeletePlannedNode(db *sql.DB, id string) error {
	_, err := db.Exec(`DELETE FROM planned_nodes WHERE id=?`, id)
	return err
}

func UpdatePlannedPosition(db *sql.DB, id string, x, y float64) error {
	_, err := db.Exec(`UPDATE planned_nodes SET position_x=?, position_y=? WHERE id=?`, x, y, id)
	return err
}

func UpdatePlannedParent(db *sql.DB, id string, parentSystemID *string) error {
	var x, y float64
	if err := db.QueryRow(`SELECT position_x, position_y FROM planned_nodes WHERE id=?`, id).Scan(&x, &y); err != nil {
		return err
	}
	return UpdatePlannedLayout(db, id, x, y, parentSystemID, nil, nil, nil)
}

func UpdatePlannedLayout(db *sql.DB, id string, x, y float64, parentSystemID *string, width, height, scale *float64) error {
	var sheetID string
	if err := db.QueryRow(`SELECT sheet_id FROM planned_nodes WHERE id=?`, id).Scan(&sheetID); err != nil {
		return err
	}
	return UpdateSheetLayouts(db, sheetID, []SheetLayoutUpdate{{
		Kind: "planned", ID: id, X: x, Y: y, ParentSystemID: parentSystemID,
		Width: width, Height: height, Scale: scale,
	}})
}

func UpsertPlannedEdge(db *sql.DB, e *PlannedEdge) error {
	if e.ID == "" {
		e.ID = uuid.New().String()
	}
	if e.Kind == "" {
		e.Kind = "DEPENDS_ON"
	}
	_, err := db.Exec(`
		INSERT INTO planned_edges (id, sheet_id, workspace_id, kind, src_planned, src_live, dst_planned, dst_live, note)
		VALUES (?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, note=excluded.note`,
		e.ID, e.SheetID, e.WorkspaceID, e.Kind, e.SrcPlanned, e.SrcLive, e.DstPlanned, e.DstLive, e.Note)
	return err
}

func GetPlannedEdges(db *sql.DB, sheetID string) ([]PlannedEdge, error) {
	rows, err := db.Query(`
		SELECT id, sheet_id, workspace_id, kind, src_planned, src_live, dst_planned, dst_live, note
		FROM planned_edges WHERE sheet_id=?`, sheetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PlannedEdge
	for rows.Next() {
		var e PlannedEdge
		if err := rows.Scan(&e.ID, &e.SheetID, &e.WorkspaceID, &e.Kind,
			&e.SrcPlanned, &e.SrcLive, &e.DstPlanned, &e.DstLive, &e.Note); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func DeletePlannedEdge(db *sql.DB, id string) error {
	_, err := db.Exec(`DELETE FROM planned_edges WHERE id=?`, id)
	return err
}

// ─── Reconciliation ───────────────────────────────────────────────────────────

// memberName extracts the bare function name from "login(email, pw)".
func memberName(sig string) string {
	if i := strings.IndexAny(sig, "( "); i > 0 {
		return strings.TrimSpace(sig[:i])
	}
	return strings.TrimSpace(sig)
}

// ReconcilePlanned matches open planned nodes against reality after an index
// pass. Exact declared_path match (suffix-tolerant) links the node; member
// signatures match against the file's symbol names. Returns nodes whose
// status or member realization changed (caller broadcasts).
func ReconcilePlanned(db *sql.DB, workspaceID string) ([]PlannedNode, error) {
	open, err := GetOpenPlannedNodes(db, workspaceID)
	if err != nil || len(open) == 0 {
		return nil, err
	}
	files, err := GetFiles(db, workspaceID)
	if err != nil {
		return nil, err
	}

	var changed []PlannedNode
	for _, n := range open {
		if n.DeclaredPath == "" {
			continue
		}
		want := strings.ToLower(strings.ReplaceAll(n.DeclaredPath, "\\", "/"))
		var match *File
		for i := range files {
			rel := strings.ToLower(files[i].RelPath)
			if rel == want || strings.HasSuffix(rel, "/"+want) {
				match = &files[i]
				break
			}
		}
		if match == nil {
			continue
		}

		syms, _ := GetSymbolsByFile(db, match.ID)
		symNames := make(map[string]bool, len(syms))
		for _, s := range syms {
			symNames[strings.ToLower(s.Name)] = true
		}

		var members []PlannedMember
		_ = json.Unmarshal(n.Members, &members)
		realized, dirty := 0, false
		for i := range members {
			is := symNames[strings.ToLower(memberName(members[i].Signature))]
			if is != members[i].Realized {
				members[i].Realized = is
				dirty = true
			}
			if is {
				realized++
			}
		}

		newStatus := "partial"
		if len(members) == 0 || realized == len(members) {
			newStatus = "realized"
		} else if realized == 0 {
			newStatus = "partial" // file exists — that alone is partial progress
		}
		if n.RealizedFileID == nil || *n.RealizedFileID != match.ID || n.Status != newStatus || dirty {
			mj, _ := json.Marshal(members)
			n.Members = mj
			n.Status = newStatus
			n.RealizedFileID = &match.ID
			if err := UpsertPlannedNode(db, &n); err == nil {
				changed = append(changed, n)
			}
		}
	}
	return changed, nil
}
