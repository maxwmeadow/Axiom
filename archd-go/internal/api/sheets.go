// Sheets + annotations + canvas→agent channel endpoints (UML_UX_PLAN.md U1/U-C).
//
//	GET    /api/sheets?workspace=            — list sheets
//	POST   /api/sheets                       — create sheet {workspaceId, name, purpose?, kind?, elements?}
//	GET    /api/sheets/:id?workspace=        — sheet + elements + annotations
//	GET    /api/sheets/:id/asm?workspace=    — agent-facing ASM text
//	PUT    /api/sheets/:id                   — update name/purpose/folder/viewport
//	DELETE /api/sheets/:id?workspace=
//	POST   /api/sheets/:id/elements          — add element(s)
//	DELETE /api/sheets/:id/elements/:elId?workspace=
//	POST   /api/sheets/:id/elements/:elId/position
//	POST   /api/annotations                  — create note/flag/reply
//	DELETE /api/annotations/:id?workspace=
//	POST   /api/canvas/send                  — canvas enqueues a message to agents
//	GET    /api/canvas/outbox?workspace=&peek= — drain (or peek) queued messages
//	POST   /api/canvas/reply                 — agent answers a message {msgId, body}
package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"

	"axiom.local/archd/internal/db"
)

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
}

// ─── Sheets ───────────────────────────────────────────────────────────────────

// sheetElementInput is the wire form for adding elements: exactly one ref.
type sheetElementInput struct {
	SystemID  *string  `json:"systemId"`
	FileID    *string  `json:"fileId"`
	InfraID   *string  `json:"infraId"`
	SymbolRef *string  `json:"symbolRef"`
	X         *float64 `json:"x"`
	Y         *float64 `json:"y"`
	AddedBy   string   `json:"addedBy"`
}

// resolveElement builds a SheetElement with its cached label from live data.
func resolveElement(sqlDB *sql.DB, sheetID string, in sheetElementInput) (*db.SheetElement, error) {
	e := &db.SheetElement{
		SheetID: sheetID, SystemID: in.SystemID, FileID: in.FileID,
		InfraID: in.InfraID, SymbolRef: in.SymbolRef, AddedBy: in.AddedBy,
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
		}
	case in.SystemID != nil:
		if sys, err := db.GetSystem(sqlDB, *in.SystemID); err == nil && sys != nil {
			e.Label = sys.Name
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
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
			jsonError(w, "bad request: name and workspaceId required", 400)
			return
		}
		sqlDB, err := s.dbFor(body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
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
		elements, _ := db.GetSheetElements(sqlDB, id)
		annotations, _ := db.GetAnnotations(sqlDB, sheet.WorkspaceID, &id)
		planned, _ := db.GetPlannedNodes(sqlDB, id)
		plannedEdges, _ := db.GetPlannedEdges(sqlDB, id)
		jsonOK(w, map[string]any{
			"sheet": sheet, "elements": elements, "annotations": annotations,
			"planned": planned, "plannedEdges": plannedEdges,
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
		s.broadcastPatch("sheet:elements", map[string]any{"sheetId": sheetID, "added": added})
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
		s.broadcastPatch("sheet:elements", map[string]any{"sheetId": sheetID, "removed": []string{rest[0]}})
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

	default:
		http.NotFound(w, r)
	}
}

// handlePlannedByID: PUT /api/planned/:id/position, DELETE /api/planned/:id,
// PUT /api/planned/:id (full update).
func (s *Server) handlePlannedByID(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/planned/")
	parts := strings.Split(rest, "/")
	id := parts[0]
	if id == "" {
		http.NotFound(w, r)
		return
	}
	switch {
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
		if err := db.DeletePlannedNode(sqlDB, id); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastPatch("planned:deleted", map[string]string{"id": id, "workspaceId": workspaceID})
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
	var m db.CanvasMessage
	if err := json.NewDecoder(r.Body).Decode(&m); err != nil || m.Note == "" {
		jsonError(w, "bad request: note required", 400)
		return
	}
	sqlDB, err := s.dbFor(m.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	if err := db.EnqueueCanvasMessage(sqlDB, &m); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	s.broadcastPatch("canvas:message", m)
	jsonOK(w, m)
}

// handleCanvasOutbox: GET ?workspace=&peek=1 returns queued count only;
// without peek, drains queued messages (marks delivered).
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
		jsonOK(w, map[string]int{"queued": n})
		return
	}
	deliveredTo := r.URL.Query().Get("agent")
	if deliveredTo == "" {
		deliveredTo = "agent"
	}
	msgs, err := db.DrainCanvasMessages(sqlDB, workspaceID, deliveredTo)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	if len(msgs) > 0 {
		for _, m := range msgs {
			s.broadcastPatch("canvas:message", m) // delivery state → note chips
		}
	}
	jsonOK(w, msgs)
}

func (s *Server) handleCanvasReply(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		MsgID       string `json:"msgId"`
		Body        string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.MsgID == "" || body.Body == "" {
		jsonError(w, "bad request: msgId and body required", 400)
		return
	}
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	msg, err := db.GetCanvasMessage(sqlDB, body.MsgID)
	if err != nil || msg == nil {
		jsonError(w, "message not found", 404)
		return
	}
	// The reply is an agent-authored annotation threaded onto the message,
	// pinned to the sheet the message came from (spatially anchored answer).
	a := db.Annotation{
		WorkspaceID: body.WorkspaceID,
		SheetID:     msg.SheetID,
		Body:        body.Body,
		Kind:        "reply",
		Author:      "agent",
	}
	if err := db.CreateAnnotation(sqlDB, &a); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	if err := db.AnswerCanvasMessage(sqlDB, body.MsgID, a.ID); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	s.broadcastPatch("annotation:upserted", a)
	updated, _ := db.GetCanvasMessage(sqlDB, body.MsgID)
	if updated != nil {
		s.broadcastPatch("canvas:message", *updated)
	}
	jsonOK(w, map[string]any{"annotation": a, "message": updated})
}
