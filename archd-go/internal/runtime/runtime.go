// Package runtime is the language-agnostic core of Axiom's runtime debugging
// layer. Per-language adapters (Python via sys.monitoring, later Node/Go/C#)
// run inside or alongside the target application and connect to this manager
// over a local TCP socket speaking newline-delimited JSON.
//
// The manager knows nothing about any specific language or about SQLite: the
// api package resolves files/symbols against the graph DB and hands fully
// resolved Watch records to the manager. Events flow:
//
//	adapter ──TCP NDJSON──▶ Manager ──ring buffer──▶ GET /api/runtime/snapshot
//	                            │
//	                            └──hub.Broadcast──▶ canvas (runtime:* events)
//
// Wire protocol (one JSON object per line, both directions):
//
//	adapter → archd:
//	  {"type":"hello","language":"python","pid":123,"workspaceId":"…","cwd":"…","runtimeVersion":"cpython 3.12.1"}
//	  {"type":"heartbeat"}
//	  {"type":"event","event":{"kind":"call|return|exception|rate_limit", …}}
//	archd → adapter:
//	  {"type":"hello_ack","sessionId":"…","watches":[…]}
//	  {"type":"watch","watch":{…}}
//	  {"type":"unwatch","watchId":"…"}
//	  {"type":"inject","inject":{…}}        (perturbation, one-shot)
package runtime

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"sync"
	"time"

	"github.com/google/uuid"

	"axiom.local/archd/internal/hub"
)

// ─── Wire types ───────────────────────────────────────────────────────────────

// Watch is a live function watch point. Stats fields are updated by the
// manager as events arrive and are served in snapshots.
type Watch struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	FileID      string `json:"fileId"`
	RelPath     string `json:"relPath"`
	AbsPath     string `json:"absPath"`
	Symbol      string `json:"symbol"`
	LineStart   int    `json:"lineStart"`
	LineEnd     int    `json:"lineEnd"`
	CreatedAt   int64  `json:"createdAt"`

	CallCount   int64           `json:"callCount"`
	LastArgs    json.RawMessage `json:"lastArgs,omitempty"`
	LastReturn  json.RawMessage `json:"lastReturn,omitempty"`
	LastError   string          `json:"lastError,omitempty"`
	LastCallAt  int64           `json:"lastCallAt,omitempty"`
	RateLimited bool            `json:"rateLimited"`
}

// AdapterEvent is the normalized runtime event schema shared by every
// language adapter.
type AdapterEvent struct {
	Kind          string          `json:"kind"` // 'call'|'return'|'exception'|'rate_limit'
	WatchID       string          `json:"watchId"`
	TraceID       string          `json:"traceId,omitempty"`
	ParentTraceID string          `json:"parentTraceId,omitempty"`
	ThreadID      string          `json:"threadId,omitempty"`
	TS            int64           `json:"ts"` // unix ms, adapter clock
	Args          json.RawMessage `json:"args,omitempty"`
	ReturnValue   json.RawMessage `json:"returnValue,omitempty"`
	DurationMs    float64         `json:"durationMs,omitempty"`
	ExcType       string          `json:"excType,omitempty"`
	Message       string          `json:"message,omitempty"`
	// Perturbation fields (inject_* events, plus injectId stamped on
	// call/return/exception events inside a perturbed subtree):
	InjectID string          `json:"injectId,omitempty"`
	Original json.RawMessage `json:"original,omitempty"`
	Injected json.RawMessage `json:"injected,omitempty"`
}

// Event is an AdapterEvent enriched with graph identity, as stored in the
// ring buffer and broadcast to the canvas.
type Event struct {
	AdapterEvent
	SessionID   string `json:"sessionId"`
	WorkspaceID string `json:"workspaceId"`
	FileID      string `json:"fileId"`
	RelPath     string `json:"relPath"`
	Symbol      string `json:"symbol"`
	CallCount   int64  `json:"callCount"`
}

