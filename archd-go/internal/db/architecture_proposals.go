package db

import (
	"database/sql"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	ProposalDecisionPending  = "pending"
	ProposalDecisionApproved = "approved"
	ProposalDecisionRejected = "rejected"
)

type ArchitectureProposal struct {
	ID              string                    `json:"id"`
	WorkspaceID     string                    `json:"workspaceId"`
	RootID          *string                   `json:"rootId"`
	ParentScopeType string                    `json:"parentScopeType"`
	ParentScopeID   string                    `json:"parentScopeId"`
	CurrentRevision int                       `json:"currentRevision"`
	CreatedBy       string                    `json:"createdBy"`
	CreatedAt       int64                     `json:"createdAt"`
	UpdatedAt       int64                     `json:"updatedAt"`
	Round           ArchitectureProposalRound `json:"round"`
}

type ArchitectureProposalRound struct {
	Revision        int                              `json:"revision"`
	Rationale       string                           `json:"rationale"`
	EvidenceSummary string                           `json:"evidenceSummary"`
	Coverage        string                           `json:"coverage"`
	CreatedBy       string                           `json:"createdBy"`
	CreatedAt       int64                            `json:"createdAt"`
	Systems         []ArchitectureProposalSystem     `json:"systems"`
	Memberships     []ArchitectureProposalMembership `json:"memberships"`
	Layouts         []ArchitectureProposalLayout     `json:"layouts"`
}

type ArchitectureProposalSystem struct {
	SystemKey            string  `json:"systemKey"`
	Name                 string  `json:"name"`
	Description          string  `json:"description"`
	ParentRefType        string  `json:"parentRefType"`
	ParentRefID          string  `json:"parentRefId"`
	Depth                int     `json:"depth"`
	Decision             string  `json:"decision"`
	RejectionReason      string  `json:"rejectionReason"`
	DecidedBy            string  `json:"decidedBy"`
	DecidedAt            *int64  `json:"decidedAt"`
	MaterializedSystemID *string `json:"materializedSystemId"`
	FileCount            int     `json:"fileCount"`
	AffectedFileCount    int     `json:"affectedFileCount"`
}

type ArchitectureProposalMembership struct {
	ID              string  `json:"id"`
	FileID          *string `json:"fileId"`
	RootID          string  `json:"rootId"`
	FilePath        string  `json:"filePath"`
	TargetSystemKey string  `json:"targetSystemKey"`
	Disposition     string  `json:"disposition"`
	Rationale       string  `json:"rationale"`
}

type ArchitectureProposalDecision struct {
	Decision        string `json:"decision"`
	RejectionReason string `json:"rejectionReason"`
	DecidedBy       string `json:"decidedBy"`
}

// ArchitectureProposalLayout is the mutable review-only counterpart of a
// Floor layout. NodeKey is a proposal system key or membership id; parent
// references are semantic proposal references, never renderer node ids.
type ArchitectureProposalLayout struct {
	NodeType      string  `json:"nodeType"`
	NodeKey       string  `json:"nodeKey"`
	ParentRefType string  `json:"parentRefType"`
	ParentRefID   string  `json:"parentRefId"`
	PositionX     float64 `json:"positionX"`
	PositionY     float64 `json:"positionY"`
	Width         float64 `json:"width"`
	Height        float64 `json:"height"`
	Scale         float64 `json:"scale"`
	InteriorScale float64 `json:"interiorScale"`
	UpdatedAt     int64   `json:"updatedAt"`
}

func validateProposalRound(round *ArchitectureProposalRound) error {
	if round.Coverage != "complete" && round.Coverage != "partial" && round.Coverage != "no_change" {
		return fmt.Errorf("invalid coverage %q", round.Coverage)
	}
	keys := make(map[string]ArchitectureProposalSystem, len(round.Systems))
	for i := range round.Systems {
		system := &round.Systems[i]
		if strings.TrimSpace(system.Name) == "" {
			return fmt.Errorf("proposal system name is required")
		}
		if system.SystemKey == "" {
			system.SystemKey = uuid.NewString()
		}
		if _, duplicate := keys[system.SystemKey]; duplicate {
			return fmt.Errorf("duplicate proposal system %s", system.SystemKey)
		}
		if system.ParentRefType != "scope" && system.ParentRefType != "live_system" && system.ParentRefType != "proposed_system" {
			return fmt.Errorf("invalid parent reference %q", system.ParentRefType)
		}
		if system.ParentRefType != "scope" && system.ParentRefID == "" {
			return fmt.Errorf("parent reference id is required")
		}
		system.Decision = ProposalDecisionPending
		system.RejectionReason = ""
		system.DecidedBy = ""
		system.DecidedAt = nil
		system.MaterializedSystemID = nil
		keys[system.SystemKey] = *system
	}
	for _, system := range round.Systems {
		if system.ParentRefType == "proposed_system" {
			if _, exists := keys[system.ParentRefID]; !exists {
				return fmt.Errorf("proposed parent %s does not exist", system.ParentRefID)
			}
			if keys[system.ParentRefID].Depth >= system.Depth {
				return fmt.Errorf("proposal depth must increase below parent %s", system.ParentRefID)
			}
		}
	}
	seenFiles := make(map[string]bool, len(round.Memberships))
	for i := range round.Memberships {
		membership := &round.Memberships[i]
		if membership.ID == "" {
			membership.ID = uuid.NewString()
		}
		if strings.TrimSpace(membership.FilePath) == "" || seenFiles[membership.FilePath] {
			return fmt.Errorf("each membership needs a unique file path")
		}
		seenFiles[membership.FilePath] = true
		switch membership.Disposition {
		case "assign":
			if keys[membership.TargetSystemKey].SystemKey == "" {
				return fmt.Errorf("assign membership needs a proposed system")
			}
		case "retain", "unassigned", "excluded":
		default:
			return fmt.Errorf("invalid membership disposition %q", membership.Disposition)
		}
	}
	return nil
}

