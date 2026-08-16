// Variable reference (def-use) extraction - the static half of Axiom's
// "variable references" primitive (plan Phase 7; renamed from data-flow
// slicing after hostile review: tree-sitter is file-scoped and has no type
// resolver, so cross-file linking is name-based heuristics, labeled as such).
//
// Kinds:
//
//	def   - a binding is introduced: let/const/var declarator, Go := / var
//	        spec, import bindings, with-as / range targets
//	param - function/method/lambda parameter
//	write - an existing binding is reassigned/updated: assignment LHS,
//	        augmented assignment, x++/x--  (Python plain assignment is
//	        classified 'write' - the language has no declaration syntax)
//	read  - any other identifier occurrence (member-access property names,
//	        object keys, declaration names, and this/self/cls are excluded)
//
// Supported: typescript, tsx, jsx, javascript, python, go - the languages the
// runtime layer traces. Others return nil.
package parser

import (
	"os"

	sitter "github.com/smacker/go-tree-sitter"
)

// VarRef is one variable occurrence in a file.
type VarRef struct {
	Name            string
	Kind            string // 'def'|'param'|'write'|'read'
	Line            int    // 1-based
	EnclosingSymbol string // nearest named function/method scope; "" = module level
}

// skippedNames are context keywords that would flood results without adding
// data-flow signal.
var skippedNames = map[string]bool{
	"this": true, "self": true, "cls": true, "_": true,
	"undefined": true, "None": true, "nil": true,
}

// varRefExtractor carries the walk state.
type varRefExtractor struct {
	src        []byte
	lang       string
	refs       []VarRef
	scope      []string
	classified map[uintptr]string // node ID → kind, set before the leaf is visited
	excluded   map[uintptr]bool   // node IDs that are not variable references
}

func extractVarRefs(root *sitter.Node, src []byte, lang string) []VarRef {
	switch lang {
	case "typescript", "tsx", "jsx", "javascript", "python", "go":
	default:
		return nil
	}
	e := &varRefExtractor{
		src:        src,
		lang:       lang,
		classified: make(map[uintptr]string),
		excluded:   make(map[uintptr]bool),
	}
	e.walk(root)
	return e.refs
}

// ExtractFileVarRefs parses a single file and returns every reference to
// `variable` (all kinds, per-occurrence with exact lines). Used by the
// data-flow API for exact on-demand results (reads aren't stored per-line).
// If variable is empty, returns all references.
func ExtractFileVarRefs(absPath, relPath, variable string) ([]VarRef, string, error) {
	src, err := os.ReadFile(absPath)
	if err != nil {
		return nil, "", err
	}
	lang := detectLanguage(absPath)
	grammar := grammarFor(lang)
	if grammar == nil {
		return nil, lang, nil
	}
	p := sitter.NewParser()
	defer p.Close() // deterministic C-heap release (this runs up to maxFiles×/request)
	p.SetLanguage(grammar)
	tree := p.Parse(nil, src)
	if tree == nil {
		return nil, lang, nil
	}
	defer tree.Close()
	all := extractVarRefs(tree.RootNode(), src, lang)
	if variable == "" {
		return all, lang, nil
	}
	filtered := all[:0]
	for _, r := range all {
		if r.Name == variable {
			filtered = append(filtered, r)
		}
	}
	return filtered, lang, nil
}

func (e *varRefExtractor) mark(n *sitter.Node, kind string) {
	if n != nil {
		e.classified[n.ID()] = kind
	}
}

func (e *varRefExtractor) exclude(n *sitter.Node) {
	if n != nil {
		e.excluded[n.ID()] = true
	}
}

func (e *varRefExtractor) excludeSubtree(n *sitter.Node) {
	if n == nil {
		return
	}
	e.excluded[n.ID()] = true
	for i := 0; i < int(n.ChildCount()); i++ {
		e.excludeSubtree(n.Child(i))
	}
}

func (e *varRefExtractor) add(n *sitter.Node, kind string) {
	name := n.Content(e.src)
	if name == "" || skippedNames[name] {
		return
	}
	enclosing := ""
	if len(e.scope) > 0 {
		enclosing = e.scope[len(e.scope)-1]
	}
	e.refs = append(e.refs, VarRef{
		Name:            name,
		Kind:            kind,
		Line:            int(n.StartPoint().Row) + 1,
		EnclosingSymbol: enclosing,
	})
}