type adapterMsg struct {
	Type           string        `json:"type"`
	Language       string        `json:"language,omitempty"`
	PID            int           `json:"pid,omitempty"`
	WorkspaceID    string        `json:"workspaceId,omitempty"`
	Cwd            string        `json:"cwd,omitempty"`
	RuntimeVersion string        `json:"runtimeVersion,omitempty"`
	Event          *AdapterEvent `json:"event,omitempty"`
}

// Session is one connected adapter (= one target process).
type Session struct {
	ID             string `json:"id"`
	WorkspaceID    string `json:"workspaceId"`
	Language       string `json:"language"`
	PID            int    `json:"pid"`
	RuntimeVersion string `json:"runtimeVersion"`
	Cwd            string `json:"cwd"`
	ConnectedAt    int64  `json:"connectedAt"`

	conn     net.Conn
	writeMu  sync.Mutex
	lastSeen time.Time
}

func (s *Session) send(v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, err = s.conn.Write(append(raw, '\n'))
	return err
}

// ─── Manager ──────────────────────────────────────────────────────────────────

const (
	eventBufferCap   = 5000
	sessionStaleTime = 30 * time.Second
	// helloDeadline bounds how long a fresh connection may sit silent before
	// identifying itself - otherwise a hung client leaks the goroutine+socket
	// forever (pruneLoop only sees registered sessions).
	helloDeadline = 15 * time.Second
	// readDeadline is rolled forward on every message; adapters heartbeat
	// every 5s, so a healthy connection never trips it.
	readDeadline = 30 * time.Second
	// maxLineBytes bounds a single NDJSON line from an adapter (serialized
	// args are already truncated adapter-side; this is a hard backstop).
	maxLineBytes = 1 << 20
)

// Manager owns adapter sessions, the watch registry, and the runtime event
// ring buffer.
type Manager struct {
	mu             sync.RWMutex
	hub            *hub.Hub
	port           int
	sessions       map[string]*Session
	delveSessions  map[string]*DelveSession
	dotnetSessions map[string]*DotnetSession
	langSessions   map[string]*dapLangSession
	watches        map[string]*Watch
	injects        map[string]*Inject
	events         []Event // ring buffer
	eventPos       int
	targets        map[string]*Target

	// autoConfirm skips the user's warn-and-confirm step for injections
	// (AXIOM_AUTO_CONFIRM_INJECT=1; headless/test use only).
	autoConfirm bool

	// resolveWorkspace maps a target process cwd to a workspace ID when the
	// adapter did not receive AXIOM_WORKSPACE_ID (e.g. user started the app
	// themselves with only PYTHONPATH set). Provided by the api package.
	resolveWorkspace func(cwd string) string

	// Investigation Capture (Phase 8): the hub tap records live events into the
	// workspace's active investigation. Guarded by its own mutex so recording
	// never contends with the main runtime state lock.
	captureMu            sync.Mutex
	activeInvestigations map[string]*Investigation
}

func NewManager(h *hub.Hub) *Manager {
	m := &Manager{
		hub:                  h,
		sessions:             make(map[string]*Session),
		delveSessions:        make(map[string]*DelveSession),
		dotnetSessions:       make(map[string]*DotnetSession),
		langSessions:         make(map[string]*dapLangSession),
		watches:              make(map[string]*Watch),
		injects:              make(map[string]*Inject),
		events:               make([]Event, 0, eventBufferCap),
		targets:              make(map[string]*Target),
		activeInvestigations: make(map[string]*Investigation),
	}
	h.SetTap(m.recordTap) // capture the live event stream for investigations
	return m
}

func (m *Manager) SetWorkspaceResolver(fn func(cwd string) string) {
	m.mu.Lock()
	m.resolveWorkspace = fn
	m.mu.Unlock()
}

// Port returns the TCP port the manager is listening on (0 before Listen).
func (m *Manager) Port() int { return m.port }

