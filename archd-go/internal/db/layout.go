package db

import (
	"database/sql"
	"fmt"
	"time"
)

// FloorLayout is visual geometry only. It must never be used as the semantic
// owner of a file or subsystem.
type FloorLayout struct {
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
	// InteriorScale compresses this frame's CONTENTS without touching its own
	// rendered size. Zero from a legacy/partial client is normalized to 1.
	InteriorScale float64 `json:"interiorScale"`
	UpdatedAt     int64   `json:"updatedAt"`
}

type FloorLayoutBatchResult struct {
	Revision int64         `json:"revision"`
	Layouts  []FloorLayout `json:"layouts"`
}

func GetFloorLayouts(db *sql.DB, workspaceID string) ([]FloorLayout, error) {
	rows, err := db.Query(`
		SELECT workspace_id, node_id, node_type, parent_node_id, parent_node_type,
		       containment_kind, position_x, position_y, width, height, scale,
		       interior_scale, updated_at
		FROM floor_layouts WHERE workspace_id=?`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]FloorLayout, 0)
	for rows.Next() {
		var layout FloorLayout
		if err := rows.Scan(&layout.WorkspaceID, &layout.NodeID, &layout.NodeType,
			&layout.ParentNodeID, &layout.ParentNodeType, &layout.ContainmentKind,
			&layout.PositionX, &layout.PositionY, &layout.Width, &layout.Height,
			&layout.Scale, &layout.InteriorScale, &layout.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, layout)
	}
	return result, rows.Err()
}

func layoutKey(nodeType, nodeID string) string { return nodeType + ":" + nodeID }

