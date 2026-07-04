// Go runtime tracing via delve (Phase 3 spike).
//
// Unlike the Python adapter (in-process sys.monitoring streaming INTO archd),
// Go tracing inverts the flow: archd spawns `dlv dap` and acts as a DAP CLIENT,
// setting function breakpoints on watched symbols. On each breakpoint hit it
// reads the goroutine (DAP threadId) + arguments, emits a normalized `call`
// event (identical schema to the Python path), and resumes.
//
// Empirically established constraints (see RUNTIME_LAYER_PLAN Phase 3 / the
// spike findings): this is INSPECTION MODE — every hit stops the whole process,
// so it is only viable at low call rates. Call events only (no return/duration
// under concurrency). Per-goroutine attribution works; parent→child stitching
// is impossible without instrumentation, so traceId is the goroutine id and
// parentTraceId is always empty.
package runtime

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// DelveSession is one delve-traced Go target owned by archd.
type DelveSession struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	Language    string `json:"language"`
	Program     string `json:"program"`
	Mode        string `json:"mode"` // "exec" (prebuilt binary) | "debug" (compile pkg)
	PID         int    `json:"pid"`
	ConnectedAt int64  `json:"connectedAt"`
	Status      string `json:"status"` // starting|running|exited|error
	Error       string `json:"error,omitempty"`

	mgr       *Manager
	dlvCmd    *exec.Cmd
	client    *dapClient
	args      []string          // target program arguments (passed to delve launch)
	funcToID  map[string]string // "main.processData" → watchId
	fileBySym map[string]string // symbol → relPath (for event enrichment fallback)

	mu         sync.Mutex // guards the mutable fields below
	hitCount   int64
	latencySum float64 // sum of stop→continue round trips (ms)
}

// dapVariable / dapScope / dapStackFrame mirror the DAP response bodies we read.
type dapStackResp struct {
	StackFrames []struct {
		ID     int    `json:"id"`
		Name   string `json:"name"`
		Line   int    `json:"line"`
		Source struct {
			Path string `json:"path"`
			Name string `json:"name"`
		} `json:"source"`
	} `json:"stackFrames"`
}

type dapScopesResp struct {
	Scopes []struct {
		Name               string `json:"name"`
		VariablesReference int    `json:"variablesReference"`
	} `json:"scopes"`
}

type dapVariablesResp struct {
	Variables []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
		Type  string `json:"type"`
	} `json:"variables"`
}

type dapStoppedBody struct {
	Reason            string `json:"reason"`
	ThreadID          int    `json:"threadId"`
	AllThreadsStopped bool   `json:"allThreadsStopped"`
	Description       string `json:"description"` // e.g. rdbg: "BP - Line app.rb:9 (call)"
}

// LaunchGoTarget starts a delve-traced Go process. `program` is a prebuilt
// binary (mode exec) or a package directory / .go file (mode debug). Function
// breakpoints are derived from the workspace's current watches.
func (m *Manager) LaunchGoTarget(workspaceID, program string, args []string) (*DelveSession, error) {
	dlvPath, err := findDelve()
	if err != nil {
		return nil, err
	}
	mode := "debug"
	if strings.HasSuffix(strings.ToLower(program), ".exe") {
		mode = "exec"
	}

	watches := m.WatchesForWorkspace(workspaceID)
	funcToID := make(map[string]string)
	fileBySym := make(map[string]string)
	for _, w := range watches {
		funcToID[qualifyGoFunc(w.Symbol)] = w.ID
		fileBySym[w.Symbol] = w.RelPath
	}

	sess := &DelveSession{
		ID:          uuid.New().String(),
		WorkspaceID: workspaceID,
		Language:    "go",
		Program:     program,
		Mode:        mode,
		ConnectedAt: time.Now().UnixMilli(),
		Status:      "starting",
		mgr:         m,
		args:        args,
		funcToID:    funcToID,
		fileBySym:   fileBySym,
	}

	if err := sess.start(dlvPath); err != nil {
		sess.Status = "error"
		sess.Error = err.Error()
		return sess, err
	}

	m.mu.Lock()
	m.delveSessions[sess.ID] = sess
	m.mu.Unlock()

	m.hub.Broadcast("runtime:session", map[string]any{
		"workspaceId": workspaceID,
		"session":     sess.dto(),
		"status":      "connected",
	})
	return sess, nil
}