func CreateArchitectureProposal(database *sql.DB, proposal ArchitectureProposal) (*ArchitectureProposal, error) {
	if proposal.WorkspaceID == "" {
		return nil, fmt.Errorf("workspace id is required")
	}
	if proposal.ParentScopeType == "" {
		proposal.ParentScopeType = "workspace"
	}
	if proposal.ParentScopeType != "workspace" && proposal.ParentScopeType != "system" {
		return nil, fmt.Errorf("invalid parent scope %q", proposal.ParentScopeType)
	}
	if proposal.ParentScopeType == "system" && proposal.ParentScopeID == "" {
		return nil, fmt.Errorf("system parent scope requires an id")
	}
	if err := validateProposalRound(&proposal.Round); err != nil {
		return nil, err
	}
	now := time.Now().UnixMilli()
	if proposal.ID == "" {
		proposal.ID = uuid.NewString()
	}
	if proposal.CreatedBy == "" {
		proposal.CreatedBy = "agent"
	}
	proposal.CurrentRevision = 1
	proposal.CreatedAt, proposal.UpdatedAt = now, now
	proposal.Round.Revision = 1
	proposal.Round.CreatedAt = now
	if proposal.Round.CreatedBy == "" {
		proposal.Round.CreatedBy = proposal.CreatedBy
	}
	tx, err := database.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck
	var exists int
	if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=?)`, proposal.WorkspaceID).Scan(&exists); err != nil || exists == 0 {
		if err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("workspace %s does not exist", proposal.WorkspaceID)
	}
	if proposal.RootID != nil {
		if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM roots WHERE id=? AND workspace_id=?)`, *proposal.RootID, proposal.WorkspaceID).Scan(&exists); err != nil || exists == 0 {
			if err != nil {
				return nil, err
			}
			return nil, fmt.Errorf("proposal root does not belong to workspace")
		}
	}
	if proposal.ParentScopeType == "system" {
		if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM systems WHERE id=? AND workspace_id=?)`, proposal.ParentScopeID, proposal.WorkspaceID).Scan(&exists); err != nil || exists == 0 {
			if err != nil {
				return nil, err
			}
			return nil, fmt.Errorf("proposal parent does not belong to workspace")
		}
	}
	if _, err := tx.Exec(`INSERT INTO architecture_proposals(id,workspace_id,root_id,parent_scope_type,parent_scope_id,current_revision,created_by,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?)`, proposal.ID, proposal.WorkspaceID, proposal.RootID, proposal.ParentScopeType, proposal.ParentScopeID, proposal.CreatedBy, now, now); err != nil {
		return nil, err
	}
	if err := insertProposalRound(tx, proposal.ID, &proposal.Round); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &proposal, nil
}

func insertProposalRound(tx *sql.Tx, proposalID string, round *ArchitectureProposalRound) error {
	var workspaceID string
	var proposalRootID *string
	if err := tx.QueryRow(`SELECT workspace_id,root_id FROM architecture_proposals WHERE id=?`, proposalID).Scan(&workspaceID, &proposalRootID); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO architecture_proposal_rounds(proposal_id,revision,rationale,evidence_summary,coverage,created_by,created_at) VALUES(?,?,?,?,?,?,?)`, proposalID, round.Revision, round.Rationale, round.EvidenceSummary, round.Coverage, round.CreatedBy, round.CreatedAt); err != nil {
		return err
	}
	for _, system := range round.Systems {
		if _, err := tx.Exec(`INSERT INTO architecture_proposal_systems(proposal_id,revision,system_key,name,description,parent_ref_type,parent_ref_id,depth) VALUES(?,?,?,?,?,?,?,?)`, proposalID, round.Revision, system.SystemKey, system.Name, system.Description, system.ParentRefType, system.ParentRefID, system.Depth); err != nil {
			return err
		}
	}
	for i := range round.Memberships {
		membership := &round.Memberships[i]
		var currentRoot, currentPath, currentLanguage string
		switch {
		case membership.FileID != nil:
			if err := tx.QueryRow(`SELECT f.root_id,f.rel_path,f.language FROM files f JOIN roots r ON r.id=f.root_id WHERE f.id=? AND r.workspace_id=?`, *membership.FileID, workspaceID).Scan(&currentRoot, &currentPath, &currentLanguage); err != nil {
				return fmt.Errorf("membership file %s is stale: %w", membership.FilePath, err)
			}
		case membership.Disposition == "assign" || membership.Disposition == "retain":
			if proposalRootID != nil {
				if err := tx.QueryRow(`SELECT id,root_id,rel_path,language FROM files WHERE root_id=? AND rel_path=?`, *proposalRootID, membership.FilePath).Scan(&membership.FileID, &currentRoot, &currentPath, &currentLanguage); err != nil {
					return fmt.Errorf("membership path %s does not resolve in proposal root: %w", membership.FilePath, err)
				}
			} else {
				rows, err := tx.Query(`SELECT f.id,f.root_id,f.rel_path,f.language FROM files f JOIN roots r ON r.id=f.root_id WHERE r.workspace_id=? AND f.rel_path=?`, workspaceID, membership.FilePath)
				if err != nil {
					return err
				}
				matches := 0
				for rows.Next() {
					matches++
					if err := rows.Scan(&membership.FileID, &currentRoot, &currentPath, &currentLanguage); err != nil {
						rows.Close()
						return err
					}
				}
				if err := rows.Close(); err != nil {
					return err
				}
				if matches != 1 {
					return fmt.Errorf("membership path %s resolved to %d files; provide rootId", membership.FilePath, matches)
				}
			}
		}
		if (membership.Disposition == "assign" || membership.Disposition == "retain") &&
			(currentLanguage == "markdown" || currentLanguage == "text") {
			return fmt.Errorf("documentation path %s belongs in Documents and cannot be assigned to an architecture system", membership.FilePath)
		}
		if currentRoot != "" {
			if membership.RootID != "" && membership.RootID != currentRoot {
				return fmt.Errorf("membership path %s belongs to a different root", membership.FilePath)
			}
			membership.RootID = currentRoot
			membership.FilePath = currentPath
		}
		if _, err := tx.Exec(`INSERT INTO architecture_proposal_memberships(id,proposal_id,revision,file_id,root_id,file_path,target_system_key,disposition,rationale) VALUES(?,?,?,?,?,?,?,?,?)`, membership.ID, proposalID, round.Revision, membership.FileID, membership.RootID, membership.FilePath, membership.TargetSystemKey, membership.Disposition, membership.Rationale); err != nil {
			return err
		}
	}
	return nil
}

