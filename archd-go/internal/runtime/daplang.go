// Generic config-driven DAP language session (plan Phase 10: C++, Java, Ruby).
//
// The delve (Go) and netcoredbg (C#) integrations proved the DAP-client pattern
// twice; the remaining languages differ only in config — which debugger to
// spawn, the launch request shape, and whether breakpoints bind by function
// name or by file:line. This one session type is parameterized by a
// dapLangConfig so a new language is ~15 lines, not a new file.
//
// Same inspection-mode constraints as delve/netcoredbg: DAP breakpoints are
// blocking, so watches must stay low-frequency; call events only.
//
// Verified live: C++ via gdb 17.2 (`gdb --interpreter=dap`, function
// breakpoints). Ruby (rdbg) and Java (java-debug) configs follow the same
// pattern but are unverified here (toolchains not installed) — see langConfigs.
package runtime

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// dapLangConfig describes how to drive one language's DAP debugger.
type dapLangConfig struct {
	language  string
	adapterID string
	// transport: "stdio" drives the debugger over its stdin/stdout (gdb,
	// java-debug); "tcp" spawns a server the debugger opens and connects over a
	// socket (rdbg --open --port).
	transport string
	// breakpointMode: "function" (setFunctionBreakpoints by name), "source"
	// (setBreakpoints by file:line), or "external" (breakpoints passed on the
	// debugger command line; skip DAP breakpoint requests — rdbg).
	breakpointMode string
	// requestType: "launch" (debugger starts the program) or "attach" (program
	// is already specified on the debugger's command line — rdbg).
	requestType  string
	threadPrefix string // e.g. "thread" → threadId label "thread-14"
	// findDebugger locates the debugger binary (env override + PATH + fallbacks).
	findDebugger func() (string, error)
	// buildArgv returns the full argv to spawn the debugger. For tcp transports
	// it embeds the chosen port, the target program, its args, and (for
	// external breakpoint mode) the watch breakpoints. stdio configs ignore
	// port/program/watches and just return the adapter invocation.
	buildArgv func(dbgPath string, port int, program string, args []string, watches []Watch) []string
	// launchArgs builds the DAP `launch` request arguments (launch mode only).
	launchArgs func(program, cwd string, args []string) map[string]any
	// qualifySymbol maps a bare tree-sitter symbol to the debugger's function
	// breakpoint name (function mode only).
	qualifySymbol func(symbol string) string
}

// dapLangSession is one debugger-traced target for a config-driven language.
type dapLangSession struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	Language    string `json:"language"`
	Program     string `json:"program"`
	PID         int    `json:"pid"`
	ConnectedAt int64  `json:"connectedAt"`
	Status      string `json:"status"`
	Error       string `json:"error,omitempty"`

	cfg      dapLangConfig
	mgr      *Manager
	dbgCmd   *exec.Cmd
	client   *dapClient
	args     []string
	watches  []Watch
	funcToID map[string]string // qualified function name → watchId (function mode)

	mu         sync.Mutex
	inspectMu  sync.Mutex // serializes stop inspections (gdb/rdbg aren't re-entrant)
	hitCount   int64
	latencySum float64
}

// LaunchLangTarget starts a debugger-traced target for a config-driven language.
func (m *Manager) LaunchLangTarget(workspaceID, language, program string, args []string) (*dapLangSession, error) {
	cfg, ok := langConfigs[language]
	if !ok {
		return nil, fmt.Errorf("unsupported DAP language %q", language)
	}
	dbgPath, err := cfg.findDebugger()
	if err != nil {
		return nil, err
	}
	watches := m.WatchesForWorkspace(workspaceID)
	funcToID := make(map[string]string)
	for _, w := range watches {
		funcToID[cfg.qualifySymbol(w.Symbol)] = w.ID
	}
	sess := &dapLangSession{
		ID:          uuid.New().String(),
		WorkspaceID: workspaceID,
		Language:    language,
		Program:     program,
		ConnectedAt: time.Now().UnixMilli(),
		Status:      "starting",
		cfg:         cfg,
		mgr:         m,
		args:        args,
		watches:     watches,
		funcToID:    funcToID,
	}
	if err := sess.start(dbgPath); err != nil {
		sess.Status = "error"
		sess.Error = err.Error()
		return sess, err
	}
	m.mu.Lock()
	m.langSessions[sess.ID] = sess
	m.mu.Unlock()
	m.hub.Broadcast("runtime:session", map[string]any{
		"workspaceId": workspaceID, "session": sess.dto(), "status": "connected",
	})
	return sess, nil
}