// Listen starts the adapter TCP server and background session pruning.
func (m *Manager) Listen(port int) error {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return fmt.Errorf("runtime: listen on %d: %w", port, err)
	}
	m.port = ln.Addr().(*net.TCPAddr).Port
	log.Printf("runtime: adapter server listening on 127.0.0.1:%d", m.port)

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				log.Printf("runtime: accept: %v", err)
				return
			}
			go m.handleConn(conn)
		}
	}()
	go m.pruneLoop()
	return nil
}

func (m *Manager) pruneLoop() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		m.mu.Lock()
		var stale []*Session
		for _, s := range m.sessions {
			if time.Since(s.lastSeen) > sessionStaleTime {
				stale = append(stale, s)
			}
		}
		m.mu.Unlock()
		for _, s := range stale {
			log.Printf("runtime: session %s (%s pid %d) stale - closing", s.ID, s.Language, s.PID)
			s.conn.Close() // handleConn's read loop unwinds and removes it
		}
	}
}

func (m *Manager) handleConn(conn net.Conn) {
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 64*1024), maxLineBytes)
	conn.SetReadDeadline(time.Now().Add(helloDeadline))

	var sess *Session
	defer func() {
		conn.Close()
		if sess != nil {
			m.mu.Lock()
			delete(m.sessions, sess.ID)
			m.mu.Unlock()
			m.hub.Broadcast("runtime:session", map[string]any{
				"workspaceId": sess.WorkspaceID,
				"session":     sess,
				"status":      "disconnected",
			})
			log.Printf("runtime: session %s disconnected", sess.ID)
		}
	}()

	for scanner.Scan() {
		conn.SetReadDeadline(time.Now().Add(readDeadline))
		var msg adapterMsg
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			log.Printf("runtime: bad message from adapter: %v", err)
			continue
		}

		switch msg.Type {
		case "hello":
			sess = m.registerSession(conn, msg)

		case "heartbeat":
			if sess != nil {
				m.mu.Lock()
				sess.lastSeen = time.Now()
				m.mu.Unlock()
			}

		case "event":
			if sess != nil && msg.Event != nil {
				m.mu.Lock()
				sess.lastSeen = time.Now()
				m.mu.Unlock()
				m.handleEvent(sess, *msg.Event)
			}

		default:
			log.Printf("runtime: unknown adapter message type %q", msg.Type)
		}
	}
}

func (m *Manager) registerSession(conn net.Conn, msg adapterMsg) *Session {
	workspaceID := msg.WorkspaceID
	m.mu.RLock()
	resolver := m.resolveWorkspace
	m.mu.RUnlock()
	if workspaceID == "" && resolver != nil {
		workspaceID = resolver(msg.Cwd)
	}

	sess := &Session{
		ID:             uuid.New().String(),
		WorkspaceID:    workspaceID,
		Language:       msg.Language,
		PID:            msg.PID,
		RuntimeVersion: msg.RuntimeVersion,
		Cwd:            msg.Cwd,
		ConnectedAt:    time.Now().UnixMilli(),
		conn:           conn,
		lastSeen:       time.Now(),
	}
	m.mu.Lock()
	m.sessions[sess.ID] = sess
	watches := m.watchesForLocked(workspaceID)
	m.mu.Unlock()

	if err := sess.send(map[string]any{
		"type":      "hello_ack",
		"sessionId": sess.ID,
		"watches":   watches,
	}); err != nil {
		log.Printf("runtime: hello_ack to %s: %v", sess.ID, err)
	}
	m.hub.Broadcast("runtime:session", map[string]any{
		"workspaceId": workspaceID,
		"session":     sess,
		"status":      "connected",
	})
	log.Printf("runtime: session %s connected (%s pid %d, workspace %s)",
		sess.ID, msg.Language, msg.PID, workspaceID)
	return sess
}

func (m *Manager) handleEvent(sess *Session, ae AdapterEvent) {
	switch ae.Kind {
	case "inject_armed", "inject_fired", "inject_removed", "inject_error":
		m.handleInjectEvent(sess, ae)
		return
	}
	m.RecordWatchEvent(sess.ID, ae)
}

