// Target process launching. The agent (via MCP) or the UI asks archd to start
// the user's application with the language adapter pre-loaded through
// environment injection - zero changes to the user's codebase.
//
// For Python: the adapter directory (containing sitecustomize.py and the
// axiom_adapter package) is prepended to PYTHONPATH. CPython's site module
// imports sitecustomize automatically on interpreter startup, which connects
// the adapter back to this manager using AXIOM_RUNTIME_PORT / AXIOM_WORKSPACE_ID.
package runtime

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	targetLogTail    = 200 // lines of output retained per target
	maxExitedTargets = 20  // exited targets retained before pruning oldest
	maxTargetLineLen = 16 * 1024
)

// Target is a process launched (and owned) by archd.
type Target struct {
	ID          string   `json:"id"`
	WorkspaceID string   `json:"workspaceId"`
	Command     []string `json:"command"`
	Cwd         string   `json:"cwd"`
	PID         int      `json:"pid"`
	StartedAt   int64    `json:"startedAt"`
	Status      string   `json:"status"` // 'running'|'exited'
	ExitCode    *int     `json:"exitCode,omitempty"`

	cmd     *exec.Cmd
	logMu   sync.Mutex
	logTail []string
}

// snapshotLocked returns a marshal-safe copy of the target's mutable state.
// Caller must hold m.mu (Status/ExitCode are mutated under it).
func (t *Target) snapshotLocked() map[string]any {
	return map[string]any{
		"id":          t.ID,
		"workspaceId": t.WorkspaceID,
		"command":     append([]string(nil), t.Command...),
		"cwd":         t.Cwd,
		"pid":         t.PID,
		"startedAt":   t.StartedAt,
		"status":      t.Status,
		"exitCode":    t.ExitCode,
	}
}

// LaunchTarget starts command in cwd with the runtime adapter for `language`
// injected via environment (zero code changes to the target). language is
// "python" or "javascript". Returns a marshal-safe snapshot of the target.
func (m *Manager) LaunchTarget(workspaceID string, command []string, cwd, language string) (map[string]any, error) {
	if len(command) == 0 {
		return nil, fmt.Errorf("command is required")
	}
	if cwd == "" {
		cwd = "."
	}
	if language == "" {
		language = "python"
	}

	var env []string
	switch language {
	case "javascript", "node":
		adapterDir, err := FindNodeAdapterDir()
		if err != nil {
			return nil, err
		}
		env = injectNodeEnv(os.Environ(), adapterDir, m.port, workspaceID, cwd)
	default:
		adapterDir, err := FindPythonAdapterDir()
		if err != nil {
			return nil, err
		}
		env = injectAdapterEnv(os.Environ(), adapterDir, m.port, workspaceID)
	}

	cmd := exec.Command(command[0], command[1:]...)
	cmd.Dir = cwd
	cmd.Env = env

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %q: %w", strings.Join(command, " "), err)
	}

	t := &Target{
		ID:          uuid.New().String(),
		WorkspaceID: workspaceID,
		Command:     command,
		Cwd:         cwd,
		PID:         cmd.Process.Pid,
		StartedAt:   time.Now().UnixMilli(),
		Status:      "running",
		cmd:         cmd,
	}
	m.mu.Lock()
	m.targets[t.ID] = t
	dto := t.snapshotLocked()
	m.mu.Unlock()

	go m.pumpTargetOutput(t, stdout, "stdout")
	go m.pumpTargetOutput(t, stderr, "stderr")
	go func() {
		err := cmd.Wait()
		code := 0
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		} else if err != nil {
			code = -1
		}
		m.mu.Lock()
		t.Status = "exited"
		t.ExitCode = &code
		m.pruneExitedTargetsLocked()
		m.mu.Unlock()
		m.hub.Broadcast("runtime:target_exit", map[string]any{
			"workspaceId": workspaceID,
			"targetId":    t.ID,
			"exitCode":    code,
		})
		log.Printf("runtime: target %s exited with code %d", t.ID, code)
	}()

	m.hub.Broadcast("runtime:target_start", map[string]any{
		"workspaceId": workspaceID,
		"target":      dto,
	})
	log.Printf("runtime: launched target %s: %s (pid %d)", t.ID, strings.Join(command, " "), t.PID)
	return dto, nil
}

