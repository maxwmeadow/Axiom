// C#/.NET runtime tracing via netcoredbg (plan Phase 9, general .NET — not Unity).
//
// Mirrors the delve integration: archd is a DAP CLIENT connecting to
// `netcoredbg --interpreter=vscode --server=PORT`, over the same TCP DAP
// client. Same empirically-established constraints as Go (see Phase 3): DAP
// breakpoints are BLOCKING (CoreCLR suspends all managed threads on a hit), so
// this is INSPECTION MODE only — low-frequency watches, call events only (no
// return events; step-out under the thread pool is a freeze/deadlock trap).
//
// Unlike Go, C# watches bind by SOURCE (file:line) rather than function name:
// netcoredbg function breakpoints require fully-qualified `Namespace.Class.Method`
// (which the bare tree-sitter symbol index lacks) and leave generic methods
// permanently pending. Source breakpoints at the symbol's start line bind via
// the PDB, sidestepping both problems. Synchronous methods yield clean argument
// values; async methods lift args into state-machine fields (documented limit).
package runtime

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// DotnetSession is one netcoredbg-traced .NET target owned by archd.
type DotnetSession struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	Language    string `json:"language"`
	Program     string `json:"program"` // path to the built managed assembly (.dll)
	PID         int    `json:"pid"`
	ConnectedAt int64  `json:"connectedAt"`
	Status      string `json:"status"` // starting|running|exited|error
	Error       string `json:"error,omitempty"`

	mgr     *Manager
	dbgCmd  *exec.Cmd
	client  *dapClient
	args    []string
	watches []Watch // resolved watches; matched to stops by file+line range

	mu         sync.Mutex
	hitCount   int64
	latencySum float64
}

// LaunchDotnetTarget starts a netcoredbg-traced .NET process. `program` is a
// prebuilt managed assembly (app.dll with its .pdb). Breakpoints are derived
// from the workspace's current watches.
func (m *Manager) LaunchDotnetTarget(workspaceID, program string, args []string) (*DotnetSession, error) {
	dbgPath, err := findNetcoredbg()
	if err != nil {
		return nil, err
	}
	sess := &DotnetSession{
		ID:          uuid.New().String(),
		WorkspaceID: workspaceID,
		Language:    "csharp",
		Program:     program,
		ConnectedAt: time.Now().UnixMilli(),
		Status:      "starting",
		mgr:         m,
		args:        args,
		watches:     m.WatchesForWorkspace(workspaceID),
	}
	if err := sess.start(dbgPath); err != nil {
		sess.Status = "error"
		sess.Error = err.Error()
		return sess, err
	}
	m.mu.Lock()
	m.dotnetSessions[sess.ID] = sess
	m.mu.Unlock()
	m.hub.Broadcast("runtime:session", map[string]any{
		"workspaceId": workspaceID,
		"session":     sess.dto(),
		"status":      "connected",
	})
	return sess, nil
}

func (s *DotnetSession) start(dbgPath string) error {
	// Drive netcoredbg over stdio (the transport VS Code uses). Its TCP
	// --server mode resets connections unreliably on Windows, so stdio is the
	// dependable path.
	cmd := exec.Command(dbgPath, "--interpreter=vscode")
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start netcoredbg: %w", err)
	}
	s.dbgCmd = cmd

	// Closing tears down the pipe and the process.
	s.client = newDAPClient(stdout, stdin, func() error {
		stdin.Close()
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
		return nil
	})

	if err := s.handshake(); err != nil {
		s.client.close()
		killAndReap(cmd)
		return err
	}
	s.setStatus("running")
	go s.eventLoop()
	go func() {
		cmd.Wait()
		s.finish("exited")
	}()
	return nil
}

func (s *DotnetSession) setStatus(status string) {
	s.mu.Lock()
	s.Status = status
	s.mu.Unlock()
}

func (s *DotnetSession) handshake() error {
	if _, err := s.client.request("initialize", map[string]any{
		"clientID":        "axiom",
		"adapterID":       "coreclr",
		"linesStartAt1":   true,
		"columnsStartAt1": true,
		"pathFormat":      "path",
	}); err != nil {
		return err
	}

	launchArgs := map[string]any{
		"type":        "coreclr",
		"request":     "launch",
		"program":     s.Program,
		"cwd":         filepath.Dir(s.Program),
		"stopAtEntry": false,
		"justMyCode":  false, // allow breakpoints outside "my code" heuristics
	}
	if len(s.args) > 0 {
		launchArgs["args"] = s.args
	}
	launchDone := make(chan error, 1)
	go func() {
		_, err := s.client.request("launch", launchArgs)
		launchDone <- err
	}()

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
	case <-time.After(25 * time.Second):
		return fmt.Errorf("launch did not complete")
	}
	if s.dbgCmd.Process != nil {
		s.mu.Lock()
		s.PID = s.dbgCmd.Process.Pid
		s.mu.Unlock()
	}
	return nil
}

