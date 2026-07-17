// ASM — Axiom Sheet Markup: the textual rendering of a sheet for agents,
// who cannot see the canvas (UML_UX_PLAN.md "How agents see sheets").
// Durable URI refs (file://relpath, sys://name-path, infra://service/name),
// containment by indentation, health as bracket tags, notes block-indented.
// Layout is topological only — x/y never appears.
package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"axiom.local/archd/internal/db"
)

type agentPlacement struct {
	X         float64  `json:"x"`
	Y         float64  `json:"y"`
	Width     *float64 `json:"width,omitempty"`
	Height    *float64 `json:"height,omitempty"`
	Scale     float64  `json:"scale"`
	ParentRef *string  `json:"parentRef,omitempty"`
}

func normalizedAgentScale(scale float64) float64 {
	if scale <= 0 {
		return 1
	}
	return scale
}

type agentFloorRef struct {
	ID              string          `json:"id"`
	URI             string          `json:"uri"`
	Path            string          `json:"path,omitempty"`
	ParentURI       *string         `json:"parentUri,omitempty"`
	Layout          *agentPlacement `json:"layout,omitempty"`
	ContainmentKind string          `json:"containmentKind,omitempty"`
}

type agentSheetNode struct {
	ID           string          `json:"id"`
	Type         string          `json:"type"`
	Name         string          `json:"name"`
	Metadata     json.RawMessage `json:"metadata,omitempty"`
	Sheet        agentPlacement  `json:"sheet"`
	LiveFloor    *agentFloorRef  `json:"liveFloor,omitempty"`
	Planned      bool            `json:"planned"`
	DeclaredPath string          `json:"declaredPath,omitempty"`
}

type agentSheetEdge struct {
	Kind   string `json:"kind"`
	Source string `json:"source"`
	Target string `json:"target"`
	Note   string `json:"note,omitempty"`
}

type agentSheetContext struct {
	SchemaVersion int              `json:"schemaVersion"`
	Sheet         map[string]any   `json:"sheet"`
	Nodes         []agentSheetNode `json:"nodes"`
	Edges         []agentSheetEdge `json:"edges"`
	Notes         []db.Annotation  `json:"notes"`
}