// pruneExitedTargetsLocked keeps only the newest maxExitedTargets exited
// targets so repeated launches don't grow m.targets forever. Caller holds m.mu.
func (m *Manager) pruneExitedTargetsLocked() {
	exited := make([]*Target, 0)
	for _, t := range m.targets {
		if t.Status == "exited" {
			exited = append(exited, t)
		}
	}
	for len(exited) > maxExitedTargets {
		oldest := 0
		for i, t := range exited {
			if t.StartedAt < exited[oldest].StartedAt {
				oldest = i
			}
		}
		delete(m.targets, exited[oldest].ID)
		exited = append(exited[:oldest], exited[oldest+1:]...)
	}
}

// pumpTargetOutput forwards child output line-by-line. Lines longer than
// maxTargetLineLen are truncated but the pipe keeps draining - abandoning the
// read (bufio.Scanner's ErrTooLong behavior) would block the child on a full
// pipe forever.
func (m *Manager) pumpTargetOutput(t *Target, r io.Reader, stream string) {
	reader := bufio.NewReaderSize(r, 32*1024)
	for {
		line, err := readLineCapped(reader, maxTargetLineLen)
		if len(line) > 0 {
			m.recordTargetLine(t, stream, line)
		}
		if err != nil {
			return
		}
	}
}

// readLineCapped reads one line, truncating anything beyond cap while still
// consuming the remainder so the pipe never backs up.
func readLineCapped(r *bufio.Reader, capLen int) (string, error) {
	var buf []byte
	truncated := false
	for {
		chunk, isPrefix, err := r.ReadLine()
		if len(chunk) > 0 && !truncated {
			remaining := capLen - len(buf)
			if len(chunk) > remaining {
				chunk = chunk[:remaining]
				truncated = true
			}
			buf = append(buf, chunk...)
		}
		if err != nil {
			return string(buf), err
		}
		if !isPrefix {
			if truncated {
				buf = append(buf, []byte(" …[truncated]")...)
			}
			return string(buf), nil
		}
	}
}

func (m *Manager) recordTargetLine(t *Target, stream, line string) {
	t.logMu.Lock()
	t.logTail = append(t.logTail, line)
	if len(t.logTail) > targetLogTail {
		t.logTail = t.logTail[len(t.logTail)-targetLogTail:]
	}
	t.logMu.Unlock()
	m.hub.Broadcast("runtime:target_log", map[string]any{
		"workspaceId": t.WorkspaceID,
		"targetId":    t.ID,
		"stream":      stream,
		"line":        line,
	})
}

// StopTarget kills a launched target process.
func (m *Manager) StopTarget(targetID string) (map[string]any, error) {
	m.mu.Lock()
	t, ok := m.targets[targetID]
	var dto map[string]any
	var running bool
	if ok {
		running = t.Status == "running"
		dto = t.snapshotLocked()
	}
	m.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("target %s not found", targetID)
	}
	if running && t.cmd.Process != nil {
		if err := t.cmd.Process.Kill(); err != nil {
			return nil, fmt.Errorf("kill target %s: %w", targetID, err)
		}
	}
	return dto, nil
}

// TargetLog returns the retained output tail for a target.
func (m *Manager) TargetLog(targetID string) ([]string, error) {
	m.mu.RLock()
	t, ok := m.targets[targetID]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("target %s not found", targetID)
	}
	t.logMu.Lock()
	defer t.logMu.Unlock()
	return append([]string{}, t.logTail...), nil
}

