package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
	axiomruntime "axiom.local/archd/internal/runtime"
)

func inboxServer(t *testing.T) (*Server, *http.ServeMux, string) {
	t.Helper()
	h := hub.New()
	s := NewServer(t.TempDir(), h, axiomruntime.NewManager(h))
	d, err := s.openDB("ws")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	// Requests for another workspace open its database too. Close every one
	// before the temp dir is removed: Windows cannot delete an open file, so a
	// test that passes elsewhere fails there on cleanup alone. Registered
	// after TempDir, so it runs first.
	t.Cleanup(func() {
		s.mu.Lock()
		ids := make([]string, 0, len(s.dbs))
		for id := range s.dbs {
			ids = append(ids, id)
		}
		s.mu.Unlock()
		for _, id := range ids {
			s.closeDB(id)
		}
	})
	root := t.TempDir()
	if err = db.UpsertWorkspace(d, db.Workspace{ID: "ws", Name: "Workspace"}); err != nil {
		t.Fatal(err)
	}
	if err = db.UpsertRoot(d, db.Root{ID: "root", WorkspaceID: "ws", Path: root, IsActive: true, IsPrimary: true}); err != nil {
		t.Fatal(err)
	}
	if err = db.UpsertFile(d, db.File{ID: "file", RootID: "root", Path: filepath.Join(root, "hello.go"), RelPath: "hello.go", Language: "go"}); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	s.RegisterRoutes(mux)
	return s, mux, root
}
func inboxHTTP(t *testing.T, handler http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(data))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestDeliveryInspectionDoesNotClaimOrExposeLease(t *testing.T) {
	_, mux, _ := inboxServer(t)
	sent := inboxHTTP(t, mux, "POST", "/api/canvas/send", map[string]any{
		"workspaceId": "ws", "id": "delivery-order", "note": "Build this", "deliveryMode": "addressed",
	})
	if sent.Code != http.StatusOK {
		t.Fatal(sent.Code, sent.Body.String())
	}
	inspect := func() db.InboxItem {
		r := inboxHTTP(t, mux, "GET", "/api/canvas/message?workspace=ws&messageId=delivery-order", nil)
		var item db.InboxItem
		if r.Code != http.StatusOK || json.Unmarshal(r.Body.Bytes(), &item) != nil {
			t.Fatal(r.Code, r.Body.String())
		}
		if item.LeaseToken != "" || item.SheetContext != "" || item.BuildSpec != "" {
			t.Fatal("delivery inspection exposed private context or lease")
		}
		return item
	}
	if inspect().Status != "queued" || inspect().LeaseExpiresAt != 0 {
		t.Fatal("inspection claimed the request")
	}
	claim := inboxHTTP(t, mux, "POST", "/api/canvas/claim", map[string]any{
		"workspaceId": "ws", "messageId": "delivery-order", "connectionId": "agent-a", "agent": "codex",
	})
	if claim.Code != http.StatusOK {
		t.Fatal(claim.Code, claim.Body.String())
	}
	if item := inspect(); item.Status != "delivered" || item.LeaseExpiresAt == 0 {
		t.Fatal("inspection did not report the current claim")
	}
	for _, target := range []string{
		"/api/canvas/message?workspace=other&messageId=delivery-order",
		"/api/canvas/message?workspace=ws&messageId=missing",
	} {
		if r := inboxHTTP(t, mux, "GET", target, nil); r.Code != http.StatusNotFound {
			t.Fatal(r.Code, r.Body.String())
		}
	}
	if r := inboxHTTP(t, mux, "GET", "/api/canvas/message?workspace=ws", nil); r.Code != http.StatusBadRequest {
		t.Fatal(r.Code, r.Body.String())
	}
}