// renderAgentSheetContext freezes the authored Sheet together with the live
// Floor identity of every referenced node. Coordinates are sheet-local; the
// parentRef makes containment explicit, while liveFloor preserves where the
// same entity comes from in the indexed codebase.
func renderAgentSheetContext(sqlDB *sql.DB, sheet *db.Sheet) (string, error) {
	elements, err := db.GetSheetElements(sqlDB, sheet.ID)
	if err != nil {
		return "", err
	}
	planned, err := db.GetPlannedNodes(sqlDB, sheet.ID)
	if err != nil {
		return "", err
	}
	edges, err := db.GetPlannedEdges(sqlDB, sheet.ID)
	if err != nil {
		return "", fmt.Errorf("get planned edges: %w", err)
	}
	liveEdges, err := db.GetDependencies(sqlDB, sheet.WorkspaceID)
	if err != nil {
		return "", fmt.Errorf("get dependencies: %w", err)
	}
	notes, err := db.GetAnnotations(sqlDB, sheet.WorkspaceID, &sheet.ID)
	if err != nil {
		return "", fmt.Errorf("get annotations: %w", err)
	}
	files, err := db.GetFiles(sqlDB, sheet.WorkspaceID)
	if err != nil {
		return "", fmt.Errorf("get files: %w", err)
	}
	systems, err := db.GetSystems(sqlDB, sheet.WorkspaceID)
	if err != nil {
		return "", fmt.Errorf("get systems: %w", err)
	}
	infras, err := db.GetInfraNodes(sqlDB, sheet.WorkspaceID)
	if err != nil {
		return "", fmt.Errorf("get infrastructure: %w", err)
	}
	floorLayouts, err := db.GetFloorLayouts(sqlDB, sheet.WorkspaceID)
	if err != nil {
		return "", fmt.Errorf("get floor layouts: %w", err)
	}

	fileByID := make(map[string]db.File, len(files))
	for _, f := range files {
		fileByID[f.ID] = f
	}
	sysByID := make(map[string]db.System, len(systems))
	for _, s := range systems {
		sysByID[s.ID] = s
	}
	infraByID := make(map[string]db.InfraNode, len(infras))
	for _, n := range infras {
		infraByID[n.ID] = n
	}
	plannedByID := make(map[string]db.PlannedNode, len(planned))
	for _, p := range planned {
		plannedByID[p.ID] = p
	}
	floorLayoutByID := make(map[string]db.FloorLayout, len(floorLayouts))
	for _, layout := range floorLayouts {
		floorLayoutByID[layout.NodeID] = layout
	}

	liveURI := func(id string) string {
		if f, ok := fileByID[id]; ok {
			return "file://" + f.RelPath
		}
		if s, ok := sysByID[id]; ok {
			return "sys://" + systemNamePath(sysByID, s)
		}
		if n, ok := infraByID[id]; ok {
			service := n.Service
			if service == "" {
				service = "generic/" + n.Category
			}
			return "infra://" + service + "/" + n.Name
		}
		return id
	}
	resolveRef := func(id *string) *string {
		if id == nil || *id == "" {
			return nil
		}
		raw := strings.TrimPrefix(*id, "planned:")
		if p, ok := plannedByID[raw]; ok {
			ref := "planned://" + p.Kind + "/" + p.Name
			return &ref
		}
		ref := liveURI(*id)
		return &ref
	}
	applyFloorLayout := func(ref *agentFloorRef) {
		layout, ok := floorLayoutByID[ref.ID]
		if !ok {
			return
		}
		width, height := layout.Width, layout.Height
		ref.Layout = &agentPlacement{X: layout.PositionX, Y: layout.PositionY, Width: &width, Height: &height, Scale: layout.Scale}
		if layout.ParentNodeID != nil {
			parent := liveURI(*layout.ParentNodeID)
			ref.Layout.ParentRef = &parent
		}
		ref.ContainmentKind = layout.ContainmentKind
	}

	nodes := make([]agentSheetNode, 0, len(elements)+len(planned))
	displayedLiveIDs := make(map[string]bool, len(elements))
	for _, e := range elements {
		n := agentSheetNode{ID: e.ID, Name: e.Label, Sheet: agentPlacement{
			X: e.PositionX, Y: e.PositionY, Width: e.Width, Height: e.Height,
			Scale: normalizedAgentScale(e.Scale), ParentRef: resolveRef(e.ParentSystemID),
		}, Metadata: e.DesignMetadata}
		switch {
		case e.FileID != nil:
			displayedLiveIDs[*e.FileID] = true
			n.Type = "file"
			if f, ok := fileByID[*e.FileID]; ok {
				n.Name = f.RelPath
				floor := &agentFloorRef{ID: f.ID, URI: "file://" + f.RelPath, Path: f.RelPath}
				if f.SystemID != nil {
					parent := liveURI(*f.SystemID)
					floor.ParentURI = &parent
				}
				n.LiveFloor = floor
				applyFloorLayout(floor)
			}
		case e.SystemID != nil:
			displayedLiveIDs[*e.SystemID] = true
			n.Type = "system"
			if s, ok := sysByID[*e.SystemID]; ok {
				n.Name = s.Name
				floor := &agentFloorRef{ID: s.ID, URI: liveURI(s.ID)}
				if s.ParentID != nil {
					parent := liveURI(*s.ParentID)
					floor.ParentURI = &parent
				}
				n.LiveFloor = floor
				applyFloorLayout(floor)
			}
		case e.InfraID != nil:
			displayedLiveIDs[*e.InfraID] = true
			n.Type = "infra"
			if inf, ok := infraByID[*e.InfraID]; ok {
				n.Name = inf.Name
				floor := &agentFloorRef{ID: inf.ID, URI: liveURI(inf.ID)}
				applyFloorLayout(floor)
				n.LiveFloor = floor
			}
		default:
			n.Type = "tombstone"
		}
		nodes = append(nodes, n)
	}
	for _, p := range planned {
		if p.Status == "flattened" {
			continue
		}
		n := agentSheetNode{
			ID: "planned:" + p.ID, Type: p.Kind, Name: p.Name, Metadata: p.Metadata,
			Planned: true, DeclaredPath: p.DeclaredPath,
			Sheet: agentPlacement{X: p.PositionX, Y: p.PositionY, Width: p.Width, Height: p.Height, Scale: normalizedAgentScale(p.Scale), ParentRef: resolveRef(p.ParentSystemID)},
		}
		if p.RealizedFileID != nil {
			if f, ok := fileByID[*p.RealizedFileID]; ok {
				floor := &agentFloorRef{ID: f.ID, URI: "file://" + f.RelPath, Path: f.RelPath}
				if f.SystemID != nil {
					parent := liveURI(*f.SystemID)
					floor.ParentURI = &parent
				}
				n.LiveFloor = floor
				applyFloorLayout(floor)
			}
		}
		nodes = append(nodes, n)
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].ID < nodes[j].ID })

	contextEdges := make([]agentSheetEdge, 0, len(edges))
	for _, e := range liveEdges {
		if displayedLiveIDs[e.Src] && displayedLiveIDs[e.Dst] {
			contextEdges = append(contextEdges, agentSheetEdge{
				Kind: e.DependencyType, Source: liveURI(e.Src), Target: liveURI(e.Dst),
			})
		}
	}
	for _, e := range edges {
		source, target := "", ""
		if e.SrcPlanned != nil {
			id := "planned:" + *e.SrcPlanned
			source = *resolveRef(&id)
		} else if e.SrcLive != nil {
			source = liveURI(*e.SrcLive)
		}
		if e.DstPlanned != nil {
			id := "planned:" + *e.DstPlanned
			target = *resolveRef(&id)
		} else if e.DstLive != nil {
			target = liveURI(*e.DstLive)
		}
		contextEdges = append(contextEdges, agentSheetEdge{Kind: e.Kind, Source: source, Target: target, Note: e.Note})
	}

	ctx := agentSheetContext{
		SchemaVersion: 1,
		Sheet:         map[string]any{"id": sheet.ID, "name": sheet.Name, "purpose": sheet.Purpose, "revision": sheet.Revision},
		Nodes:         nodes, Edges: contextEdges, Notes: notes,
	}
	encoded, err := json.MarshalIndent(ctx, "", "  ")
	return string(encoded), err
}