// injectAdapterEnv returns env with the Python adapter wired in. Existing
// PYTHONPATH entries are preserved (appended after the adapter dir).
func injectAdapterEnv(env []string, adapterDir string, port int, workspaceID string) []string {
	out := make([]string, 0, len(env)+3)
	pythonPath := adapterDir
	for _, kv := range env {
		if strings.HasPrefix(strings.ToUpper(kv), "PYTHONPATH=") {
			if v := kv[len("PYTHONPATH="):]; v != "" {
				pythonPath += string(os.PathListSeparator) + v
			}
			continue
		}
		out = append(out, kv)
	}
	out = append(out,
		"PYTHONPATH="+pythonPath,
		fmt.Sprintf("AXIOM_RUNTIME_PORT=%d", port),
		"AXIOM_WORKSPACE_ID="+workspaceID,
		// Without this, Python block-buffers stdout into a pipe and the live
		// target log stays empty until 8KB accumulates.
		"PYTHONUNBUFFERED=1",
	)
	return out
}

// injectNodeEnv wires the Node adapter in via NODE_OPTIONS (--require for CJS,
// --import for ESM), preserving any existing NODE_OPTIONS. AXIOM_WORKSPACE_ROOT
// scopes instrumentation to the user's files (node_modules is skipped).
func injectNodeEnv(env []string, adapterDir string, port int, workspaceID, workspaceRoot string) []string {
	cjs := filepath.Join(adapterDir, "cjs-bootstrap.cjs")
	esm := filepath.ToSlash(filepath.Join(adapterDir, "esm-bootstrap.mjs"))
	// --import needs a file: URL; --require takes a path (quote for spaces).
	axiomOpts := fmt.Sprintf(`--require %q --import file:///%s`, cjs, esm)

	out := make([]string, 0, len(env)+4)
	for _, kv := range env {
		if strings.HasPrefix(strings.ToUpper(kv), "NODE_OPTIONS=") {
			if v := kv[len("NODE_OPTIONS="):]; v != "" {
				axiomOpts = v + " " + axiomOpts
			}
			continue
		}
		out = append(out, kv)
	}
	out = append(out,
		"NODE_OPTIONS="+axiomOpts,
		fmt.Sprintf("AXIOM_RUNTIME_PORT=%d", port),
		"AXIOM_WORKSPACE_ID="+workspaceID,
		"AXIOM_WORKSPACE_ROOT="+workspaceRoot,
	)
	return out
}

// FindNodeAdapterDir locates the bundled Node adapter (marker: cjs-bootstrap.cjs).
func FindNodeAdapterDir() (string, error) {
	return findAdapterDir("node", "cjs-bootstrap.cjs")
}

// findAdapterDir searches standard locations for adapters/<sub>/<marker>.
func findAdapterDir(sub, marker string) (string, error) {
	var candidates []string
	if envDir := os.Getenv("AXIOM_ADAPTERS_DIR"); envDir != "" {
		candidates = append(candidates, filepath.Join(envDir, sub))
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		for i := 0; i < 4; i++ {
			candidates = append(candidates, filepath.Join(dir, "adapters", sub))
			dir = filepath.Dir(dir)
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(cwd, "adapters", sub))
	}
	for _, c := range candidates {
		if st, err := os.Stat(filepath.Join(c, marker)); err == nil && !st.IsDir() {
			return c, nil
		}
	}
	return "", fmt.Errorf("%s adapter not found (searched %s); set AXIOM_ADAPTERS_DIR", sub, strings.Join(candidates, ", "))
}

// FindPythonAdapterDir locates the bundled Python adapter. Search order:
//  1. AXIOM_ADAPTERS_DIR env var (expects <dir>/python)
//  2. adapters/python next to the archd executable (packaged layout)
//  3. walking up from the executable to a repo root containing adapters/python (dev layout)
func FindPythonAdapterDir() (string, error) {
	var candidates []string
	if envDir := os.Getenv("AXIOM_ADAPTERS_DIR"); envDir != "" {
		candidates = append(candidates, filepath.Join(envDir, "python"))
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		for i := 0; i < 4; i++ {
			candidates = append(candidates, filepath.Join(dir, "adapters", "python"))
			dir = filepath.Dir(dir)
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(cwd, "adapters", "python"))
	}
	for _, c := range candidates {
		if st, err := os.Stat(filepath.Join(c, "sitecustomize.py")); err == nil && !st.IsDir() {
			return c, nil
		}
	}
	return "", fmt.Errorf("python adapter not found (searched %s); set AXIOM_ADAPTERS_DIR", strings.Join(candidates, ", "))
}
