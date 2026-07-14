// Package registry is the infra service registry (INFRA_LAYER_PLAN.md).
//
// A "service" is one external-infrastructure product Axiom knows how to
// render and (later) detect: aws/rds, openai/api, stripe/api, generic/postgres.
// Identity is Category x Provider x Service: the CATEGORY defines edge
// semantics and the node silhouette, the PROVIDER defines the brand skin,
// the SERVICE carries config fields and detection signatures.
//
// Adding a service is a data change: drop a .json file into a registry layer.
// Resolution is layered — later layers override earlier by service id:
//
//	1. embedded defaults   (archd-go/internal/registry/services/*.json, go:embed)
//	2. global user layer   (~/.config/axiom/services/*.json)
//	3. workspace layer     (<root>/.axiom/services/*.json)
//
// The renderer never bundles its own copy: it fetches the resolved registry
// from GET /api/registry/services, so archd and canvas cannot disagree.
package registry

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

//go:embed services/*.json
var embedded embed.FS

// Categories is the closed set of semantic roles. Each category defines which
// dependency_type values are legal for edges touching its nodes.
var Categories = map[string][]string{
	"database":      {"READS", "WRITES", "MIGRATES"},
	"cache":         {"READS", "WRITES"},
	"queue":         {"PUBLISHES", "CONSUMES"},
	"storage":       {"READS", "WRITES"},
	"search":        {"QUERIES", "INDEXES"},
	"llm":           {"CALLS"},
	"api":           {"CALLS", "HANDLES_WEBHOOK"},
	"auth":          {"AUTHENTICATES_VIA"},
	"platform":      {"DEPLOYS_TO"},
	"cdn":           {"SERVES_VIA"},
	"observability": {"REPORTS_TO"},
	"email":         {"SENDS_VIA"},
}

// Brand is the visual identity of a service on the canvas.
type Brand struct {
	Icon      string `json:"icon"`                // simple-icons slug ("amazonrds", "openai")
	Color     string `json:"color"`               // brand accent, light theme
	DarkColor string `json:"darkColor,omitempty"` // optional dark-theme override
}

// Detect holds the (Phase I2/I3, currently unused) detection signatures.
type Detect struct {
	Packages    map[string][]string `json:"packages,omitempty"`    // language → package names
	EnvPatterns []string            `json:"envPatterns,omitempty"` // env var name prefixes
	URLPatterns []string            `json:"urlPatterns,omitempty"` // hostname regexes
}

// Service is one registry entry.
type Service struct {
	ID           string   `json:"id"`   // "aws/rds" — provider/slug, unique
	Name         string   `json:"name"` // "Amazon RDS"
	Category     string   `json:"category"`
	Subtype      string   `json:"subtype,omitempty"` // category-specific: 'sql'|'document'|'kv'|'vector'|...
	Provider     string   `json:"provider"`
	Brand        Brand    `json:"brand"`
	ConfigFields []string `json:"configFields,omitempty"`
	Detect       *Detect  `json:"detect,omitempty"`
	Layer        string   `json:"layer,omitempty"` // resolved provenance: 'embedded'|'user'|'workspace'
}

// EdgeKinds returns the legal dependency_type values for this service's category.
func (s Service) EdgeKinds() []string {
	return Categories[s.Category]
}

// Registry is a resolved, immutable view of all service definitions.
type Registry struct {
	mu       sync.RWMutex
	services map[string]Service // id → service
}

// Validate checks a single service definition. Returns nil if usable.
func Validate(s Service) error {
	if s.ID == "" || !strings.Contains(s.ID, "/") {
		return fmt.Errorf("service id %q must be provider/slug", s.ID)
	}
	if s.Name == "" {
		return fmt.Errorf("service %s: name is required", s.ID)
	}
	if _, ok := Categories[s.Category]; !ok {
		return fmt.Errorf("service %s: unknown category %q", s.ID, s.Category)
	}
	if s.Provider == "" {
		return fmt.Errorf("service %s: provider is required", s.ID)
	}
	return nil
}

// Load resolves the layered registry. workspaceRoots may be empty (no
// workspace layer). Invalid definitions are logged and skipped — a bad
// user-supplied file must never take archd down.
func Load(workspaceRoots []string) *Registry {
	r := &Registry{services: make(map[string]Service)}
	r.loadFS(embedded, "services", "embedded")

	if home, err := os.UserHomeDir(); err == nil {
		r.loadDir(filepath.Join(home, ".config", "axiom", "services"), "user")
	}
	for _, root := range workspaceRoots {
		r.loadDir(filepath.Join(root, ".axiom", "services"), "workspace")
	}
	return r
}

func (r *Registry) loadFS(fsys fs.FS, dir, layer string) {
	entries, err := fs.ReadDir(fsys, dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := fs.ReadFile(fsys, dir+"/"+e.Name())
		if err != nil {
			log.Printf("[registry] read %s/%s: %v", dir, e.Name(), err)
			continue
		}
		r.addFile(data, layer, e.Name())
	}
}

func (r *Registry) loadDir(dir, layer string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return // layer directory not present — fine
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			log.Printf("[registry] read %s: %v", filepath.Join(dir, e.Name()), err)
			continue
		}
		r.addFile(data, layer, e.Name())
	}
}

// addFile parses a definition file holding one Service or an array of them.
func (r *Registry) addFile(data []byte, layer, name string) {
	var many []Service
	if err := json.Unmarshal(data, &many); err != nil {
		var one Service
		if err2 := json.Unmarshal(data, &one); err2 != nil {
			log.Printf("[registry] %s (%s): not a service or service array: %v", name, layer, err2)
			return
		}
		many = []Service{one}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range many {
		if err := Validate(s); err != nil {
			log.Printf("[registry] %s (%s): skipped: %v", name, layer, err)
			continue
		}
		s.Layer = layer
		r.services[s.ID] = s // later layers override by id
	}
}

// Get returns the service for an id, or false.
func (r *Registry) Get(id string) (Service, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.services[id]
	return s, ok
}

// All returns every service sorted by provider then name — the canonical
// order for pickers and the API response.
func (r *Registry) All() []Service {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Service, 0, len(r.services))
	for _, s := range r.services {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Provider != out[j].Provider {
			return out[i].Provider < out[j].Provider
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// ValidEdgeKind reports whether kind is legal for the category.
func ValidEdgeKind(category, kind string) bool {
	for _, k := range Categories[category] {
		if k == kind {
			return true
		}
	}
	return false
}

// CategoryList returns all category names sorted, for the API response.
func CategoryList() []map[string]any {
	names := make([]string, 0, len(Categories))
	for c := range Categories {
		names = append(names, c)
	}
	sort.Strings(names)
	out := make([]map[string]any, 0, len(names))
	for _, c := range names {
		out = append(out, map[string]any{"id": c, "edgeKinds": Categories[c]})
	}
	return out
}
