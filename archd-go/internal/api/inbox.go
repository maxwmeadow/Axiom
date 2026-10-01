package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"axiom.local/archd/internal/db"
)

func decodeInbox(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 128<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(v); err != nil {
		jsonError(w, "invalid or oversized inbox request", 400)
		return false
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		jsonError(w, "expected one JSON object", 400)
		return false
	}
	return true
}
func inboxError(w http.ResponseWriter, err error) {
	if errors.Is(err, db.ErrInboxConflict) {
		jsonError(w, err.Error(), 409)
	} else if errors.Is(err, sql.ErrNoRows) {
		jsonError(w, "message not found", 404)
	} else {
		jsonError(w, err.Error(), 500)
	}
}
func (s *Server) publishInbox(item db.InboxItem) {
	item.LeaseToken = ""
	item.SheetContext = ""
	item.BuildSpec = ""
	s.broadcastPatch("canvas:message", item)
}
func (s *Server) handleInboxHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.NotFound(w, r)
		return
	}
	d, err := s.dbFor(r.URL.Query().Get("workspace"))
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 || limit > 100 {
		limit = 50
	}
	items, err := db.InboxHistory(d, r.URL.Query().Get("workspace"), r.URL.Query().Get("before"), limit, time.Now().UnixMilli())
	if err != nil {
		inboxError(w, err)
		return
	}
	next := ""
	if len(items) == limit {
		next = items[len(items)-1].ID
	}
	available, err := db.CountQueuedCanvasMessages(d, r.URL.Query().Get("workspace"))
	if err != nil {
		inboxError(w, err)
		return
	}
	jsonOK(w, map[string]any{"messages": items, "nextCursor": next, "availableCount": available})
}