func AddArchitectureProposalRevision(database *sql.DB, proposalID, workspaceID string, expectedRevision int, round ArchitectureProposalRound) (*ArchitectureProposal, error) {
	if err := validateProposalRound(&round); err != nil {
		return nil, err
	}
	tx, err := database.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck
	var current int
	if err := tx.QueryRow(`SELECT current_revision FROM architecture_proposals WHERE id=? AND workspace_id=?`, proposalID, workspaceID).Scan(&current); err != nil {
		return nil, err
	}
	if current != expectedRevision {
		return nil, fmt.Errorf("stale proposal revision: current=%d", current)
	}
	round.Revision = current + 1
	round.CreatedAt = time.Now().UnixMilli()
	if round.CreatedBy == "" {
		round.CreatedBy = "agent"
	}
	if err := insertProposalRound(tx, proposalID, &round); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`UPDATE architecture_proposals SET current_revision=?,updated_at=? WHERE id=?`, round.Revision, round.CreatedAt, proposalID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return GetArchitectureProposal(database, proposalID, workspaceID, false)
}

// ApplyArchitectureProposalLayouts commits one complete review gesture. In
// addition to geometry, a changed coordinate parent updates the proposal's
// semantic hierarchy (or a membership's target) in the same transaction.
// Nothing here mutates the live systems/files tables.
func ApplyArchitectureProposalLayouts(database *sql.DB, proposalID, workspaceID string, revision int, updates []ArchitectureProposalLayout) (*ArchitectureProposal, error) {
	if len(updates) == 0 {
		return nil, fmt.Errorf("at least one proposal layout is required")
	}
	tx, err := database.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck

	var current int
	if err := tx.QueryRow(`SELECT current_revision FROM architecture_proposals WHERE id=? AND workspace_id=?`, proposalID, workspaceID).Scan(&current); err != nil {
		return nil, err
	}
	if current != revision {
		return nil, fmt.Errorf("stale proposal revision: current=%d", current)
	}

	type systemState struct {
		parentType string
		parentID   string
		decision   string
	}
	systems := make(map[string]systemState)
	rows, err := tx.Query(`SELECT system_key,parent_ref_type,parent_ref_id,decision FROM architecture_proposal_systems WHERE proposal_id=? AND revision=?`, proposalID, revision)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var key string
		var state systemState
		if err := rows.Scan(&key, &state.parentType, &state.parentID, &state.decision); err != nil {
			rows.Close()
			return nil, err
		}
		systems[key] = state
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	now := time.Now().UnixMilli()
	seen := make(map[string]bool, len(updates))
	for i := range updates {
		u := &updates[i]
		key := u.NodeType + ":" + u.NodeKey
		if seen[key] {
			return nil, fmt.Errorf("duplicate proposal layout %s", key)
		}
		seen[key] = true
		if u.InteriorScale == 0 {
			u.InteriorScale = 1
		}
		geometry := []float64{u.PositionX, u.PositionY, u.Width, u.Height, u.Scale, u.InteriorScale}
		for _, value := range geometry {
			if math.IsNaN(value) || math.IsInf(value, 0) {
				return nil, fmt.Errorf("invalid geometry for proposal layout %s", key)
			}
		}
		if u.Width <= 0 || u.Height <= 0 || u.Scale <= 0 || u.InteriorScale <= 0 {
			return nil, fmt.Errorf("invalid geometry for proposal layout %s", key)
		}
		switch u.NodeType {
		case "system":
			state, ok := systems[u.NodeKey]
			if !ok {
				return nil, fmt.Errorf("proposal system %s does not exist", u.NodeKey)
			}
			if state.decision != ProposalDecisionPending {
				return nil, fmt.Errorf("proposal system %s is already %s", u.NodeKey, state.decision)
			}
			switch u.ParentRefType {
			case "scope":
				u.ParentRefID = ""
			case "proposed_system":
				if u.ParentRefID == u.NodeKey || systems[u.ParentRefID].parentType == "" {
					return nil, fmt.Errorf("proposed parent %s does not exist", u.ParentRefID)
				}
			case "live_system":
				var exists int
				if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM systems WHERE id=? AND workspace_id=?)`, u.ParentRefID, workspaceID).Scan(&exists); err != nil {
					return nil, err
				}
				if exists == 0 {
					return nil, fmt.Errorf("live parent %s does not belong to workspace", u.ParentRefID)
				}
			default:
				return nil, fmt.Errorf("invalid parent reference %q", u.ParentRefType)
			}
			state.parentType, state.parentID = u.ParentRefType, u.ParentRefID
			systems[u.NodeKey] = state
		case "file":
			target, targetExists := systems[u.ParentRefID]
			if u.ParentRefType != "proposed_system" || !targetExists {
				return nil, fmt.Errorf("proposal file parent must be a proposed system")
			}
			if target.decision != ProposalDecisionPending {
				return nil, fmt.Errorf("proposal file parent %s is already %s", u.ParentRefID, target.decision)
			}
			var decision, disposition string
			if err := tx.QueryRow(`SELECT s.decision,m.disposition FROM architecture_proposal_memberships m JOIN architecture_proposal_systems s ON s.proposal_id=m.proposal_id AND s.revision=m.revision AND s.system_key=m.target_system_key WHERE m.proposal_id=? AND m.revision=? AND m.id=?`, proposalID, revision, u.NodeKey).Scan(&decision, &disposition); err != nil {
				return nil, fmt.Errorf("proposal membership %s does not exist: %w", u.NodeKey, err)
			}
			if disposition != "assign" || decision != ProposalDecisionPending {
				return nil, fmt.Errorf("proposal membership %s is not editable", u.NodeKey)
			}
		default:
			return nil, fmt.Errorf("invalid proposal layout node type %q", u.NodeType)
		}
	}

	// Reject cycles and derive all depths from the resulting hierarchy. The
	// stored depth can never drift from a drag-based reparent operation.
	depths := make(map[string]int, len(systems))
	visiting := make(map[string]bool, len(systems))
	var depthFor func(string) (int, error)
	depthFor = func(key string) (int, error) {
		if depth, ok := depths[key]; ok {
			return depth, nil
		}
		if visiting[key] {
			return 0, fmt.Errorf("proposal hierarchy cycle involving %s", key)
		}
		visiting[key] = true
		state := systems[key]
		depth := 0
		switch state.parentType {
		case "proposed_system":
			parentDepth, err := depthFor(state.parentID)
			if err != nil {
				return 0, err
			}
			depth = parentDepth + 1
		case "live_system":
			if err := tx.QueryRow(`SELECT depth + 1 FROM systems WHERE id=? AND workspace_id=?`, state.parentID, workspaceID).Scan(&depth); err != nil {
				return 0, err
			}
		case "scope":
			var scopeType, scopeID string
			if err := tx.QueryRow(`SELECT parent_scope_type,parent_scope_id FROM architecture_proposals WHERE id=?`, proposalID).Scan(&scopeType, &scopeID); err != nil {
				return 0, err
			}
			if scopeType == "system" {
				if err := tx.QueryRow(`SELECT depth + 1 FROM systems WHERE id=? AND workspace_id=?`, scopeID, workspaceID).Scan(&depth); err != nil {
					return 0, err
				}
			}
		default:
			return 0, fmt.Errorf("invalid parent reference %q", state.parentType)
		}
		delete(visiting, key)
		depths[key] = depth
		return depth, nil
	}
	for key := range systems {
		if _, err := depthFor(key); err != nil {
			return nil, err
		}
	}

	for key, state := range systems {
		if _, err := tx.Exec(`UPDATE architecture_proposal_systems SET parent_ref_type=?,parent_ref_id=?,depth=? WHERE proposal_id=? AND revision=? AND system_key=?`, state.parentType, state.parentID, depths[key], proposalID, revision, key); err != nil {
			return nil, err
		}
	}
	for _, u := range updates {
		if u.NodeType == "file" {
			if _, err := tx.Exec(`UPDATE architecture_proposal_memberships SET target_system_key=? WHERE proposal_id=? AND revision=? AND id=?`, u.ParentRefID, proposalID, revision, u.NodeKey); err != nil {
				return nil, err
			}
		}
		if _, err := tx.Exec(`INSERT INTO architecture_proposal_layouts(proposal_id,revision,node_type,node_key,parent_ref_type,parent_ref_id,position_x,position_y,width,height,scale,interior_scale,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(proposal_id,revision,node_type,node_key) DO UPDATE SET parent_ref_type=excluded.parent_ref_type,parent_ref_id=excluded.parent_ref_id,position_x=excluded.position_x,position_y=excluded.position_y,width=excluded.width,height=excluded.height,scale=excluded.scale,interior_scale=excluded.interior_scale,updated_at=excluded.updated_at`, proposalID, revision, u.NodeType, u.NodeKey, u.ParentRefType, u.ParentRefID, u.PositionX, u.PositionY, u.Width, u.Height, u.Scale, u.InteriorScale, now); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(`UPDATE architecture_proposals SET updated_at=? WHERE id=?`, now, proposalID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return GetArchitectureProposal(database, proposalID, workspaceID, false)
}

// approveArchitectureProposalSystemTx materializes one pending proposal system
// into the canonical Floor. The caller owns the transaction and the Floor
// layout revision, which lets a whole reviewed tree become live atomically
// instead of exposing one partially-materialized branch at a time.
func approveArchitectureProposalSystemTx(tx *sql.Tx, proposalID, workspaceID string, revision int, system *ArchitectureProposalSystem, decidedBy string, now int64) (bool, error) {
	var parentID *string
	switch system.ParentRefType {
	case "scope":
		var scopeType, scopeID string
		if err := tx.QueryRow(`SELECT parent_scope_type,parent_scope_id FROM architecture_proposals WHERE id=?`, proposalID).Scan(&scopeType, &scopeID); err != nil {
			return false, err
		}
		if scopeType == "system" {
			parentID = &scopeID
		}
	case "live_system":
		parentID = &system.ParentRefID
	case "proposed_system":
		if err := tx.QueryRow(`SELECT materialized_system_id FROM architecture_proposal_systems WHERE proposal_id=? AND revision=? AND system_key=? AND decision='approved'`, proposalID, revision, system.ParentRefID).Scan(&parentID); err != nil || parentID == nil {
			return false, fmt.Errorf("proposed parent %s must be approved first", system.ParentRefID)
		}
	}
	materializedID := uuid.NewString()
	if _, err := tx.Exec(`INSERT INTO systems(id,workspace_id,name,parent_id,source,description,depth,created_at,updated_at) VALUES(?,?,?,?,'agent',?,?,?,?)`, materializedID, workspaceID, system.Name, parentID, system.Description, system.Depth, now, now); err != nil {
		return false, err
	}
	wroteFloorLayout := false
	var systemLayout ArchitectureProposalLayout
	layoutErr := tx.QueryRow(`SELECT node_type,node_key,parent_ref_type,parent_ref_id,position_x,position_y,width,height,scale,interior_scale,updated_at FROM architecture_proposal_layouts WHERE proposal_id=? AND revision=? AND node_type='system' AND node_key=?`, proposalID, revision, system.SystemKey).Scan(&systemLayout.NodeType, &systemLayout.NodeKey, &systemLayout.ParentRefType, &systemLayout.ParentRefID, &systemLayout.PositionX, &systemLayout.PositionY, &systemLayout.Width, &systemLayout.Height, &systemLayout.Scale, &systemLayout.InteriorScale, &systemLayout.UpdatedAt)
	if layoutErr != nil && !errors.Is(layoutErr, sql.ErrNoRows) {
		return false, layoutErr
	}
	if layoutErr == nil {
		var parentType *string
		if parentID != nil {
			value := "system"
			parentType = &value
		}
		containment := "root"
		if parentID != nil {
			containment = "part_of"
		}
		if _, err := tx.Exec(`INSERT INTO floor_layouts(workspace_id,node_id,node_type,parent_node_id,parent_node_type,containment_kind,position_x,position_y,width,height,scale,interior_scale,updated_at) VALUES(?,?,'system',?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,node_type,node_id) DO UPDATE SET parent_node_id=excluded.parent_node_id,parent_node_type=excluded.parent_node_type,containment_kind=excluded.containment_kind,position_x=excluded.position_x,position_y=excluded.position_y,width=excluded.width,height=excluded.height,scale=excluded.scale,interior_scale=excluded.interior_scale,updated_at=excluded.updated_at`, workspaceID, materializedID, parentID, parentType, containment, systemLayout.PositionX, systemLayout.PositionY, systemLayout.Width, systemLayout.Height, systemLayout.Scale, systemLayout.InteriorScale, now); err != nil {
			return false, err
		}
		wroteFloorLayout = true
	}
	rows, err := tx.Query(`SELECT m.id,m.file_id,m.root_id,m.file_path,l.position_x,l.position_y,l.width,l.height,l.scale,l.interior_scale FROM architecture_proposal_memberships m LEFT JOIN architecture_proposal_layouts l ON l.proposal_id=m.proposal_id AND l.revision=m.revision AND l.node_type='file' AND l.node_key=m.id WHERE m.proposal_id=? AND m.revision=? AND m.target_system_key=? AND m.disposition='assign'`, proposalID, revision, system.SystemKey)
	if err != nil {
		return false, err
	}
	for rows.Next() {
		var membershipID string
		var fileID *string
		var rootID, path string
		var x, y, width, height, scale, interiorScale *float64
		if err := rows.Scan(&membershipID, &fileID, &rootID, &path, &x, &y, &width, &height, &scale, &interiorScale); err != nil {
			rows.Close()
			return false, err
		}
		if fileID == nil {
			rows.Close()
			return false, fmt.Errorf("membership %s no longer resolves to a file", path)
		}
		result, err := tx.Exec(`UPDATE files SET system_id=? WHERE id=? AND root_id=?`, materializedID, *fileID, rootID)
		if err != nil {
			rows.Close()
			return false, err
		}
		if affected, _ := result.RowsAffected(); affected != 1 {
			rows.Close()
			return false, fmt.Errorf("membership %s is stale", path)
		}
		if x != nil && y != nil && width != nil && height != nil && scale != nil && interiorScale != nil {
			parentType := "system"
			if _, err := tx.Exec(`INSERT INTO floor_layouts(workspace_id,node_id,node_type,parent_node_id,parent_node_type,containment_kind,position_x,position_y,width,height,scale,interior_scale,updated_at) VALUES(?,?,'file',?,?,'part_of',?,?,?,?,?,?,?) ON CONFLICT(workspace_id,node_type,node_id) DO UPDATE SET parent_node_id=excluded.parent_node_id,parent_node_type=excluded.parent_node_type,containment_kind=excluded.containment_kind,position_x=excluded.position_x,position_y=excluded.position_y,width=excluded.width,height=excluded.height,scale=excluded.scale,interior_scale=excluded.interior_scale,updated_at=excluded.updated_at`, workspaceID, *fileID, materializedID, parentType, *x, *y, *width, *height, *scale, *interiorScale, now); err != nil {
				rows.Close()
				return false, err
			}
			wroteFloorLayout = true
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return false, err
	}
	if err := rows.Close(); err != nil {
		return false, err
	}
	result, err := tx.Exec(`UPDATE architecture_proposal_systems SET decision='approved',materialized_system_id=?,decided_by=?,decided_at=? WHERE proposal_id=? AND revision=? AND system_key=? AND decision='pending'`, materializedID, decidedBy, now, proposalID, revision, system.SystemKey)
	if err != nil {
		return false, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return false, fmt.Errorf("proposal system %s is already decided", system.SystemKey)
	}
	system.Decision = ProposalDecisionApproved
	system.MaterializedSystemID = &materializedID
	return wroteFloorLayout, nil
}

func bumpFloorLayoutRevisionTx(tx *sql.Tx, workspaceID string) error {
	_, err := tx.Exec(`INSERT INTO floor_layout_revisions(workspace_id,revision) VALUES(?,1) ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1`, workspaceID)
	return err
}

// pruneEmptyClassifierSystemsTx removes the provisional classifier scaffolding
// that a reviewed proposal has superseded. Proposal memberships move files into
// authored systems, but the old cluster tree can otherwise remain as empty
// shells until a later live-clustering pass. That delayed cleanup is not code
// drift and must not become a Morning Delta asking the user to review the map
// they just approved.
//
// Delete empty leaves repeatedly so a classifier parent survives whenever it
// still contains a file or any authored/classifier child. The systems delete
// trigger removes their obsolete Floor layouts in the same transaction.
func pruneEmptyClassifierSystemsTx(tx *sql.Tx, workspaceID string) (int64, error) {
	var total int64
	for {
		result, err := tx.Exec(`
			DELETE FROM systems
			WHERE workspace_id=?
			  AND source IN ('cluster','directory')
			  AND NOT EXISTS (
				SELECT 1 FROM files WHERE files.system_id=systems.id
			  )
			  AND NOT EXISTS (
				SELECT 1 FROM systems child WHERE child.parent_id=systems.id
			  )`, workspaceID)
		if err != nil {
			return total, err
		}
		removed, err := result.RowsAffected()
		if err != nil {
			return total, err
		}
		total += removed
		if removed == 0 {
			return total, nil
		}
	}
}

func DecideArchitectureProposalSystem(database *sql.DB, proposalID, workspaceID, systemKey string, revision int, decision ArchitectureProposalDecision) (*ArchitectureProposalSystem, error) {
	if decision.Decision != ProposalDecisionApproved && decision.Decision != ProposalDecisionRejected {
		return nil, fmt.Errorf("invalid decision %q", decision.Decision)
	}
	if decision.Decision == ProposalDecisionRejected && strings.TrimSpace(decision.RejectionReason) == "" {
		return nil, fmt.Errorf("rejection reason is required")
	}
	if decision.DecidedBy == "" {
		decision.DecidedBy = "user"
	}
	tx, err := database.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck
	var current int
	if err := tx.QueryRow(`SELECT current_revision FROM architecture_proposals WHERE id=? AND workspace_id=?`, proposalID, workspaceID).Scan(&current); err != nil {
		return nil, err
	}
	if current != revision {
		return nil, fmt.Errorf("stale proposal revision: current=%d", current)
	}
	var system ArchitectureProposalSystem
	if err := tx.QueryRow(`SELECT system_key,name,description,parent_ref_type,parent_ref_id,depth,decision,rejection_reason,materialized_system_id FROM architecture_proposal_systems WHERE proposal_id=? AND revision=? AND system_key=?`, proposalID, revision, systemKey).Scan(&system.SystemKey, &system.Name, &system.Description, &system.ParentRefType, &system.ParentRefID, &system.Depth, &system.Decision, &system.RejectionReason, &system.MaterializedSystemID); err != nil {
		return nil, err
	}
	if system.Decision != ProposalDecisionPending {
		if system.Decision == decision.Decision {
			return &system, tx.Commit()
		}
		return nil, fmt.Errorf("proposal system already %s", system.Decision)
	}
	now := time.Now().UnixMilli()
	if decision.Decision == ProposalDecisionRejected {
		if _, err := tx.Exec(`UPDATE architecture_proposal_systems SET decision='rejected',rejection_reason=?,decided_by=?,decided_at=? WHERE proposal_id=? AND revision=? AND system_key=? AND decision='pending'`, decision.RejectionReason, decision.DecidedBy, now, proposalID, revision, systemKey); err != nil {
			return nil, err
		}
	} else {
		wroteFloorLayout, err := approveArchitectureProposalSystemTx(tx, proposalID, workspaceID, revision, &system, decision.DecidedBy, now)
		if err != nil {
			return nil, err
		}
		if wroteFloorLayout {
			if err := bumpFloorLayoutRevisionTx(tx, workspaceID); err != nil {
				return nil, err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	proposal, err := GetArchitectureProposal(database, proposalID, workspaceID, false)
	if err != nil {
		return nil, err
	}
	for _, candidate := range proposal.Round.Systems {
		if candidate.SystemKey == systemKey {
			return &candidate, nil
		}
	}
	return nil, sql.ErrNoRows
}

// FinalizeArchitectureProposal is the commit boundary for review. Every
// remaining pending system is approved in hierarchy order, and the complete
// system tree, memberships, and reviewed geometry become canonical in one
// transaction. A malformed remainder (for example, a pending child beneath a
// rejected parent) aborts the whole commit instead of leaking a partial Floor.
func FinalizeArchitectureProposal(database *sql.DB, proposalID, workspaceID string, revision int, decidedBy string) (*ArchitectureProposal, error) {
	if decidedBy == "" {
		decidedBy = "user"
	}
	tx, err := database.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck
	var current int
	if err := tx.QueryRow(`SELECT current_revision FROM architecture_proposals WHERE id=? AND workspace_id=?`, proposalID, workspaceID).Scan(&current); err != nil {
		return nil, err
	}
	if current != revision {
		return nil, fmt.Errorf("stale proposal revision: current=%d", current)
	}

	rows, err := tx.Query(`SELECT system_key,name,description,parent_ref_type,parent_ref_id,depth,decision,rejection_reason,materialized_system_id FROM architecture_proposal_systems WHERE proposal_id=? AND revision=? ORDER BY depth,name,system_key`, proposalID, revision)
	if err != nil {
		return nil, err
	}
	systems := make([]ArchitectureProposalSystem, 0)
	for rows.Next() {
		var system ArchitectureProposalSystem
		if err := rows.Scan(&system.SystemKey, &system.Name, &system.Description, &system.ParentRefType, &system.ParentRefID, &system.Depth, &system.Decision, &system.RejectionReason, &system.MaterializedSystemID); err != nil {
			rows.Close()
			return nil, err
		}
		systems = append(systems, system)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	now := time.Now().UnixMilli()
	wroteFloorLayout := false
	for i := range systems {
		if systems[i].Decision != ProposalDecisionPending {
			continue
		}
		wrote, err := approveArchitectureProposalSystemTx(tx, proposalID, workspaceID, revision, &systems[i], decidedBy, now)
		if err != nil {
			return nil, fmt.Errorf("could not finalize %s: %w", systems[i].Name, err)
		}
		wroteFloorLayout = wroteFloorLayout || wrote
	}
	prunedClassifierSystems, err := pruneEmptyClassifierSystemsTx(tx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("prune superseded classifier systems: %w", err)
	}
	if wroteFloorLayout || prunedClassifierSystems > 0 {
		if err := bumpFloorLayoutRevisionTx(tx, workspaceID); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(`UPDATE architecture_proposals SET updated_at=? WHERE id=? AND workspace_id=?`, now, proposalID, workspaceID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return GetArchitectureProposal(database, proposalID, workspaceID, false)
}

func GetArchitectureProposal(database *sql.DB, proposalID, workspaceID string, includeRetained bool) (*ArchitectureProposal, error) {
	proposal := &ArchitectureProposal{ID: proposalID, WorkspaceID: workspaceID}
	if err := database.QueryRow(`SELECT root_id,parent_scope_type,parent_scope_id,current_revision,created_by,created_at,updated_at FROM architecture_proposals WHERE id=? AND workspace_id=?`, proposalID, workspaceID).Scan(&proposal.RootID, &proposal.ParentScopeType, &proposal.ParentScopeID, &proposal.CurrentRevision, &proposal.CreatedBy, &proposal.CreatedAt, &proposal.UpdatedAt); err != nil {
		return nil, err
	}
	round := &proposal.Round
	if err := database.QueryRow(`SELECT revision,rationale,evidence_summary,coverage,created_by,created_at FROM architecture_proposal_rounds WHERE proposal_id=? AND revision=?`, proposalID, proposal.CurrentRevision).Scan(&round.Revision, &round.Rationale, &round.EvidenceSummary, &round.Coverage, &round.CreatedBy, &round.CreatedAt); err != nil {
		return nil, err
	}
	rows, err := database.Query(`SELECT s.system_key,s.name,s.description,s.parent_ref_type,s.parent_ref_id,s.depth,s.decision,s.rejection_reason,s.decided_by,s.decided_at,s.materialized_system_id,COUNT(CASE WHEN m.disposition='assign' THEN 1 END),COUNT(CASE WHEN m.disposition!='retain' THEN 1 END) FROM architecture_proposal_systems s LEFT JOIN architecture_proposal_memberships m ON m.proposal_id=s.proposal_id AND m.revision=s.revision AND m.target_system_key=s.system_key WHERE s.proposal_id=? AND s.revision=? GROUP BY s.system_key ORDER BY s.depth,s.name`, proposalID, round.Revision)
	if err != nil {
		return nil, err
	}
	round.Systems = make([]ArchitectureProposalSystem, 0)
	for rows.Next() {
		var system ArchitectureProposalSystem
		if err := rows.Scan(&system.SystemKey, &system.Name, &system.Description, &system.ParentRefType, &system.ParentRefID, &system.Depth, &system.Decision, &system.RejectionReason, &system.DecidedBy, &system.DecidedAt, &system.MaterializedSystemID, &system.FileCount, &system.AffectedFileCount); err != nil {
			rows.Close()
			return nil, err
		}
		round.Systems = append(round.Systems, system)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	membershipSQL := `SELECT id,file_id,root_id,file_path,target_system_key,disposition,rationale FROM architecture_proposal_memberships WHERE proposal_id=? AND revision=?`
	if !includeRetained {
		membershipSQL += ` AND disposition!='retain'`
	}
	membershipSQL += ` ORDER BY file_path`
	rows, err = database.Query(membershipSQL, proposalID, round.Revision)
	if err != nil {
		return nil, err
	}
	round.Memberships = make([]ArchitectureProposalMembership, 0)
	for rows.Next() {
		var membership ArchitectureProposalMembership
		if err := rows.Scan(&membership.ID, &membership.FileID, &membership.RootID, &membership.FilePath, &membership.TargetSystemKey, &membership.Disposition, &membership.Rationale); err != nil {
			rows.Close()
			return nil, err
		}
		round.Memberships = append(round.Memberships, membership)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	rows, err = database.Query(`SELECT node_type,node_key,parent_ref_type,parent_ref_id,position_x,position_y,width,height,scale,interior_scale,updated_at FROM architecture_proposal_layouts WHERE proposal_id=? AND revision=? ORDER BY node_type,node_key`, proposalID, round.Revision)
	if err != nil {
		return nil, err
	}
	round.Layouts = make([]ArchitectureProposalLayout, 0)
	for rows.Next() {
		var layout ArchitectureProposalLayout
		if err := rows.Scan(&layout.NodeType, &layout.NodeKey, &layout.ParentRefType, &layout.ParentRefID, &layout.PositionX, &layout.PositionY, &layout.Width, &layout.Height, &layout.Scale, &layout.InteriorScale, &layout.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		round.Layouts = append(round.Layouts, layout)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	return proposal, rows.Close()
}

func ListArchitectureProposals(database *sql.DB, workspaceID string) ([]ArchitectureProposal, error) {
	rows, err := database.Query(`SELECT id FROM architecture_proposals WHERE workspace_id=? ORDER BY updated_at DESC`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	result := make([]ArchitectureProposal, 0, len(ids))
	for _, id := range ids {
		proposal, err := GetArchitectureProposal(database, id, workspaceID, false)
		if err != nil {
			return nil, err
		}
		proposal.Round.Memberships = []ArchitectureProposalMembership{}
		result = append(result, *proposal)
	}
	return result, nil
}
