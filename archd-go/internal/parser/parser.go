// Package parser wraps tree-sitter to extract symbols and import dependencies from source files.
// Each language gets one grammar. The parser is goroutine-safe: callers can parse concurrently
// as long as they call ParseFile on separate goroutines (each invocation creates its own
// tree-sitter parser instance).
package parser

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"

	sitter "github.com/smacker/go-tree-sitter"
	"github.com/smacker/go-tree-sitter/cpp"
	"github.com/smacker/go-tree-sitter/csharp"
	"github.com/smacker/go-tree-sitter/golang"
	"github.com/smacker/go-tree-sitter/java"
	"github.com/smacker/go-tree-sitter/javascript"
	"github.com/smacker/go-tree-sitter/python"
	"github.com/smacker/go-tree-sitter/ruby"
	"github.com/smacker/go-tree-sitter/rust"
	"github.com/smacker/go-tree-sitter/typescript/tsx"
	"github.com/smacker/go-tree-sitter/typescript/typescript"

	"axiom.local/archd/internal/db"
)

// RawCall is an unresolved function call extracted from a file.
// CalleeName is the raw identifier — resolved to a file ID by the indexer
// after all files and their symbols are in the database.
type RawCall struct {
	CallerSymbol string // enclosing function/method name; empty for module-level calls
	CalleeName   string // name of the function/constructor being called
}

// Result is what the parser returns for one file.
type Result struct {
	Language  string
	LineCount int
	Symbols   []db.Symbol
	// Imports holds resolved relative paths or module specifiers for most languages.
	// For C#, entries prefixed with "#ns:" are the file's own namespace declaration;
	// other entries are internal using directives (namespace strings, not file paths).
	Imports []string
	// Calls holds raw (unresolved) function calls extracted by tree-sitter.
	// The indexer resolves CalleeName → callee file ID using the symbols table.
	Calls []RawCall
	// VarRefs holds per-occurrence variable references (def/param/write/read).
	// The indexer aggregates reads before storing; the data-flow API re-parses
	// for exact per-line results.
	VarRefs []VarRef
}

// ParseFile reads a file and extracts symbols and imports using tree-sitter.
// Returns an error only for OS-level failures; parse failures return a partial result.
func ParseFile(absPath, relPath string) (*Result, error) {
	src, err := os.ReadFile(absPath)
	if err != nil {
		return nil, err
	}
	lang := detectLanguage(absPath)
	lineCount := countLines(src)

	result := &Result{
		Language:  lang,
		LineCount: lineCount,
	}

	// C# import extraction is regex-based (tree-sitter C# grammar is incomplete for imports),
	// but we still use tree-sitter for symbols and call extraction.
	if lang == "csharp" {
		result.Imports = extractCSharpImports(src)
		if grammar := grammarFor(lang); grammar != nil {
			p := sitter.NewParser()
			p.SetLanguage(grammar)
			if tree := p.Parse(nil, src); tree != nil {
				root := tree.RootNode()
				result.Symbols = extractSymbols(root, src, lang)
				result.Calls = extractCalls(root, src, lang)
				tree.Close()
			}
			p.Close()
		}
		return result, nil
	}

	grammar := grammarFor(lang)
	if grammar == nil {
		return result, nil // unsupported language — return metadata only
	}

	p := sitter.NewParser()
	defer p.Close()
	p.SetLanguage(grammar)
	tree := p.Parse(nil, src)
	if tree == nil {
		return result, nil
	}
	defer tree.Close()

	rootNode := tree.RootNode()
	result.Symbols = extractSymbols(rootNode, src, lang)
	result.Imports = extractImports(rootNode, src, lang, relPath)
	result.Calls = extractCalls(rootNode, src, lang)
	result.VarRefs = extractVarRefs(rootNode, src, lang)
	return result, nil
}

// ─── Language detection ───────────────────────────────────────────────────────