// RecordWatchEvent updates watch stats, appends to the ring buffer, and
// broadcasts a runtime:<kind> event. Shared by the in-process adapter path
// (TCP) and the delve DAP path - both produce the same normalized events.
func (m *Manager) RecordWatchEvent(sessionID string, ae AdapterEvent) {
	m.mu.Lock()
	w, ok := m.watches[ae.WatchID]
	if !ok {
		m.mu.Unlock()
		return // watch was removed; late event
	}
	switch ae.Kind {
	case "call":
		w.CallCount++
		w.LastCallAt = ae.TS
		if len(ae.Args) > 0 {
			w.LastArgs = ae.Args
		}
	case "return":
		if len(ae.ReturnValue) > 0 {
			w.LastReturn = ae.ReturnValue
		}
	case "exception":
		w.LastError = ae.ExcType + ": " + ae.Message
	case "rate_limit":
		w.RateLimited = true
	}
	ev := Event{
		AdapterEvent: ae,
		SessionID:    sessionID,
		WorkspaceID:  w.WorkspaceID,
		FileID:       w.FileID,
		RelPath:      w.RelPath,
		Symbol:       w.Symbol,
		CallCount:    w.CallCount,
	}
	m.appendEventLocked(ev)
	m.mu.Unlock()

	m.hub.Broadcast("runtime:"+ae.Kind, ev)
}

// WatchesForFunctions returns the workspace's watches indexed by symbol name,
// for the delve session to translate function-breakpoint hits into watch IDs.
func (m *Manager) WatchesForWorkspace(workspaceID string) []Watch {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.watchesForLocked(workspaceID)
}

func (m *Manager) appendEventLocked(ev Event) {
	if len(m.events) < eventBufferCap {
		m.events = append(m.events, ev)
		return
	}
	m.events[m.eventPos] = ev
	m.eventPos = (m.eventPos + 1) % eventBufferCap
}