func (s *DelveSession) start(dlvPath string) error {
	port, err := freeTCPPort()
	if err != nil {
		return err
	}
	addr := fmt.Sprintf("127.0.0.1:%d", port)

	cmd := exec.Command(dlvPath, "dap", "--listen", addr)
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start dlv dap: %w", err)
	}
	s.dlvCmd = cmd

	conn, err := dialWithRetry(addr, 5*time.Second)
	if err != nil {
		killAndReap(cmd)
		return fmt.Errorf("connect to dlv dap: %w", err)
	}
	s.client = newDAPClientConn(conn)

	if err := s.handshake(); err != nil {
		s.client.close()
		killAndReap(cmd)
		return err
	}
	s.setStatus("running")
	go s.eventLoop()
	go func() {
		cmd.Wait() // reap the dlv process once it exits
		s.finish("exited")
	}()
	return nil
}

func (s *DelveSession) setStatus(status string) {
	s.mu.Lock()
	s.Status = status
	s.mu.Unlock()
}

func (s *DelveSession) handshake() error {
	if _, err := s.client.request("initialize", map[string]any{
		"clientID":        "axiom",
		"adapterID":       "go",
		"linesStartAt1":   true,
		"columnsStartAt1": true,
		"pathFormat":      "path",
	}); err != nil {
		return err
	}

	launchArgs := map[string]any{
		"request":     "launch",
		"mode":        s.Mode,
		"program":     s.Program,
		"stopOnEntry": false,
	}
	if len(s.args) > 0 {
		launchArgs["args"] = s.args
	}
	// launch response only arrives after configuration completes on some
	// adapters; delve responds promptly, and emits an "initialized" event.
	launchDone := make(chan error, 1)
	go func() {
		_, err := s.client.request("launch", launchArgs)
		launchDone <- err
	}()

	// Wait for the "initialized" event, then send breakpoints + configurationDone.
	if err := s.waitForInitialized(); err != nil {
		return err
	}
	if err := s.setBreakpoints(); err != nil {
		return err
	}
	if _, err := s.client.request("configurationDone", map[string]any{}); err != nil {
		return err
	}
	select {
	case err := <-launchDone:
		if err != nil {
			return err
		}
	case <-time.After(20 * time.Second):
		return fmt.Errorf("launch did not complete")
	}
	if s.dlvCmd.Process != nil {
		s.mu.Lock()
		s.PID = s.dlvCmd.Process.Pid
		s.mu.Unlock()
	}
	return nil
}

func (s *DelveSession) waitForInitialized() error {
	for {
		select {
		case ev := <-s.client.events:
			if ev.Event == "initialized" {
				return nil
			}
			// Buffer other early events (e.g. output) — harmless to drop for the spike.
		case <-time.After(20 * time.Second):
			return fmt.Errorf("no initialized event from dlv")
		case <-s.client.closed:
			return fmt.Errorf("dlv closed before initialized")
		}
	}
}

func (s *DelveSession) setBreakpoints() error {
	names := make([]map[string]any, 0, len(s.funcToID))
	for fn := range s.funcToID {
		names = append(names, map[string]any{"name": fn})
	}
	if len(names) == 0 {
		log.Printf("delve: session %s has no watches — no breakpoints set", s.ID)
		return nil
	}
	_, err := s.client.request("setFunctionBreakpoints", map[string]any{
		"breakpoints": names,
	})
	if err != nil {
		return fmt.Errorf("setFunctionBreakpoints: %w", err)
	}
	log.Printf("delve: session %s set %d function breakpoint(s)", s.ID, len(names))
	return nil
}

func (s *DelveSession) eventLoop() {
	for {
		select {
		case ev, ok := <-s.client.events:
			if !ok {
				return
			}
			switch ev.Event {
			case "stopped":
				// Run inspection off the event loop so readLoop is never
				// blocked waiting for us to drain c.events (which would in turn
				// stall the DAP responses our inspect() requests need — a
				// circular wait). Only one goroutine is ever stopped at a time
				// (the process is frozen until we `continue`), so there is no
				// concurrent second stop to race with.
				go s.handleStopped(ev.Body)
			case "terminated", "exited":
				s.finish("exited")
				return
			}
		case <-s.client.closed:
			s.finish("exited")
			return
		}
	}
}