// renderSheetASM renders one sheet as agent-facing text.
func renderSheetASM(sqlDB *sql.DB, sheet *db.Sheet) (string, error) {
	elements, err := db.GetSheetElements(sqlDB, sheet.ID)
	if err != nil {
		return "", err
	}
	annotations, err := db.GetAnnotations(sqlDB, sheet.WorkspaceID, &sheet.ID)
	if err != nil {
		return "", err
	}

	// Resolve live model context once.
	files, _ := db.GetFiles(sqlDB, sheet.WorkspaceID)
	systems, _ := db.GetSystems(sqlDB, sheet.WorkspaceID)
	infras, _ := db.GetInfraNodes(sqlDB, sheet.WorkspaceID)
	fileByID := make(map[string]db.File, len(files))
	for _, f := range files {
		fileByID[f.ID] = f
	}
	sysByID := make(map[string]db.System, len(systems))
	for _, s := range systems {
		sysByID[s.ID] = s
	}
	infraByID := make(map[string]db.InfraNode, len(infras))
	for _, n := range infras {
		infraByID[n.ID] = n
	}

	// Notes indexed by target for inline attachment.
	notesByTarget := map[string][]db.Annotation{}
	var floating []db.Annotation
	for _, a := range annotations {
		if a.TargetType != nil && a.TargetID != nil {
			key := *a.TargetType + ":" + *a.TargetID
			notesByTarget[key] = append(notesByTarget[key], a)
		} else {
			floating = append(floating, a)
		}
	}

	tombstones, ghosts := 0, 0
	for _, e := range elements {
		if e.Tombstoned() && e.TombstoneAck == 0 {
			tombstones++
		}
		if e.Ghost != 0 {
			ghosts++
		}
	}

	var b strings.Builder
	fmt.Fprintf(&b, "sheet: %q — rev %d", sheet.Name, sheet.Revision)
	if ghosts > 0 {
		fmt.Fprintf(&b, " · %d ghost", ghosts)
	}
	if tombstones > 0 {
		fmt.Fprintf(&b, " · %d deleted", tombstones)
	}
	b.WriteString("\n")
	if sheet.Purpose != nil && *sheet.Purpose != "" {
		fmt.Fprintf(&b, "purpose: %s\n", *sheet.Purpose)
	}
	b.WriteString("\n")

	// Partition: system elements render as containers; file elements nest
	// under their system's container when both are on the sheet.
	sheetSystemIDs := map[string]bool{}
	for _, e := range elements {
		if e.SystemID != nil {
			sheetSystemIDs[*e.SystemID] = true
		}
	}

	writeNotes := func(indent, targetType, targetID string) {
		for _, a := range notesByTarget[targetType+":"+targetID] {
			fmt.Fprintf(&b, "%s  note(%s): %q\n", indent, a.Author, a.Body)
		}
	}
	writeFileLine := func(indent string, e db.SheetElement) {
		if e.Tombstoned() {
			// Ref gone, only the cached label remains — could have been any type.
			fmt.Fprintf(&b, "%s%s [TOMBSTONE: deleted]\n", indent, e.Label)
			return
		}
		f, ok := fileByID[*e.FileID]
		if !ok {
			fmt.Fprintf(&b, "%s%s [TOMBSTONE: deleted]\n", indent, e.Label)
			return
		}
		tag := ""
		if e.Ghost != 0 {
			tag = " [GHOST]"
		}
		fmt.Fprintf(&b, "%sfile://%s%s\n", indent, f.RelPath, tag)
		writeNotes(indent, "file", f.ID)
	}

	// Sort elements deterministically: systems, files, infra, by label.
	sort.SliceStable(elements, func(i, j int) bool { return elements[i].Label < elements[j].Label })

	renderedFiles := map[string]bool{} // element ids nested under a system

	for _, e := range elements {
		if e.SystemID == nil {
			continue
		}
		sys, ok := sysByID[*e.SystemID]
		if !ok {
			fmt.Fprintf(&b, "sys://%s [TOMBSTONE: deleted]\n", e.Label)
			continue
		}
		fmt.Fprintf(&b, "sys://%s as %q\n", systemNamePath(sysByID, sys), sys.Name)
		writeNotes("", "system", sys.ID)
		for _, fe := range elements {
			if fe.FileID == nil {
				continue
			}
			if f, ok := fileByID[*fe.FileID]; ok && f.SystemID != nil && *f.SystemID == sys.ID {
				writeFileLine("  ", fe)
				renderedFiles[fe.ID] = true
			}
		}
	}

	// Loose files (not nested under a rendered system) and tombstones —
	// a tombstoned element has all refs NULL, only its cached label remains.
	for _, e := range elements {
		if renderedFiles[e.ID] {
			continue
		}
		if e.FileID != nil || e.Tombstoned() {
			writeFileLine("", e)
		}
	}

	for _, e := range elements {
		if e.InfraID == nil {
			continue
		}
		n, ok := infraByID[*e.InfraID]
		if !ok {
			fmt.Fprintf(&b, "infra://%s [TOMBSTONE: deleted]\n", e.Label)
			continue
		}
		svc := n.Service
		if svc == "" {
			svc = "generic/" + n.Category
		}
		fmt.Fprintf(&b, "infra://%s as %q [%s]\n", svc, n.Name, strings.ToUpper(n.Category))
		writeNotes("", "infra", n.ID)
	}

	if len(floating) > 0 {
		b.WriteString("\n# Notes\n")
		for _, a := range floating {
			fmt.Fprintf(&b, "note(%s): %q\n", a.Author, a.Body)
		}
	}

	return b.String(), nil
}

