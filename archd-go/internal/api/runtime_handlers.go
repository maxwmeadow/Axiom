// Runtime layer HTTP endpoints — the bridge between MCP tools and the
// runtime.Manager. This is where graph identity (file IDs, symbol line
// ranges from the SQLite index) is resolved before handing language-agnostic
// Watch records to the manager.
//
//	POST /api/runtime/watch    {workspaceId, file, symbol}         — start watching a function
//	POST /api/runtime/unwatch  {workspaceId, watchId?|file+symbol} — stop watching
//	GET  /api/runtime/snapshot?workspace=                          — sessions, watches, targets, recent events
//	POST /api/runtime/launch   {workspaceId, command[], cwd?}      — start target app with adapter injected
//	POST /api/runtime/stop     {targetId}                          — kill a launched target
//	GET  /api/runtime/target-log?target=                           — retained output tail of a target
package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/runtime"
)

// limitBody caps request bodies so a runaway client cannot OOM the daemon.
func limitBody(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
}

func (s *Server) registerRuntimeRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/runtime/watch", s.handleRuntimeWatch)
	mux.HandleFunc("/api/runtime/unwatch", s.handleRuntimeUnwatch)
	mux.HandleFunc("/api/runtime/snapshot", s.handleRuntimeSnapshot)
	mux.HandleFunc("/api/runtime/inject", s.handleRuntimeInject)
	mux.HandleFunc("/api/runtime/inject/confirm", s.handleRuntimeInjectConfirm)
	mux.HandleFunc("/api/runtime/inject/cancel", s.handleRuntimeInjectCancel)
	mux.HandleFunc("/api/runtime/launch", s.handleRuntimeLaunch)
	mux.HandleFunc("/api/runtime/stop", s.handleRuntimeStop)
	mux.HandleFunc("/api/runtime/stop-go", s.handleRuntimeStopGo)
	mux.HandleFunc("/api/runtime/target-log", s.handleRuntimeTargetLog)
}

// resolveWatchTarget resolves {file, symbol} against the graph DB into the
// identity fields of a Watch. Symbol matching prefers callable kinds since
// watches only make sense on functions/methods.
func (s *Server) resolveWatchTarget(workspaceID, fileRef, symbolName string) (*runtime.Watch, error) {
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		return nil, err
	}
	file, err := db.FindFileByIDOrPath(sqlDB, workspaceID, fileRef)
	if err != nil {
		return nil, err
	}
	if file == nil {
		return nil, fmt.Errorf("file %q not found in workspace", fileRef)
	}
	symbols, err := db.GetSymbolsByFile(sqlDB, file.ID)
	if err != nil {
		return nil, err
	}
	var match *db.Symbol
	for i, sym := range symbols {
		if sym.Name != symbolName {
			continue
		}
		callable := sym.Kind == "function" || sym.Kind == "method"
		if match == nil || (callable && !(match.Kind == "function" || match.Kind == "method")) {
			match = &symbols[i]
		}
	}
	if match == nil {
		names := make([]string, 0, len(symbols))
		for _, sym := range symbols {
			names = append(names, sym.Name)
		}
		return nil, fmt.Errorf("symbol %q not found in %s. Available symbols: %s",
			symbolName, file.RelPath, strings.Join(names, ", "))
	}
	return &runtime.Watch{
		WorkspaceID: workspaceID,
		FileID:      file.ID,
		RelPath:     file.RelPath,
		AbsPath:     file.Path,
		Symbol:      match.Name,
		LineStart:   match.LineStart,
		LineEnd:     match.LineEnd,
	}, nil
}

func (s *Server) handleRuntimeWatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	limitBody(w, r)
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		File        string `json:"file"`
		Symbol      string `json:"symbol"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	watch, err := s.resolveWatchTarget(body.WorkspaceID, body.File, body.Symbol)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	notified := s.runtime.AddWatch(watch)
	jsonOK(w, map[string]any{
		"watch":            watch,
		"sessionsNotified": notified,
		"note":             watchNote(notified),
	})
}

func watchNote(notified int) string {
	if notified == 0 {
		return "Watch registered, but no runtime adapter is connected yet. " +
			"Launch the target app via the launch_target tool (or with the axiom_adapter launcher) to start streaming calls."
	}
	return fmt.Sprintf("Watch active — streaming to canvas from %d connected process(es).", notified)
}

func (s *Server) handleRuntimeUnwatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	limitBody(w, r)
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		WatchID     string `json:"watchId"`
		File        string `json:"file"`
		Symbol      string `json:"symbol"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	fileID := ""
	if body.WatchID == "" {
		watch, err := s.resolveWatchTarget(body.WorkspaceID, body.File, body.Symbol)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		fileID = watch.FileID
	}
	removed := s.runtime.RemoveWatch(body.WorkspaceID, body.WatchID, fileID, body.Symbol)
	if removed == nil {
		jsonError(w, "no matching watch found", 404)
		return
	}
	jsonOK(w, map[string]any{"removed": removed})
}