// Delivery inspects exactly one request without taking an agent's lease.
func (s *Server) handleInboxMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	workspace, id := r.URL.Query().Get("workspace"), r.URL.Query().Get("messageId")
	if workspace == "" || id == "" {
		jsonError(w, "workspace and messageId are required", 400)
		return
	}
	d, err := s.dbFor(workspace)
	if err != nil {
		inboxError(w, err)
		return
	}
	item, err := db.ReadInboxItem(d, id, time.Now().UnixMilli())
	if err != nil {
		inboxError(w, err)
		return
	}
	if item.WorkspaceID != workspace {
		inboxError(w, sql.ErrNoRows)
		return
	}
	item.LeaseToken, item.SheetContext, item.BuildSpec = "", "", ""
	w.Header().Set("Cache-Control", "no-store")
	jsonOK(w, item)
}
func (s *Server) handleInboxSnapshot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	workspace, messageID := r.URL.Query().Get("workspace"), r.URL.Query().Get("messageId")
	if workspace == "" || messageID == "" {
		jsonError(w, "workspace and messageId are required", http.StatusBadRequest)
		return
	}
	d, err := s.dbFor(workspace)
	if err != nil {
		inboxError(w, err)
		return
	}
	message, err := db.GetCanvasMessage(d, messageID)
	if err != nil {
		inboxError(w, err)
		return
	}
	if message == nil || message.WorkspaceID != workspace {
		inboxError(w, sql.ErrNoRows)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	jsonOK(w, map[string]string{"sheetContext": message.SheetContext, "buildSpec": message.BuildSpec})
}
func (s *Server) handleInboxSnapshotComparison(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	workspace, messageID := r.URL.Query().Get("workspace"), r.URL.Query().Get("messageId")
	if workspace == "" || messageID == "" {
		jsonError(w, "workspace and messageId are required", http.StatusBadRequest)
		return
	}
	d, err := s.dbFor(workspace)
	if err != nil {
		inboxError(w, err)
		return
	}
	message, err := db.GetCanvasMessage(d, messageID)
	if err != nil {
		inboxError(w, err)
		return
	}
	if message == nil || message.WorkspaceID != workspace || message.SheetID == nil {
		inboxError(w, sql.ErrNoRows)
		return
	}
	tx, err := d.Begin()
	if err != nil {
		inboxError(w, err)
		return
	}
	defer tx.Rollback()
	comparison, err := db.CompareWorkOrderSnapshot(tx, workspace, message)
	if err != nil {
		inboxError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	jsonOK(w, comparison)
}
func (s *Server) handleInboxClaim(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID  string `json:"workspaceId"`
		ConnectionID string `json:"connectionId"`
		Agent        string `json:"agent"`
		MessageID    string `json:"messageId"`
	}
	if !decodeInbox(w, r, &body) {
		return
	}
	if len(body.ConnectionID) < 1 || len(body.ConnectionID) > 128 || len(body.Agent) < 1 || len(body.Agent) > 128 {
		jsonError(w, "connectionId and agent required (maximum 128 characters)", 400)
		return
	}
	if len(body.MessageID) > 128 {
		jsonError(w, "messageId is too long", 400)
		return
	}
	d, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	var items []db.InboxItem
	if body.MessageID != "" {
		items, err = db.ClaimInboxByID(d, body.WorkspaceID, body.ConnectionID, body.Agent, body.MessageID, time.Now().UnixMilli())
	} else {
		items, err = db.ClaimInbox(d, body.WorkspaceID, body.ConnectionID, body.Agent, time.Now().UnixMilli())
	}
	if err != nil {
		inboxError(w, err)
		return
	}
	for _, item := range items {
		s.publishInbox(item)
	}
	// Large snapshots are fetched separately, only for the claimed instruction.
	for i := range items {
		items[i].SheetContext = ""
		items[i].BuildSpec = ""
	}
	jsonOK(w, map[string]any{"protocolVersion": 1, "workspaceId": body.WorkspaceID, "messages": items})
}
func (s *Server) handleInboxContext(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		MsgID       string `json:"msgId"`
		LeaseToken  string `json:"leaseToken"`
		Offset      int    `json:"offset"`
	}
	if !decodeInbox(w, r, &body) {
		return
	}
	d, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	item, err := db.ReadInboxItem(d, body.MsgID, time.Now().UnixMilli())
	if err != nil {
		inboxError(w, err)
		return
	}
	if item.WorkspaceID != body.WorkspaceID || item.LeaseToken != body.LeaseToken || body.LeaseToken == "" || item.Status != "delivered" {
		inboxError(w, db.ErrInboxConflict)
		return
	}
	message, err := db.GetCanvasMessage(d, body.MsgID)
	if err != nil {
		inboxError(w, err)
		return
	}
	if message == nil {
		inboxError(w, sql.ErrNoRows)
		return
	}
	content := []rune(message.SheetContext + "\n" + message.BuildSpec)
	if body.Offset < 0 || body.Offset > len(content) {
		jsonError(w, "invalid context offset", 400)
		return
	}
	end := body.Offset + 12000
	if end > len(content) {
		end = len(content)
	}
	next := -1
	if end < len(content) {
		next = end
	}
	jsonOK(w, map[string]any{"text": string(content[body.Offset:end]), "nextOffset": next, "totalCharacters": len(content)})
}
func (s *Server) handleInboxCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		MsgID       string `json:"msgId"`
	}
	if !decodeInbox(w, r, &body) {
		return
	}
	d, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	if err = db.CancelInbox(d, body.WorkspaceID, body.MsgID); err != nil {
		inboxError(w, err)
		return
	}
	item, err := db.ReadInboxItem(d, body.MsgID, time.Now().UnixMilli())
	if err != nil {
		inboxError(w, err)
		return
	}
	s.publishInbox(*item)
	item.LeaseToken = ""
	jsonOK(w, item)
}

func (s *Server) handleInboxReview(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		MsgID       string `json:"msgId"`
		ReviewID    string `json:"reviewId"`
		Decision    string `json:"decision"`
		Note        string `json:"note"`
	}
	if !decodeInbox(w, r, &body) {
		return
	}
	body.Note = strings.TrimSpace(body.Note)
	if body.WorkspaceID == "" || body.MsgID == "" || len(body.MsgID) > 128 || body.ReviewID == "" || len(body.ReviewID) > 128 ||
		(body.Decision != "accepted" && body.Decision != "reopened") || len(body.Note) > 4000 || (body.Decision == "reopened" && body.Note == "") {
		jsonError(w, "valid workspaceId, msgId, reviewId, decision and reopen feedback required", 400)
		return
	}
	d, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	item, err := db.ReviewInbox(d, body.WorkspaceID, body.MsgID, body.ReviewID, body.Decision, body.Note, time.Now().UnixMilli())
	if err != nil {
		inboxError(w, err)
		return
	}
	s.publishInbox(*item)
	item.LeaseToken = ""
	jsonOK(w, map[string]any{"message": item})
}

func validInboxText(text string, max int) bool {
	return strings.TrimSpace(text) != "" && len(text) <= max
}
