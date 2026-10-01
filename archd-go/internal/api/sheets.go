// Sheets + annotations + canvas→agent channel endpoints (docs/history/UML_UX_PLAN.md U1/U-C).
//
//	GET    /api/sheets?workspace=            - list sheets
//	POST   /api/sheets                       - create sheet {workspaceId, name, purpose?, kind?, elements?}
//	GET    /api/sheets/:id?workspace=        - sheet + elements + annotations
//	GET    /api/sheets/:id/asm?workspace=    - agent-facing ASM text
//	PUT    /api/sheets/:id                   - update name/purpose/folder/viewport
//	DELETE /api/sheets/:id?workspace=
//	POST   /api/sheets/:id/elements          - add element(s)
//	DELETE /api/sheets/:id/elements/:elId?workspace=
//	POST   /api/sheets/:id/elements/:elId/position
//	POST   /api/annotations                  - create note/flag/reply
//	DELETE /api/annotations/:id?workspace=
//	POST   /api/canvas/send                  - canvas enqueues a message to agents
//	GET    /api/canvas/outbox?workspace=&peek= - non-destructive legacy open-queue read (or peek)
//	POST   /api/canvas/reply                 - agent answers a message {msgId, body}
package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"axiom.local/archd/internal/db"
)

func (s *Server) broadcastSheetLayoutState(sqlDB *sql.DB, sheetID string) ([]db.SheetElement, []db.PlannedNode, *db.Sheet) {
	elements, _ := db.GetSheetElements(sqlDB, sheetID)
	planned, _ := db.GetPlannedNodes(sqlDB, sheetID)
	layouts, _ := db.GetSheetLayouts(sqlDB, sheetID)
	sheet, _ := db.GetSheet(sqlDB, sheetID)
	revision := 0
	workspaceID := ""
	if sheet != nil {
		revision = sheet.Revision
		workspaceID = sheet.WorkspaceID
	}
	s.broadcastPatch("sheet:elements", map[string]any{
		"workspaceId": workspaceID, "sheetId": sheetID, "added": elements, "replace": true,
	})
	s.broadcastPatch("sheet:layouts", map[string]any{
		"workspaceId": workspaceID, "sheetId": sheetID, "layouts": layouts, "revision": revision, "replace": true,
	})
	for _, node := range planned {
		s.broadcastPatch("planned:upserted", node)
	}
	if sheet != nil {
		s.broadcastPatch("sheet:upserted", sheet)
	}
	return elements, planned, sheet
}

func (s *Server) registerSheetRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/sheets", s.handleSheets)
	mux.HandleFunc("/api/sheets/", s.handleSheetByID)
	mux.HandleFunc("/api/planned/", s.handlePlannedByID)
	mux.HandleFunc("/api/planned-edge/", s.handlePlannedEdgeByID)
	mux.HandleFunc("/api/annotations", s.handleAnnotations)
	mux.HandleFunc("/api/annotations/", s.handleAnnotationByID)
	mux.HandleFunc("/api/canvas/send", s.handleCanvasSend)
	mux.HandleFunc("/api/canvas/outbox", s.handleCanvasOutbox)
	mux.HandleFunc("/api/canvas/reply", s.handleCanvasReply)
	mux.HandleFunc("/api/canvas/history", s.handleInboxHistory)
	mux.HandleFunc("/api/canvas/message", s.handleInboxMessage)
	mux.HandleFunc("/api/canvas/snapshot", s.handleInboxSnapshot)
	mux.HandleFunc("/api/canvas/snapshot-comparison", s.handleInboxSnapshotComparison)
	mux.HandleFunc("/api/canvas/claim", s.handleInboxClaim)
	mux.HandleFunc("/api/canvas/context", s.handleInboxContext)
	mux.HandleFunc("/api/canvas/cancel", s.handleInboxCancel)
	mux.HandleFunc("/api/canvas/review", s.handleInboxReview)
}

// ─── Sheets ───────────────────────────────────────────────────────────────────

// sheetElementInput is the wire form for adding elements: exactly one ref.
type sheetElementInput struct {
	SystemID       *string  `json:"systemId"`
	FileID         *string  `json:"fileId"`
	InfraID        *string  `json:"infraId"`
	SymbolRef      *string  `json:"symbolRef"`
	X              *float64 `json:"x"`
	Y              *float64 `json:"y"`
	ParentSystemID *string  `json:"parentSystemId"`
	AddedBy        string   `json:"addedBy"`
}