// markBindingPattern marks every binding identifier inside a (possibly
// destructured) binding target: object/array/tuple patterns, defaults, rest.
// Default values and type annotations are NOT marked (they are reads/types).
func (e *varRefExtractor) markBindingPattern(n *sitter.Node, kind string) {
	if n == nil {
		return
	}
	switch n.Type() {
	case "identifier", "shorthand_property_identifier_pattern":
		e.mark(n, kind)
	case "pair_pattern": // { key: binding } - key is a property name
		e.exclude(n.ChildByFieldName("key"))
		e.markBindingPattern(n.ChildByFieldName("value"), kind)
	case "assignment_pattern": // binding = default - default value is a read
		e.markBindingPattern(n.ChildByFieldName("left"), kind)
	case "default_parameter", "typed_default_parameter": // Python: x=1 / x: T = 1
		e.markBindingPattern(n.ChildByFieldName("name"), kind)
	case "typed_parameter": // Python: x: T
		e.markBindingPattern(n.NamedChild(0), kind)
	case "required_parameter", "optional_parameter": // TS: pattern [?]: T [= v]
		e.markBindingPattern(n.ChildByFieldName("pattern"), kind)
	case "parameter_declaration", "variadic_parameter_declaration": // Go: a, b T
		for i := 0; i < int(n.NamedChildCount()); i++ {
			if c := n.NamedChild(i); c.Type() == "identifier" {
				e.mark(c, kind)
			}
		}
	case "object_pattern", "array_pattern", "rest_pattern", "tuple_pattern",
		"list_splat_pattern", "dictionary_splat_pattern", "formal_parameters",
		"parameters", "lambda_parameters", "parameter_list":
		for i := 0; i < int(n.NamedChildCount()); i++ {
			e.markBindingPattern(n.NamedChild(i), kind)
		}
	}
}

// markWriteTarget marks assignable identifiers in an assignment LHS as writes.
// For obj.x / obj[i] targets the container identifier remains a read (the
// object is read; its property is written) and property names are excluded.
func (e *varRefExtractor) markWriteTarget(n *sitter.Node) {
	if n == nil {
		return
	}
	switch n.Type() {
	case "identifier":
		e.mark(n, "write")
	case "tuple_pattern", "list_pattern", "pattern_list", "expression_list", "tuple":
		for i := 0; i < int(n.NamedChildCount()); i++ {
			e.markWriteTarget(n.NamedChild(i))
		}
	case "attribute": // Python obj.attr = …
		e.exclude(n.ChildByFieldName("attribute"))
	case "member_expression", "selector_expression",
		"subscript", "subscript_expression", "index_expression":
		// container identifier stays a read; nothing to mark
	case "parenthesized_expression":
		for i := 0; i < int(n.NamedChildCount()); i++ {
			e.markWriteTarget(n.NamedChild(i))
		}
	}
}