func (s *DotnetSession) waitForInitialized() error {
	// Absolute deadline (not per-iteration) so a chatty pre-init event stream
	// can't defer the timeout forever, and only one timer is allocated.
	deadline := time.NewTimer(25 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case ev := <-s.client.events:
			if ev.Event == "initialized" {
				return nil
			}
		case <-deadline.C:
			return fmt.Errorf("no initialized event from netcoredbg")
		case <-s.client.closed:
			return fmt.Errorf("netcoredbg closed before initialized")
		}
	}
}

// setBreakpoints groups watches by source file and sets a source breakpoint at
// each watched method's start line. netcoredbg moves it to the first executable
// statement of the method during PDB binding.
func (s *DotnetSession) setBreakpoints() error {
	byFile := make(map[string][]Watch)
	for _, w := range s.watches {
		if w.AbsPath == "" {
			continue
		}
		byFile[w.AbsPath] = append(byFile[w.AbsPath], w)
	}
	if len(byFile) == 0 {
		log.Printf("netcoredbg: session %s has no watches — no breakpoints set", s.ID)
		return nil
	}
	total := 0
	for path, ws := range byFile {
		bps := make([]map[string]any, 0, len(ws))
		for _, w := range ws {
			bps = append(bps, map[string]any{"line": w.LineStart})
		}
		if _, err := s.client.request("setBreakpoints", map[string]any{
			"source":      map[string]any{"path": path},
			"breakpoints": bps,
		}); err != nil {
			return fmt.Errorf("setBreakpoints for %s: %w", path, err)
		}
		total += len(bps)
	}
	log.Printf("netcoredbg: session %s set %d source breakpoint(s) across %d file(s)", s.ID, total, len(byFile))
	return nil
}

