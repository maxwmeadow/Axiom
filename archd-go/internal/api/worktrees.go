package api

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/gitworktree"
	"axiom.local/archd/internal/indexer"
)

type rootOpenOptions struct {
	IgnoredPaths               []string
	SourceBoundariesReviewedAt *int64
}

type worktreeMonitor struct {
	cancel context.CancelFunc
	done   chan struct{}
}

type pendingRootSync struct {
	root      db.Root
	fullIndex bool
}

func normalizedRootPath(path string) string {
	return strings.ToLower(filepath.ToSlash(filepath.Clean(path)))
}

func sameRootPath(left, right string) bool {
	return normalizedRootPath(left) == normalizedRootPath(right)
}

func sameOptionalInt64(left, right *int64) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

func stableRootID(workspaceID, path string) string {
	sum := sha256.Sum256([]byte(workspaceID + "|" + normalizedRootPath(path)))
	return hex.EncodeToString(sum[:])[:32]
}

func ignoredPathsForWorktree(patterns []string, requestedRoot, targetRoot string) []string {
	requested := strings.TrimSuffix(filepath.ToSlash(filepath.Clean(requestedRoot)), "/")
	target := strings.TrimSuffix(filepath.ToSlash(filepath.Clean(targetRoot)), "/")
	translated := make([]string, 0, len(patterns))
	for _, pattern := range patterns {
		normalized := filepath.ToSlash(pattern)
		if len(normalized) >= len(requested) &&
			strings.EqualFold(normalized[:len(requested)], requested) &&
			(len(normalized) == len(requested) || normalized[len(requested)] == '/') {
			normalized = target + normalized[len(requested):]
		}
		translated = append(translated, normalized)
	}
	return translated
}

func (s *Server) discoverInitialWorktrees(rootPath string) ([]gitworktree.Worktree, bool) {
	worktrees, err := s.discoverWorktrees(rootPath)
	if err == nil {
		return worktrees, true
	}
	log.Printf("api: %v; using the requested folder as a single root", err)
	return []gitworktree.Worktree{{Path: filepath.Clean(rootPath), Primary: true}}, false
}

// syncWorkspaceWorktrees reconciles persisted roots and live watchers against
// one authoritative porcelain snapshot. Missing roots retain their metadata
// and history but lose their current graph projection.
func (s *Server) syncWorkspaceWorktrees(
	sqlDB *sql.DB,
	workspaceID string,
	requestedPath string,
	worktrees []gitworktree.Worktree,
	options rootOpenOptions,
	scheduleIndex bool,
	reconcileExisting bool,
) (string, error) {
	existing, err := db.GetRoots(sqlDB, workspaceID)
	if err != nil {
		return "", err
	}
	existingByPath := make(map[string]db.Root, len(existing))
	for _, root := range existing {
		existingByPath[normalizedRootPath(root.Path)] = root
	}

	activeIDs := make(map[string]struct{}, len(worktrees))
	requestedRootID := ""
	rootsChanged := reconcileExisting
	topologyChanged := reconcileExisting
	for _, discovered := range worktrees {
		path := filepath.Clean(discovered.Path)
		prior, known := existingByPath[normalizedRootPath(path)]
		root := db.Root{
			ID:          stableRootID(workspaceID, path),
			WorkspaceID: workspaceID,
			Path:        path,
			Branch:      discovered.Branch,
			HeadCommit:  discovered.HeadCommit,
			IsPrimary:   discovered.Primary,
			IsActive:    true,
			IgnoredPaths: ignoredPathsForWorktree(
				options.IgnoredPaths,
				requestedPath,
				path,
			),
			SourceBoundariesReviewedAt: options.SourceBoundariesReviewedAt,
		}
		if known {
			root.ID = prior.ID
			root.IndexedAt = prior.IndexedAt
			root.ClassifierVersion = prior.ClassifierVersion
			if options.SourceBoundariesReviewedAt == nil && prior.SourceBoundariesReviewedAt != nil {
				root.IgnoredPaths = prior.IgnoredPaths
				root.SourceBoundariesReviewedAt = prior.SourceBoundariesReviewedAt
			}
		}
		rootChanged := !known || !prior.IsActive || prior.Branch != root.Branch ||
			prior.HeadCommit != root.HeadCommit || prior.IsPrimary != root.IsPrimary ||
			!slices.Equal(prior.IgnoredPaths, root.IgnoredPaths) ||
			!sameOptionalInt64(prior.SourceBoundariesReviewedAt, root.SourceBoundariesReviewedAt)
		if rootChanged {
			if err := db.UpsertRoot(sqlDB, root); err != nil {
				return "", fmt.Errorf("register worktree %s: %w", path, err)
			}
			rootsChanged = true
			if !known || !prior.IsActive || prior.IsPrimary != root.IsPrimary {
				topologyChanged = true
			}
		}
		activeIDs[root.ID] = struct{}{}
		if sameRootPath(path, requestedPath) {
			requestedRootID = root.ID
		}
		s.startWatcher(sqlDB, root)

		if !scheduleIndex {
			continue
		}
		indexed := root.IndexedAt != nil && *root.IndexedAt > 0
		headChanged := known && prior.HeadCommit != root.HeadCommit
		switch {
		case !indexed:
			if err := db.DeleteFilesByRoot(sqlDB, root.ID); err != nil {
				return "", fmt.Errorf("clear root %s: %w", path, err)
			}
			s.launchRootSync(sqlDB, root, true)
		case reconcileExisting || headChanged || !prior.IsActive:
			s.launchRootSync(sqlDB, root, false)
		}
	}

	for _, root := range existing {
		if !root.IsActive {
			continue
		}
		if _, remains := activeIDs[root.ID]; remains {
			continue
		}
		s.stopWatcher(root.ID)
		if err := db.DeactivateRoot(sqlDB, root.ID); err != nil {
			return "", fmt.Errorf("deactivate removed worktree %s: %w", root.Path, err)
		}
		log.Printf("api: worktree removed from active roots: %s", root.Path)
		rootsChanged = true
		topologyChanged = true
	}

	if requestedRootID == "" && len(worktrees) > 0 {
		requestedRootID = stableRootID(workspaceID, worktrees[0].Path)
		if prior, ok := existingByPath[normalizedRootPath(worktrees[0].Path)]; ok {
			requestedRootID = prior.ID
		}
	}
	if topologyChanged {
		s.reloadRegistry()
	}
	if rootsChanged {
		s.hub.Broadcast("roots:changed", map[string]any{"workspaceId": workspaceID})
	}
	return requestedRootID, nil
}