func (s *dapLangSession) start(dbgPath string) error {
	if s.cfg.transport == "tcp" {
		return s.startTCP(dbgPath)
	}
	return s.startStdio(dbgPath)
}

func (s *dapLangSession) startStdio(dbgPath string) error {
	argv := s.cfg.buildArgv(dbgPath, 0, s.Program, s.args, s.watches)
	cmd := exec.Command(argv[0], argv[1:]...)
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
		return fmt.Errorf("start %s debugger: %w", s.Language, err)
	}
	s.dbgCmd = cmd
	s.client = newDAPClient(stdout, stdin, func() error {
		stdin.Close()
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
		return nil
	})
	return s.finishStart(cmd)
}

// startTCP spawns a debugger that opens a DAP server (rdbg --open --port), then
// connects to it as a DAP client over TCP.
func (s *dapLangSession) startTCP(dbgPath string) error {
	port, err := freeTCPPort()
	if err != nil {
		return err
	}
	argv := s.cfg.buildArgv(dbgPath, port, s.Program, s.args, s.watches)
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = dirOf(s.Program)
	cmd.Stderr = os.Stderr
	cmd.Stdout = os.Stderr // debugger banner/logs → our stderr, not the DAP stream
	// Some adapters try to launch an editor frontend from PATH; withhold it so
	// tracing never pops open the user's IDE.
	cmd.Env = envWithoutEditors(os.Environ())
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start %s debugger: %w", s.Language, err)
	}
	s.dbgCmd = cmd
	conn, err := dialWithRetry(fmt.Sprintf("127.0.0.1:%d", port), 8*time.Second)
	if err != nil {
		killAndReap(cmd)
		return fmt.Errorf("connect to %s debugger: %w", s.Language, err)
	}
	s.client = newDAPClientConn(conn)
	return s.finishStart(cmd)
}

func (s *dapLangSession) finishStart(cmd *exec.Cmd) error {
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

func (s *dapLangSession) setStatus(status string) {
	s.mu.Lock()
	s.Status = status
	s.mu.Unlock()
}

func (s *dapLangSession) handshake() error {
	if _, err := s.client.request("initialize", map[string]any{
		"clientID": "axiom", "adapterID": s.cfg.adapterID,
		"linesStartAt1": true, "columnsStartAt1": true, "pathFormat": "path",
	}); err != nil {
		return err
	}

	// requestType "none": the debugger already has the program on its command
	// line and starts it on configurationDone (rdbg) — no launch/attach request.
	launchDone := make(chan error, 1)
	if s.cfg.requestType != "none" {
		go func() {
			req := "launch"
			var args map[string]any = map[string]any{}
			if s.cfg.requestType == "attach" {
				req = "attach"
			} else {
				args = s.cfg.launchArgs(s.Program, dirOf(s.Program), s.args)
			}
			_, err := s.client.request(req, args)
			launchDone <- err
		}()
	}

	if err := s.waitForInitialized(); err != nil {
		return err
	}
	// "external" breakpoint mode sets breakpoints on the debugger command line
	// (rdbg -e "break …"), so no DAP breakpoint request is sent here.
	if s.cfg.breakpointMode != "external" {
		if err := s.setBreakpoints(); err != nil {
			return err
		}
	}
	if _, err := s.client.request("configurationDone", map[string]any{}); err != nil {
		return err
	}
	if s.cfg.requestType != "none" {
		select {
		case err := <-launchDone:
			if err != nil {
				return err
			}
		case <-time.After(25 * time.Second):
			return fmt.Errorf("launch did not complete")
		}
	}
	if s.dbgCmd.Process != nil {
		s.mu.Lock()
		s.PID = s.dbgCmd.Process.Pid
		s.mu.Unlock()
	}
	return nil
}

func (s *dapLangSession) waitForInitialized() error {
	deadline := time.NewTimer(25 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case ev := <-s.client.events:
			if ev.Event == "initialized" {
				return nil
			}
			// Fail fast if the target crashed on launch — otherwise we'd wait
			// out the full deadline for an "initialized" that never comes.
			if ev.Event == "terminated" || ev.Event == "exited" {
				return fmt.Errorf("%s target exited before initialization (bad program/args?)", s.Language)
			}
		case <-deadline.C:
			return fmt.Errorf("no initialized event from %s debugger", s.Language)
		case <-s.client.closed:
			return fmt.Errorf("%s debugger closed before initialized", s.Language)
		}
	}
}

