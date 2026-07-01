// Package api serves the HTTP + WebSocket endpoints consumed by Electron and the MCP server.
//
// Endpoint map:
//   GET  /ws                           — WebSocket upgrade (renderer connects here)
//   GET  /api/snapshot/:workspaceId    — full canvas snapshot
//   POST /api/workspace                — create or open a workspace + root (opens per-project DB)
//   DELETE /api/workspace/:id          — close workspace DB connection (call before deleting project dir)
//   POST /api/systems                  — create / upsert a system
//   PUT  /api/systems/:id              — update system (name, parent, description)
//   DELETE /api/systems/:id?workspace= — delete system
//   POST /api/systems/:id/position?workspace= — update canvas position
//   POST /api/files/:id/assign         — assign file to system  {systemId, workspaceId}
//   POST /api/files/:id/position       — update file canvas position  {x, y, workspaceId}
//   PUT  /api/files/:id/size           — update file canvas size  {w, h, workspaceId}
//   GET  /api/files/:id/symbols?workspace= — get symbols for a file
//   POST /api/infra                    — create infra node
//   POST /api/classification/start     — start a classification job
//   GET  /api/classification/:jobId?workspace=    — get job status
//   GET  /api/classification/:jobId/batch?workspace= — get next batch for agent
//   POST /api/classification/:jobId/submit?workspace= — submit agent assignments
//   GET  /api/call-path?from=&to=&workspace= — trace call path between two files
package api

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
	"axiom.local/archd/internal/indexer"
)

var upgrader = websocket.Upgrader{
	CheckOrigin:      func(r *http.Request) bool { return true }, // Electron origin
	HandshakeTimeout: 5 * time.Second,
}

// Server holds all dependencies for the HTTP handlers.
// Each workspace (project) gets its own SQLite database, opened on demand and
// stored in dbs keyed by workspace ID. This guarantees complete data isolation
// between projects and makes project removal (delete the directory) work correctly.
type Server struct {
	dataDir string
	dbs     map[string]*sql.DB
	mu      sync.RWMutex
	hub     *hub.Hub
	roots   map[string]db.Root // rootID → Root; populated on workspace open
}

func NewServer(dataDir string, h *hub.Hub) *Server {
	return &Server{
		dataDir: dataDir,
		dbs:     make(map[string]*sql.DB),
		hub:     h,
		roots:   make(map[string]db.Root),
	}
}

// openDB opens (or creates) the per-project database at <dataDir>/<workspaceID>/axiom.db.
// Safe to call concurrently; returns the existing connection if already open.
func (s *Server) openDB(workspaceID string) (*sql.DB, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d, ok := s.dbs[workspaceID]; ok {
		return d, nil
	}
	projectDir := filepath.Join(s.dataDir, workspaceID)
	d, err := db.Open(projectDir)
	if err != nil {
		return nil, fmt.Errorf("open db for workspace %s: %w", workspaceID, err)
	}
	s.dbs[workspaceID] = d
	return d, nil
}

// dbFor returns the already-open database for a workspace, or an error if it
// has not been opened yet (i.e. the workspace was never registered via POST /api/workspace).
func (s *Server) dbFor(workspaceID string) (*sql.DB, error) {
	if workspaceID == "" {
		return nil, fmt.Errorf("workspaceId is required")
	}
	s.mu.RLock()
	d, ok := s.dbs[workspaceID]
	s.mu.RUnlock()
	if !ok {
		// Attempt to open lazily — the DB may exist on disk from a previous session.
		return s.openDB(workspaceID)
	}
	return d, nil
}

// closeDB closes and removes the database connection for a workspace without
// deleting the data on disk. Called before the electron process deletes the
// project directory so the file lock is released (important on Windows).
func (s *Server) closeDB(workspaceID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d, ok := s.dbs[workspaceID]; ok {
		d.Close()
		delete(s.dbs, workspaceID)
	}
}

// RegisterRoutes wires all API endpoints onto mux.
func (s *Server) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/api/snapshot/", s.handleSnapshot)
	mux.HandleFunc("/api/workspace/", s.handleWorkspaceByID)
	mux.HandleFunc("/api/workspace", s.handleWorkspace)
	mux.HandleFunc("/api/systems", s.handleSystems)
	mux.HandleFunc("/api/systems/", s.handleSystemByID)
	mux.HandleFunc("/api/files/", s.handleFileByID)
	mux.HandleFunc("/api/infra", s.handleInfra)
	mux.HandleFunc("/api/classification/start", s.handleClassificationStart)
	mux.HandleFunc("/api/classification/", s.handleClassification)
	mux.HandleFunc("/api/call-path", s.handleCallPath)
	mux.HandleFunc("/api/agent/activity", s.handleAgentActivity)
	mux.HandleFunc("/api/query", s.handleQuery)
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}
	s.hub.Register(conn)
}