// renderBuildSpec renders a sheet's PLANNED elements as an agent build spec
// (UML_UX_PLAN.md REVISION 2 — "the sheet as prompt"): target additions with
// paths and member signature tables, structural intent edges, and precise
// live-context links so the agent doesn't search-hallucinate.
func renderBuildSpec(sqlDB *sql.DB, sheet *db.Sheet) (string, error) {
	planned, err := db.GetPlannedNodes(sqlDB, sheet.ID)
	if err != nil {
		return "", err
	}
	edges, _ := db.GetPlannedEdges(sqlDB, sheet.ID)
	files, _ := db.GetFiles(sqlDB, sheet.WorkspaceID)
	fileByID := make(map[string]db.File, len(files))
	for _, f := range files {
		fileByID[f.ID] = f
	}
	plannedByID := make(map[string]db.PlannedNode, len(planned))
	for _, p := range planned {
		plannedByID[p.ID] = p
	}
	liveRef := func(id string) string {
		if f, ok := fileByID[id]; ok {
			return "file://" + f.RelPath
		}
		return id
	}

	var b strings.Builder
	fmt.Fprintf(&b, "# Build spec — sheet %q (rev %d)\n", sheet.Name, sheet.Revision)
	if sheet.Purpose != nil && *sheet.Purpose != "" {
		fmt.Fprintf(&b, "Purpose: %s\n", *sheet.Purpose)
	}
	open := 0
	b.WriteString("\n## Target additions\n")
	for _, p := range planned {
		if p.Status == "flattened" {
			continue
		}
		tag := strings.ToUpper(p.Status)
		fmt.Fprintf(&b, "\n### %s %q [%s]", p.Kind, p.Name, tag)
		if p.DeclaredPath != "" {
			fmt.Fprintf(&b, " → %s", p.DeclaredPath)
		}
		b.WriteString("\n")
		if p.Notes != "" {
			fmt.Fprintf(&b, "Intent: %s\n", p.Notes)
		}
		if len(p.Metadata) > 0 && string(p.Metadata) != "{}" {
			var formatted bytes.Buffer
			if err := json.Indent(&formatted, p.Metadata, "", "  "); err == nil {
				b.WriteString("Metadata:\n```json\n")
				b.WriteString(formatted.String())
				b.WriteString("\n```\n")
			}
		}
		var members []db.PlannedMember
		_ = json.Unmarshal(p.Members, &members)
		for _, m := range members {
			mark := " "
			if m.Realized {
				mark = "x"
			}
			fmt.Fprintf(&b, "- [%s] `%s`", mark, m.Signature)
			if m.Intent != "" {
				fmt.Fprintf(&b, " — %s", m.Intent)
			}
			b.WriteString("\n")
		}
		if p.Status != "realized" {
			open++
		}
	}

	if len(edges) > 0 {
		b.WriteString("\n## Structural intent\n")
		for _, e := range edges {
			src, dst := "?", "?"
			if e.SrcPlanned != nil {
				if p, ok := plannedByID[*e.SrcPlanned]; ok {
					src = "planned:" + p.Name
				}
			} else if e.SrcLive != nil {
				src = liveRef(*e.SrcLive)
			}
			if e.DstPlanned != nil {
				if p, ok := plannedByID[*e.DstPlanned]; ok {
					dst = "planned:" + p.Name
				}
			} else if e.DstLive != nil {
				dst = liveRef(*e.DstLive)
			}
			fmt.Fprintf(&b, "- %s %s %s", src, e.Kind, dst)
			if e.Note != "" {
				fmt.Fprintf(&b, " — %s", e.Note)
			}
			b.WriteString("\n")
		}
	}

	fmt.Fprintf(&b, "\n%d element(s) awaiting realization. Use Sheet containment and the live Floor context "+
		"to place the design; Axiom reconciles automatically as code appears and the user watches members turn green.\n", open)
	if context, err := renderAgentSheetContext(sqlDB, sheet); err == nil {
		b.WriteString("\n## Sheet placement in live Floor context\n```json\n")
		b.WriteString(context)
		b.WriteString("\n```\n")
	}
	return b.String(), nil
}

// systemNamePath builds the durable sys:// path ("Parent/Child").
func systemNamePath(sysByID map[string]db.System, s db.System) string {
	parts := []string{s.Name}
	cur := s
	for cur.ParentID != nil {
		p, ok := sysByID[*cur.ParentID]
		if !ok {
			break
		}
		parts = append([]string{p.Name}, parts...)
		cur = p
	}
	return strings.Join(parts, "/")
}