func (s *Server) launchRootSync(sqlDB *sql.DB, root db.Root, fullIndex bool) {
	s.mu.Lock()
	if s.rootSyncing[root.ID] {
		pending := s.rootSyncPending[root.ID]
		pending.root = root
		pending.fullIndex = pending.fullIndex || fullIndex
		s.rootSyncPending[root.ID] = pending
		s.mu.Unlock()
		return
	}
	s.rootSyncing[root.ID] = true
	s.mu.Unlock()

	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.rootSyncing, root.ID)
			_, active := s.roots[root.ID]
			pending, hasPending := s.rootSyncPending[root.ID]
			delete(s.rootSyncPending, root.ID)
			s.mu.Unlock()
			if !active {
				_ = db.DeactivateRoot(sqlDB, root.ID)
			} else if hasPending {
				s.launchRootSync(sqlDB, pending.root, pending.fullIndex)
			}
		}()

		if fullIndex {
			if err := indexer.IndexRoot(sqlDB, s.hub, root, root.IgnoredPaths); err != nil {
				log.Printf("api: index root %s: %v", root.Path, err)
				return
			}
			baselineAt := time.Now().UnixMilli()
			if err := db.SetDeltaReviewedAtForRoot(
				sqlDB, root.WorkspaceID, root.ID, baselineAt,
			); err != nil {
				log.Printf("api: baseline delta watermark for %s/%s: %v", root.WorkspaceID, root.ID, err)
			}
			if _, err := s.saveDeltaSnapshotForRoot(sqlDB, root, baselineAt); err != nil {
				log.Printf("api: baseline delta snapshot for %s/%s: %v", root.WorkspaceID, root.ID, err)
			}
		} else {
			if _, err := indexer.ReconcileRoot(sqlDB, s.hub, root, root.IgnoredPaths); err != nil {
				log.Printf("api: reconcile %s: %v", root.Path, err)
			}
			snapshot, _ := db.GetCanvasSnapshot(sqlDB, root.WorkspaceID)
			needsCluster := snapshot != nil && len(snapshot.Files) > 0 &&
				(len(snapshot.Systems) == 0 || root.ClassifierVersion < indexer.ClassifierVersion)
			if needsCluster {
				if err := indexer.ClusterOnly(sqlDB, root); err != nil {
					log.Printf("api: cluster-only %s: %v", root.Path, err)
				}
			}
		}

		snapshot, _ := db.GetCanvasSnapshot(sqlDB, root.WorkspaceID)
		if snapshot != nil {
			s.hub.BroadcastSnapshot(snapshot)
		}
		s.hub.Broadcast("delta:ready", map[string]any{
			"workspaceId": root.WorkspaceID,
			"rootId":      root.ID,
			"branch":      root.Branch,
		})
	}()
}

func (s *Server) startWorktreeMonitor(
	sqlDB *sql.DB,
	workspaceID string,
	anchorPath string,
	options rootOpenOptions,
) {
	if s.worktreeRefresh <= 0 {
		return
	}
	s.mu.Lock()
	if _, exists := s.worktreeMonitors[workspaceID]; exists {
		s.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.worktreeMonitors[workspaceID] = worktreeMonitor{cancel: cancel, done: done}
	interval := s.worktreeRefresh
	s.mu.Unlock()

	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				worktrees, err := s.discoverWorktrees(anchorPath)
				if err != nil {
					log.Printf("api: refresh worktrees for %s: %v", workspaceID, err)
					continue
				}
				if _, err := s.syncWorkspaceWorktrees(
					sqlDB, workspaceID, anchorPath, worktrees, options, true, false,
				); err != nil {
					log.Printf("api: reconcile worktrees for %s: %v", workspaceID, err)
				}
			}
		}
	}()
}

func (s *Server) handleRoots(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	workspaceID := r.URL.Query().Get("workspace")
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}
	roots, err := db.GetActiveRoots(sqlDB, workspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, roots)
}
