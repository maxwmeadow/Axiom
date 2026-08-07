package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// SheetLayout is the proposal-local counterpart of FloorLayout. The fields are
// intentionally identical so renderer geometry has one algebra on both
// surfaces; SheetID is the only additional identity dimension.
type SheetLayout struct {
	SheetID         string  `json:"sheetId"`
	WorkspaceID     string  `json:"workspaceId"`
	NodeID          string  `json:"nodeId"`
	NodeType        string  `json:"nodeType"`
	ParentNodeID    *string `json:"parentNodeId"`
	ParentNodeType  *string `json:"parentNodeType"`
	ContainmentKind string  `json:"containmentKind"`
	PositionX       float64 `json:"positionX"`
	PositionY       float64 `json:"positionY"`
	Width           float64 `json:"width"`
	Height          float64 `json:"height"`
	Scale           float64 `json:"scale"`
	InteriorScale   float64 `json:"interiorScale"`
	UpdatedAt       int64   `json:"updatedAt"`
}

type SheetLayoutBatchResult struct {
	Revision int64         `json:"revision"`
	Layouts  []SheetLayout `json:"layouts"`
}

func GetSheetLayouts(db *sql.DB, sheetID string) ([]SheetLayout, error) {
	rows, err := db.Query(`
		SELECT sheet_id, workspace_id, node_id, node_type, parent_node_id,
		       parent_node_type, containment_kind, position_x, position_y,
		       width, height, scale, interior_scale, updated_at
		FROM sheet_layouts WHERE sheet_id=?`, sheetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]SheetLayout, 0)
	for rows.Next() {
		var layout SheetLayout
		if err := rows.Scan(
			&layout.SheetID, &layout.WorkspaceID, &layout.NodeID, &layout.NodeType,
			&layout.ParentNodeID, &layout.ParentNodeType, &layout.ContainmentKind,
			&layout.PositionX, &layout.PositionY, &layout.Width, &layout.Height,
			&layout.Scale, &layout.InteriorScale, &layout.UpdatedAt,
		); err != nil {
			return nil, err
		}
		result = append(result, layout)
	}
	return result, rows.Err()
}

func sheetLayoutNodeExists(
	tx *sql.Tx,
	sheetID, workspaceID, nodeID, nodeType string,
) (bool, error) {
	if strings.HasPrefix(nodeID, "planned:") {
		var kind string
		err := tx.QueryRow(`
			SELECT kind FROM planned_nodes
			WHERE id=? AND sheet_id=? AND workspace_id=?`,
			strings.TrimPrefix(nodeID, "planned:"), sheetID, workspaceID,
		).Scan(&kind)
		if err == sql.ErrNoRows {
			return false, nil
		}
		expectedType := "file"
		if kind == "system" {
			expectedType = "system"
		} else if kind == "infra" {
			expectedType = "infra"
		}
		return nodeType == expectedType, err
	}
	return nodeBelongsToWorkspace(tx, workspaceID, nodeType, nodeID)
}