func (s *DotnetSession) eventLoop() {
	for {
		select {
		case ev, ok := <-s.client.events:
			if !ok {
				return
			}
			switch ev.Event {
			case "stopped":
				go s.handleStopped(ev.Body) // off the event loop; see delve.go rationale
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

func (s *DotnetSession) handleStopped(body json.RawMessage) {
	start := time.Now()
	var st dapStoppedBody
	if err := json.Unmarshal(body, &st); err != nil {
		return
	}
	if !strings.Contains(st.Reason, "breakpoint") {
		// pause / step / entry / exception — resume so the process never wedges.
		s.resume(st.ThreadID)
		return
	}

	watchID, method, args := s.inspect(st.ThreadID)

	roundTrip := float64(time.Since(start).Microseconds()) / 1000.0
	s.resume(st.ThreadID)

	if watchID == "" {
		return // stop we couldn't map to a watch
	}
	s.mu.Lock()
	s.hitCount++
	s.latencySum += roundTrip
	s.mu.Unlock()

	ae := AdapterEvent{
		Kind:       "call",
		WatchID:    watchID,
		TraceID:    fmt.Sprintf("t%d", st.ThreadID),
		ThreadID:   fmt.Sprintf("thread-%d", st.ThreadID),
		TS:         time.Now().UnixMilli(),
		Args:       args,
		DurationMs: roundTrip,
	}
	_ = method
	s.mgr.RecordWatchEvent(s.ID, ae)
}

// resume continues the process after a stop. CoreCLR freezes all managed
// threads on a hit, so a failed continue permanently wedges the target — log
// it loudly rather than swallowing it.
func (s *DotnetSession) resume(threadID int) {
	if _, err := s.client.request("continue", map[string]any{"threadId": threadID}); err != nil {
		log.Printf("netcoredbg: session %s continue failed (target may be frozen): %v", s.ID, err)
	}
}

// inspect reads the top frame for the stopped thread and maps it back to a
// watch by source file + line range. Returns (watchID, method, argsJSON).
func (s *DotnetSession) inspect(threadID int) (string, string, json.RawMessage) {
	resp, err := s.client.request("stackTrace", map[string]any{
		"threadId": threadID, "startFrame": 0, "levels": 1,
	})
	if err != nil {
		return "", "", nil
	}
	var st dapStackResp
	if err := json.Unmarshal(resp.Body, &st); err != nil || len(st.StackFrames) == 0 {
		return "", "", nil
	}
	frame := st.StackFrames[0]
	watchID := s.matchWatch(frame.Source.Path, frame.Line)

	scopesResp, err := s.client.request("scopes", map[string]any{"frameId": frame.ID})
	if err != nil {
		return watchID, frame.Name, nil
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
	// Fall back to the first scope with variables — async methods surface args
	// under Locals (lifted state-machine fields) rather than an Arguments scope.
	if argsRef == 0 {
		for _, sc := range scopes.Scopes {
			if sc.VariablesReference != 0 {
				argsRef = sc.VariablesReference
				break
			}
		}
	}
	if argsRef == 0 {
		return watchID, frame.Name, nil
	}
	varsResp, err := s.client.request("variables", map[string]any{"variablesReference": argsRef})
	if err != nil {
		return watchID, frame.Name, nil
	}
	var vars dapVariablesResp
	json.Unmarshal(varsResp.Body, &vars)

	args := make(map[string]map[string]string, len(vars.Variables))
	for _, v := range vars.Variables {
		if v.Name == "this" || strings.HasPrefix(v.Name, "<") {
			continue // skip receiver and compiler-generated state-machine fields
		}
		args[v.Name] = map[string]string{"type": v.Type, "value": truncateRunes(v.Value, 256)}
	}
	argsJSON, _ := json.Marshal(args)
	return watchID, frame.Name, argsJSON
}

// matchWatch maps a stopped frame's source+line back to the watch whose file
// matches and whose [LineStart, LineEnd] contains the line.
func (s *DotnetSession) matchWatch(framePath string, frameLine int) string {
	if framePath == "" {
		return "" // no source info — don't collide with empty-path watches
	}
	fp := normalizePath(framePath)
	best := ""
	bestSpan := 1 << 30
	for _, w := range s.watches {
		if normalizePath(w.AbsPath) != fp {
			continue
		}
		if frameLine >= w.LineStart && frameLine <= w.LineEnd {
			if span := w.LineEnd - w.LineStart; span < bestSpan {
				best, bestSpan = w.ID, span
			}
		}
	}
	// Fall back: same file, breakpoint moved just past the declaration line.
	if best == "" {
		for _, w := range s.watches {
			if normalizePath(w.AbsPath) == fp && (frameLine == w.LineStart || frameLine == w.LineStart+1) {
				return w.ID
			}
		}
	}
	return best
}

func (s *DotnetSession) finish(status string) {
	s.mu.Lock()
	if s.Status == "exited" {
		s.mu.Unlock()
		return
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
	if s.dbgCmd != nil && s.dbgCmd.Process != nil {
		s.dbgCmd.Process.Kill()
	}
	s.mgr.mu.Lock()
	delete(s.mgr.dotnetSessions, s.ID)
	s.mgr.mu.Unlock()

	log.Printf("netcoredbg: session %s %s — %d breakpoint hits, avg stop→continue %.1fms",
		s.ID, status, hits, avg)
	s.mgr.hub.Broadcast("runtime:session", map[string]any{
		"workspaceId": s.WorkspaceID,
		"session":     s.dto(),
		"status":      "disconnected",
	})
}

// StopDotnetTarget kills a netcoredbg session.
func (m *Manager) StopDotnetTarget(sessionID string) (*DotnetSession, error) {
	m.mu.RLock()
	s, ok := m.dotnetSessions[sessionID]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("dotnet session %s not found", sessionID)
	}
	s.finish("exited")
	return s, nil
}

func (s *DotnetSession) dto() map[string]any {
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
		"pid":            s.PID,
		"connectedAt":    s.ConnectedAt,
		"status":         s.Status,
		"error":          s.Error,
		"hitCount":       s.hitCount,
		"avgLatencyMs":   avg,
		"runtimeVersion": "netcoredbg",
	}
}

// ─── helpers ──────────────────────────────────────────────────────────────────

func normalizePath(p string) string {
	return strings.ToLower(filepath.ToSlash(filepath.Clean(p)))
}

// truncateRunes caps a string at max runes (not bytes), so a multibyte
// character is never split into invalid UTF-8.
func truncateRunes(s string, max int) string {
	if len(s) <= max {
		return s
	}
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max-1]) + "…"
}

func findNetcoredbg() (string, error) {
	if p := os.Getenv("AXIOM_NETCOREDBG_PATH"); p != "" {
		return p, nil
	}
	if p, err := exec.LookPath("netcoredbg"); err == nil {
		return p, nil
	}
	// Common winget/scoop install locations on Windows.
	if home, err := os.UserHomeDir(); err == nil {
		candidates := []string{
			filepath.Join(home, "scoop", "apps", "netcoredbg", "current", "netcoredbg.exe"),
		}
		for _, c := range candidates {
			if _, err := os.Stat(c); err == nil {
				return c, nil
			}
		}
	}
	return "", fmt.Errorf("netcoredbg not found — install it (winget install Samsung.netcoredbg) or set AXIOM_NETCOREDBG_PATH")
}