// resolveElement builds a SheetElement with its cached label from live data.
func resolveElement(sqlDB *sql.DB, sheetID string, in sheetElementInput) (*db.SheetElement, error) {
	e := &db.SheetElement{
		SheetID: sheetID, SystemID: in.SystemID, FileID: in.FileID,
		InfraID: in.InfraID, SymbolRef: in.SymbolRef, AddedBy: in.AddedBy,
		ParentSystemID: in.ParentSystemID,
	}
	if in.X != nil {
		e.PositionX = *in.X
	}
	if in.Y != nil {
		e.PositionY = *in.Y
	}
	switch {
	case in.FileID != nil:
		if f, err := db.GetFileByID(sqlDB, *in.FileID); err == nil && f != nil {
			e.Label = f.RelPath
			if e.ParentSystemID == nil {
				e.ParentSystemID = f.SystemID
			}
		}
	case in.SystemID != nil:
		if sys, err := db.GetSystem(sqlDB, *in.SystemID); err == nil && sys != nil {
			e.Label = sys.Name
			if e.ParentSystemID == nil {
				e.ParentSystemID = sys.ParentID
			}
		}
	case in.InfraID != nil:
		if n, err := db.GetInfraNode(sqlDB, *in.InfraID); err == nil && n != nil {
			e.Label = n.Name
		}
	case in.SymbolRef != nil:
		e.Label = *in.SymbolRef
	}
	if e.Label == "" {
		e.Label = "unknown"
	}
	return e, nil
}