// ─── Snapshot ─────────────────────────────────────────────────────────────────

func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	workspaceID := strings.TrimPrefix(r.URL.Path, "/api/snapshot/")
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	snap, err := db.GetCanvasSnapshot(sqlDB, workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	jsonOK(w, snap)
}

// ─── Workspace ────────────────────────────────────────────────────────────────

type openWorkspaceReq struct {
	WorkspaceID  string   `json:"workspaceId"` // empty = create new
	Name         string   `json:"name"`
	RootPath     string   `json:"rootPath"`
	IgnoredPaths []string `json:"ignoredPaths"`
}

func (s *Server) handleWorkspace(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var req openWorkspaceReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	log.Printf("[api] handleWorkspace: workspaceId=%q rootPath=%q ignoredPaths=%v", req.WorkspaceID, req.RootPath, req.IgnoredPaths)
	wsID := req.WorkspaceID
	if wsID == "" {
		wsID = uuid.New().String()
	}

	sqlDB, err := s.openDB(wsID)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}

	ws := db.Workspace{ID: wsID, Name: req.Name, OpenedAt: time.Now().UnixMilli()}
	if err := db.UpsertWorkspace(sqlDB, ws); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	// Use a stable root ID derived from workspace+path so re-opens reuse the same row.
	h := sha256.Sum256([]byte(wsID + "|" + req.RootPath))
	rootID := hex.EncodeToString(h[:])[:32]
	root := db.Root{
		ID:          rootID,
		WorkspaceID: wsID,
		Path:        req.RootPath,
	}
	// Check if this root has been successfully indexed before.
	// On first open: wipe any stale data and do a full index.
	// On re-open: skip the wipe — indexer upserts only what changed.
	alreadyIndexed := false
	if existing, err := db.GetRoots(sqlDB, wsID); err == nil {
		for _, r := range existing {
			if r.ID == rootID && r.IndexedAt != nil && *r.IndexedAt > 0 {
				alreadyIndexed = true
				break
			}
		}
	}
	if !alreadyIndexed {
		if err := db.DeleteFilesByWorkspace(sqlDB, wsID); err != nil {
			log.Printf("api: clear files for workspace %s: %v", wsID, err)
		}
		if err := db.DeleteDirectorySystemsByWorkspace(sqlDB, wsID); err != nil {
			log.Printf("api: clear directory systems for workspace %s: %v", wsID, err)
		}
	}
	log.Printf("[api] workspace %s alreadyIndexed=%v", wsID, alreadyIndexed)
	if err := db.UpsertRoot(sqlDB, root); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	s.roots[root.ID] = root

	// Kick off indexing in the background.
	// On first open: full index + cluster. On re-open: skip re-indexing to preserve
	// user-arranged positions — the watcher handles live file changes.
	// Exception: if the project has files but no systems yet (e.g. indexed in a prior
	// version before clustering was introduced), run a cluster-only pass so the canvas
	// is populated without re-parsing every file.
	go func() {
		if !alreadyIndexed {
			if err := indexer.IndexRoot(sqlDB, s.hub, root, req.IgnoredPaths); err != nil {
				log.Printf("api: index root %s: %v", root.Path, err)
				return
			}
		} else {
			snap, _ := db.GetCanvasSnapshot(sqlDB, wsID)
			needsCluster := snap != nil && len(snap.Systems) == 0 && len(snap.Files) > 0
			if needsCluster {
				log.Printf("[api] workspace %s: already indexed but 0 systems — running cluster-only pass", wsID)
				if err := indexer.ClusterOnly(sqlDB, root); err != nil {
					log.Printf("api: cluster-only %s: %v", root.Path, err)
				}
			}
		}
		snap, _ := db.GetCanvasSnapshot(sqlDB, wsID)
		if snap != nil {
			s.hub.BroadcastSnapshot(snap)
		}
	}()

	jsonOK(w, map[string]any{"workspaceId": wsID, "rootId": root.ID})
}

// handleWorkspaceByID handles DELETE /api/workspace/:id.
// The renderer calls this before deleting the project directory so the SQLite
// file lock is released (critical on Windows).
func (s *Server) handleWorkspaceByID(w http.ResponseWriter, r *http.Request) {
	workspaceID := strings.TrimPrefix(r.URL.Path, "/api/workspace/")
	if workspaceID == "" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodDelete {
		http.NotFound(w, r)
		return
	}
	s.closeDB(workspaceID)
	log.Printf("[api] workspace %s closed", workspaceID)
	jsonOK(w, map[string]string{"closed": workspaceID})
}

