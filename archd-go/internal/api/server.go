// Package api serves the HTTP + WebSocket endpoints consumed by Electron and the MCP server.
//
// Endpoint map:
//
//	GET  /ws                           - WebSocket upgrade (renderer connects here)
//	GET  /api/snapshot/:workspaceId    - full canvas snapshot
//	POST /api/workspace                - create or open a workspace + root (opens per-project DB)
//	DELETE /api/workspace/:id          - close and permanently delete workspace-owned data
//	POST /api/systems                  - create / upsert a system
//	PUT  /api/systems/:id              - update system (name, parent, description)
//	DELETE /api/systems/:id?workspace= - delete system
//	POST /api/systems/:id/position?workspace= - update canvas position
//	POST /api/files/:id/assign         - assign file to system  {systemId, workspaceId}
//	POST /api/files/:id/position       - update file canvas position  {x, y, workspaceId}
//	PUT  /api/files/:id/size           - update file canvas size  {w, h, workspaceId}
//	GET  /api/files/:id/symbols?workspace= - get symbols for a file
//	POST /api/infra                    - create infra node
//	GET  /api/call-path?from=&to=&workspace= - trace call path between two files
package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"axiom.local/archd/internal/activity"
	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/gitworktree"
	"axiom.local/archd/internal/hub"
	"axiom.local/archd/internal/registry"
	"axiom.local/archd/internal/runtime"
	"axiom.local/archd/internal/watcher"
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
	dataDir  string
	dbs      map[string]*sql.DB
	mu       sync.RWMutex
	hub      *hub.Hub
	roots    map[string]db.Root // rootID → Root; populated on workspace open
	runtime  *runtime.Manager
	registry *registry.Registry // infra service registry (layered; reloaded on workspace open)
	// watchers holds one running fsnotify watcher per root so live edits
	// re-index and feed the activity engine. Keyed by root ID; closed on
	// workspace close.
	watchers map[string]*watcher.Watcher
	// Worktree topology and heads are driven by Git metadata notifications. A
	// slow periodic refresh remains only as protection against dropped events.
	discoverWorktrees func(string) ([]gitworktree.Worktree, error)
	worktreeRefresh   time.Duration
	worktreeMonitors  map[string]worktreeMonitor
	rootSyncing       map[string]bool
	rootSyncPending   map[string]pendingRootSync
	collisionCache    map[string]collisionCacheEntry
	collisionCacheTTL time.Duration
	// A deleted workspace cannot be lazily reopened by a late poll or an old
	// MCP process. Only POST /api/workspace explicitly starts a new lifetime.
	deletedWorkspaces map[string]struct{}
	// Agent presence is a short lease renewed by each running MCP process. It
	// is deliberately separate from the durable action log: history proves an
	// agent connected before, while a lease proves it is connected now.
	presenceMu       sync.Mutex
	agentPresence    map[string]map[string]AgentPresence
	presenceNow      func() time.Time
	agentPresenceTTL time.Duration
}

func NewServer(dataDir string, h *hub.Hub, rt *runtime.Manager) *Server {
	s := &Server{
		dataDir:           dataDir,
		dbs:               make(map[string]*sql.DB),
		hub:               h,
		roots:             make(map[string]db.Root),
		runtime:           rt,
		registry:          registry.Load(nil),
		watchers:          make(map[string]*watcher.Watcher),
		discoverWorktrees: gitworktree.Discover,
		worktreeRefresh:   5 * time.Minute,
		worktreeMonitors:  make(map[string]worktreeMonitor),
		rootSyncing:       make(map[string]bool),
		rootSyncPending:   make(map[string]pendingRootSync),
		collisionCache:    make(map[string]collisionCacheEntry),
		collisionCacheTTL: 2 * time.Second,
		deletedWorkspaces: make(map[string]struct{}),
		agentPresence:     make(map[string]map[string]AgentPresence),
		presenceNow:       time.Now,
		agentPresenceTTL:  15 * time.Second,
	}
	// Adapters started outside the launcher (PYTHONPATH opt-in) have no
	// AXIOM_WORKSPACE_ID; map them to a workspace by their working directory.
	rt.SetWorkspaceResolver(s.workspaceForCwd)
	return s
}

