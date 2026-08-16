// Variable references / data-flow slice endpoint (plan Phase 7).
//
//	GET /api/data-flow?workspace=<id>&variable=<name>[&file=<fileId|relPath>][&maxFiles=50]
//
// Hybrid model: the variable_refs table gives the candidate files fast (defs,
// params, writes stored per-occurrence; reads aggregated). We then re-parse
// each candidate on demand for exact per-line references (reads aren't stored
// per-line). File scope narrows to one file. Cross-file results are name-based
// (tree-sitter has no type resolver) and flagged as such.
package api

import (
	"net/http"
	"strconv"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/parser"
)

const defaultMaxFlowFiles = 50

type flowRef struct {
	Kind            string `json:"kind"` // def|param|write|read
	Line            int    `json:"line"`
	EnclosingSymbol string `json:"enclosingSymbol,omitempty"`
}

type flowFile struct {
	FileID   string    `json:"fileId"`
	RelPath  string    `json:"relPath"`
	Language string    `json:"language"`
	Defs     int       `json:"defs"`
	Params   int       `json:"params"`
	Writes   int       `json:"writes"`
	Reads    int       `json:"reads"`
	Refs     []flowRef `json:"refs"` // exact per-line refs (present unless truncated)
}

func (s *Server) handleDataFlow(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.URL.Query().Get("workspace")
	variable := r.URL.Query().Get("variable")
	fileRef := r.URL.Query().Get("file")
	if variable == "" {
		jsonError(w, "variable is required", 400)
		return
	}
	maxFiles := defaultMaxFlowFiles
	if v := r.URL.Query().Get("maxFiles"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			maxFiles = n
		}
	}
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}

	// A common name without a file scope produces noise - warn (plan open
	// decision #4) but still answer.
	var warnings []string
	if len(variable) <= 2 && fileRef == "" {
		warnings = append(warnings, "very short variable name without a file scope - results may be noisy; pass file= to scope")
	}

	hits, err := db.GetVariableFileHits(sqlDB, workspaceID, variable)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}

	// File scope: keep only the matching file.
	scoped := false
	if fileRef != "" {
		file, err := db.FindFileByIDOrPath(sqlDB, workspaceID, fileRef)
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		if file == nil {
			jsonError(w, "file not found: "+fileRef, 404)
			return
		}
		filtered := hits[:0]
		for _, h := range hits {
			if h.FileID == file.ID {
				filtered = append(filtered, h)
			}
		}
		hits = filtered
		scoped = true
	}

	truncated := false
	if len(hits) > maxFiles {
		hits = hits[:maxFiles]
		truncated = true
		warnings = append(warnings, "slice exceeded maxFiles; showing the top files by write/def count")
	}

	// Re-parse each candidate for exact per-line references.
	files := make([]flowFile, 0, len(hits))
	nodeIDs := make([]string, 0, len(hits))
	for _, h := range hits {
		ff := flowFile{
			FileID: h.FileID, RelPath: h.RelPath, Language: h.Language,
			Defs: h.Defs, Params: h.Params, Writes: h.Writes, Reads: h.Reads,
		}
		if h.Path != "" {
			if refs, _, err := parser.ExtractFileVarRefs(h.Path, h.RelPath, variable); err == nil {
				for _, ref := range refs {
					ff.Refs = append(ff.Refs, flowRef{Kind: ref.Kind, Line: ref.Line, EnclosingSymbol: ref.EnclosingSymbol})
				}
			}
		}
		files = append(files, ff)
		nodeIDs = append(nodeIDs, h.FileID)
	}

	// Broadcast the slice so the canvas can render the purple overlay.
	s.hub.Broadcast("data:flow", map[string]any{
		"workspaceId": workspaceID,
		"variable":    variable,
		"fileIds":     nodeIDs,
		"scoped":      scoped,
	})

	jsonOK(w, map[string]any{
		"variable":  variable,
		"scoped":    scoped,
		"fileCount": len(files),
		"truncated": truncated,
		"crossFileNote": "Cross-file matches are name-based (no type resolution). " +
			"Same-named variables in unrelated files may appear; use file scope or enclosingSymbol to disambiguate.",
		"warnings": warnings,
		"files":    files,
	})
}