func (s *DelveSession) handleStopped(body json.RawMessage) {
	start := time.Now()
	var st dapStoppedBody
	if err := json.Unmarshal(body, &st); err != nil {
		return
	}
	// Only breakpoint stops are function-entry hits we care about.
	if !strings.Contains(st.Reason, "breakpoint") {
		// Resume anything else (pause, step) so the process never wedges.
		s.client.request("continue", map[string]any{"threadId": st.ThreadID})
		return
	}

	goroutineID := st.ThreadID
	symbol, relPath, args := s.inspect(st.ThreadID)
	watchID := s.funcToID[symbol]

	// Resume immediately after inspection — minimize the stop-the-world window.
	roundTrip := float64(time.Since(start).Microseconds()) / 1000.0
	s.client.request("continue", map[string]any{"threadId": st.ThreadID})

	if watchID == "" {
		return // breakpoint we didn't map (shouldn't happen) — nothing to emit
	}
	s.mu.Lock()
	s.hitCount++
	s.latencySum += roundTrip
	s.mu.Unlock()

	ae := AdapterEvent{
		Kind:       "call",
		WatchID:    watchID,
		TraceID:    fmt.Sprintf("g%d", goroutineID), // goroutine id; no parent stitching
		ThreadID:   fmt.Sprintf("goroutine-%d", goroutineID),
		TS:         time.Now().UnixMilli(),
		Args:       args,
		DurationMs: roundTrip, // stop→continue inspection cost, the spike's key metric
	}
	_ = relPath
	s.mgr.RecordWatchEvent(s.ID, ae)
}

// inspect reads the top stack frame's function name and arguments for the
// stopped goroutine. Must complete before `continue` (state is frozen only
// while stopped). Returns (qualifiedSymbol, relPath, argsJSON).
func (s *DelveSession) inspect(threadID int) (string, string, json.RawMessage) {
	resp, err := s.client.request("stackTrace", map[string]any{
		"threadId":   threadID,
		"startFrame": 0,
		"levels":     1,
	})
	if err != nil {
		return "", "", nil
	}
	var st dapStackResp
	if err := json.Unmarshal(resp.Body, &st); err != nil || len(st.StackFrames) == 0 {
		return "", "", nil
	}
	frame := st.StackFrames[0]
	symbol := normalizeGoFrameName(frame.Name)

	scopesResp, err := s.client.request("scopes", map[string]any{"frameId": frame.ID})
	if err != nil {
		return symbol, frame.Source.Name, nil
	}
	var scopes dapScopesResp
	json.Unmarshal(scopesResp.Body, &scopes)

	argsRef := 0
	for _, sc := range scopes.Scopes {
		if strings.EqualFold(sc.Name, "Arguments") {
			argsRef = sc.VariablesReference
			break
		}
	}
	// Fall back to the first scope with variables (delve names the local scope
	// "Locals" and includes arguments there in some versions).
	if argsRef == 0 {
		for _, sc := range scopes.Scopes {
			if sc.VariablesReference != 0 {
				argsRef = sc.VariablesReference
				break
			}
		}
	}
	if os.Getenv("AXIOM_DLV_DEBUG") == "1" {
		names := make([]string, 0)
		for _, sc := range scopes.Scopes {
			names = append(names, fmt.Sprintf("%s(ref=%d)", sc.Name, sc.VariablesReference))
		}
		log.Printf("delve: frame=%q scopes=%v argsRef=%d", frame.Name, names, argsRef)
	}
	if argsRef == 0 {
		return symbol, frame.Source.Name, nil
	}
	varsResp, err := s.client.request("variables", map[string]any{"variablesReference": argsRef})
	if err != nil {
		return symbol, frame.Source.Name, nil
	}
	var vars dapVariablesResp
	json.Unmarshal(varsResp.Body, &vars)

	args := make(map[string]map[string]string, len(vars.Variables))
	for _, v := range vars.Variables {
		// Skip delve's synthetic return-value slots (~r0, ~r1, …).
		if strings.HasPrefix(v.Name, "~") {
			continue
		}
		val := v.Value
		if len(val) > 256 {
			val = val[:255] + "…"
		}
		args[v.Name] = map[string]string{"type": v.Type, "value": val}
	}
	argsJSON, _ := json.Marshal(args)
	return symbol, frame.Source.Name, argsJSON
}

