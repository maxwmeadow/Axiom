// Function body extraction — serves the source code of an indexed symbol.
//
//	GET /api/function-body?workspace=<id>&file=<fileId|relPath>&symbol=<name>
//
// The file may be referenced by ID or by relative path (suffix match allowed,
// forward or back slashes). The symbol is matched exactly first, then
// case-insensitively. Returns every match — overloaded/duplicate names in the
// same file are all included so the agent can disambiguate by line range.
package api

import (
	"bufio"
	"fmt"
	"net/http"
	"os"
	"strings"

	"axiom.local/archd/internal/db"
)

// maxBodyLines caps a single returned function body so a pathological symbol
// (e.g. a 5,000-line class) cannot blow out the agent's context window.
const maxBodyLines = 400

type functionBodyMatch struct {
	Symbol    string `json:"symbol"`
	Kind      string `json:"kind"`
	LineStart int    `json:"lineStart"`
	LineEnd   int    `json:"lineEnd"`
	Truncated bool   `json:"truncated,omitempty"`
	Body      string `json:"body"`
}

func (s *Server) handleFunctionBody(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	workspaceID := r.URL.Query().Get("workspace")
	fileRef := r.URL.Query().Get("file")
	symbolName := r.URL.Query().Get("symbol")
	if fileRef == "" || symbolName == "" {
		jsonError(w, "file and symbol are required", 400)
		return
	}
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}

	file, err := db.FindFileByIDOrPath(sqlDB, workspaceID, fileRef)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	if file == nil {
		jsonError(w, fmt.Sprintf("file %q not found in workspace", fileRef), 404)
		return
	}

	symbols, err := db.GetSymbolsByFile(sqlDB, file.ID)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	var matches []db.Symbol
	for _, sym := range symbols {
		if sym.Name == symbolName {
			matches = append(matches, sym)
		}
	}
	if len(matches) == 0 {
		for _, sym := range symbols {
			if strings.EqualFold(sym.Name, symbolName) {
				matches = append(matches, sym)
			}
		}
	}
	if len(matches) == 0 {
		names := make([]string, 0, len(symbols))
		for _, sym := range symbols {
			names = append(names, sym.Name)
		}
		jsonError(w, fmt.Sprintf("symbol %q not found in %s. Available symbols: %s",
			symbolName, file.RelPath, strings.Join(names, ", ")), 404)
		return
	}

	// Read only up to the last line any match needs — never the whole file
	// into memory (an indexed file could be a huge generated artifact).
	maxLine := 0
	for _, sym := range matches {
		if sym.LineEnd > maxLine {
			maxLine = sym.LineEnd
		}
		if sym.LineStart+maxBodyLines > maxLine {
			maxLine = sym.LineStart + maxBodyLines
		}
	}
	lines, err := readLines(file.Path, maxLine)
	if err != nil {
		jsonError(w, fmt.Sprintf("read %s: %v", file.Path, err), 500)
		return
	}

	results := make([]functionBodyMatch, 0, len(matches))
	for _, sym := range matches {
		body, truncated := sliceLines(lines, sym.LineStart, sym.LineEnd)
		results = append(results, functionBodyMatch{
			Symbol:    sym.Name,
			Kind:      sym.Kind,
			LineStart: sym.LineStart,
			LineEnd:   sym.LineEnd,
			Truncated: truncated,
			Body:      body,
		})
	}
	jsonOK(w, map[string]any{
		"fileId":  file.ID,
		"relPath": file.RelPath,
		"matches": results,
	})
}

// readLines reads at most maxLine lines from path.
func readLines(path string, maxLine int) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	lines := make([]string, 0, 256)
	for len(lines) < maxLine && scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return lines, nil
}

// sliceLines returns lines start..end (1-indexed, inclusive), clamped to the
// file and capped at maxBodyLines. The index may be stale relative to the file
// on disk, so out-of-range values clamp rather than error.
func sliceLines(lines []string, start, end int) (string, bool) {
	if start < 1 {
		start = 1
	}
	if end < start {
		end = start
	}
	if start > len(lines) {
		return "", false
	}
	if end > len(lines) {
		end = len(lines)
	}
	truncated := false
	if end-start+1 > maxBodyLines {
		end = start + maxBodyLines - 1
		truncated = true
	}
	return strings.Join(lines[start-1:end], "\n"), truncated
}
