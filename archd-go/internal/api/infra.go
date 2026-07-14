// Infra layer HTTP endpoints (INFRA_LAYER_PLAN.md Phase I1).
//
//	GET  /api/registry/services              — resolved service registry (categories + services)
//	GET  /api/infra?workspace=               — list infra nodes + their edges
//	POST /api/infra                          — create/upsert an infra node
//	PUT  /api/infra/:id                      — update (rename, reskin, config, status)
//	DELETE /api/infra/:id?workspace=         — delete node (edges cleaned by trigger)
//	POST /api/infra/:id/position             — move on canvas {x, y, workspaceId}
//	POST /api/infra/connect                  — create a typed file/system→infra edge
//	DELETE /api/infra/edge/:id?workspace=    — remove an infra edge
package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/registry"
)

// reloadRegistry re-resolves the layered registry with all known workspace
// roots so <root>/.axiom/services/ definitions are picked up.
func (s *Server) reloadRegistry() {
	s.mu.RLock()
	paths := make([]string, 0, len(s.roots))
	for _, r := range s.roots {
		paths = append(paths, r.Path)
	}
	s.mu.RUnlock()
	s.registry = registry.Load(paths)
}

func (s *Server) handleRegistryServices(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	jsonOK(w, map[string]any{
		"categories": registry.CategoryList(),
		"services":   s.registry.All(),
	})
}

// applyService fills a node's category/provider/subtype from its registry
// entry so callers only need to send a service id. Explicit fields win when
// no service is set (unassigned generic nodes).
func (s *Server) applyService(n *db.InfraNode) error {
	if n.Service != "" {
		svc, ok := s.registry.Get(n.Service)
		if !ok {
			return fmt.Errorf("unknown service %q — see GET /api/registry/services", n.Service)
		}
		n.Category = svc.Category
		n.Provider = svc.Provider
		if n.Subtype == "" {
			n.Subtype = svc.Subtype
		}
		if n.Name == "" {
			n.Name = svc.Name
		}
		return nil
	}
	if _, ok := registry.Categories[n.Category]; n.Category != "" && !ok {
		return fmt.Errorf("unknown category %q", n.Category)
	}
	return nil
}