func (s *Server) handleSheets(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		workspaceID := r.URL.Query().Get("workspace")
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		sheets, err := db.GetSheets(sqlDB, workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		jsonOK(w, sheets)

	case http.MethodPost:
		var body struct {
			WorkspaceID string              `json:"workspaceId"`
			Name        string              `json:"name"`
			Purpose     *string             `json:"purpose"`
			Kind        string              `json:"kind"`
			Folder      string              `json:"folder"`
			CreatedBy   string              `json:"createdBy"`
			Elements    []sheetElementInput `json:"elements"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
			jsonError(w, "bad request: name and workspaceId required", 400)
			return
		}
		body.Name = strings.TrimSpace(body.Name)
		sqlDB, err := s.dbFor(body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		taken, err := db.SheetNameTaken(sqlDB, body.WorkspaceID, body.Name, "")
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		if taken {
			jsonError(w, "a sheet named \""+body.Name+"\" already exists", 409)
			return
		}
		sheet := &db.Sheet{
			WorkspaceID: body.WorkspaceID, Name: body.Name, Purpose: body.Purpose,
			Kind: body.Kind, Folder: body.Folder, CreatedBy: body.CreatedBy,
		}
		if err := db.CreateSheet(sqlDB, sheet); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		for _, in := range body.Elements {
			if in.AddedBy == "" {
				in.AddedBy = body.CreatedBy
			}
			e, _ := resolveElement(sqlDB, sheet.ID, in)
			if err := db.AddSheetElement(sqlDB, e); err != nil {
				jsonError(w, "element: "+err.Error(), 400)
				return
			}
		}
		if err := db.BackfillSheetLayouts(sqlDB); err != nil {
			jsonError(w, "layout: "+err.Error(), 500)
			return
		}
		s.broadcastPatch("sheet:upserted", sheet)
		jsonOK(w, sheet)

	default:
		http.NotFound(w, r)
	}
}

func (s *Server) handleSheetByID(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/sheets/")
	parts := strings.Split(rest, "/")
	id := parts[0]
	if id == "" {
		http.NotFound(w, r)
		return
	}
	workspaceID := r.URL.Query().Get("workspace")

	if len(parts) == 2 && (parts[1] == "compare" || parts[1] == "resolve" || parts[1] == "bind" || parts[1] == "reopen" || parts[1] == "apply_nesting" || parts[1] == "context") {
		s.handleSheetWork(w, r, id, parts[1])
		return
	}

	// element subroutes: /api/sheets/:id/elements[/:elId[/position]]
	if len(parts) >= 2 && parts[1] == "elements" {
		s.handleSheetElements(w, r, id, parts[2:])
		return
	}
	// planned-element subroutes (REVISION 2 authoring)
	if len(parts) == 2 && parts[1] == "planned" && r.Method == http.MethodPost {
		var n db.PlannedNode
		if err := json.NewDecoder(r.Body).Decode(&n); err != nil || n.Name == "" {
			jsonError(w, "bad request: name required", 400)
			return
		}
		n.SheetID = id
		sqlDB, err := s.dbFor(n.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.UpsertPlannedNode(sqlDB, &n); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		if err := db.BackfillSheetLayouts(sqlDB); err != nil {
			jsonError(w, "layout: "+err.Error(), 500)
			return
		}
		s.broadcastPatch("planned:upserted", n)
		jsonOK(w, n)
		return
	}
	if len(parts) == 2 && parts[1] == "planned-edges" && r.Method == http.MethodPost {
		var e db.PlannedEdge
		if err := json.NewDecoder(r.Body).Decode(&e); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		e.SheetID = id
		sqlDB, err := s.dbFor(e.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.UpsertPlannedEdge(sqlDB, &e); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastPatch("planned:edge", e)
		jsonOK(w, e)
		return
	}
	if len(parts) == 2 && parts[1] == "buildspec" && r.Method == http.MethodGet {
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		sheet, err := db.GetSheet(sqlDB, id)
		if err != nil || sheet == nil {
			jsonError(w, "sheet not found", 404)
			return
		}
		spec, err := renderBuildSpec(sqlDB, sheet)
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		jsonOK(w, map[string]any{"sheetId": id, "buildSpec": spec})
		return
	}
	if len(parts) == 3 && parts[1] == "layout" && parts[2] == "batch" && r.Method == http.MethodPost {
		var body struct {
			WorkspaceID string                 `json:"workspaceId"`
			Layouts     []db.SheetLayoutUpdate `json:"layouts"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		sqlDB, err := s.dbFor(body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.UpdateSheetLayouts(sqlDB, id, body.Layouts); err != nil {
			jsonError(w, err.Error(), 400)
			return
		}
		elements, planned, sheet := s.broadcastSheetLayoutState(sqlDB, id)
		jsonOK(w, map[string]any{"sheet": sheet, "elements": elements, "planned": planned})
		return
	}
	if len(parts) == 3 && parts[1] == "layouts" && parts[2] == "batch" && r.Method == http.MethodPost {
		var body struct {
			WorkspaceID string           `json:"workspaceId"`
			Layouts     []db.SheetLayout `json:"layouts"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		sqlDB, err := s.dbFor(body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		result, err := db.ApplySheetLayoutBatch(sqlDB, id, body.WorkspaceID, body.Layouts)
		if err != nil {
			jsonError(w, err.Error(), 400)
			return
		}
		s.broadcastPatch("sheet:layouts", map[string]any{
			"workspaceId": body.WorkspaceID, "sheetId": id, "layouts": result.Layouts, "revision": result.Revision,
		})
		if sheet, _ := db.GetSheet(sqlDB, id); sheet != nil {
			s.broadcastPatch("sheet:upserted", sheet)
		}
		jsonOK(w, result)
		return
	}

	switch {
	case r.Method == http.MethodGet && len(parts) == 2 && parts[1] == "asm":
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		sheet, err := db.GetSheet(sqlDB, id)
		if err != nil || sheet == nil {
			jsonError(w, "sheet not found", 404)
			return
		}
		text, err := renderSheetASM(sqlDB, sheet)
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		jsonOK(w, map[string]any{"sheetId": id, "revision": sheet.Revision, "asm": text})

	case r.Method == http.MethodGet && len(parts) == 1:
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		sheet, err := db.GetSheet(sqlDB, id)
		if err != nil || sheet == nil {
			jsonError(w, "sheet not found", 404)
			return
		}
		if err := db.BackfillSheetLayouts(sqlDB); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		elements, _ := db.GetSheetElements(sqlDB, id)
		annotations, _ := db.GetAnnotations(sqlDB, sheet.WorkspaceID, &id)
		planned, _ := db.GetPlannedNodes(sqlDB, id)
		plannedEdges, _ := db.GetPlannedEdges(sqlDB, id)
		layouts, _ := db.GetSheetLayouts(sqlDB, id)
		jsonOK(w, map[string]any{
			"sheet": sheet, "elements": elements, "annotations": annotations,
			"planned": planned, "plannedEdges": plannedEdges, "layouts": layouts,
		})

	case r.Method == http.MethodPut && len(parts) == 1:
		var body struct {
			WorkspaceID string          `json:"workspaceId"`
			Name        *string         `json:"name"`
			Purpose     *string         `json:"purpose"`
			Folder      *string         `json:"folder"`
			Viewport    json.RawMessage `json:"viewport"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		sqlDB, err := s.dbFor(body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if body.Name != nil {
			trimmed := strings.TrimSpace(*body.Name)
			if trimmed == "" {
				jsonError(w, "bad request: name cannot be empty", 400)
				return
			}
			taken, err := db.SheetNameTaken(sqlDB, body.WorkspaceID, trimmed, id)
			if err != nil {
				jsonError(w, err.Error(), 500)
				return
			}
			if taken {
				jsonError(w, "a sheet named \""+trimmed+"\" already exists", 409)
				return
			}
			body.Name = &trimmed
		}
		if err := db.UpdateSheet(sqlDB, id, body.Name, body.Purpose, body.Folder, body.Viewport); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		sheet, _ := db.GetSheet(sqlDB, id)
		if sheet != nil {
			s.broadcastPatch("sheet:upserted", sheet)
		}
		jsonOK(w, sheet)

	case r.Method == http.MethodDelete && len(parts) == 1:
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.DeleteSheet(sqlDB, id); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastPatch("sheet:deleted", map[string]string{"id": id, "workspaceId": workspaceID})
		jsonOK(w, map[string]string{"deleted": id})

	default:
		http.NotFound(w, r)
	}
}

func (s *Server) handleSheetElements(w http.ResponseWriter, r *http.Request, sheetID string, rest []string) {
	workspaceID := r.URL.Query().Get("workspace")
	switch {
	case r.Method == http.MethodPost && len(rest) == 0:
		var body struct {
			WorkspaceID string              `json:"workspaceId"`
			Elements    []sheetElementInput `json:"elements"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Elements) == 0 {
			jsonError(w, "bad request: elements required", 400)
			return
		}
		sqlDB, err := s.dbFor(body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		added := make([]db.SheetElement, 0, len(body.Elements))
		for _, in := range body.Elements {
			e, _ := resolveElement(sqlDB, sheetID, in)
			if err := db.AddSheetElement(sqlDB, e); err != nil {
				jsonError(w, err.Error(), 400)
				return
			}
			added = append(added, *e)
		}
		if err := db.BackfillSheetLayouts(sqlDB); err != nil {
			jsonError(w, "layout: "+err.Error(), 500)
			return
		}
		s.broadcastPatch("sheet:elements", map[string]any{"workspaceId": body.WorkspaceID, "sheetId": sheetID, "added": added})
		jsonOK(w, added)

	case r.Method == http.MethodDelete && len(rest) == 1:
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.RemoveSheetElement(sqlDB, rest[0]); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastSheetLayoutState(sqlDB, sheetID)
		jsonOK(w, map[string]string{"deleted": rest[0]})

	case r.Method == http.MethodPost && len(rest) == 2 && rest[1] == "position":
		var body struct {
			WorkspaceID string  `json:"workspaceId"`
			X           float64 `json:"x"`
			Y           float64 `json:"y"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		sqlDB, err := s.dbFor(body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.UpdateSheetElementPosition(sqlDB, rest[0], body.X, body.Y); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		jsonOK(w, map[string]any{"id": rest[0], "x": body.X, "y": body.Y})

	case r.Method == http.MethodPost && len(rest) == 2 && rest[1] == "parent":
		var body struct {
			WorkspaceID    string  `json:"workspaceId"`
			ParentSystemID *string `json:"parentSystemId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		sqlDB, err := s.dbFor(body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.ValidateSheetElementParent(sqlDB, sheetID, rest[0], body.ParentSystemID); err != nil {
			jsonError(w, err.Error(), 400)
			return
		}
		if err := db.UpdateSheetElementParent(sqlDB, rest[0], body.ParentSystemID); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastSheetLayoutState(sqlDB, sheetID)
		jsonOK(w, map[string]any{"id": rest[0], "parentSystemId": body.ParentSystemID})

	case r.Method == http.MethodPost && len(rest) == 2 && rest[1] == "metadata":
		var body struct {
			WorkspaceID string          `json:"workspaceId"`
			Metadata    json.RawMessage `json:"metadata"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		sqlDB, err := s.dbFor(body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.UpdateSheetElementDesignMetadata(sqlDB, sheetID, rest[0], body.Metadata); err != nil {
			jsonError(w, err.Error(), 400)
			return
		}
		if elements, err := db.GetSheetElements(sqlDB, sheetID); err == nil {
			for _, element := range elements {
				if element.ID == rest[0] {
					s.broadcastPatch("sheet:elements", map[string]any{"workspaceId": body.WorkspaceID, "sheetId": sheetID, "added": []db.SheetElement{element}})
					break
				}
			}
		}
		jsonOK(w, map[string]any{"id": rest[0], "metadata": body.Metadata})

	case r.Method == http.MethodPost && len(rest) == 2 && rest[1] == "layout":
		var body struct {
			WorkspaceID    string   `json:"workspaceId"`
			X              float64  `json:"x"`
			Y              float64  `json:"y"`
			ParentSystemID *string  `json:"parentSystemId"`
			Width          *float64 `json:"width"`
			Height         *float64 `json:"height"`
			Scale          *float64 `json:"scale"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		sqlDB, err := s.dbFor(body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.ValidateSheetElementParent(sqlDB, sheetID, rest[0], body.ParentSystemID); err != nil {
			jsonError(w, err.Error(), 400)
			return
		}
		if err := db.UpdateSheetElementLayout(sqlDB, rest[0], body.X, body.Y, body.ParentSystemID, body.Width, body.Height, body.Scale); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastSheetLayoutState(sqlDB, sheetID)
		jsonOK(w, map[string]any{"id": rest[0], "x": body.X, "y": body.Y, "parentSystemId": body.ParentSystemID})

	default:
		http.NotFound(w, r)
	}
}

// handlePlannedByID: GET status, POST approval/layout mutations,
// PUT full update, DELETE.
func (s *Server) handlePlannedByID(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/planned/")
	parts := strings.Split(rest, "/")
	id := parts[0]
	if id == "" {
		http.NotFound(w, r)
		return
	}
	switch {
	case r.Method == http.MethodGet && len(parts) == 1:
		workspaceID := r.URL.Query().Get("workspace")
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		planned, err := db.GetPlannedNode(sqlDB, id)
		if err != nil || planned == nil || planned.WorkspaceID != workspaceID {
			jsonError(w, "planned node not found", 404)
			return
		}
		jsonOK(w, planned)

	case r.Method == http.MethodPost && len(parts) == 2 && parts[1] == "approval":
		var body struct {
			WorkspaceID string `json:"workspaceId"`
			Decision    string `json:"decision"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		sqlDB, err := s.dbFor(body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		planned, err := db.GetPlannedNode(sqlDB, id)
		if err != nil || planned == nil || planned.WorkspaceID != body.WorkspaceID {
			jsonError(w, "planned node not found", 404)
			return
		}
		planned, err = db.SetPlannedApproval(sqlDB, id, body.Decision)
		if err != nil {
			jsonError(w, err.Error(), 409)
			return
		}
		s.broadcastPatch("planned:upserted", planned)
		jsonOK(w, planned)

	case r.Method == http.MethodPost && len(parts) == 2 && parts[1] == "position":
		var body struct {
			WorkspaceID string  `json:"workspaceId"`
			X           float64 `json:"x"`
			Y           float64 `json:"y"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		sqlDB, err := s.dbFor(body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.UpdatePlannedPosition(sqlDB, id, body.X, body.Y); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		jsonOK(w, map[string]any{"id": id})

	case r.Method == http.MethodPost && len(parts) == 2 && parts[1] == "parent":
		var body struct {
			WorkspaceID    string  `json:"workspaceId"`
			ParentSystemID *string `json:"parentSystemId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		sqlDB, err := s.dbFor(body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		planned, err := db.GetPlannedNode(sqlDB, id)
		if err != nil || planned == nil {
			jsonError(w, "planned node not found", 404)
			return
		}
		if err := db.ValidatePlannedParent(sqlDB, id, body.ParentSystemID); err != nil {
			jsonError(w, err.Error(), 400)
			return
		}
		if err := db.UpdatePlannedParent(sqlDB, id, body.ParentSystemID); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastSheetLayoutState(sqlDB, planned.SheetID)
		jsonOK(w, map[string]any{"id": id, "parentSystemId": body.ParentSystemID})

	case r.Method == http.MethodPost && len(parts) == 2 && parts[1] == "layout":
		var body struct {
			WorkspaceID    string   `json:"workspaceId"`
			X              float64  `json:"x"`
			Y              float64  `json:"y"`
			ParentSystemID *string  `json:"parentSystemId"`
			Width          *float64 `json:"width"`
			Height         *float64 `json:"height"`
			Scale          *float64 `json:"scale"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		sqlDB, err := s.dbFor(body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		planned, err := db.GetPlannedNode(sqlDB, id)
		if err != nil || planned == nil {
			jsonError(w, "planned node not found", 404)
			return
		}
		if err := db.ValidatePlannedParent(sqlDB, id, body.ParentSystemID); err != nil {
			jsonError(w, err.Error(), 400)
			return
		}
		if err := db.UpdatePlannedLayout(sqlDB, id, body.X, body.Y, body.ParentSystemID, body.Width, body.Height, body.Scale); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastSheetLayoutState(sqlDB, planned.SheetID)
		jsonOK(w, map[string]any{"id": id, "x": body.X, "y": body.Y, "parentSystemId": body.ParentSystemID})

	case r.Method == http.MethodPut && len(parts) == 1:
		var n db.PlannedNode
		if err := json.NewDecoder(r.Body).Decode(&n); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		n.ID = id
		sqlDB, err := s.dbFor(n.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.UpsertPlannedNode(sqlDB, &n); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastPatch("planned:upserted", n)
		jsonOK(w, n)

	case r.Method == http.MethodDelete && len(parts) == 1:
		workspaceID := r.URL.Query().Get("workspace")
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		planned, err := db.GetPlannedNode(sqlDB, id)
		if err != nil || planned == nil || planned.WorkspaceID != workspaceID {
			jsonError(w, "planned node not found", 404)
			return
		}
		if err := db.DeletePlannedNode(sqlDB, id); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastPatch("planned:deleted", map[string]string{"id": id, "workspaceId": workspaceID})
		s.broadcastSheetLayoutState(sqlDB, planned.SheetID)
		jsonOK(w, map[string]string{"deleted": id})

	default:
		http.NotFound(w, r)
	}
}

func (s *Server) handlePlannedEdgeByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/planned-edge/")
	if id == "" || r.Method != http.MethodDelete {
		http.NotFound(w, r)
		return
	}
	workspaceID := r.URL.Query().Get("workspace")
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	if err := db.DeletePlannedEdge(sqlDB, id); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	s.broadcastPatch("planned:edge-deleted", map[string]string{"id": id, "workspaceId": workspaceID})
	jsonOK(w, map[string]string{"deleted": id})
}

// ─── Annotations ──────────────────────────────────────────────────────────────

func (s *Server) handleAnnotations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var a db.Annotation
	if err := json.NewDecoder(r.Body).Decode(&a); err != nil || a.Body == "" {
		jsonError(w, "bad request: body required", 400)
		return
	}
	sqlDB, err := s.dbFor(a.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	if err := db.CreateAnnotation(sqlDB, &a); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	s.broadcastPatch("annotation:upserted", a)
	jsonOK(w, a)
}

func (s *Server) handleAnnotationByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/annotations/")
	if id == "" || r.Method != http.MethodDelete {
		http.NotFound(w, r)
		return
	}
	workspaceID := r.URL.Query().Get("workspace")
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	if err := db.DeleteAnnotation(sqlDB, id); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	s.broadcastPatch("annotation:deleted", map[string]string{"id": id, "workspaceId": workspaceID})
	jsonOK(w, map[string]string{"deleted": id})
}

// ─── Canvas → agent channel ───────────────────────────────────────────────────

func (s *Server) handleCanvasSend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var input struct {
		ID           string  `json:"id"`
		WorkspaceID  string  `json:"workspaceId"`
		SheetID      *string `json:"sheetId"`
		Note         string  `json:"note"`
		Selection    string  `json:"selection"`
		DeliveryMode string  `json:"deliveryMode"`
	}
	if !decodeInbox(w, r, &input) {
		return
	}
	m := db.CanvasMessage{ID: input.ID, WorkspaceID: input.WorkspaceID, SheetID: input.SheetID, Note: strings.TrimSpace(input.Note), Selection: input.Selection, DeliveryMode: input.DeliveryMode}
	if m.DeliveryMode == "" {
		m.DeliveryMode = "open"
	}
	if m.DeliveryMode != "open" && m.DeliveryMode != "addressed" {
		jsonError(w, "deliveryMode must be open or addressed", 400)
		return
	}
	if m.DeliveryMode == "addressed" && m.ID == "" {
		jsonError(w, "addressed work requires a stable message id", 400)
		return
	}
	if !validInboxText(m.Note, 16000) || len(m.ID) > 128 {
		jsonError(w, "bad request: note required", 400)
		return
	}
	sqlDB, err := s.dbFor(m.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	if m.Selection == "" {
		m.Selection = "[]"
	}
	// A client-generated ID makes a lost HTTP response safe to retry.
	if m.ID != "" {
		previous, e := db.GetCanvasMessage(sqlDB, m.ID)
		if e != nil {
			inboxError(w, e)
			return
		}
		if previous != nil {
			sameSheet := (previous.SheetID == nil && m.SheetID == nil) || (previous.SheetID != nil && m.SheetID != nil && *previous.SheetID == *m.SheetID)
			if previous.WorkspaceID != m.WorkspaceID || previous.Note != m.Note || previous.Selection != m.Selection || previous.DeliveryMode != m.DeliveryMode || !sameSheet {
				inboxError(w, db.ErrInboxConflict)
				return
			}
			jsonOK(w, previous)
			return
		}
	}
	var refs []string
	if json.Unmarshal([]byte(m.Selection), &refs) != nil || refs == nil || len(refs) > 100 {
		jsonError(w, "selection must contain at most 100 references", 400)
		return
	}
	for _, ref := range refs {
		u, e := url.Parse(ref)
		if e != nil || len(ref) > 2048 || u.Scheme != "axiom" {
			jsonError(w, "selection requires canonical axiom references", 400)
			return
		}
		table := ""
		switch u.Host {
		case "file":
			table = "files"
		case "system":
			table = "systems"
		case "infra":
			table = "infra_nodes"
		case "planned":
			table = "planned_nodes"
		}
		if table == "" {
			jsonError(w, "unsupported selection target", 400)
			return
		}
		var count int
		query := "SELECT count(*) FROM " + table + " WHERE id=? AND workspace_id=?"
		if table == "files" {
			query = "SELECT count(*) FROM files f JOIN roots r ON r.id=f.root_id WHERE f.id=? AND r.workspace_id=?"
		}
		if e = sqlDB.QueryRow(query, strings.TrimPrefix(u.Path, "/"), m.WorkspaceID).Scan(&count); e != nil {
			jsonError(w, e.Error(), 500)
			return
		}
		if count != 1 {
			jsonError(w, "selection target is no longer in this workspace", 409)
			return
		}
	}
	if m.SheetID != nil {
		tx, txErr := sqlDB.Begin()
		if txErr != nil {
			inboxError(w, txErr)
			return
		}
		defer tx.Rollback()
		sheet, sheetErr := db.GetSheet(tx, *m.SheetID)
		if sheetErr != nil || sheet == nil || sheet.WorkspaceID != m.WorkspaceID {
			jsonError(w, "sheet not found in workspace", 404)
			return
		}
		context, contextErr := renderAgentSheetContext(tx, sheet, true)
		if contextErr != nil {
			jsonError(w, contextErr.Error(), 500)
			return
		}
		comparison, compareErr := db.CompareSheetStructure(tx, m.WorkspaceID, sheet.ID)
		if compareErr != nil {
			inboxError(w, compareErr)
			return
		}
		comparisonJSON, compareErr := json.Marshal(comparison)
		if compareErr != nil {
			inboxError(w, compareErr)
			return
		}
		var snapshot map[string]json.RawMessage
		if err := json.Unmarshal([]byte(context), &snapshot); err != nil {
			inboxError(w, err)
			return
		}
		snapshot["comparisonAtSend"] = comparisonJSON
		snapshotJSON, err := json.Marshal(snapshot)
		if err != nil {
			inboxError(w, err)
			return
		}
		m.SheetContext = string(snapshotJSON)
		spec, specErr := renderBuildSpec(tx, sheet)
		if specErr != nil {
			jsonError(w, specErr.Error(), 500)
			return
		}
		m.BuildSpec = spec
		// Freeze all attached reads together, then release the lock before enqueue.
		if err := tx.Commit(); err != nil {
			inboxError(w, err)
			return
		}
	}
	if len(m.SheetContext)+len(m.BuildSpec) > 2<<20 {
		jsonError(w, "sheet context exceeds 2 MB; dispatch a smaller sheet", 413)
		return
	}
	if err := db.EnqueueCanvasMessage(sqlDB, &m); err != nil {
		inboxError(w, err)
		return
	}
	s.publishInbox(db.InboxItem{CanvasMessage: m})
	jsonOK(w, m)
}

// handleCanvasOutbox: legacy reads are non-destructive and exclude addressed work.
func (s *Server) handleCanvasOutbox(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	workspaceID := r.URL.Query().Get("workspace")
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	if r.URL.Query().Get("peek") != "" {
		n, err := db.CountQueuedCanvasMessages(sqlDB, workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		open, err := db.CountOpenCanvasMessages(sqlDB, workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		jsonOK(w, map[string]int{"queued": n, "open": open})
		return
	}
	// Legacy reads are non-destructive. New clients explicitly POST /claim.
	messages, err := db.InboxHistory(sqlDB, workspaceID, "", 100, time.Now().UnixMilli())
	if err != nil {
		inboxError(w, err)
		return
	}
	pending := []db.CanvasMessage{}
	for _, m := range messages {
		if m.Status == "queued" && m.DeliveryMode == "open" {
			pending = append(pending, m.CanvasMessage)
		}
	}
	jsonOK(w, pending)
}

func (s *Server) handleCanvasReply(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string         `json:"workspaceId"`
		MsgID       string         `json:"msgId"`
		Body        string         `json:"body"`
		LeaseToken  string         `json:"leaseToken"`
		Result      *db.WorkResult `json:"result"`
	}
	if !decodeInbox(w, r, &body) {
		return
	}
	body.Body = strings.TrimSpace(body.Body)
	if !validInboxText(body.Body, 64000) || body.MsgID == "" || body.LeaseToken == "" {
		jsonError(w, "msgId, leaseToken and reply (maximum 64 KB) required", 400)
		return
	}
	if body.Result != nil {
		if len(body.Result.Commit) > 128 || len(body.Result.ChangedFiles) > 100 || len(body.Result.Checks) > 30 || len(body.Result.Remaining) > 30 {
			jsonError(w, "work result exceeds limits", 400)
			return
		}
		for _, file := range body.Result.ChangedFiles {
			if !validInboxText(file, 1024) {
				jsonError(w, "invalid changed file", 400)
				return
			}
		}
		for _, check := range body.Result.Checks {
			if !validInboxText(check.Command, 1024) || !validInboxText(check.Outcome, 1024) {
				jsonError(w, "invalid check", 400)
				return
			}
		}
		for _, remaining := range body.Result.Remaining {
			if !validInboxText(remaining, 2048) {
				jsonError(w, "invalid remaining item", 400)
				return
			}
		}
	}
	d, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	item, err := db.ReplyInbox(d, body.WorkspaceID, body.MsgID, body.LeaseToken, body.Body, time.Now().UnixMilli(), body.Result)
	if err != nil {
		inboxError(w, err)
		return
	}
	s.publishInbox(*item)
	item.LeaseToken = ""
	jsonOK(w, map[string]any{"message": item})
}
