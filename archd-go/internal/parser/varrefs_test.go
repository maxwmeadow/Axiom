package parser

import (
	"os"
	"path/filepath"
	"testing"
)

// refKey is a compact assertion form: name/kind.
func has(refs []VarRef, name, kind string) bool {
	for _, r := range refs {
		if r.Name == name && r.Kind == kind {
			return true
		}
	}
	return false
}

func kindsOf(refs []VarRef, name string) map[string]int {
	out := map[string]int{}
	for _, r := range refs {
		if r.Name == name {
			out[r.Kind]++
		}
	}
	return out
}

func parseSrc(t *testing.T, name, src string) []VarRef {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := ParseFile(path, name)
	if err != nil {
		t.Fatal(err)
	}
	return res.VarRefs
}

func TestPythonVarRefs(t *testing.T) {
	refs := parseSrc(t, "sample.py", `
import os
from decimal import Decimal as D

RATE = 0.07

def total(amount, qty=1):
    subtotal = amount * qty
    subtotal += subtotal * RATE
    tax = D(subtotal)
    for item in [1, 2]:
        subtotal += item
    obj.field = amount
    print(name=subtotal)
    return subtotal

class Cart:
    def add(self, price):
        self.total += price
`)
	checks := []struct{ name, kind string }{
		{"os", "def"}, {"D", "def"},
		{"amount", "param"}, {"qty", "param"}, {"price", "param"},
		{"RATE", "write"},     // module-level assignment (Python has no decl syntax)
		{"subtotal", "write"}, // = and +=
		{"subtotal", "read"},
		{"tax", "write"},
		{"item", "write"}, // for target
		{"amount", "read"},
		{"RATE", "read"},
	}
	for _, c := range checks {
		if !has(refs, c.name, c.kind) {
			t.Errorf("python: missing %s/%s; got %v", c.name, c.kind, kindsOf(refs, c.name))
		}
	}
	// exclusions
	if has(refs, "self", "read") || has(refs, "self", "param") {
		t.Error("python: self should be skipped")
	}
	if has(refs, "field", "read") || has(refs, "field", "write") {
		t.Error("python: attribute name should be excluded")
	}
	if kindsOf(refs, "name")["read"] > 0 {
		t.Error("python: keyword-argument name should be excluded")
	}
	// obj in obj.field = amount → read (container read, property written)
	if !has(refs, "obj", "read") {
		t.Error("python: obj should be a read")
	}
}

func TestJavaScriptVarRefs(t *testing.T) {
	refs := parseSrc(t, "sample.js", `
import def, { a, b as c } from './m'
import * as ns from './n'

const limit = 10
let count = 0

function tally(items, factor = 2) {
  let sum = 0
  for (const it of items) {
    sum += it * factor
  }
  count++
  const { x, y: z } = getPoint()
  const obj = { key: sum, shorthand }
  obj.prop = limit
  return sum
}

const area = (w) => w * limit
`)
	checks := []struct{ name, kind string }{
		{"def", "def"}, {"a", "def"}, {"c", "def"}, {"ns", "def"},
		{"limit", "def"}, {"count", "def"},
		{"items", "param"}, {"factor", "param"}, {"w", "param"},
		{"sum", "def"}, {"sum", "write"}, {"sum", "read"},
		{"it", "def"},
		{"count", "write"},         // count++
		{"x", "def"}, {"z", "def"}, // destructuring, aliased
		{"shorthand", "read"}, // object shorthand value
		{"limit", "read"},
	}
	for _, c := range checks {
		if !has(refs, c.name, c.kind) {
			t.Errorf("js: missing %s/%s; got %v", c.name, c.kind, kindsOf(refs, c.name))
		}
	}
	if has(refs, "b", "def") {
		t.Error("js: aliased import source name should be excluded")
	}
	if has(refs, "y", "def") || has(refs, "y", "read") {
		t.Error("js: pair_pattern key should be excluded")
	}
	if has(refs, "key", "read") {
		t.Error("js: object literal key should be excluded")
	}
	if has(refs, "prop", "read") || has(refs, "prop", "write") {
		t.Error("js: member property should be excluded")
	}
	if has(refs, "tally", "read") {
		t.Error("js: function declaration name should not be a var ref")
	}
}

func TestGoVarRefs(t *testing.T) {
	refs := parseSrc(t, "sample.go", `package main

import "fmt"

var rate = 0.07

func total(amount float64, qty int) float64 {
	subtotal := amount * float64(qty)
	subtotal += subtotal * rate
	var tax float64
	tax = subtotal / 10
	for i, v := range []int{1, 2} {
		subtotal += float64(i + v)
	}
	obj.Field = amount
	p := Point{X: subtotal}
	fmt.Println(p, tax)
	return subtotal
}
`)
	checks := []struct{ name, kind string }{
		{"rate", "def"},
		{"amount", "param"}, {"qty", "param"},
		{"subtotal", "def"}, {"subtotal", "write"}, {"subtotal", "read"},
		{"tax", "def"}, {"tax", "write"},
		{"i", "def"}, {"v", "def"},
		{"rate", "read"}, {"p", "def"},
	}
	for _, c := range checks {
		if !has(refs, c.name, c.kind) {
			t.Errorf("go: missing %s/%s; got %v", c.name, c.kind, kindsOf(refs, c.name))
		}
	}
	if has(refs, "X", "read") || has(refs, "X", "write") {
		t.Error("go: composite literal field name should be excluded")
	}
	if has(refs, "Field", "read") || has(refs, "Field", "write") {
		t.Error("go: selector field should be excluded (field_identifier)")
	}
}