// workspaceForCwd finds the workspace whose root contains (or equals) cwd.
// The longest matching root wins so nested roots resolve correctly.
func (s *Server) workspaceForCwd(cwd string) string {
	if cwd == "" {
		return ""
	}
	norm := normalizedRootPath(cwd)
	s.mu.RLock()
	defer s.mu.RUnlock()
	best := ""
	bestLen := -1
	for _, root := range s.roots {
		rootNorm := normalizedRootPath(root.Path)
		if pathInsideRoot(norm, rootNorm) && len(rootNorm) > bestLen {
			best = root.WorkspaceID
			bestLen = len(rootNorm)
		}
	}
	return best
}

// openDB opens (or creates) the per-project database at <dataDir>/<workspaceID>/axiom.db.
// Safe to call concurrently; returns the existing connection if already open.
func (s *Server) openDB(workspaceID string) (*sql.DB, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, deleted := s.deletedWorkspaces[workspaceID]; deleted {
		return nil, fmt.Errorf("workspace %s was deleted; reopen it explicitly", workspaceID)
	}
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

func validWorkspaceID(workspaceID string) bool {
	if workspaceID == "" || workspaceID == "." || workspaceID == ".." || len(workspaceID) > 128 {
		return false
	}
	for _, char := range workspaceID {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') || char == '-' || char == '_' || char == '.' {
			continue
		}
		return false
	}
	return true
}

func (s *Server) workspaceDataPath(workspaceID string) (string, error) {
	if !validWorkspaceID(workspaceID) {
		return "", fmt.Errorf("invalid workspace id")
	}
	base, err := filepath.Abs(s.dataDir)
	if err != nil {
		return "", err
	}
	target, err := filepath.Abs(filepath.Join(base, workspaceID))
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(base, target)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("workspace path escapes data directory")
	}
	return target, nil
}

func (s *Server) markWorkspaceDeleted(workspaceID string) {
	s.mu.Lock()
	s.deletedWorkspaces[workspaceID] = struct{}{}
	s.mu.Unlock()
}

func (s *Server) reviveWorkspace(workspaceID string) {
	s.mu.Lock()
	delete(s.deletedWorkspaces, workspaceID)
	s.mu.Unlock()
}

func (s *Server) deleteWorkspace(workspaceID string) error {
	projectDir, err := s.workspaceDataPath(workspaceID)
	if err != nil {
		return err
	}
	// Tombstone first. Otherwise a proposal poll between closeDB and RemoveAll
	// can lazily reopen the same SQLite database and keep the deleted project alive.
	s.markWorkspaceDeleted(workspaceID)
	s.closeDB(workspaceID)
	if err := os.RemoveAll(projectDir); err != nil {
		return fmt.Errorf("delete workspace data: %w", err)
	}
	if _, err := os.Stat(projectDir); !os.IsNotExist(err) {
		if err == nil {
			return fmt.Errorf("workspace data still exists after deletion")
		}
		return fmt.Errorf("verify workspace deletion: %w", err)
	}
	return nil
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
		// Attempt to open lazily - the DB may exist on disk from a previous session.
		return s.openDB(workspaceID)
	}
	return d, nil
}

// closeDB closes and removes the database connection for a workspace without
// deleting the data on disk. Called before the electron process deletes the
// project directory so the file lock is released (important on Windows).
func (s *Server) closeDB(workspaceID string) {
	s.mu.Lock()
	monitor, hasMonitor := s.worktreeMonitors[workspaceID]
	if hasMonitor {
		monitor.cancel()
		delete(s.worktreeMonitors, workspaceID)
	}
	s.mu.Unlock()
	if hasMonitor {
		<-monitor.done
	}

	s.mu.Lock()
	watchers := make([]*watcher.Watcher, 0)
	for rootID, r := range s.roots {
		if r.WorkspaceID == workspaceID {
			if w, ok := s.watchers[rootID]; ok {
				watchers = append(watchers, w)
				delete(s.watchers, rootID)
			}
			delete(s.roots, rootID)
			delete(s.rootSyncPending, rootID)
		}
	}
	d := s.dbs[workspaceID]
	delete(s.dbs, workspaceID)
	delete(s.collisionCache, workspaceID)
	s.mu.Unlock()
	for _, w := range watchers {
		_ = w.Close()
	}
	if d != nil {
		_ = d.Close()
	}
	s.presenceMu.Lock()
	delete(s.agentPresence, workspaceID)
	s.presenceMu.Unlock()
}