func (e *varRefExtractor) walk(n *sitter.Node) {
	if n == nil {
		return
	}
	t := n.Type()

	// ── scope tracking (reuses the call-graph scope node set) ──
	if scopeNodeTypes[t] {
		name := extractName(n, e.src, e.lang)
		e.scope = append(e.scope, name)
		defer func() { e.scope = e.scope[:len(e.scope)-1] }()
		e.exclude(n.ChildByFieldName("name")) // declaration name ≠ variable ref
		// Arrow with a single bare parameter: `x => …`
		if t == "arrow_function" {
			if p := n.ChildByFieldName("parameter"); p != nil {
				e.mark(p, "param")
			}
		}
	}

	switch t {
	// ── defs ──
	case "variable_declarator": // JS/TS: let/const/var X = …
		e.markBindingPattern(n.ChildByFieldName("name"), "def")
	case "for_in_statement": // JS/TS: for (const x of/in …) - x isn't a declarator
		if l := n.ChildByFieldName("left"); l != nil {
			if n.ChildByFieldName("kind") != nil { // const/let/var present → binding
				e.markBindingPattern(l, "def")
			} else if l.Type() == "identifier" { // for (x of …) reassigns existing x
				e.mark(l, "write")
			}
		}
	case "short_var_declaration": // Go: x, y := …
		if l := n.ChildByFieldName("left"); l != nil {
			for i := 0; i < int(l.NamedChildCount()); i++ {
				if c := l.NamedChild(i); c.Type() == "identifier" {
					e.mark(c, "def")
				}
			}
		}
	case "var_spec", "const_spec": // Go: var x T = … / const x = …
		for i := 0; i < int(n.NamedChildCount()); i++ {
			c := n.NamedChild(i)
			if c.Type() == "identifier" {
				e.mark(c, "def")
			} else {
				break // names come first; type/value follow
			}
		}
	case "range_clause": // Go: for i, v := range xs  (:= declares, = reassigns)
		if l := n.ChildByFieldName("left"); l != nil {
			kind := "write"
			for i := 0; i < int(n.ChildCount()); i++ {
				if n.Child(i).Type() == ":=" {
					kind = "def"
					break
				}
			}
			for i := 0; i < int(l.NamedChildCount()); i++ {
				if c := l.NamedChild(i); c.Type() == "identifier" {
					e.mark(c, kind)
				}
			}
		}
	case "import_specifier": // JS: import { a as b }
		if a := n.ChildByFieldName("alias"); a != nil {
			e.mark(a, "def")
			e.exclude(n.ChildByFieldName("name"))
		} else {
			e.mark(n.ChildByFieldName("name"), "def")
		}
	case "namespace_import", "import_clause": // JS: import * as ns / import Def
		for i := 0; i < int(n.NamedChildCount()); i++ {
			if c := n.NamedChild(i); c.Type() == "identifier" {
				e.mark(c, "def")
			}
		}
	case "aliased_import": // Python: import x as y
		e.excludeSubtree(n.ChildByFieldName("name"))
		e.mark(n.ChildByFieldName("alias"), "def")
	case "import_from_statement": // Python: from m import a, b
		mod := n.ChildByFieldName("module_name")
		e.excludeSubtree(mod)
		for i := 0; i < int(n.NamedChildCount()); i++ {
			c := n.NamedChild(i)
			if c.Type() == "dotted_name" && (mod == nil || c.ID() != mod.ID()) {
				if int(c.NamedChildCount()) == 1 {
					e.mark(c.NamedChild(0), "def")
				} else {
					e.excludeSubtree(c)
				}
			}
		}
	case "import_statement": // Python: import a.b - binds first segment
		for i := 0; i < int(n.NamedChildCount()); i++ {
			c := n.NamedChild(i)
			if c.Type() == "dotted_name" {
				e.excludeSubtree(c)
				if id := c.NamedChild(0); id != nil {
					delete(e.excluded, id.ID())
					e.mark(id, "def")
				}
			}
		}
	case "as_pattern_target": // Python: with open() as f / except E as ex
		if c := n.NamedChild(0); c != nil && c.Type() == "identifier" {
			e.mark(c, "def")
		}

	// ── params ──
	case "formal_parameters", "parameters", "lambda_parameters", "parameter_list":
		e.markBindingPattern(n, "param")

	// ── writes ──
	case "assignment_expression", "augmented_assignment_expression", // JS/TS
		"augmented_assignment", "assignment": // Python
		e.markWriteTarget(n.ChildByFieldName("left"))
	case "named_expression": // Python walrus: (x := …)
		e.mark(n.ChildByFieldName("name"), "write")
	case "assignment_statement": // Go: x = … / x, y = …
		if l := n.ChildByFieldName("left"); l != nil {
			for i := 0; i < int(l.NamedChildCount()); i++ {
				e.markWriteTarget(l.NamedChild(i))
			}
		}
	case "update_expression": // JS: x++
		if a := n.ChildByFieldName("argument"); a != nil && a.Type() == "identifier" {
			e.mark(a, "write")
		}
	case "inc_dec_statement": // Go: x++
		if c := n.NamedChild(0); c != nil && c.Type() == "identifier" {
			e.mark(c, "write")
		}
	case "for_statement": // Python: for x in …
		if e.lang == "python" {
			e.markWriteTarget(n.ChildByFieldName("left"))
		}

	// ── exclusions: identifier-shaped nodes that aren't variables ──
	case "attribute": // Python obj.attr
		e.exclude(n.ChildByFieldName("attribute"))
	case "keyword_argument": // Python f(name=…)
		e.exclude(n.ChildByFieldName("name"))
	case "pair": // JS object literal { key: value }
		if k := n.ChildByFieldName("key"); k != nil && k.Type() == "identifier" {
			e.exclude(k)
		}
	case "keyed_element": // Go composite literal { Field: value }
		if k := n.NamedChild(0); k != nil {
			if k.Type() == "literal_element" { // grammar wraps the key
				k = k.NamedChild(0)
			}
			if k != nil && k.Type() == "identifier" {
				e.exclude(k)
			}
		}
	case "field_declaration": // Go struct fields aren't variables
		for i := 0; i < int(n.NamedChildCount()); i++ {
			if c := n.NamedChild(i); c.Type() == "field_identifier" || c.Type() == "identifier" {
				e.exclude(c)
			}
		}
	}

	// ── identifier leaves ──
	// (property_identifier / field_identifier / type_identifier are distinct
	// node types and never reach here as "identifier".)
	if t == "identifier" || t == "shorthand_property_identifier" ||
		t == "shorthand_property_identifier_pattern" {
		if e.excluded[n.ID()] {
			return
		}
		if kind, ok := e.classified[n.ID()]; ok {
			e.add(n, kind)
		} else {
			// bare identifier, or { a } object-literal shorthand - a read
			e.add(n, "read")
		}
		return
	}

	for i := 0; i < int(n.ChildCount()); i++ {
		e.walk(n.Child(i))
	}
}
