// Language configs for the generic DAP session (plan Phase 10).
//
//	C++  - gdb 14+ `--interpreter=dap`, function breakpoints.  LIVE-VERIFIED.
//	Ruby - rdbg (debug gem) DAP over TCP, native breakpoints.  LIVE-VERIFIED
//	       (call attribution; args unavailable - rdbg stackTrace bug, see below).
//	Java - Microsoft java-debug adapter jar, source breakpoints.  Config provided;
//	       requires the adapter jar (AXIOM_JAVA_DEBUG_JAR) - that adapter normally
//	       runs inside the JDT language server, so standalone use is environment-
//	       specific and not verified here.
//
// Adding a language is this file plus a launch-detection clause - the session
// machinery in daplang.go is shared.
package runtime

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

var langConfigs = map[string]dapLangConfig{
	"cpp":  cppConfig,
	"ruby": rubyConfig,
	"java": javaConfig,
}

// ─── C++ (gdb) ──────────────────────────────────────────────────────────────
// gdb reports frame names with signatures ("process_payment(int, double, …)");
// the session's matchFunc strips the signature. Breakpoints bind by the bare
// (demangled) function name, avoiding gdb's fiddly Windows source-path matching.
// The target must carry debug info (-g); statically-linked binaries avoid the
// "wrong runtime DLL" startup failure under the debugger on MinGW.
var cppConfig = dapLangConfig{
	language:       "cpp",
	adapterID:      "gdb",
	transport:      "stdio",
	breakpointMode: "function",
	requestType:    "launch",
	threadPrefix:   "thread",
	findDebugger:   func() (string, error) { return findOnPath("gdb", "AXIOM_GDB_PATH") },
	buildArgv: func(dbg string, port int, program string, args []string, watches []Watch) []string {
		return []string{dbg, "--interpreter=dap"}
	},
	launchArgs: func(program, cwd string, args []string) map[string]any {
		m := map[string]any{"program": program, "cwd": cwd}
		if len(args) > 0 {
			m["args"] = args
		}
		return m
	},
	qualifySymbol: func(sym string) string { return sym }, // gdb takes the bare name
}

// ─── Ruby (rdbg / debug gem) ────────────────────────────────────────────────
// rdbg speaks DAP over TCP via `rdbg --open=vscode --port N script.rb`. Verified
// live (rdbg 1.11 / Ruby 3.4): call attribution across threads works. Three
// rdbg quirks handled here:
//   - DAP setBreakpoints is rejected for the main script ("… is not available"),
//     so breakpoints are set natively with `-e "break file:line"` (external
//     breakpoint mode) - these bind to method entry and hit on every call.
//   - the program runs from the command line and rdbg starts it on
//     configurationDone, so no launch/attach request is sent (requestType none).
//   - stackTrace HANGS on stopped worker threads (an rdbg threading bug), so we
//     attribute the call from the stopped event's breakpoint description instead
//     of stackTrace. Consequence: Ruby is call-only - argument VALUES are not
//     available (would require the frame/scopes stackTrace can't return here).
//
// rdbg is a Ruby script, so we invoke it through the ruby interpreter.
var rubyConfig = dapLangConfig{
	language:       "ruby",
	adapterID:      "rdbg",
	transport:      "tcp",
	breakpointMode: "external",
	requestType:    "none", // rdbg runs the program from its argv on configurationDone
	threadPrefix:   "thread",
	findDebugger:   func() (string, error) { return findOnPath("ruby", "AXIOM_RUBY_PATH") },
	buildArgv: func(rubyPath string, port int, program string, args []string, watches []Watch) []string {
		rdbg := os.Getenv("AXIOM_RDBG_PATH")
		if rdbg == "" {
			rdbg = filepath.Join(filepath.Dir(rubyPath), "rdbg")
		}
		argv := []string{rubyPath, rdbg, "--open=vscode", "--port", fmt.Sprintf("%d", port)}
		// Native file:line breakpoints on each watched method's def line - rdbg
		// binds these to method entry, so they hit on every call.
		for _, w := range watches {
			argv = append(argv, "-e", fmt.Sprintf("break %s:%d", filepath.ToSlash(w.RelPath), w.LineStart))
		}
		argv = append(argv, program)
		argv = append(argv, args...)
		return argv
	},
	launchArgs:    nil, // attach mode
	qualifySymbol: func(sym string) string { return sym },
}

