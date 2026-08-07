package api

import (
	"database/sql"
	"net/http"
	"path/filepath"
	"time"

	"axiom.local/archd/internal/collision"
	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/delta"
	"axiom.local/archd/internal/gitworktree"
)

type collisionCacheEntry struct {
	snapshot  collision.Snapshot
	expiresAt int64
}

// GET /api/collisions?workspace=...
//
// Git determines which files still diverge pairwise from a merge base. Axiom
// determines which semantic systems those files occupy and supplies the
// branch-stamped claims. No line-level conflict prediction happens here.
func (s *Server) handleCollisions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	workspaceID := r.URL.Query().Get("workspace")
	if workspaceID == "" {
		jsonError(w, "workspace is required", http.StatusBadRequest)
		return
	}
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusNotFound)
		return
	}
	snapshot, err := s.cachedCrossBranchCollisions(sqlDB, workspaceID, time.Now().UnixMilli())
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonOK(w, snapshot)
}

func (s *Server) cachedCrossBranchCollisions(
	sqlDB *sql.DB,
	workspaceID string,
	now int64,
) (collision.Snapshot, error) {
	s.mu.RLock()
	cached, ok := s.collisionCache[workspaceID]
	s.mu.RUnlock()
	if ok && cached.expiresAt > now {
		return cached.snapshot, nil
	}
	snapshot, err := s.crossBranchCollisions(sqlDB, workspaceID, now)
	if err != nil {
		return collision.Snapshot{}, err
	}
	s.mu.Lock()
	s.collisionCache[workspaceID] = collisionCacheEntry{
		snapshot: snapshot, expiresAt: now + s.collisionCacheTTL.Milliseconds(),
	}
	s.mu.Unlock()
	return snapshot, nil
}

func (s *Server) invalidateCollisionCache(workspaceID string) {
	s.mu.Lock()
	delete(s.collisionCache, workspaceID)
	s.mu.Unlock()
}

func (s *Server) crossBranchCollisions(
	sqlDB *sql.DB,
	workspaceID string,
	now int64,
) (collision.Snapshot, error) {
	roots, err := db.GetActiveRoots(sqlDB, workspaceID)
	if err != nil {
		return collision.Snapshot{}, err
	}
	systems, err := db.GetSystems(sqlDB, workspaceID)
	if err != nil {
		return collision.Snapshot{}, err
	}
	systemNames := make(map[string]string, len(systems))
	for _, system := range systems {
		systemNames[system.ID] = system.Name
	}

	filesByRoot := make(map[string][]db.File, len(roots))
	globalBoundaries := map[string]collision.Boundary{}
	for _, root := range roots {
		files, filesErr := db.GetFilesByRoot(sqlDB, root.ID)
		if filesErr != nil {
			return collision.Snapshot{}, filesErr
		}
		filesByRoot[root.ID] = files
		for _, file := range files {
			if file.SystemID == nil || *file.SystemID == "" {
				continue
			}
			relPath := filepath.ToSlash(filepath.Clean(file.RelPath))
			if _, exists := globalBoundaries[relPath]; !exists {
				globalBoundaries[relPath] = collision.Boundary{
					SystemID: *file.SystemID, SystemName: systemNames[*file.SystemID],
				}
			}
		}
	}

	inputs := make([]collision.BranchInput, 0, len(roots))
	working := make(map[string][]string, len(roots))
	workingErrors := make(map[string]error, len(roots))
	for _, root := range roots {
		pathSystems := make(map[string]collision.Boundary, len(globalBoundaries))
		for path, boundary := range globalBoundaries {
			pathSystems[path] = boundary
		}
		for _, file := range filesByRoot[root.ID] {
			if file.SystemID == nil || *file.SystemID == "" {
				continue
			}
			pathSystems[filepath.ToSlash(filepath.Clean(file.RelPath))] = collision.Boundary{
				SystemID: *file.SystemID, SystemName: systemNames[*file.SystemID],
			}
		}
		events, eventsErr := db.GetStructuralEventsForRoot(
			sqlDB, workspaceID, root.ID, root.Branch, 0,
		)
		if eventsErr != nil {
			return collision.Snapshot{}, eventsErr
		}
		summary := delta.Aggregate(events, 0, now)
		claims := delta.BuildClaims(
			summary, s.systemTopologyForRoot(sqlDB, workspaceID, root.ID),
		)
		claims = delta.ClassifyRealization(claims, dispatchedIntents(sqlDB, workspaceID))
		inputs = append(inputs, collision.BranchInput{
			RootID: root.ID, Branch: root.Branch, HeadCommit: root.HeadCommit,
			IsPrimary: root.IsPrimary, PathSystems: pathSystems, Claims: claims,
		})
		working[root.ID], workingErrors[root.ID] = gitworktree.WorkingChangedPaths(root.Path)
	}

	pairs := make([]collision.PairInput, 0, len(roots)*(len(roots)-1)/2)
	for leftIndex := 0; leftIndex < len(roots); leftIndex++ {
		for rightIndex := leftIndex + 1; rightIndex < len(roots); rightIndex++ {
			left, right := roots[leftIndex], roots[rightIndex]
			pair := collision.PairInput{LeftRootID: left.ID, RightRootID: right.ID}
			switch {
			case workingErrors[left.ID] != nil:
				pair.Error = workingErrors[left.ID].Error()
			case workingErrors[right.ID] != nil:
				pair.Error = workingErrors[right.ID].Error()
			default:
				base, baseErr := gitworktree.MergeBase(left.Path, left.HeadCommit, right.HeadCommit)
				if baseErr != nil {
					pair.Error = baseErr.Error()
					break
				}
				leftCommitted, leftErr := gitworktree.CommittedChangedPaths(
					left.Path, base, left.HeadCommit,
				)
				if leftErr != nil {
					pair.Error = leftErr.Error()
					break
				}
				rightCommitted, rightErr := gitworktree.CommittedChangedPaths(
					right.Path, base, right.HeadCommit,
				)
				if rightErr != nil {
					pair.Error = rightErr.Error()
					break
				}
				pair.LeftPaths = unionPaths(leftCommitted, working[left.ID])
				pair.RightPaths = unionPaths(rightCommitted, working[right.ID])
			}
			pairs = append(pairs, pair)
		}
	}
	return collision.Build(workspaceID, now, inputs, pairs), nil
}

func unionPaths(groups ...[]string) []string {
	seen := map[string]struct{}{}
	for _, paths := range groups {
		for _, path := range paths {
			seen[filepath.ToSlash(filepath.Clean(path))] = struct{}{}
		}
	}
	result := make([]string, 0, len(seen))
	for path := range seen {
		result = append(result, path)
	}
	return result
}