// startWatcher attaches a live fsnotify watcher to a root so saves re-index
// the file, feed the activity engine, and patch the canvas in real time.
// Idempotent per root - re-opening a workspace reuses the running watcher.
func (s *Server) startWatcher(sqlDB *sql.DB, root db.Root) {
	s.mu.Lock()
	s.roots[root.ID] = root
	if existing, ok := s.watchers[root.ID]; ok {
		existing.UpdateRoot(root)
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	w, err := watcher.New(sqlDB, s.hub, []db.Root{root})
	if err != nil {
		log.Printf("api: start watcher for %s: %v", root.Path, err)
		return
	}
	s.mu.Lock()
	if existing, ok := s.watchers[root.ID]; ok {
		s.mu.Unlock()
		_ = w.Close()
		existing.UpdateRoot(root)
		return
	}
	s.watchers[root.ID] = w
	s.roots[root.ID] = root
	s.mu.Unlock()
	go w.Run()
	log.Printf("api: watcher attached to %s", root.Path)
}

func (s *Server) stopWatcher(rootID string) {
	s.mu.Lock()
	w := s.watchers[rootID]
	delete(s.watchers, rootID)
	delete(s.roots, rootID)
	s.mu.Unlock()
	if w != nil {
		_ = w.Close()
	}
}

// RegisterRoutes wires all API endpoints onto mux.
func (s *Server) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/api/snapshot/", s.handleSnapshot)
	mux.HandleFunc("/api/workspace-scope/", s.handleWorkspaceScope)
	mux.HandleFunc("/api/workspace/", s.handleWorkspaceByID)
	mux.HandleFunc("/api/workspace", s.handleWorkspace)
	mux.HandleFunc("/api/roots", s.handleRoots)
	mux.HandleFunc("/api/systems", s.handleSystems)
	mux.HandleFunc("/api/systems/", s.handleSystemByID)
	mux.HandleFunc("/api/files/", s.handleFileByID)
	mux.HandleFunc("/api/infra", s.handleInfra)
	mux.HandleFunc("/api/infra/connect", s.handleInfraConnect)
	mux.HandleFunc("/api/infra/edge/", s.handleInfraEdge)
	mux.HandleFunc("/api/infra/", s.handleInfraByID)
	mux.HandleFunc("/api/registry/services", s.handleRegistryServices)
	mux.HandleFunc("/api/layout/batch", s.handleFloorLayoutBatch)
	s.registerSheetRoutes(mux)
	s.registerArchitectureProposalRoutes(mux)
	mux.HandleFunc("/api/call-path", s.handleCallPath)
	mux.HandleFunc("/api/function-body", s.handleFunctionBody)
	mux.HandleFunc("/api/data-flow", s.handleDataFlow)
	s.registerRuntimeRoutes(mux)
	s.registerInvestigationRoutes(mux)
	mux.HandleFunc("/api/agent/activity", s.handleAgentActivity)
	mux.HandleFunc("/api/agent/presence", s.handleAgentPresence)
	mux.HandleFunc("/api/agent/action", s.handleAgentAction)
	mux.HandleFunc("/api/agent/actions", s.handleAgentActions)
	mux.HandleFunc("/api/activity/hotspots", s.handleActivityHotspots)
	mux.HandleFunc("/api/delta", s.handleDelta)
	mux.HandleFunc("/api/delta/ack", s.handleDeltaAck)
	mux.HandleFunc("/api/collisions", s.handleCollisions)
	mux.HandleFunc("/api/work/", s.handleWork)
	mux.HandleFunc("/api/command-deck", s.handleCommandDeck)
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
	WorkspaceID                string   `json:"workspaceId"` // empty = create new
	Name                       string   `json:"name"`
	RootPath                   string   `json:"rootPath"`
	IgnoredPaths               []string `json:"ignoredPaths"`
	SourceBoundariesReviewedAt *int64   `json:"sourceBoundariesReviewedAt"`
}