func detectLanguage(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".ts":
		return "typescript"
	case ".tsx":
		return "tsx"
	case ".js", ".mjs", ".cjs":
		return "javascript"
	case ".jsx":
		return "jsx"
	case ".py":
		return "python"
	case ".go":
		return "go"
	case ".rs":
		return "rust"
	case ".cs":
		return "csharp"
	case ".cpp", ".cc", ".cxx", ".hpp", ".hxx":
		return "cpp"
	case ".rb":
		return "ruby"
	case ".java":
		return "java"
	default:
		return "unknown"
	}
}

func grammarFor(lang string) *sitter.Language {
	switch lang {
	case "typescript":
		return typescript.GetLanguage()
	case "tsx", "jsx":
		return tsx.GetLanguage()
	case "javascript":
		return javascript.GetLanguage()
	case "python":
		return python.GetLanguage()
	case "go":
		return golang.GetLanguage()
	case "rust":
		return rust.GetLanguage()
	case "csharp":
		return csharp.GetLanguage()
	case "cpp":
		return cpp.GetLanguage()
	case "ruby":
		return ruby.GetLanguage()
	case "java":
		return java.GetLanguage()
	default:
		return nil
	}
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

// symbolNodeTypes maps tree-sitter node types → symbol kind strings.
// Each language has slightly different names; we handle the union here.
var symbolNodeTypes = map[string]string{
	// TypeScript / JavaScript
	"function_declaration":   "function",
	"method_definition":      "method",
	"class_declaration":      "class",
	"interface_declaration":  "interface",
	"type_alias_declaration": "type",
	"lexical_declaration":    "variable",
	"variable_declaration":   "variable",
	"export_statement":       "", // descend into children
	"arrow_function":         "function",
	// Go
	"function_declaration_go": "function", // handled by alias below
	"method_declaration":      "method",
	"type_declaration":        "type",
	"const_declaration":       "variable",
	// Python
	"function_definition":  "function",
	"class_definition":     "class",
	"decorated_definition": "", // descend
	// Rust
	"function_item": "function",
	"struct_item":   "class",
	"enum_item":     "type",
	"impl_item":     "", // descend
	"trait_item":    "interface",
	// C# (unique to C#)
	"constructor_declaration":  "function",
	"struct_declaration":       "class",
	"enum_declaration":         "type",
	"record_declaration":       "class",
	"local_function_statement": "function",
	// C++ (function_definition shared with Python above → "function")
	"class_specifier":  "class",
	"struct_specifier": "class",
	// Ruby
	"method":           "method",
	"singleton_method": "method",
	"module":           "type",
	"class":            "class",
	// (Ruby "class" and Java "class_declaration"/"interface_declaration" reuse
	// the entries above; Java method_declaration reuses Go's mapping.)
}

// containerSymbolTypes are declaration nodes that name a scope we record as a symbol
// but must also descend into — otherwise nested methods/functions inside classes are invisible.
var containerSymbolTypes = map[string]bool{
	"class_declaration":     true, // TS/JS/C#/Java
	"interface_declaration": true, // TS/JS/C#/Java
	"struct_declaration":    true, // C#
	"record_declaration":    true, // C#
	"class_definition":      true, // Python
	"class_specifier":       true, // C++
	"struct_specifier":      true, // C++
	"class":                 true, // Ruby
	"module":                true, // Ruby
}

func extractSymbols(root *sitter.Node, src []byte, lang string) []db.Symbol {
	var symbols []db.Symbol
	var walk func(node *sitter.Node)
	walk = func(node *sitter.Node) {
		kind, ok := symbolNodeTypes[node.Type()]
		if ok && kind != "" {
			name := extractName(node, src, lang)
			if name != "" {
				symbols = append(symbols, db.Symbol{
					Name:      name,
					Kind:      kind,
					LineStart: int(node.StartPoint().Row) + 1,
					LineEnd:   int(node.EndPoint().Row) + 1,
				})
				if !containerSymbolTypes[node.Type()] {
					return // leaf symbol — stop descending into its body
				}
				// container (class/interface/struct/record) — fall through to descend
			}
		}
		for i := 0; i < int(node.ChildCount()); i++ {
			walk(node.Child(i))
		}
	}
	walk(root)
	return symbols
}

// extractName finds the declared identifier for a node.
func extractName(node *sitter.Node, src []byte, lang string) string {
	// Use the grammar's named "name" field first — avoids confusing return types
	// with method names in C# (where return type appears before name in child order).
	if nameNode := node.ChildByFieldName("name"); nameNode != nil {
		return nameNode.Content(src)
	}
	// C++: the function name is nested in a declarator chain
	// (function_definition → declarator: function_declarator → declarator: identifier).
	if lang == "cpp" {
		if d := node.ChildByFieldName("declarator"); d != nil {
			if n := cppDeclaratorName(d, src); n != "" {
				return n
			}
		}
	}
	// Fallback: walk children for any identifier-like node
	for i := 0; i < int(node.ChildCount()); i++ {
		child := node.Child(i)
		t := child.Type()
		if t == "identifier" || t == "name" || t == "property_identifier" || t == "type_identifier" {
			return child.Content(src)
		}
	}
	return ""
}

// cppDeclaratorName walks a C++ declarator to the innermost declared name.
// For a qualified name (Class::method) it returns the final segment.
func cppDeclaratorName(node *sitter.Node, src []byte) string {
	switch node.Type() {
	case "identifier", "field_identifier", "type_identifier", "operator_name", "destructor_name":
		return node.Content(src)
	case "qualified_identifier":
		// Class::method — take the rightmost name.
		if n := node.ChildByFieldName("name"); n != nil {
			return cppDeclaratorName(n, src)
		}
	}
	// pointer_declarator / reference_declarator / function_declarator / etc. —
	// descend through the nested "declarator" field.
	if d := node.ChildByFieldName("declarator"); d != nil {
		return cppDeclaratorName(d, src)
	}
	return ""
}

// ─── Import extraction ────────────────────────────────────────────────────────

func extractImports(root *sitter.Node, src []byte, lang, relPath string) []string {
	switch lang {
	case "typescript", "tsx", "javascript", "jsx":
		return extractJSImports(root, src, relPath)
	case "python":
		return extractPythonImports(root, src)
	case "go":
		return extractGoImports(root, src)
	default:
		return nil
	}
}

func extractJSImports(root *sitter.Node, src []byte, relPath string) []string {
	var imports []string
	base := filepath.Dir(relPath)
	var walk func(node *sitter.Node)
	walk = func(node *sitter.Node) {
		if node.Type() == "import_statement" || node.Type() == "import_declaration" {
			// find string literal child
			for i := 0; i < int(node.ChildCount()); i++ {
				child := node.Child(i)
				if child.Type() == "string" {
					spec := unquote(child.Content(src))
					if strings.HasPrefix(spec, ".") {
						// relative import — resolve against file's directory
						resolved := filepath.ToSlash(filepath.Join(base, spec))
						imports = append(imports, resolved)
					} else {
						imports = append(imports, spec) // bare module specifier
					}
					break
				}
			}
		}
		for i := 0; i < int(node.ChildCount()); i++ {
			walk(node.Child(i))
		}
	}
	walk(root)
	return imports
}

func extractPythonImports(root *sitter.Node, src []byte) []string {
	var imports []string
	var walk func(node *sitter.Node)
	walk = func(node *sitter.Node) {
		if node.Type() == "import_statement" || node.Type() == "import_from_statement" {
			for i := 0; i < int(node.ChildCount()); i++ {
				child := node.Child(i)
				if child.Type() == "dotted_name" || child.Type() == "relative_import" {
					imports = append(imports, child.Content(src))
					break
				}
			}
		}
		for i := 0; i < int(node.ChildCount()); i++ {
			walk(node.Child(i))
		}
	}
	walk(root)
	return imports
}

func extractGoImports(root *sitter.Node, src []byte) []string {
	var imports []string
	var walk func(node *sitter.Node)
	walk = func(node *sitter.Node) {
		if node.Type() == "import_spec" {
			for i := 0; i < int(node.ChildCount()); i++ {
				child := node.Child(i)
				if child.Type() == "interpreted_string_literal" {
					imports = append(imports, unquote(child.Content(src)))
					break
				}
			}
		}
		for i := 0; i < int(node.ChildCount()); i++ {
			walk(node.Child(i))
		}
	}
	walk(root)
	return imports
}

// ─── C# import extraction (regex-based) ──────────────────────────────────────
// C# uses namespace-based imports, not file paths. We extract:
//   - The file's own namespace declaration → "#ns:Foo.Bar" entry
//   - Internal using directives → "Foo.Bar" entries (external ones are filtered)
// The indexer resolves these to file IDs via a separate namespace→fileID map.

// externalCSharpPrefixes are well-known external/Unity namespaces to skip.
var externalCSharpPrefixes = []string{
	"System", "Unity", "UnityEngine", "UnityEditor",
	"TMPro", "Newtonsoft", "Microsoft", "Mono",
	"Cinemachine", "DG", "NUnit", "JetBrains",
	"Photon", "Mirror", "FishNet", "PlayFab",
	"Sirenix", "Odin", "AOT", "NaughtyAttributes",
}

func extractCSharpImports(src []byte) []string {
	var imports []string
	for _, rawLine := range strings.Split(string(src), "\n") {
		line := strings.TrimSpace(rawLine)
		// Skip comments and empty lines
		if line == "" || strings.HasPrefix(line, "//") ||
			strings.HasPrefix(line, "*") || strings.HasPrefix(line, "/*") {
			continue
		}
		// Strip inline comment
		if idx := strings.Index(line, "//"); idx >= 0 {
			line = strings.TrimSpace(line[:idx])
		}

		// Namespace declaration (the file's own namespace)
		if strings.HasPrefix(line, "namespace ") {
			ns := strings.TrimPrefix(line, "namespace ")
			ns = strings.TrimRight(ns, " {;")
			ns = strings.TrimSpace(ns)
			// Skip partial or generic namespace artifacts
			if ns != "" && !strings.ContainsAny(ns, "(<{") {
				imports = append(imports, "#ns:"+ns)
			}
			continue
		}

		// Using directive
		if strings.HasPrefix(line, "using ") && strings.HasSuffix(line, ";") {
			name := strings.TrimPrefix(line, "using ")
			name = strings.TrimSuffix(name, ";")
			name = strings.TrimSpace(name)
			// Skip: static using, alias using
			if strings.HasPrefix(name, "static ") || strings.Contains(name, " = ") {
				continue
			}
			// Skip well-known external namespaces
			if isCSharpExternal(name) {
				continue
			}
			imports = append(imports, name)
		}
	}
	return imports
}

func isCSharpExternal(ns string) bool {
	for _, prefix := range externalCSharpPrefixes {
		if ns == prefix || strings.HasPrefix(ns, prefix+".") {
			return true
		}
	}
	return false
}

// ─── Call extraction ──────────────────────────────────────────────────────────

// callNodeTypes are tree-sitter node types that represent a function/method call.
var callNodeTypes = map[string]bool{
	"call_expression":       true, // TS, JS, Go, Rust
	"call":                  true, // Python
	"new_expression":        true, // TS/JS: new Foo()
	"invocation_expression": true, // C#
}

// scopeNodeTypes introduce a named callable scope (function, method, closure).
// When the walker enters one of these it pushes the function name onto the stack
// so we know which function is the caller for any calls found inside it.
var scopeNodeTypes = map[string]bool{
	// TypeScript / JavaScript
	"function_declaration":           true,
	"method_definition":              true,
	"arrow_function":                 true,
	"function":                       true, // function expression
	"generator_function_declaration": true,
	// Go
	"method_declaration": true,
	"func_literal":       true,
	// Python
	"function_definition": true,
	// Rust
	"function_item":      true,
	"closure_expression": true,
	// C#
	"constructor_declaration":  true,
	"local_function_statement": true,
}

// extractCalls walks the AST and returns every function/method call site found,
// annotated with the name of the enclosing function (CallerSymbol).
// csNodeDiagDone gates the one-time C# node-type diagnostic log.
var csNodeDiagDone atomic.Bool

func extractCalls(root *sitter.Node, src []byte, lang string) []RawCall {
	var calls []RawCall
	var scope []string // stack of enclosing function names

	// One-time diagnostic: log every unique node type seen in the first C# file
	// so we can verify the tree-sitter grammar's actual node names.
	var diagTypes map[string]int
	if lang == "csharp" && csNodeDiagDone.CompareAndSwap(false, true) {
		diagTypes = make(map[string]int)
	}

	var walk func(*sitter.Node)
	walk = func(n *sitter.Node) {
		t := n.Type()

		if diagTypes != nil {
			diagTypes[t]++
		}

		// Scope push/pop: enter function body, recurse, exit.
		if scopeNodeTypes[t] {
			name := extractName(n, src, lang)
			scope = append(scope, name)
			for i := 0; i < int(n.ChildCount()); i++ {
				walk(n.Child(i))
			}
			scope = scope[:len(scope)-1]
			return
		}

		// Record a call site.
		if callNodeTypes[t] {
			callee := extractCalleeName(n, src)
			if callee != "" && len(callee) >= 2 {
				caller := ""
				if len(scope) > 0 {
					caller = scope[len(scope)-1]
				}
				calls = append(calls, RawCall{CallerSymbol: caller, CalleeName: callee})
			}
			// Still descend — calls can be nested (foo(bar()))
		}

		for i := 0; i < int(n.ChildCount()); i++ {
			walk(n.Child(i))
		}
	}
	walk(root)

	if diagTypes != nil {
		log.Printf("[parser/csharp] unique node types in first C# file (%d total nodes):", len(diagTypes))
		for nt, count := range diagTypes {
			log.Printf("[parser/csharp]   %-40s %d", nt, count)
		}
	}

	return calls
}

// extractCalleeName returns the function/constructor name from a call node.
// It handles simple calls (foo()), method calls (obj.method()), and constructors (new Foo()).
func extractCalleeName(n *sitter.Node, src []byte) string {
	// Try the "function" named field first (TS/JS/Go/Python call_expression, call).
	fn := n.ChildByFieldName("function")
	if fn == nil {
		// new_expression uses "constructor"; invocation_expression uses "expression"
		fn = n.ChildByFieldName("constructor")
	}
	if fn == nil {
		fn = n.ChildByFieldName("expression")
	}
	if fn == nil {
		return ""
	}

	switch fn.Type() {
	case "identifier", "type_identifier":
		return fn.Content(src)

	case "member_expression": // TS/JS:  obj.method
		prop := fn.ChildByFieldName("property")
		if prop != nil {
			return prop.Content(src)
		}

	case "selector_expression": // Go:     pkg.Func / obj.Method
		field := fn.ChildByFieldName("field")
		if field != nil {
			return field.Content(src)
		}

	case "attribute": // Python: obj.method
		attr := fn.ChildByFieldName("attribute")
		if attr != nil {
			return attr.Content(src)
		}

	case "member_access_expression": // C#:    obj.Method
		name := fn.ChildByFieldName("name")
		if name != nil {
			return name.Content(src)
		}
	}

	// Fallback: scan children for the last identifier-like node.
	for i := int(fn.ChildCount()) - 1; i >= 0; i-- {
		c := fn.Child(i)
		ct := c.Type()
		if ct == "identifier" || ct == "property_identifier" ||
			ct == "field_identifier" || ct == "type_identifier" {
			content := c.Content(src)
			if content != "." {
				return content
			}
		}
	}
	return ""
}

// ─── Utilities ────────────────────────────────────────────────────────────────

func countLines(src []byte) int {
	if len(src) == 0 {
		return 0
	}
	count := 1
	for _, b := range src {
		if b == '\n' {
			count++
		}
	}
	return count
}

func unquote(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && (s[0] == '"' || s[0] == '\'') {
		return s[1 : len(s)-1]
	}
	return s
}