func TestInboxSnapshotRetainsSentPlanAfterSheetChanges(t *testing.T) {
	s, mux, _ := inboxServer(t)
	d, _ := s.dbFor("ws")
	sheet := db.Sheet{ID: "sent-sheet", WorkspaceID: "ws", Name: "Original plan"}
	if err := db.CreateSheet(d, &sheet); err != nil {
		t.Fatal(err)
	}
	sent := inboxHTTP(t, mux, "POST", "/api/canvas/send", map[string]any{
		"workspaceId": "ws", "id": "snapshot-order", "sheetId": sheet.ID, "note": "Build this plan",
	})
	if sent.Code != http.StatusOK {
		t.Fatal(sent.Code, sent.Body.String())
	}
	if _, err := d.Exec(`UPDATE sheets SET name='Revised plan',revision=revision+1 WHERE id=?`, sheet.ID); err != nil {
		t.Fatal(err)
	}
	history := inboxHTTP(t, mux, "GET", "/api/canvas/history?workspace=ws", nil)
	var listed struct {
		Messages []db.InboxItem `json:"messages"`
	}
	if history.Code != http.StatusOK || json.Unmarshal(history.Body.Bytes(), &listed) != nil || len(listed.Messages) != 1 || listed.Messages[0].SentSheetName != "Original plan" || listed.Messages[0].SentSheetRevision != 1 {
		t.Fatalf("history did not preserve the sent sheet revision: %d %s", history.Code, history.Body.String())
	}
	response := inboxHTTP(t, mux, "GET", "/api/canvas/snapshot?workspace=ws&messageId=snapshot-order", nil)
	if response.Code != http.StatusOK {
		t.Fatal(response.Code, response.Body.String())
	}
	var snapshot struct {
		SheetContext string `json:"sheetContext"`
		BuildSpec    string `json:"buildSpec"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	var context struct {
		Sheet struct {
			Name     string `json:"name"`
			Revision int    `json:"revision"`
		} `json:"sheet"`
	}
	if err := json.Unmarshal([]byte(snapshot.SheetContext), &context); err != nil {
		t.Fatal(err)
	}
	if context.Sheet.Name != "Original plan" || context.Sheet.Revision != 1 || strings.Contains(snapshot.SheetContext, "Revised plan") {
		t.Fatalf("snapshot followed a later sheet edit: %s", snapshot.SheetContext)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("snapshot should not be cached")
	}
	if _, err := d.Exec(`DELETE FROM sheets WHERE id=?`, sheet.ID); err != nil {
		t.Fatal(err)
	}
	afterDelete := inboxHTTP(t, mux, "GET", "/api/canvas/snapshot?workspace=ws&messageId=snapshot-order", nil)
	if afterDelete.Code != http.StatusOK || !strings.Contains(afterDelete.Body.String(), "Original plan") {
		t.Fatalf("sent plan disappeared with its sheet: %d %s", afterDelete.Code, afterDelete.Body.String())
	}
	if other := inboxHTTP(t, mux, "GET", "/api/canvas/snapshot?workspace=other&messageId=snapshot-order", nil); other.Code != http.StatusNotFound {
		t.Fatalf("cross-workspace snapshot status %d", other.Code)
	}
}

func TestWorkOrderReviewReopensWithHistoryAndFeedback(t *testing.T) {
	s, mux, _ := inboxServer(t)
	send := map[string]any{"id": "review-order", "workspaceId": "ws", "note": "Fix checkout", "deliveryMode": "addressed"}
	if r := inboxHTTP(t, mux, "POST", "/api/canvas/send", send); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	claim := func(owner string) db.InboxItem {
		r := inboxHTTP(t, mux, "POST", "/api/canvas/claim", map[string]string{"workspaceId": "ws", "connectionId": owner, "agent": owner, "messageId": "review-order"})
		if r.Code != 200 {
			t.Fatal(r.Code, r.Body.String())
		}
		var response struct {
			Messages []db.InboxItem `json:"messages"`
		}
		if err := json.Unmarshal(r.Body.Bytes(), &response); err != nil || len(response.Messages) != 1 {
			t.Fatal(r.Body.String(), err)
		}
		return response.Messages[0]
	}
	first := claim("agent-a")
	d, err := s.dbFor("ws")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartInboxWorkSession(d, db.WorkSession{ID: "session-1", WorkspaceID: "ws", MessageID: "review-order", OwnerKey: "agent-a", Agent: "agent-a", Goal: "Fix checkout"}, "agent-a", first.LeaseToken); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordStructuralEvent(d, db.StructuralEvent{WorkspaceID: "ws", SessionID: "session-1", Kind: db.EventFileUpdated, SubjectLabel: "checkout.go"}); err != nil {
		t.Fatal(err)
	}
	result := db.WorkResult{ChangedFiles: []string{"checkout.go"}, Checks: []db.WorkCheck{{Command: "go test ./...", Outcome: "passed"}}}
	submit := map[string]any{"workspaceId": "ws", "msgId": "review-order", "leaseToken": first.LeaseToken, "body": "First attempt", "result": result}
	if r := inboxHTTP(t, mux, "POST", "/api/canvas/reply", submit); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	if r := inboxHTTP(t, mux, "POST", "/api/canvas/reply", submit); r.Code != 200 {
		t.Fatal("identical submission should retry", r.Body.String())
	}
	reopen := map[string]string{"workspaceId": "ws", "msgId": "review-order", "reviewId": "review-1", "decision": "reopened", "note": "Handle timeouts too"}
	for i := 0; i < 2; i++ {
		if r := inboxHTTP(t, mux, "POST", "/api/canvas/review", reopen); r.Code != 200 {
			t.Fatal("reopen retry", r.Code, r.Body.String())
		}
	}
	if r := inboxHTTP(t, mux, "POST", "/api/canvas/review", map[string]string{"workspaceId": "ws", "msgId": "review-order", "reviewId": "review-1", "decision": "accepted"}); r.Code != 409 {
		t.Fatal("changed review ID payload should conflict", r.Code)
	}
	second := claim("agent-b")
	if second.Review == nil || second.Review.Note != "Handle timeouts too" || len(second.PriorReplies) != 1 {
		t.Fatalf("reopened context missing: %#v", second)
	}
	if second.PriorReplies[0].Result == nil || second.PriorReplies[0].Result.Checks[0].Outcome != "passed" {
		t.Fatalf("result history missing: %#v", second.PriorReplies)
	}
	submit = map[string]any{"workspaceId": "ws", "msgId": "review-order", "leaseToken": second.LeaseToken, "body": "Timeouts handled"}
	if r := inboxHTTP(t, mux, "POST", "/api/canvas/reply", submit); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	accept := map[string]string{"workspaceId": "ws", "msgId": "review-order", "reviewId": "review-2", "decision": "accepted"}
	if r := inboxHTTP(t, mux, "POST", "/api/canvas/review", accept); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	history := inboxHTTP(t, mux, "GET", "/api/canvas/history?workspace=ws", nil)
	var response struct {
		Messages []db.InboxItem `json:"messages"`
	}
	if err := json.Unmarshal(history.Body.Bytes(), &response); err != nil || len(response.Messages) != 1 {
		t.Fatal(history.Body.String(), err)
	}
	item := response.Messages[0]
	if item.Status != "answered" || item.Review == nil || item.Review.Decision != "accepted" || item.Reply == nil || item.Reply.Body != "Timeouts handled" || len(item.PriorReplies) != 1 {
		t.Fatalf("incorrect final review: %#v", item)
	}
	if len(item.Reviews) != 2 || item.Reviews[0].Note != "Handle timeouts too" {
		t.Fatalf("review history missing: %#v", item.Reviews)
	}
	if len(item.Changes) != 1 || item.Changes[0].SubjectLabel != "checkout.go" {
		t.Fatalf("linked architecture change missing: %#v", item.Changes)
	}
	if strings.Contains(history.Body.String(), second.LeaseToken) {
		t.Fatal("history leaked claim token")
	}
}
func TestInboxHTTPLifecycle(t *testing.T) {
	s, mux, _ := inboxServer(t)
	send := map[string]any{"id": "request", "workspaceId": "ws", "note": "Review file", "selection": "[\"axiom://file/file?label=hello.go\"]"}
	for i := 0; i < 2; i++ {
		r := inboxHTTP(t, mux, "POST", "/api/canvas/send", send)
		if r.Code != 200 {
			t.Fatal(r.Code, r.Body.String())
		}
	}
	// Legacy GET and prompt previews must never consume instructions.
	for i := 0; i < 2; i++ {
		r := inboxHTTP(t, mux, "GET", "/api/canvas/outbox?workspace=ws", nil)
		if !strings.Contains(r.Body.String(), "request") {
			t.Fatal(r.Body.String())
		}
	}
	claim := inboxHTTP(t, mux, "POST", "/api/canvas/claim", map[string]string{"workspaceId": "ws", "connectionId": "agent-a", "agent": "A"})
	var result struct {
		Messages []db.InboxItem `json:"messages"`
	}
	if err := json.Unmarshal(claim.Body.Bytes(), &result); err != nil || len(result.Messages) != 1 {
		t.Fatal(claim.Body.String(), err)
	}
	item := result.Messages[0]
	history := inboxHTTP(t, mux, "GET", "/api/canvas/history?workspace=ws", nil)
	if strings.Contains(history.Body.String(), item.LeaseToken) {
		t.Fatal("history leaked claim credential")
	}
	reply := map[string]string{"workspaceId": "ws", "msgId": item.ID, "leaseToken": item.LeaseToken, "body": "Here is the answer"}
	for i := 0; i < 2; i++ {
		r := inboxHTTP(t, mux, "POST", "/api/canvas/reply", reply)
		if r.Code != 200 {
			t.Fatal(r.Code, r.Body.String())
		}
	}
	reply["body"] = "changed"
	if r := inboxHTTP(t, mux, "POST", "/api/canvas/reply", reply); r.Code != 409 {
		t.Fatal(r.Code)
	}
	// Lost send acknowledgement remains retryable after selected objects disappear.
	d, _ := s.dbFor("ws")
	if _, err := d.Exec(`DELETE FROM files WHERE id='file'`); err != nil {
		t.Fatal(err)
	}
	if r := inboxHTTP(t, mux, "POST", "/api/canvas/send", send); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
}
func TestAddressedInboxDoesNotLeakAcrossAgentsOrChats(t *testing.T) {
	_, mux, _ := inboxServer(t)
	for _, id := range []string{"chat-one", "chat-two"} {
		body := map[string]any{"id": id, "workspaceId": "ws", "note": "Implement " + id, "deliveryMode": "addressed"}
		if r := inboxHTTP(t, mux, "POST", "/api/canvas/send", body); r.Code != 200 {
			t.Fatal(r.Code, r.Body.String())
		}
	}
	peek := inboxHTTP(t, mux, "GET", "/api/canvas/outbox?workspace=ws&peek=1", nil)
	var counts struct {
		Queued int `json:"queued"`
		Open   int `json:"open"`
	}
	if err := json.Unmarshal(peek.Body.Bytes(), &counts); err != nil || counts.Queued != 2 || counts.Open != 0 {
		t.Fatal(peek.Code, peek.Body.String(), err)
	}
	legacyRead := inboxHTTP(t, mux, "GET", "/api/canvas/outbox?workspace=ws", nil)
	if legacyRead.Code != 200 || strings.Contains(legacyRead.Body.String(), "chat-one") || strings.Contains(legacyRead.Body.String(), "chat-two") {
		t.Fatal("legacy open-queue read exposed addressed work", legacyRead.Code, legacyRead.Body.String())
	}
	claim := func(owner, id string) (*httptest.ResponseRecorder, []db.InboxItem) {
		body := map[string]string{"workspaceId": "ws", "connectionId": owner, "agent": "Claude Code", "messageId": id}
		r := inboxHTTP(t, mux, "POST", "/api/canvas/claim", body)
		var result struct {
			Messages []db.InboxItem `json:"messages"`
		}
		if r.Code == 200 {
			if err := json.Unmarshal(r.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
		}
		return r, result.Messages
	}
	if r, items := claim("terminal-one", ""); r.Code != 200 || len(items) != 0 {
		t.Fatal("undirected claim took addressed work", r.Code, r.Body.String())
	}
	first, items := claim("terminal-one", "chat-one")
	if first.Code != 200 || len(items) != 1 || items[0].ID != "chat-one" {
		t.Fatal(first.Code, first.Body.String())
	}
	if r, _ := claim("terminal-two", "chat-one"); r.Code != 409 {
		t.Fatal("another terminal claimed the same work", r.Code, r.Body.String())
	}
	second, items := claim("terminal-two", "chat-two")
	if second.Code != 200 || len(items) != 1 || items[0].ID != "chat-two" {
		t.Fatal(second.Code, second.Body.String())
	}
	if r, _ := claim("terminal-one", "chat-two"); r.Code != 409 {
		t.Fatal("cross-chat claim succeeded", r.Code, r.Body.String())
	}
	if r, _ := claim("terminal-one", "does-not-exist"); r.Code != 409 {
		t.Fatal("missing addressed work did not fail", r.Code, r.Body.String())
	}
	changed := map[string]any{"id": "chat-one", "workspaceId": "ws", "note": "Implement chat-one", "deliveryMode": "open"}
	if r := inboxHTTP(t, mux, "POST", "/api/canvas/send", changed); r.Code != 409 {
		t.Fatal("retry changed delivery mode", r.Code, r.Body.String())
	}
}
func TestInboxRejectsInvalidBodiesAndForeignTargets(t *testing.T) {
	_, mux, _ := inboxServer(t)
	for _, body := range []map[string]any{
		{"workspaceId": "ws", "note": "   "},
		{"workspaceId": "ws", "note": strings.Repeat("x", 16001)},
		{"workspaceId": "ws", "note": "valid", "selection": "{}"},
		{"workspaceId": "ws", "note": "valid", "selection": "null"},
		{"workspaceId": "ws", "note": "valid", "selection": "[\"axiom://file/foreign\"]"},
		{"workspaceId": "ws", "note": "valid", "status": "answered"},
		{"workspaceId": "ws", "note": "valid", "deliveryMode": "addressed"},
		{"workspaceId": "ws", "note": "valid", "deliveryMode": "unknown"},
		{"workspaceId": "../outside", "note": "valid"},
	} {
		r := inboxHTTP(t, mux, "POST", "/api/canvas/send", body)
		if r.Code < 400 || r.Code >= 500 {
			t.Fatal(r.Code, r.Body.String())
		}
	}
}

func TestInboxHistoryCountsPendingOutsideLoadedPage(t *testing.T) {
	s, mux, _ := inboxServer(t)
	d, _ := s.dbFor("ws")
	for _, item := range []struct {
		id, status string
		created    int
	}{
		{"older-pending", "queued", 1},
		{"newer-cancelled", "cancelled", 2},
	} {
		if _, err := d.Exec(`INSERT INTO canvas_outbox(id,workspace_id,note,selection,status,created_at) VALUES(?, 'ws', 'Instruction', '[]', ?, ?)`, item.id, item.status, item.created); err != nil {
			t.Fatal(err)
		}
	}
	r := inboxHTTP(t, mux, "GET", "/api/canvas/history?workspace=ws&limit=1", nil)
	var result struct {
		Messages       []db.InboxItem `json:"messages"`
		AvailableCount int            `json:"availableCount"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &result); err != nil || r.Code != 200 {
		t.Fatal(r.Code, r.Body.String(), err)
	}
	if len(result.Messages) != 1 || result.Messages[0].ID != "newer-cancelled" || result.AvailableCount != 1 {
		t.Fatal(r.Body.String())
	}
}
func TestAgentWorkspaceUsesPersistedRootsAndExplicitBinding(t *testing.T) {
	_, mux, root := inboxServer(t)
	r := inboxHTTP(t, mux, "GET", "/api/agent/workspace?cwd="+root, nil)
	if r.Code != 200 || !strings.Contains(r.Body.String(), `"workspaceId":"ws"`) {
		t.Fatal(r.Code, r.Body.String())
	}
	r = inboxHTTP(t, mux, "GET", "/api/agent/workspace?cwd=/unrelated", nil)
	if r.Code != 404 {
		t.Fatal(r.Code)
	}
	r = inboxHTTP(t, mux, "GET", "/api/agent/workspace?cwd=/unrelated&workspace=ws", nil)
	if r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
}
func TestLocalTokenProtectsHTTPAndWebsocket(t *testing.T) {
	_, mux, _ := inboxServer(t)
	token := "01234567890123456789012345678901"
	handler := AllowAuthenticatedOrigins(RequireLocalToken(token, mux))
	for _, path := range []string{"/api/canvas/history?workspace=ws", "/ws?workspace=ws"} {
		r := inboxHTTP(t, handler, "GET", path, nil)
		if r.Code != 401 {
			t.Fatal(r.Code)
		}
	}
	req := httptest.NewRequest("GET", "/api/canvas/history?workspace=ws", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Origin", "null")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != 200 {
		t.Fatal(response.Code)
	}
	if response.Header().Get("Access-Control-Allow-Origin") != "null" {
		t.Fatal("packaged renderer cannot read authenticated response")
	}
	dir := t.TempDir()
	first, err := LocalAPIToken(dir)
	if err != nil {
		t.Fatal(err)
	}
	second, err := LocalAPIToken(dir)
	if err != nil || first != second {
		t.Fatal("token changed across restart", err)
	}
}