// ─── Systems ──────────────────────────────────────────────────────────────────

func (s *Server) handleSystems(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		var sys db.System
		if err := json.NewDecoder(r.Body).Decode(&sys); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		sqlDB, err := s.dbFor(sys.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.UpsertSystem(sqlDB, sys); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastPatch("system:upserted", sys)
		jsonOK(w, sys)
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) handleSystemByID(w http.ResponseWriter, r *http.Request) {
	// Path: /api/systems/<id>[/position]
	rest := strings.TrimPrefix(r.URL.Path, "/api/systems/")
	parts := strings.SplitN(rest, "/", 2)
	id := parts[0]
	sub := ""
	if len(parts) > 1 {
		sub = parts[1]
	}

	switch {
	case r.Method == http.MethodPut && sub == "":
		var sys db.System
		if err := json.NewDecoder(r.Body).Decode(&sys); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		sys.ID = id
		sqlDB, err := s.dbFor(sys.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.UpsertSystem(sqlDB, sys); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastPatch("system:upserted", sys)
		jsonOK(w, sys)

	case r.Method == http.MethodDelete && sub == "":
		workspaceID := r.URL.Query().Get("workspace")
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.DeleteSystem(sqlDB, id); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastPatch("system:deleted", map[string]string{"id": id})
		jsonOK(w, map[string]string{"deleted": id})

	case r.Method == http.MethodPost && sub == "position":
		workspaceID := r.URL.Query().Get("workspace")
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		var body struct {
			X float64 `json:"x"`
			Y float64 `json:"y"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		if err := db.UpdateSystemPosition(sqlDB, id, body.X, body.Y); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		jsonOK(w, map[string]any{"id": id, "x": body.X, "y": body.Y})

	default:
		http.NotFound(w, r)
	}
}

// ─── Files ────────────────────────────────────────────────────────────────────

func (s *Server) handleFileByID(w http.ResponseWriter, r *http.Request) {
	// Path: /api/files/<id>[/assign|/position|/size|/symbols]
	rest := strings.TrimPrefix(r.URL.Path, "/api/files/")
	parts := strings.SplitN(rest, "/", 2)
	id := parts[0]
	sub := ""
	if len(parts) > 1 {
		sub = parts[1]
	}

	switch {
	case r.Method == http.MethodPost && sub == "assign":
		var body struct {
			SystemID    string `json:"systemId"`
			WorkspaceID string `json:"workspaceId"`
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
		if err := db.AssignFileToSystem(sqlDB, id, body.SystemID); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastPatch("file:assigned", map[string]string{"fileId": id, "systemId": body.SystemID})
		jsonOK(w, map[string]string{"fileId": id, "systemId": body.SystemID})

	case r.Method == http.MethodPost && sub == "position":
		var body struct {
			X           float64 `json:"x"`
			Y           float64 `json:"y"`
			WorkspaceID string  `json:"workspaceId"`
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
		if err := db.UpdateFilePosition(sqlDB, id, body.X, body.Y); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		jsonOK(w, map[string]any{"id": id, "x": body.X, "y": body.Y})

	case r.Method == http.MethodPut && sub == "size":
		var body struct {
			W           float64 `json:"w"`
			H           float64 `json:"h"`
			WorkspaceID string  `json:"workspaceId"`
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
		if err := db.UpdateFileSize(sqlDB, id, body.W, body.H); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		jsonOK(w, map[string]any{"id": id, "w": body.W, "h": body.H})

	case r.Method == http.MethodGet && sub == "symbols":
		workspaceID := r.URL.Query().Get("workspace")
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		syms, err := db.GetSymbolsByFile(sqlDB, id)
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		jsonOK(w, syms)

	default:
		http.NotFound(w, r)
	}
}

// ─── Infra ────────────────────────────────────────────────────────────────────

func (s *Server) handleInfra(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var n db.InfraNode
	if err := json.NewDecoder(r.Body).Decode(&n); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	sqlDB, err := s.dbFor(n.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	if err := db.UpsertInfraNode(sqlDB, n); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	s.broadcastPatch("infra:upserted", n)
	jsonOK(w, n)
}

// ─── Classification ───────────────────────────────────────────────────────────

func (s *Server) handleClassificationStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		Strategy    string `json:"strategy"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	if body.Strategy == "" {
		body.Strategy = "by_import_cluster"
	}
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	job, err := db.CreateClassificationJob(sqlDB, body.WorkspaceID, body.Strategy)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	jsonOK(w, job)
}

func (s *Server) handleClassification(w http.ResponseWriter, r *http.Request) {
	// /api/classification/<jobId>[/batch|/submit]
	rest := strings.TrimPrefix(r.URL.Path, "/api/classification/")
	parts := strings.SplitN(rest, "/", 2)
	jobID := parts[0]
	sub := ""
	if len(parts) > 1 {
		sub = parts[1]
	}

	workspaceID := r.URL.Query().Get("workspace")
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}

	switch {
	case r.Method == http.MethodGet && sub == "":
		job, err := db.GetClassificationJob(sqlDB, jobID)
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		if job == nil {
			jsonError(w, "not found", 404)
			return
		}
		jsonOK(w, job)

	case r.Method == http.MethodGet && sub == "batch":
		job, err := db.GetClassificationJob(sqlDB, jobID)
		if err != nil || job == nil {
			jsonError(w, "job not found", 404)
			return
		}
		batch, err := db.GetNextClassificationBatch(sqlDB, jobID, job.WorkspaceID, 15)
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		systems, _ := db.GetSystems(sqlDB, job.WorkspaceID)
		names := make([]string, 0, len(systems))
		for _, sys := range systems {
			names = append(names, sys.Name)
		}
		jsonOK(w, map[string]any{
			"files":           batch,
			"existingSystems": names,
			"progress":        map[string]any{"classified": job.ClassifiedFiles, "total": job.TotalFiles},
			"instructions":    "Group files by feature domain, not directory. Create new system names that reflect what the code does.",
		})

	case r.Method == http.MethodPost && sub == "submit":
		var assignments []db.ClassificationAssignment
		if err := json.NewDecoder(r.Body).Decode(&assignments); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		if err := db.SubmitClassificationAssignments(sqlDB, jobID, assignments); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		// Broadcast the graph update
		job, _ := db.GetClassificationJob(sqlDB, jobID)
		if job != nil {
			snap, _ := db.GetCanvasSnapshot(sqlDB, job.WorkspaceID)
			if snap != nil {
				s.hub.BroadcastSnapshot(snap)
			}
		}
		jsonOK(w, map[string]any{"accepted": len(assignments)})

	default:
		http.NotFound(w, r)
	}
}

// ─── Call path ────────────────────────────────────────────────────────────────

func (s *Server) handleCallPath(w http.ResponseWriter, r *http.Request) {
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	workspaceID := r.URL.Query().Get("workspace")
	if from == "" || to == "" {
		jsonError(w, "from and to required", 400)
		return
	}
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	path, err := db.GetCallPath(sqlDB, from, to, 6)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	// Broadcast the trace to the canvas so it animates in real-time as the agent queries.
	if len(path) > 0 {
		s.hub.Broadcast("call:trace", map[string]any{
			"workspaceId": workspaceID,
			"steps":       path,
		})
	}
	jsonOK(w, map[string]any{"path": path})
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func (s *Server) broadcastPatch(eventType string, payload any) {
	s.hub.Broadcast("graph:patch", map[string]any{
		"type":    eventType,
		"payload": payload,
	})
}

func (s *Server) handleQuery(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		SQL         string `json:"sql"`
		Params      []any  `json:"params"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	sqlClean := strings.TrimSpace(strings.ToUpper(body.SQL))
	if !strings.HasPrefix(sqlClean, "SELECT") {
		jsonError(w, "only SELECT queries are allowed", 403)
		return
	}
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	rows, err := sqlDB.Query(body.SQL, body.Params...)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}

	var result []map[string]any
	for rows.Next() {
		columns := make([]any, len(cols))
		columnPointers := make([]any, len(cols))
		for i := range columns {
			columnPointers[i] = &columns[i]
		}
		if err := rows.Scan(columnPointers...); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}

		rowMap := make(map[string]any)
		for i, colName := range cols {
			val := columns[i]
			b, ok := val.([]byte)
			if ok {
				rowMap[colName] = string(b)
			} else {
				rowMap[colName] = val
			}
		}
		result = append(result, rowMap)
	}

	if result == nil {
		result = []map[string]any{}
	}
	jsonOK(w, result)
}

func (s *Server) handleAgentActivity(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		Message     string `json:"message"`
		Level       string `json:"level"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	s.hub.Broadcast("agent:activity", body)
	jsonOK(w, map[string]string{"status": "ok"})
}

func jsonOK(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("api: encode response: %v", err)
	}
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