func sheetLayoutParentExists(
	tx *sql.Tx,
	sheetID, workspaceID, parentID, parentType string,
) (bool, error) {
	if strings.HasPrefix(parentID, "planned:") {
		var kind string
		var metadata string
		err := tx.QueryRow(`
			SELECT kind, metadata FROM planned_nodes
			WHERE id=? AND sheet_id=? AND workspace_id=?`,
			strings.TrimPrefix(parentID, "planned:"), sheetID, workspaceID,
		).Scan(&kind, &metadata)
		if err == sql.ErrNoRows {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		node := PlannedNode{Kind: kind, Metadata: json.RawMessage(metadata)}
		expectedType := "system"
		if kind == "infra" {
			expectedType = "infra"
		}
		return parentType == expectedType && plannedNodeCanContain(node), nil
	}
	if parentType != "system" && parentType != "infra" {
		return false, nil
	}
	ok, err := nodeBelongsToWorkspace(tx, workspaceID, parentType, parentID)
	if err != nil || !ok || parentType != "infra" {
		return ok, err
	}
	var category string
	if err := tx.QueryRow(`
		SELECT category FROM infra_nodes WHERE workspace_id=? AND id=?`,
		workspaceID, parentID,
	).Scan(&category); err != nil {
		return false, err
	}
	return category == "platform", nil
}

// BackfillSheetLayouts migrates legacy sheet-local geometry into the canonical
// layout table. It is deliberately INSERT OR IGNORE: once a sheet has a layout
// opinion, future starts must never overwrite it from the deprecated columns.
func BackfillSheetLayouts(db *sql.DB) error {
	now := time.Now().UnixMilli()
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO sheet_layouts
		(sheet_id,workspace_id,node_id,node_type,parent_node_id,parent_node_type,
		 containment_kind,position_x,position_y,width,height,scale,interior_scale,updated_at)
		SELECT e.sheet_id, s.workspace_id,
		       COALESCE(e.system_id,e.file_id,e.infra_id),
		       CASE WHEN e.system_id IS NOT NULL THEN 'system'
		            WHEN e.file_id IS NOT NULL THEN 'file' ELSE 'infra' END,
		       e.parent_system_id,
		       CASE WHEN e.parent_system_id IS NULL THEN NULL
		            WHEN EXISTS(SELECT 1 FROM infra_nodes i WHERE i.id=e.parent_system_id)
		              OR EXISTS(SELECT 1 FROM planned_nodes p
		                        WHERE 'planned:' || p.id=e.parent_system_id AND p.kind='infra')
		            THEN 'infra' ELSE 'system' END,
		       CASE WHEN e.parent_system_id IS NULL THEN 'root'
		            WHEN EXISTS(SELECT 1 FROM infra_nodes i WHERE i.id=e.parent_system_id)
		              OR EXISTS(SELECT 1 FROM planned_nodes p
		                        WHERE 'planned:' || p.id=e.parent_system_id AND p.kind='infra')
		            THEN 'hosted_by' ELSE 'part_of' END,
		       e.position_x, e.position_y,
		       COALESCE(e.width, fl.width,
		                CASE WHEN e.system_id IS NOT NULL THEN 620
		                     WHEN e.infra_id IS NOT NULL AND EXISTS(
		                       SELECT 1 FROM infra_nodes i WHERE i.id=e.infra_id AND i.category='platform'
		                     ) THEN 760
		                     WHEN e.infra_id IS NOT NULL THEN 260 ELSE 220 END),
		       COALESCE(e.height, fl.height,
		                CASE WHEN e.system_id IS NOT NULL THEN 420
		                     WHEN e.infra_id IS NOT NULL AND EXISTS(
		                       SELECT 1 FROM infra_nodes i WHERE i.id=e.infra_id AND i.category='platform'
		                     ) THEN 520
		                     WHEN e.infra_id IS NOT NULL THEN 160 ELSE 110 END),
		       CASE WHEN e.scale > 0 THEN e.scale ELSE COALESCE(fl.scale,1) END,
		       COALESCE(fl.interior_scale,1), ?
		FROM sheet_elements e
		JOIN sheets s ON s.id=e.sheet_id
		LEFT JOIN floor_layouts fl
		  ON fl.workspace_id=s.workspace_id
		 AND fl.node_id=COALESCE(e.system_id,e.file_id,e.infra_id)
		WHERE e.symbol_ref IS NULL
		  AND COALESCE(e.system_id,e.file_id,e.infra_id) IS NOT NULL`, now); err != nil {
		return fmt.Errorf("backfill sheet element layouts: %w", err)
	}
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO sheet_layouts
		(sheet_id,workspace_id,node_id,node_type,parent_node_id,parent_node_type,
		 containment_kind,position_x,position_y,width,height,scale,interior_scale,updated_at)
		SELECT p.sheet_id, p.workspace_id, 'planned:' || p.id,
		       CASE WHEN p.kind='system' THEN 'system'
		            WHEN p.kind='infra' THEN 'infra' ELSE 'file' END,
		       p.parent_system_id,
		       CASE WHEN p.parent_system_id IS NULL THEN NULL
		            WHEN EXISTS(SELECT 1 FROM infra_nodes i WHERE i.id=p.parent_system_id)
		              OR EXISTS(SELECT 1 FROM planned_nodes parent
		                        WHERE 'planned:' || parent.id=p.parent_system_id AND parent.kind='infra')
		            THEN 'infra' ELSE 'system' END,
		       CASE WHEN p.parent_system_id IS NULL THEN 'root'
		            WHEN EXISTS(SELECT 1 FROM infra_nodes i WHERE i.id=p.parent_system_id)
		              OR EXISTS(SELECT 1 FROM planned_nodes parent
		                        WHERE 'planned:' || parent.id=p.parent_system_id AND parent.kind='infra')
		            THEN 'hosted_by' ELSE 'part_of' END,
		       p.position_x, p.position_y,
		       COALESCE(p.width,
		                CASE WHEN p.kind='system' THEN 620
		                     WHEN p.kind='infra' AND json_valid(p.metadata)
		                       AND json_extract(p.metadata,'$.category')='platform'
		                     THEN 760
		                     WHEN p.kind='infra' THEN 260 ELSE 220 END),
		       COALESCE(p.height,
		                CASE WHEN p.kind='system' THEN 420
		                     WHEN p.kind='infra' AND json_valid(p.metadata)
		                       AND json_extract(p.metadata,'$.category')='platform'
		                     THEN 520
		                     WHEN p.kind='infra' THEN 160 ELSE 110 END),
		       CASE WHEN p.scale > 0 THEN p.scale ELSE 1 END,
		       1, ?
		FROM planned_nodes p`, now); err != nil {
		return fmt.Errorf("backfill planned sheet layouts: %w", err)
	}
	return nil
}