func nodeBelongsToWorkspace(tx *sql.Tx, workspaceID, nodeType, nodeID string) (bool, error) {
	var exists int
	var err error
	switch nodeType {
	case "system":
		err = tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM systems WHERE workspace_id=? AND id=?)`, workspaceID, nodeID).Scan(&exists)
	case "file":
		err = tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM files f JOIN roots r ON r.id=f.root_id WHERE r.workspace_id=? AND f.id=?)`, workspaceID, nodeID).Scan(&exists)
	case "infra":
		err = tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM infra_nodes WHERE workspace_id=? AND id=?)`, workspaceID, nodeID).Scan(&exists)
	default:
		return false, fmt.Errorf("unsupported node type %q", nodeType)
	}
	return exists == 1, err
}

// ApplyFloorLayoutBatch validates and commits an entire group transform in one
// transaction so collaborators never observe half of a reparent/resize.
func ApplyFloorLayoutBatch(db *sql.DB, workspaceID string, updates []FloorLayout) (*FloorLayoutBatchResult, error) {
	if len(updates) == 0 {
		return nil, fmt.Errorf("at least one layout is required")
	}
	tx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	parents := make(map[string]string)
	rows, err := tx.Query(`SELECT node_type, node_id, parent_node_type, parent_node_id FROM floor_layouts WHERE workspace_id=?`, workspaceID)
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

	now := time.Now().UnixMilli()
	seen := make(map[string]bool)
	for i := range updates {
		u := &updates[i]
		u.WorkspaceID = workspaceID
		u.UpdatedAt = now
		key := layoutKey(u.NodeType, u.NodeID)
		if seen[key] {
			return nil, fmt.Errorf("duplicate layout %s", key)
		}
		seen[key] = true
		// A client that predates interior compression omits the field entirely,
		// which decodes as 0. Treat that as "no compression" rather than
		// rejecting the write, so old and new clients can share a workspace.
		if u.InteriorScale == 0 {
			u.InteriorScale = 1
		}
		if u.Width <= 0 || u.Height <= 0 || u.Scale <= 0 || u.InteriorScale <= 0 {
			return nil, fmt.Errorf("invalid geometry for %s", key)
		}
		if ok, err := nodeBelongsToWorkspace(tx, workspaceID, u.NodeType, u.NodeID); err != nil || !ok {
			if err != nil {
				return nil, err
			}
			return nil, fmt.Errorf("node %s does not belong to workspace", key)
		}
		if u.ParentNodeID == nil || u.ParentNodeType == nil {
			u.ParentNodeID, u.ParentNodeType = nil, nil
			u.ContainmentKind = "root"
			delete(parents, key)
			continue
		}
		if *u.ParentNodeType != "system" && *u.ParentNodeType != "infra" {
			return nil, fmt.Errorf("%s cannot be a frame", *u.ParentNodeType)
		}
		if ok, err := nodeBelongsToWorkspace(tx, workspaceID, *u.ParentNodeType, *u.ParentNodeID); err != nil || !ok {
			if err != nil {
				return nil, err
			}
			return nil, fmt.Errorf("parent %s:%s does not belong to workspace", *u.ParentNodeType, *u.ParentNodeID)
		}
		if *u.ParentNodeType == "infra" {
			var category string
			if err := tx.QueryRow(`SELECT category FROM infra_nodes WHERE workspace_id=? AND id=?`, workspaceID, *u.ParentNodeID).Scan(&category); err != nil {
				return nil, err
			}
			if category != "platform" {
				return nil, fmt.Errorf("infra category %q cannot host nodes", category)
			}
			u.ContainmentKind = "hosted_by"
		} else {
			u.ContainmentKind = "part_of"
		}
		parents[key] = layoutKey(*u.ParentNodeType, *u.ParentNodeID)
	}

	for key := range seen {
		visited := map[string]bool{key: true}
		for parent := parents[key]; parent != ""; parent = parents[parent] {
			if visited[parent] {
				return nil, fmt.Errorf("layout cycle involving %s", key)
			}
			visited[parent] = true
		}
	}

	for _, u := range updates {
		// A system frame is semantic part-of intent on the live Floor. Hosting is
		// intentionally visual/deployment-only and never overwrites code ownership.
		if u.NodeType == "file" && (u.ContainmentKind == "part_of" || u.ContainmentKind == "root") {
			var semanticParent any
			if u.ContainmentKind == "part_of" {
				semanticParent = u.ParentNodeID
			}
			if _, err = tx.Exec(`UPDATE files SET system_id=? WHERE id=?`, semanticParent, u.NodeID); err != nil {
				return nil, err
			}
		}
		if u.NodeType == "system" && (u.ContainmentKind == "part_of" || u.ContainmentKind == "root") {
			var oldDepth int
			if err := tx.QueryRow(`SELECT depth FROM systems WHERE id=?`, u.NodeID).Scan(&oldDepth); err != nil {
				return nil, err
			}
			newDepth := 0
			var semanticParent any
			if u.ContainmentKind == "part_of" {
				semanticParent = u.ParentNodeID
				if err := tx.QueryRow(`SELECT depth+1 FROM systems WHERE id=?`, u.ParentNodeID).Scan(&newDepth); err != nil {
					return nil, err
				}
			}
			if _, err = tx.Exec(`UPDATE systems SET parent_id=? WHERE id=?`, semanticParent, u.NodeID); err != nil {
				return nil, err
			}
			delta := newDepth - oldDepth
			if delta != 0 {
				if _, err = tx.Exec(`WITH RECURSIVE subtree(id) AS (
					SELECT ? UNION ALL SELECT s.id FROM systems s JOIN subtree p ON s.parent_id=p.id
				) UPDATE systems SET depth=depth+? WHERE id IN (SELECT id FROM subtree)`, u.NodeID, delta); err != nil {
					return nil, err
				}
			}
		}
		_, err = tx.Exec(`
			INSERT INTO floor_layouts
			(workspace_id,node_id,node_type,parent_node_id,parent_node_type,containment_kind,position_x,position_y,width,height,scale,interior_scale,updated_at)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
			ON CONFLICT(workspace_id,node_type,node_id) DO UPDATE SET
			parent_node_id=excluded.parent_node_id, parent_node_type=excluded.parent_node_type,
			containment_kind=excluded.containment_kind, position_x=excluded.position_x,
			position_y=excluded.position_y, width=excluded.width, height=excluded.height,
			scale=excluded.scale, interior_scale=excluded.interior_scale,
			updated_at=excluded.updated_at`,
			workspaceID, u.NodeID, u.NodeType, u.ParentNodeID, u.ParentNodeType,
			u.ContainmentKind, u.PositionX, u.PositionY, u.Width, u.Height, u.Scale,
			u.InteriorScale, now)
		if err != nil {
			return nil, err
		}
	}
	_, err = tx.Exec(`INSERT INTO floor_layout_revisions(workspace_id,revision) VALUES(?,1)
		ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1`, workspaceID)
	if err != nil {
		return nil, err
	}
	var revision int64
	if err := tx.QueryRow(`SELECT revision FROM floor_layout_revisions WHERE workspace_id=?`, workspaceID).Scan(&revision); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &FloorLayoutBatchResult{Revision: revision, Layouts: updates}, nil
}