func (s *Server) handleRuntimeInject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	limitBody(w, r)
	var body struct {
		WorkspaceID string          `json:"workspaceId"`
		File        string          `json:"file"`
		Symbol      string          `json:"symbol"`
		ParamName   string          `json:"paramName"`
		Value       json.RawMessage `json:"value"`
		Once        *bool           `json:"once"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	if body.ParamName == "" || len(body.Value) == 0 {
		jsonError(w, "paramName and value are required", 400)
		return
	}
	target, err := s.resolveWatchTarget(body.WorkspaceID, body.File, body.Symbol)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	once := true
	if body.Once != nil {
		once = *body.Once
	}
	inj := s.runtime.RequestInject(&runtime.Inject{
		WorkspaceID: body.WorkspaceID,
		FileID:      target.FileID,
		RelPath:     target.RelPath,
		AbsPath:     target.AbsPath,
		Symbol:      target.Symbol,
		LineStart:   target.LineStart,
		LineEnd:     target.LineEnd,
		ParamName:   body.ParamName,
		Value:       body.Value,
		Once:        once,
	})
	note := "Injection is pending user confirmation on the Axiom canvas. " +
		"Poll get_runtime_snapshot to see it become armed, then fired."
	switch inj.Status {
	case "armed":
		note = "Injection armed (auto-confirm). It fires on the next call to " + inj.Symbol + "."
	case "error":
		note = "Injection failed: " + inj.Error
	}
	jsonOK(w, map[string]any{"inject": inj, "note": note})
}

func (s *Server) handleRuntimeInjectConfirm(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	limitBody(w, r)
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		InjectID    string `json:"injectId"`
		Approved    bool   `json:"approved"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	inj, err := s.runtime.ConfirmInject(body.WorkspaceID, body.InjectID, body.Approved)
	if err != nil {
		jsonError(w, err.Error(), 409)
		return
	}
	jsonOK(w, map[string]any{"inject": inj})
}