func (s *DelveSession) finish(status string) {
	s.mu.Lock()
	if s.Status == "exited" {
		s.mu.Unlock()
		return // already finished
	}
	s.Status = status
	hits, avg := s.hitCount, 0.0
	if s.hitCount > 0 {
		avg = s.latencySum / float64(s.hitCount)
	}
	s.mu.Unlock()

	if s.client != nil {
		s.client.close()
	}
	if s.dlvCmd != nil && s.dlvCmd.Process != nil {
		s.dlvCmd.Process.Kill()
	}
	// Drop the session from the registry so it doesn't accumulate forever.
	s.mgr.mu.Lock()
	delete(s.mgr.delveSessions, s.ID)
	s.mgr.mu.Unlock()

	log.Printf("delve: session %s %s — %d breakpoint hits, avg stop→continue %.1fms",
		s.ID, status, hits, avg)
	s.mgr.hub.Broadcast("runtime:session", map[string]any{
		"workspaceId": s.WorkspaceID,
		"session":     s.dto(),
		"status":      "disconnected",
	})
}

// StopGoTarget kills a delve session.
func (m *Manager) StopGoTarget(sessionID string) (*DelveSession, error) {
	m.mu.RLock()
	s, ok := m.delveSessions[sessionID]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("delve session %s not found", sessionID)
	}
	s.finish("exited")
	return s, nil
}

func (s *DelveSession) dto() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	avg := 0.0
	if s.hitCount > 0 {
		avg = s.latencySum / float64(s.hitCount)
	}
	return map[string]any{
		"id":             s.ID,
		"workspaceId":    s.WorkspaceID,
		"language":       s.Language,
		"program":        s.Program,
		"mode":           s.Mode,
		"pid":            s.PID,
		"connectedAt":    s.ConnectedAt,
		"status":         s.Status,
		"error":          s.Error,
		"hitCount":       s.hitCount,
		"avgLatencyMs":   avg,
		"runtimeVersion": "delve",
	}
}

// ─── helpers ──────────────────────────────────────────────────────────────────

// qualifyGoFunc turns a bare symbol into a delve breakpoint name. Unqualified
// names are assumed to be in package main (the spike demo); already-qualified
// names (containing a dot) pass through.
func qualifyGoFunc(symbol string) string {
	if strings.Contains(symbol, ".") {
		return symbol
	}
	return "main." + symbol
}

// normalizeGoFrameName reduces a delve frame name to the qualified func name.
func normalizeGoFrameName(name string) string {
	// delve frame names look like "main.processData" already; strip any suffix.
	if i := strings.Index(name, " "); i >= 0 {
		name = name[:i]
	}
	return name
}

// killAndReap kills a started process and reaps its exit status in the
// background so a failed launch never leaves a zombie / leaked handle.
func killAndReap(cmd *exec.Cmd) {
	if cmd.Process != nil {
		cmd.Process.Kill()
	}
	go cmd.Wait()
}

func findDelve() (string, error) {
	if p := os.Getenv("AXIOM_DLV_PATH"); p != "" {
		return p, nil
	}
	if p, err := exec.LookPath("dlv"); err == nil {
		return p, nil
	}
	if home, err := os.UserHomeDir(); err == nil {
		cand := filepath.Join(home, "go", "bin", "dlv")
		if _, err := os.Stat(cand); err == nil {
			return cand, nil
		}
		if _, err := os.Stat(cand + ".exe"); err == nil {
			return cand + ".exe", nil
		}
	}
	return "", fmt.Errorf("delve (dlv) not found — install with: go install github.com/go-delve/delve/cmd/dlv@latest, or set AXIOM_DLV_PATH")
}

func freeTCPPort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port, nil
}

func dialWithRetry(addr string, timeout time.Duration) (net.Conn, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn, err := net.Dial("tcp", addr)
		if err == nil {
			return conn, nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return nil, fmt.Errorf("could not connect to %s within %s", addr, timeout)
}