func (s *Server) handleInfra(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		workspaceID := r.URL.Query().Get("workspace")
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		nodes, err := db.GetInfraNodes(sqlDB, workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		edges, err := db.GetInfraEdges(sqlDB, workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		jsonOK(w, map[string]any{"nodes": nodes, "edges": edges})

	case http.MethodPost:
		var n db.InfraNode
		if err := json.NewDecoder(r.Body).Decode(&n); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		if err := s.applyService(&n); err != nil {
			jsonError(w, err.Error(), 400)
			return
		}
		if n.Name == "" {
			jsonError(w, "name is required (or send a service id to inherit its name)", 400)
			return
		}
		sqlDB, err := s.dbFor(n.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.UpsertInfraNode(sqlDB, &n); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastPatch("infra:upserted", n)
		jsonOK(w, n)

	default:
		http.NotFound(w, r)
	}
}

// handleInfraByID routes /api/infra/:id and /api/infra/:id/position.
func (s *Server) handleInfraByID(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/infra/")
	parts := strings.SplitN(rest, "/", 2)
	id := parts[0]
	sub := ""
	if len(parts) > 1 {
		sub = parts[1]
	}
	if id == "" {
		http.NotFound(w, r)
		return
	}

	switch {
	case r.Method == http.MethodPut && sub == "":
		var body struct {
			WorkspaceID string          `json:"workspaceId"`
			Name        *string         `json:"name"`
			Service     *string         `json:"service"` // reskin: re-resolves category/provider
			Subtype     *string         `json:"subtype"`
			Status      *string         `json:"status"` // 'proposed'|'confirmed'|'dismissed'
			Config      json.RawMessage `json:"config"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		sqlDB, err := s.dbFor(body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		n, err := db.GetInfraNode(sqlDB, id)
		if err != nil || n == nil {
			jsonError(w, "infra node not found", 404)
			return
		}
		if body.Name != nil {
			n.Name = *body.Name
		}
		if body.Service != nil {
			n.Service = *body.Service
			n.Subtype = "" // re-derive from the new service
			if err := s.applyService(n); err != nil {
				jsonError(w, err.Error(), 400)
				return
			}
		}
		if body.Subtype != nil {
			n.Subtype = *body.Subtype
		}
		if body.Status != nil {
			if *body.Status != "proposed" && *body.Status != "confirmed" && *body.Status != "dismissed" {
				jsonError(w, "status must be proposed|confirmed|dismissed", 400)
				return
			}
			n.Status = *body.Status
		}
		if body.Config != nil {
			n.Config = body.Config
		}
		if err := db.UpsertInfraNode(sqlDB, n); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastPatch("infra:upserted", *n)
		jsonOK(w, n)

	case r.Method == http.MethodDelete && sub == "":
		workspaceID := r.URL.Query().Get("workspace")
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.DeleteInfraNode(sqlDB, id); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.broadcastPatch("infra:deleted", map[string]string{"id": id, "workspaceId": workspaceID})
		jsonOK(w, map[string]string{"deleted": id})

	case r.Method == http.MethodPost && sub == "position":
		var body struct {
			WorkspaceID string  `json:"workspaceId"`
			X           float64 `json:"x"`
			Y           float64 `json:"y"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, "bad request", 400)
			return
		}
		sqlDB, err := s.dbFor(body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		if err := db.UpdateInfraPosition(sqlDB, id, body.X, body.Y); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		jsonOK(w, map[string]any{"id": id, "x": body.X, "y": body.Y})

	default:
		http.NotFound(w, r)
	}
}

// handleInfraConnect creates a typed edge from a file or system to an infra
// node, validating the edge kind against the node's category.
func (s *Server) handleInfraConnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string  `json:"workspaceId"`
		SrcID       string  `json:"srcId"`
		SrcType     string  `json:"srcType"` // 'file' | 'system'
		InfraID     string  `json:"infraId"`
		Kind        string  `json:"kind"` // 'READS'|'WRITES'|'PUBLISHES'|... per category
		Evidence    *string `json:"evidence"`
		CreatedBy   string  `json:"createdBy"` // 'user'|'agent'; defaults to 'user'
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	if body.SrcType != "file" && body.SrcType != "system" {
		jsonError(w, "srcType must be 'file' or 'system'", 400)
		return
	}
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	n, err := db.GetInfraNode(sqlDB, body.InfraID)
	if err != nil || n == nil {
		jsonError(w, "infra node not found", 404)
		return
	}
	if !registry.ValidEdgeKind(n.Category, body.Kind) {
		jsonError(w, fmt.Sprintf("edge kind %q is not valid for category %q (valid: %s)",
			body.Kind, n.Category, strings.Join(registry.Categories[n.Category], ", ")), 400)
		return
	}
	if body.CreatedBy == "" {
		body.CreatedBy = "user"
	}
	dep := db.Dependency{
		WorkspaceID:    body.WorkspaceID,
		Src:            body.SrcID,
		Dst:            body.InfraID,
		SrcType:        body.SrcType,
		DstType:        "infra",
		DependencyType: body.Kind,
		CreatedBy:      body.CreatedBy,
		Evidence:       body.Evidence,
	}
	if err := db.UpsertDependency(sqlDB, dep); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	s.broadcastPatch("infra:connected", dep)
	jsonOK(w, dep)
}

// handleInfraEdge handles DELETE /api/infra/edge/:id.
func (s *Server) handleInfraEdge(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/infra/edge/")
	if id == "" || r.Method != http.MethodDelete {
		http.NotFound(w, r)
		return
	}
	workspaceID := r.URL.Query().Get("workspace")
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	if err := db.DeleteDependency(sqlDB, id); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	s.broadcastPatch("infra:disconnected", map[string]string{"id": id, "workspaceId": workspaceID})
	jsonOK(w, map[string]string{"deleted": id})
}