// recentEventsLocked returns up to n most-recent events for a workspace, oldest first.
func (m *Manager) recentEventsLocked(workspaceID string, n int) []Event {
	ordered := make([]Event, 0, len(m.events))
	// Ring order: eventPos..end is the older half once the buffer has wrapped.
	ordered = append(ordered, m.events[m.eventPos:]...)
	ordered = append(ordered, m.events[:m.eventPos]...)
	out := make([]Event, 0, n)
	for i := len(ordered) - 1; i >= 0 && len(out) < n; i-- {
		if ordered[i].WorkspaceID == workspaceID {
			out = append(out, ordered[i])
		}
	}
	// reverse to oldest-first
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

// ─── Watch registry ───────────────────────────────────────────────────────────

// AddWatch registers a watch and pushes it to every connected session in the
// same workspace. Returns the number of sessions notified.
func (m *Manager) AddWatch(w *Watch) int {
	if w.ID == "" {
		w.ID = uuid.New().String()
	}
	w.CreatedAt = time.Now().UnixMilli()

	m.mu.Lock()
	// Replace an existing watch on the same function rather than duplicating.
	for id, existing := range m.watches {
		if existing.WorkspaceID == w.WorkspaceID && existing.FileID == w.FileID && existing.Symbol == w.Symbol {
			delete(m.watches, id)
		}
	}
	m.watches[w.ID] = w
	sessions := m.sessionsForLocked(w.WorkspaceID)
	wCopy := *w // marshal a copy - the live struct is mutated under m.mu by handleEvent
	m.mu.Unlock()

	// Send asynchronously: a hung session's 5s write timeout must not stack up
	// and block the HTTP request goroutine.
	for _, s := range sessions {
		go m.sendOrDrop(s, map[string]any{"type": "watch", "watch": wCopy})
	}
	m.hub.Broadcast("runtime:watch", map[string]any{
		"workspaceId": w.WorkspaceID,
		"watch":       wCopy,
	})
	return len(sessions)
}

// sendOrDrop sends to a session and closes the connection on failure so its
// read loop unwinds immediately instead of waiting for the stale prune.
func (m *Manager) sendOrDrop(s *Session, v any) {
	if err := s.send(v); err != nil {
		log.Printf("runtime: send to session %s failed (%v) - closing", s.ID, err)
		s.conn.Close()
	}
}

// RemoveWatch removes a watch by ID, or by (fileID, symbol) when id is empty.
// Returns the removed watch, or nil if none matched.
func (m *Manager) RemoveWatch(workspaceID, id, fileID, symbol string) *Watch {
	m.mu.Lock()
	var found *Watch
	for wid, w := range m.watches {
		if w.WorkspaceID != workspaceID {
			continue
		}
		if (id != "" && wid == id) || (id == "" && w.FileID == fileID && w.Symbol == symbol) {
			found = w
			delete(m.watches, wid)
			break
		}
	}
	var sessions []*Session
	if found != nil {
		sessions = m.sessionsForLocked(workspaceID)
	}
	m.mu.Unlock()

	if found == nil {
		return nil
	}
	for _, s := range sessions {
		go m.sendOrDrop(s, map[string]any{"type": "unwatch", "watchId": found.ID})
	}
	m.hub.Broadcast("runtime:unwatch", map[string]any{
		"workspaceId": workspaceID,
		"watch":       found,
	})
	return found
}

// watchesForLocked returns value copies - callers marshal them after the
// lock is released.
func (m *Manager) watchesForLocked(workspaceID string) []Watch {
	out := make([]Watch, 0)
	for _, w := range m.watches {
		if w.WorkspaceID == workspaceID {
			out = append(out, *w)
		}
	}
	return out
}

func (m *Manager) sessionsForLocked(workspaceID string) []*Session {
	out := make([]*Session, 0)
	for _, s := range m.sessions {
		if s.WorkspaceID == workspaceID {
			out = append(out, s)
		}
	}
	return out
}

// Snapshot returns the current runtime state for a workspace: connected
// sessions, active watches with live stats, launched targets, and the most
// recent events. Everything is deep-copied under the lock - the caller JSON-
// encodes without holding it, while handleEvent keeps mutating the originals.
func (m *Manager) Snapshot(workspaceID string) map[string]any {
	m.mu.RLock()
	defer m.mu.RUnlock()

	watches := make([]Watch, 0)
	for _, w := range m.watches {
		if w.WorkspaceID == workspaceID {
			watches = append(watches, *w)
		}
	}
	sessions := make([]map[string]any, 0)
	for _, s := range m.sessions {
		if s.WorkspaceID == workspaceID {
			sessions = append(sessions, map[string]any{
				"id":             s.ID,
				"workspaceId":    s.WorkspaceID,
				"language":       s.Language,
				"pid":            s.PID,
				"runtimeVersion": s.RuntimeVersion,
				"cwd":            s.Cwd,
				"connectedAt":    s.ConnectedAt,
			})
		}
	}
	// delve-traced Go sessions appear alongside in-process adapter sessions.
	for _, ds := range m.delveSessions {
		if ds.WorkspaceID == workspaceID {
			sessions = append(sessions, ds.dto())
		}
	}
	// netcoredbg-traced .NET sessions likewise.
	for _, ns := range m.dotnetSessions {
		if ns.WorkspaceID == workspaceID {
			sessions = append(sessions, ns.dto())
		}
	}
	// config-driven DAP language sessions (C++, Ruby, Java).
	for _, ls := range m.langSessions {
		if ls.WorkspaceID == workspaceID {
			sessions = append(sessions, ls.dto())
		}
	}
	targets := make([]map[string]any, 0)
	for _, t := range m.targets {
		if t.WorkspaceID == workspaceID {
			targets = append(targets, t.snapshotLocked())
		}
	}
	return map[string]any{
		"sessions":     sessions,
		"watches":      watches,
		"injections":   m.injectsForLocked(workspaceID),
		"targets":      targets,
		"recentEvents": m.recentEventsLocked(workspaceID, 50),
	}
}