func (s *Server) handleWorkspaceScope(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	workspaceID := strings.TrimPrefix(r.URL.Path, "/api/workspace-scope/")
	if workspaceID == "" {
		jsonError(w, "workspace id is required", http.StatusBadRequest)
		return
	}
	dbPath := filepath.Join(s.dataDir, workspaceID, "axiom.db")
	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		jsonOK(w, map[string]any{
			"indexed":                    false,
			"ignoredPaths":               []string{},
			"sourceBoundariesReviewedAt": nil,
		})
		return
	}
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	roots, err := db.GetRoots(sqlDB, workspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	requestedPath := filepath.Clean(r.URL.Query().Get("rootPath"))
	for _, root := range roots {
		if requestedPath != "." && !sameRootPath(root.Path, requestedPath) {
			continue
		}
		jsonOK(w, map[string]any{
			"indexed":                    root.IndexedAt != nil && *root.IndexedAt > 0,
			"ignoredPaths":               root.IgnoredPaths,
			"sourceBoundariesReviewedAt": root.SourceBoundariesReviewedAt,
		})
		return
	}
	jsonOK(w, map[string]any{
		"indexed":                    false,
		"ignoredPaths":               []string{},
		"sourceBoundariesReviewedAt": nil,
	})
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
	if !validWorkspaceID(wsID) {
		jsonError(w, "invalid workspace id", http.StatusBadRequest)
		return
	}
	// This POST is the one operation allowed to begin a new lifetime for an id
	// that was explicitly deleted. Ordinary reads and writes remain tombstoned.
	s.reviveWorkspace(wsID)

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
	worktrees, isGitWorkspace := s.discoverInitialWorktrees(req.RootPath)
	options := rootOpenOptions{
		IgnoredPaths:               req.IgnoredPaths,
		SourceBoundariesReviewedAt: req.SourceBoundariesReviewedAt,
	}
	rootID, err := s.syncWorkspaceWorktrees(
		sqlDB, wsID, req.RootPath, worktrees, options, true, true,
	)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if isGitWorkspace {
		monitorOptions := options
		monitorOptions.IgnoredPaths = ignoredPathsForWorktree(
			options.IgnoredPaths,
			req.RootPath,
			worktrees[0].Path,
		)
		s.startWorktreeMonitor(sqlDB, wsID, worktrees[0].Path, monitorOptions)
	}

	jsonOK(w, map[string]any{"workspaceId": wsID, "rootId": rootID})
}

// handleWorkspaceByID handles DELETE /api/workspace/:id. The daemon owns the
// whole teardown: it releases locks, deletes the database directory, and
// tombstones the id so late reads cannot recreate it.
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
	if err := s.deleteWorkspace(workspaceID); err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}
	log.Printf("[api] workspace %s deleted", workspaceID)
	jsonOK(w, map[string]string{"deleted": workspaceID})
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

	case r.Method == http.MethodGet && sub == "source":
		s.handleFileSource(w, r, id)

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
	// Every MCP tool call posts here - that signal attributes watcher-detected
	// file edits in the next ~90s to the agent (activity engine).
	activity.MarkAgent(body.WorkspaceID)
	s.hub.Broadcast("agent:activity", body)
	jsonOK(w, map[string]string{"status": "ok"})
}

// handleActivityHotspots returns files ranked by decayed live-edit activity -
// "where is the code changing right now". GET /api/activity/hotspots?workspace=&limit=
func (s *Server) handleActivityHotspots(w http.ResponseWriter, r *http.Request) {
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
	limit := 20
	if l := r.URL.Query().Get("limit"); l != "" {
		fmt.Sscanf(l, "%d", &limit)
	}
	files, err := db.GetFiles(sqlDB, workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	now := time.Now().UnixMilli()
	type hotspot struct {
		FileID     string  `json:"fileId"`
		RelPath    string  `json:"relPath"`
		Score      float64 `json:"score"`      // decayed raw score
		Normalized float64 `json:"normalized"` // 0..1 workspace percentile
		LastEdit   int64   `json:"lastEditAt"` // ms epoch of last burst
	}
	entries := make([]activity.ScoreEntry, len(files))
	for i, f := range files {
		entries[i] = activity.ScoreEntry{ID: f.ID, Score: f.ActivityScore, AtMs: f.ActivityAt}
	}
	norm := activity.Normalize(entries, now)
	// Empty must serialize as [] - a quiet workspace is a normal answer, and a
	// null here crashes every client that iterates the result.
	hots := []hotspot{}
	for _, f := range files {
		d := activity.Decayed(f.ActivityScore, f.ActivityAt, now)
		if d <= 0 {
			continue
		}
		hots = append(hots, hotspot{f.ID, f.RelPath, d, norm[f.ID], f.ActivityAt})
	}
	sort.Slice(hots, func(i, j int) bool { return hots[i].Score > hots[j].Score })
	if len(hots) > limit {
		hots = hots[:limit]
	}
	jsonOK(w, hots)
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