func effectiveSheetParents(
	tx *sql.Tx,
	sheetID, workspaceID string,
) (map[string]string, error) {
	parents := make(map[string]string)
	rows, err := tx.Query(`
		SELECT node_type, node_id, parent_node_type, parent_node_id
		FROM floor_layouts WHERE workspace_id=?`, workspaceID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var nodeType, nodeID string
		var parentType, parentID *string
		if err := rows.Scan(&nodeType, &nodeID, &parentType, &parentID); err != nil {
			rows.Close()
			return nil, err
		}
		if parentType != nil && parentID != nil {
			parents[layoutKey(nodeType, nodeID)] = layoutKey(*parentType, *parentID)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	rows, err = tx.Query(`
		SELECT node_type, node_id, parent_node_type, parent_node_id
		FROM sheet_layouts WHERE sheet_id=?`, sheetID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var nodeType, nodeID string
		var parentType, parentID *string
		if err := rows.Scan(&nodeType, &nodeID, &parentType, &parentID); err != nil {
			rows.Close()
			return nil, err
		}
		key := layoutKey(nodeType, nodeID)
		if parentType == nil || parentID == nil {
			delete(parents, key)
		} else {
			parents[key] = layoutKey(*parentType, *parentID)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	return parents, rows.Close()
}

// ApplySheetLayoutBatch persists the same complete geometry rows as the Floor
// planner without mutating semantic ownership. Context nodes may receive rows:
// once a sheet gesture changes their geometry they are, by definition, part of
// that proposal's spatial opinion.
func ApplySheetLayoutBatch(
	db *sql.DB,
	sheetID, workspaceID string,
	updates []SheetLayout,
) (*SheetLayoutBatchResult, error) {
	if len(updates) == 0 {
		return nil, fmt.Errorf("at least one layout is required")
	}
	tx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var revision int64
	if err := tx.QueryRow(`
		SELECT revision FROM sheets WHERE id=? AND workspace_id=?`,
		sheetID, workspaceID,
	).Scan(&revision); err != nil {
		return nil, fmt.Errorf("sheet not found")
	}
	parents, err := effectiveSheetParents(tx, sheetID, workspaceID)
	if err != nil {
		return nil, err
	}

	now := time.Now().UnixMilli()
	seen := make(map[string]bool)
	for i := range updates {
		update := &updates[i]
		update.SheetID = sheetID
		update.WorkspaceID = workspaceID
		update.UpdatedAt = now
		if update.InteriorScale == 0 {
			update.InteriorScale = 1
		}
		key := layoutKey(update.NodeType, update.NodeID)
		if seen[update.NodeID] {
			return nil, fmt.Errorf("duplicate layout node %s", update.NodeID)
		}
		seen[update.NodeID] = true
		if update.Width <= 0 || update.Height <= 0 || update.Scale <= 0 || update.InteriorScale <= 0 {
			return nil, fmt.Errorf("invalid geometry for %s", key)
		}
		if ok, err := sheetLayoutNodeExists(tx, sheetID, workspaceID, update.NodeID, update.NodeType); err != nil || !ok {
			if err != nil {
				return nil, err
			}
			return nil, fmt.Errorf("node %s does not belong to this sheet workspace", key)
		}

		if update.ParentNodeID == nil || update.ParentNodeType == nil {
			update.ParentNodeID, update.ParentNodeType = nil, nil
			update.ContainmentKind = "root"
			delete(parents, key)
			continue
		}
		if ok, err := sheetLayoutParentExists(
			tx, sheetID, workspaceID, *update.ParentNodeID, *update.ParentNodeType,
		); err != nil || !ok {
			if err != nil {
				return nil, err
			}
			return nil, fmt.Errorf("layout parent is not a container in this sheet workspace")
		}
		if *update.ParentNodeType == "infra" {
			update.ContainmentKind = "hosted_by"
		} else {
			update.ContainmentKind = "part_of"
		}
		parents[key] = layoutKey(*update.ParentNodeType, *update.ParentNodeID)
	}

	for _, update := range updates {
		key := layoutKey(update.NodeType, update.NodeID)
		visited := map[string]bool{key: true}
		for parent := parents[key]; parent != ""; parent = parents[parent] {
			if visited[parent] {
				return nil, fmt.Errorf("layout cycle involving %s", key)
			}
			visited[parent] = true
		}
	}

	for _, update := range updates {
		if _, err := tx.Exec(`
			INSERT INTO sheet_layouts
			(sheet_id,workspace_id,node_id,node_type,parent_node_id,parent_node_type,
			 containment_kind,position_x,position_y,width,height,scale,interior_scale,updated_at)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
			ON CONFLICT(sheet_id,node_id) DO UPDATE SET
			workspace_id=excluded.workspace_id, node_type=excluded.node_type,
			parent_node_id=excluded.parent_node_id, parent_node_type=excluded.parent_node_type,
			containment_kind=excluded.containment_kind, position_x=excluded.position_x,
			position_y=excluded.position_y, width=excluded.width, height=excluded.height,
			scale=excluded.scale, interior_scale=excluded.interior_scale,
			updated_at=excluded.updated_at`,
			sheetID, workspaceID, update.NodeID, update.NodeType,
			update.ParentNodeID, update.ParentNodeType, update.ContainmentKind,
			update.PositionX, update.PositionY, update.Width, update.Height,
			update.Scale, update.InteriorScale, now,
		); err != nil {
			return nil, err
		}
	}
	revision++
	if _, err := tx.Exec(`
		UPDATE sheets SET revision=?, updated_at=? WHERE id=? AND workspace_id=?`,
		revision, now, sheetID, workspaceID,
	); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &SheetLayoutBatchResult{Revision: revision, Layouts: updates}, nil
}