func (s *dapLangSession) setBreakpoints() error {
	if s.cfg.breakpointMode == "function" {
		names := make([]map[string]any, 0, len(s.funcToID))
		for fn := range s.funcToID {
			names = append(names, map[string]any{"name": fn})
		}
		if len(names) == 0 {
			return nil
		}
		if _, err := s.client.request("setFunctionBreakpoints", map[string]any{"breakpoints": names}); err != nil {
			return fmt.Errorf("setFunctionBreakpoints: %w", err)
		}
		log.Printf("%s: session %s set %d function breakpoint(s)", s.Language, s.ID, len(names))
		return nil
	}
	// source mode: one setBreakpoints request per file
	byFile := make(map[string][]Watch)
	for _, w := range s.watches {
		if w.AbsPath != "" {
			byFile[w.AbsPath] = append(byFile[w.AbsPath], w)
		}
	}
	for path, ws := range byFile {
		bps := make([]map[string]any, 0, len(ws))
		for _, w := range ws {
			bps = append(bps, map[string]any{"line": w.LineStart})
		}
		if _, err := s.client.request("setBreakpoints", map[string]any{
			"source": map[string]any{"path": path}, "breakpoints": bps,
		}); err != nil {
			return fmt.Errorf("setBreakpoints for %s: %w", path, err)
		}
	}
	log.Printf("%s: session %s set source breakpoints across %d file(s)", s.Language, s.ID, len(byFile))
	return nil
}

