// ASM — Axiom Sheet Markup: the textual rendering of a sheet for agents,
// who cannot see the canvas (UML_UX_PLAN.md "How agents see sheets").
// Durable URI refs (file://relpath, sys://name-path, infra://service/name),
// containment by indentation, health as bracket tags, notes block-indented.
// Layout is topological only — x/y never appears.
package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"axiom.local/archd/internal/db"
)

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

	fmt.Fprintf(&b, "\n%d element(s) awaiting realization. Build them at the declared paths; "+
		"Axiom reconciles automatically as files appear and the user watches members turn green.\n", open)
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