func (s *Server) handleRuntimeInjectCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	limitBody(w, r)
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		InjectID    string `json:"injectId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	inj, err := s.runtime.CancelInject(body.WorkspaceID, body.InjectID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	jsonOK(w, map[string]any{"inject": inj})
}

func (s *Server) handleRuntimeSnapshot(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.URL.Query().Get("workspace")
	if workspaceID == "" {
		jsonError(w, "workspace is required", 400)
		return
	}
	jsonOK(w, s.runtime.Snapshot(workspaceID))
}

func (s *Server) handleRuntimeLaunch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	limitBody(w, r)
	var body struct {
		WorkspaceID string   `json:"workspaceId"`
		Command     []string `json:"command"`
		Cwd         string   `json:"cwd"`
		Language    string   `json:"language"` // optional hint: "go" | "python"
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	if len(body.Command) == 0 {
		jsonError(w, "command is required", 400)
		return
	}
	// Default the working directory to the workspace's first root so agents
	// can launch with a relative script path.
	if body.Cwd == "" {
		if sqlDB, err := s.dbFor(body.WorkspaceID); err == nil {
			if roots, err := db.GetRoots(sqlDB, body.WorkspaceID); err == nil && len(roots) > 0 {
				body.Cwd = roots[0].Path
			}
		}
	}

	// Go targets route to delve (archd as DAP client). Detected by an explicit
	// language hint or by the command shape (`go run`, a .go file, a Go binary).
	if program, progArgs, isGo := goProgram(body.Command, body.Cwd, body.Language); isGo {
		sess, err := s.runtime.LaunchGoTarget(body.WorkspaceID, program, progArgs)
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		jsonOK(w, map[string]any{
			"session": sess,
			"note": "Go target launched under delve (inspection mode). Note: delve stops the " +
				"whole process on every breakpoint hit, so keep watches to low-frequency functions.",
		})
		return
	}

	// C#/.NET targets route to netcoredbg (archd as DAP client). Detected by an
	// explicit hint or by the command shape (a .dll, or `dotnet <app.dll>`).
	if program, progArgs, isNet := dotnetProgram(body.Command, body.Cwd, body.Language); isNet {
		sess, err := s.runtime.LaunchDotnetTarget(body.WorkspaceID, program, progArgs)
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		jsonOK(w, map[string]any{
			"session": sess,
			"note": "C#/.NET target launched under netcoredbg (inspection mode). Breakpoints " +
				"bind by file:line; keep watches to low-frequency, synchronous methods (async " +
				"methods lift arguments into state-machine fields). Requires a prebuilt .dll with its .pdb.",
		})
		return
	}

	// Config-driven DAP languages (C++/Ruby/Java) route to the generic session.
	if language, program, progArgs, ok := s.runtime.LangForCommand(body.Command, body.Cwd, body.Language); ok {
		sess, err := s.runtime.LaunchLangTarget(body.WorkspaceID, language, program, progArgs)
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		jsonOK(w, map[string]any{
			"session": sess,
			"note": "Launched under the " + language + " debugger (DAP, inspection mode). " +
				"Breakpoints are blocking — keep watches to low-frequency functions. Requires a debug build.",
		})
		return
	}

	lang := body.Language
	if lang == "" && isNodeCommand(body.Command) {
		lang = "javascript"
	}
	target, err := s.runtime.LaunchTarget(body.WorkspaceID, body.Command, body.Cwd, lang)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	jsonOK(w, map[string]any{"target": target})
}

// isNodeCommand detects a Node.js launch by its executable or entry file.
func isNodeCommand(command []string) bool {
	if len(command) == 0 {
		return false
	}
	first := strings.ToLower(command[0])
	base := filepath.Base(first)
	if base == "node" || base == "node.exe" || base == "nodemon" || base == "ts-node" {
		return true
	}
	for _, a := range command {
		la := strings.ToLower(a)
		if strings.HasSuffix(la, ".js") || strings.HasSuffix(la, ".mjs") || strings.HasSuffix(la, ".cjs") {
			return true
		}
	}
	return false
}

// dotnetProgram decides whether a launch command is a C#/.NET target and
// returns the path to the managed assembly (.dll) netcoredbg should run, plus
// the target's own arguments. Detects a bare `app.dll`, `dotnet app.dll`, or a
// language hint of "csharp"/"dotnet".
func dotnetProgram(command []string, cwd, langHint string) (string, []string, bool) {
	first := strings.ToLower(command[0])
	base := filepath.Base(first)

	// `dotnet <app.dll> [args…]` — the assembly is the first .dll argument.
	if base == "dotnet" || base == "dotnet.exe" {
		for i := 1; i < len(command); i++ {
			if strings.HasSuffix(strings.ToLower(command[i]), ".dll") {
				return resolveRel(cwd, command[i]), command[i+1:], true
			}
		}
		// `dotnet run` / `dotnet <project>` isn't directly debuggable without a
		// built assembly path — fall through unless hinted.
	}
	// A bare managed assembly path.
	if strings.HasSuffix(first, ".dll") {
		return resolveRel(cwd, command[0]), command[1:], true
	}
	// Explicit hint with a program path (may be a .dll or project dir).
	if langHint == "csharp" || langHint == "dotnet" {
		return resolveRel(cwd, command[0]), command[1:], true
	}
	return "", nil, false
}

// goProgram decides whether a launch command is a Go target and returns the
// program path delve should run (a package dir for `go run`/`.go`, or a
// prebuilt binary) plus the target's own arguments. Returns isGo=false for
// non-Go commands.
func goProgram(command []string, cwd, langHint string) (string, []string, bool) {
	first := strings.ToLower(command[0])
	// `go run <path> [args…]` → debug the package/file at <path> (default: cwd).
	if (first == "go" || strings.HasSuffix(first, "/go") || strings.HasSuffix(first, "\\go.exe")) &&
		len(command) >= 2 && command[1] == "run" {
		prog := cwd
		rest := []string{}
		if len(command) >= 3 {
			if command[2] != "." {
				prog = resolveRel(cwd, command[2])
			}
			rest = command[3:]
		}
		return prog, rest, true
	}
	// A .go source file.
	if strings.HasSuffix(first, ".go") {
		return resolveRel(cwd, command[0]), command[1:], true
	}
	// Explicit hint with a binary/dir program.
	if langHint == "go" {
		return resolveRel(cwd, command[0]), command[1:], true
	}
	return "", nil, false
}

func resolveRel(cwd, p string) string {
	if p == "" {
		return cwd
	}
	if filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(cwd, p)
}

func (s *Server) handleRuntimeStopGo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	limitBody(w, r)
	var body struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	sess, err := s.runtime.StopGoTarget(body.SessionID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	jsonOK(w, map[string]any{"session": sess.ID, "status": "stopped"})
}

func (s *Server) handleRuntimeStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	limitBody(w, r)
	var body struct {
		TargetID string `json:"targetId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	// The same tool stops both in-process targets and delve Go sessions —
	// fall back to a delve session if the id isn't a launched target.
	if target, err := s.runtime.StopTarget(body.TargetID); err == nil {
		jsonOK(w, map[string]any{"target": target})
		return
	}
	if sess, err := s.runtime.StopGoTarget(body.TargetID); err == nil {
		jsonOK(w, map[string]any{"session": sess.ID, "status": "stopped"})
		return
	}
	if sess, err := s.runtime.StopDotnetTarget(body.TargetID); err == nil {
		jsonOK(w, map[string]any{"session": sess.ID, "status": "stopped"})
		return
	}
	if sess, err := s.runtime.StopLangTarget(body.TargetID); err == nil {
		jsonOK(w, map[string]any{"session": sess.ID, "status": "stopped"})
		return
	}
	jsonError(w, fmt.Sprintf("no target or debug session with id %q", body.TargetID), 404)
}

func (s *Server) handleRuntimeTargetLog(w http.ResponseWriter, r *http.Request) {
	targetID := r.URL.Query().Get("target")
	lines, err := s.runtime.TargetLog(targetID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	jsonOK(w, map[string]any{"targetId": targetID, "lines": lines})
}