// ─── Java (Microsoft java-debug) ────────────────────────────────────────────
// The java-debug adapter runs as `java -jar com.microsoft.java.debug.plugin.jar`
// speaking DAP over stdio. Path via AXIOM_JAVA_DEBUG_JAR. Source breakpoints
// bind by file:line through JDWP.
var javaConfig = dapLangConfig{
	language:       "java",
	adapterID:      "java",
	transport:      "stdio",
	breakpointMode: "source",
	requestType:    "launch",
	threadPrefix:   "thread",
	findDebugger: func() (string, error) {
		// The adapter jar is required - validate it up front so we never spawn
		// `java -jar ""` and hang the handshake waiting on a dead process.
		jar := os.Getenv("AXIOM_JAVA_DEBUG_JAR")
		if jar == "" {
			return "", fmt.Errorf("Java tracing needs AXIOM_JAVA_DEBUG_JAR set to the java-debug adapter jar")
		}
		if _, err := os.Stat(jar); err != nil {
			return "", fmt.Errorf("AXIOM_JAVA_DEBUG_JAR %q not found: %w", jar, err)
		}
		return findOnPath("java", "AXIOM_JAVA_PATH")
	},
	buildArgv: func(dbg string, port int, program string, args []string, watches []Watch) []string {
		return []string{dbg, "-jar", os.Getenv("AXIOM_JAVA_DEBUG_JAR")}
	},
	launchArgs: func(program, cwd string, args []string) map[string]any {
		// program is the main class; java-debug needs the classpath (the dir of
		// the compiled .class) to resolve it.
		m := map[string]any{"request": "launch", "mainClass": program, "cwd": cwd}
		if len(args) > 0 {
			m["args"] = args
		}
		if cp := os.Getenv("AXIOM_JAVA_CLASSPATH"); cp != "" {
			m["classPaths"] = []string{cp}
		} else {
			m["classPaths"] = []string{cwd}
		}
		return m
	},
	qualifySymbol: func(sym string) string { return sym },
}

// findOnPath resolves a debugger binary: env override, PATH, then ~/go/bin and
// ~/axiom-tools fallbacks used elsewhere in Axiom.
func findOnPath(name, envVar string) (string, error) {
	if p := os.Getenv(envVar); p != "" {
		return p, nil
	}
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
	}
	if home, err := os.UserHomeDir(); err == nil {
		for _, c := range []string{
			filepath.Join(home, "axiom-tools", name, name+".exe"),
			filepath.Join(home, "axiom-tools", name, name),
		} {
			if _, err := os.Stat(c); err == nil {
				return c, nil
			}
		}
	}
	return "", fmt.Errorf("%s not found - install it or set %s", name, envVar)
}

// LangForCommand is the exported entry point used by the api package to detect
// a config-driven DAP language before dispatching a launch.
func (m *Manager) LangForCommand(command []string, cwd, langHint string) (string, string, []string, bool) {
	return langForCommand(command, cwd, langHint)
}

// langForCommand detects a config-driven DAP language from a launch command,
// returning (language, program, args, ok). Program is the target the debugger
// should run.
func langForCommand(command []string, cwd, langHint string) (string, string, []string, bool) {
	if len(command) == 0 {
		return "", "", nil, false
	}
	first := strings.ToLower(command[0])
	base := strings.ToLower(filepath.Base(first))

	// Explicit hint wins.
	switch langHint {
	case "cpp", "c++":
		return "cpp", resolveRelR(cwd, command[0]), command[1:], true
	case "ruby":
		return "ruby", resolveRelR(cwd, firstWithExtOr(command, ".rb", command[0])), rubyArgs(command), true
	case "java":
		mainClass, jargs := javaMainClass(command)
		return "java", mainClass, jargs, true
	}

	// `ruby app.rb`
	if base == "ruby" || base == "ruby.exe" {
		return "ruby", resolveRelR(cwd, firstWithExt(command, ".rb")), rubyArgs(command), true
	}
	// A bare .rb script.
	if strings.HasSuffix(first, ".rb") {
		return "ruby", resolveRelR(cwd, command[0]), command[1:], true
	}
	// A native executable with C++ debug info is ambiguous; require the hint
	// (handled above) so we don't hijack arbitrary .exe launches.
	return "", "", nil, false
}

// javaMainClass extracts the main class (or -jar target) and the program args
// from a `java [jvm-flags] <mainClass|-jar app.jar> [args…]` command. Returns
// ("", nil) if only the launcher is present.
func javaMainClass(command []string) (string, []string) {
	i := 0
	if len(command) > 0 {
		base := strings.ToLower(filepath.Base(strings.ToLower(command[0])))
		if base == "java" || base == "java.exe" {
			i = 1 // skip the launcher
		}
	}
	for ; i < len(command); i++ {
		arg := command[i]
		switch {
		case arg == "-jar":
			if i+1 < len(command) {
				return command[i+1], command[i+2:]
			}
			return "", nil
		case arg == "-cp" || arg == "-classpath" || arg == "--class-path" || arg == "-p" || arg == "--module-path":
			i++ // skip the flag's value
		case strings.HasPrefix(arg, "-"):
			// JVM flag (-Xmx…, -D…, -ea, …) - skip
		default:
			// first non-flag token is the main class
			return arg, command[i+1:]
		}
	}
	return "", nil
}

func rubyArgs(command []string) []string {
	// everything after the .rb script
	for i, a := range command {
		if strings.HasSuffix(strings.ToLower(a), ".rb") {
			return command[i+1:]
		}
	}
	return nil
}

func firstWithExt(command []string, ext string) string {
	for _, a := range command {
		if strings.HasSuffix(strings.ToLower(a), ext) {
			return a
		}
	}
	return command[len(command)-1]
}

func firstWithExtOr(command []string, ext, fallback string) string {
	for _, a := range command {
		if strings.HasSuffix(strings.ToLower(a), ext) {
			return a
		}
	}
	return fallback
}

// resolveRelR resolves p against cwd (absolute paths pass through).
func resolveRelR(cwd, p string) string {
	if p == "" {
		return cwd
	}
	if filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(cwd, p)
}