func (s *dapLangSession) eventLoop() {
	for {
		select {
		case ev, ok := <-s.client.events:
			if !ok {
				return
			}
			switch ev.Event {
			case "stopped":
				// Off the event loop so readLoop never blocks. handleStopped
				// serializes only the inspection path internally, so a
				// non-breakpoint stop (pause/step) always resumes promptly even
				// while a slow breakpoint inspection is in flight.
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

func (s *dapLangSession) handleStopped(body json.RawMessage) {
	start := time.Now()
	var st dapStoppedBody
	if err := json.Unmarshal(body, &st); err != nil {
		return
	}
	if os.Getenv("AXIOM_DAP_DEBUG") == "1" {
		log.Printf("%s: stopped reason=%q thread=%d body=%s", s.Language, st.Reason, st.ThreadID, string(body))
	}
	if !strings.Contains(st.Reason, "breakpoint") &&
		!strings.Contains(st.Reason, "function") {
		s.resume(st.ThreadID)
		return
	}

	// External breakpoint mode (rdbg): the stopped event's description carries
	// the breakpoint's file:line, so we attribute the call from that and skip
	// stackTrace — rdbg 1.11 hangs on stackTrace for stopped worker threads, so
	// argument values are unavailable (call-only tracing for Ruby).
	if s.cfg.breakpointMode == "external" {
		watchID := s.matchStoppedLocation(st.Description)
		s.resume(st.ThreadID)
		if watchID == "" {
			return
		}
		s.mu.Lock()
		s.hitCount++
		s.mu.Unlock()
		s.mgr.RecordWatchEvent(s.ID, AdapterEvent{
			Kind:     "call",
			WatchID:  watchID,
			TraceID:  fmt.Sprintf("t%d", st.ThreadID),
			ThreadID: fmt.Sprintf("%s-%d", s.cfg.threadPrefix, st.ThreadID),
			TS:       time.Now().UnixMilli(),
		})
		return
	}

	// Serialize only the inspection: stackTrace/scopes/variables + continue must
	// not interleave for non-re-entrant debuggers (gdb). Non-breakpoint stops
	// and external-mode (rdbg) resumes above never take this lock, so they're
	// never blocked by a slow inspection.
	s.inspectMu.Lock()
	dbg := os.Getenv("AXIOM_DAP_DEBUG") == "1"
	watchID, args := s.inspect(st.ThreadID)
	roundTrip := float64(time.Since(start).Microseconds()) / 1000.0
	s.resume(st.ThreadID)
	s.inspectMu.Unlock()
	if dbg {
		log.Printf("%s: inspect+resume in %v watchID=%q", s.Language, time.Since(start), watchID)
	}

	if watchID == "" {
		return
	}
	s.mu.Lock()
	s.hitCount++
	s.latencySum += roundTrip
	s.mu.Unlock()

	s.mgr.RecordWatchEvent(s.ID, AdapterEvent{
		Kind:       "call",
		WatchID:    watchID,
		TraceID:    fmt.Sprintf("t%d", st.ThreadID),
		ThreadID:   fmt.Sprintf("%s-%d", s.cfg.threadPrefix, st.ThreadID),
		TS:         time.Now().UnixMilli(),
		Args:       args,
		DurationMs: roundTrip,
	})
}

func (s *dapLangSession) resume(threadID int) {
	if _, err := s.client.request("continue", map[string]any{"threadId": threadID}); err != nil {
		log.Printf("%s: session %s continue failed (target may be frozen): %v", s.Language, s.ID, err)
	}
}

// inspect reads the stopped thread's top frame and maps it to a watch. In
// function mode it matches by the frame's function name; in source mode by
// file+line range. Returns (watchID, argsJSON).
func (s *dapLangSession) inspect(threadID int) (string, json.RawMessage) {
	resp, err := s.client.request("stackTrace", map[string]any{
		"threadId": threadID, "startFrame": 0, "levels": 1,
	})
	if err != nil {
		return "", nil
	}
	var st dapStackResp
	if err := json.Unmarshal(resp.Body, &st); err != nil || len(st.StackFrames) == 0 {
		return "", nil
	}
	frame := st.StackFrames[0]

	watchID := ""
	if s.cfg.breakpointMode == "function" {
		watchID = s.matchFunc(frame.Name)
	} else {
		watchID = s.matchSource(frame.Source.Path, frame.Line)
	}

	scopesResp, err := s.client.request("scopes", map[string]any{"frameId": frame.ID})
	if err != nil {
		return watchID, nil
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
	if argsRef == 0 {
		for _, sc := range scopes.Scopes {
			if sc.VariablesReference != 0 {
				argsRef = sc.VariablesReference
				break
			}
		}
	}
	if argsRef == 0 {
		return watchID, nil
	}
	varsResp, err := s.client.request("variables", map[string]any{"variablesReference": argsRef})
	if err != nil {
		return watchID, nil
	}
	var vars dapVariablesResp
	json.Unmarshal(varsResp.Body, &vars)
	args := make(map[string]map[string]string, len(vars.Variables))
	for _, v := range vars.Variables {
		// Skip receivers and debugger-internal pseudo-vars (rdbg exposes %self).
		if v.Name == "this" || v.Name == "self" || v.Name == "" ||
			strings.HasPrefix(v.Name, "<") || strings.HasPrefix(v.Name, "%") {
			continue
		}
		args[v.Name] = map[string]string{"type": v.Type, "value": truncateRunes(v.Value, 256)}
	}
	argsJSON, _ := json.Marshal(args)
	return watchID, argsJSON
}

// matchFunc maps a frame's (possibly signature-bearing) function name to a
// watch. gdb reports "process_payment(int, double, ...)" — match on the base
// name before the first '('.
func (s *dapLangSession) matchFunc(frameName string) string {
	base := frameName
	if i := strings.IndexByte(base, '('); i >= 0 {
		base = base[:i]
	}
	base = strings.TrimSpace(base)
	// Try the qualified name as-is, then the bare last segment. (We avoid a
	// fuzzy "any key whose last segment matches" scan — with two watched
	// same-named methods it would resolve by map-iteration order, i.e.
	// non-deterministically.)
	if id, ok := s.funcToID[base]; ok {
		return id
	}
	if i := strings.LastIndexAny(base, ".:"); i >= 0 {
		if id, ok := s.funcToID[base[i+1:]]; ok {
			return id
		}
	}
	return ""
}

// matchStoppedLocation parses a "file:line" out of a stopped-event description
// (rdbg: "BP - Line  c:/…/app.rb:9 (call)") and maps it to a watch. Used in
// external breakpoint mode where we don't call stackTrace.
func (s *dapLangSession) matchStoppedLocation(desc string) string {
	if desc == "" {
		return ""
	}
	if i := strings.Index(desc, "("); i >= 0 {
		desc = desc[:i] // drop trailing "(call)"
	}
	desc = strings.TrimSpace(desc)
	ci := strings.LastIndex(desc, ":")
	if ci < 0 {
		return ""
	}
	line, err := strconv.Atoi(strings.TrimSpace(desc[ci+1:]))
	if err != nil {
		return ""
	}
	path := desc[:ci]
	if li := strings.LastIndex(strings.ToLower(path), "line "); li >= 0 {
		path = path[li+len("line "):]
	}
	return s.matchSource(strings.TrimSpace(path), line)
}

func (s *dapLangSession) matchSource(framePath string, frameLine int) string {
	if framePath == "" {
		return ""
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
	return best
}

func (s *dapLangSession) finish(status string) {
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
	delete(s.mgr.langSessions, s.ID)
	s.mgr.mu.Unlock()

	log.Printf("%s: session %s %s — %d breakpoint hits, avg stop→continue %.1fms",
		s.Language, s.ID, status, hits, avg)
	s.mgr.hub.Broadcast("runtime:session", map[string]any{
		"workspaceId": s.WorkspaceID, "session": s.dto(), "status": "disconnected",
	})
}

// StopLangTarget kills a config-driven language session.
func (m *Manager) StopLangTarget(sessionID string) (*dapLangSession, error) {
	m.mu.RLock()
	s, ok := m.langSessions[sessionID]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("lang session %s not found", sessionID)
	}
	s.finish("exited")
	return s, nil
}

func (s *dapLangSession) dto() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	avg := 0.0
	if s.hitCount > 0 {
		avg = s.latencySum / float64(s.hitCount)
	}
	return map[string]any{
		"id": s.ID, "workspaceId": s.WorkspaceID, "language": s.Language,
		"program": s.Program, "pid": s.PID, "connectedAt": s.ConnectedAt,
		"status": s.Status, "error": s.Error, "hitCount": s.hitCount,
		"avgLatencyMs": avg, "runtimeVersion": s.cfg.adapterID,
	}
}

func dirOf(program string) string {
	return filepath.Dir(program)
}

// envWithoutEditors strips editor directories (VS Code) from PATH so an adapter
// that auto-launches a frontend (rdbg --open) can't pop open the user's IDE.
func envWithoutEditors(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		if !strings.HasPrefix(strings.ToUpper(kv), "PATH=") {
			out = append(out, kv)
			continue
		}
		val := kv[len("PATH="):]
		parts := strings.Split(val, string(os.PathListSeparator))
		kept := parts[:0]
		for _, p := range parts {
			lp := strings.ToLower(p)
			if strings.Contains(lp, "microsoft vs code") || strings.Contains(lp, "\\code\\") ||
				strings.HasSuffix(lp, "\\microsoft vs code\\bin") {
				continue
			}
			kept = append(kept, p)
		}
		out = append(out, "PATH="+strings.Join(kept, string(os.PathListSeparator)))
	}
	return out
}
