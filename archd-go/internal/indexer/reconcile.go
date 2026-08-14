package indexer

import (
	"database/sql"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
)

// collectSourcePaths walks a root and returns every indexable source file,
// honouring both the built-in skip list and the user's source boundaries.
func collectSourcePaths(root db.Root, ignoredPaths []string) ([]string, error) {
	ignoredAbsDirs := make(map[string]bool)
	for _, p := range ignoredPaths {
		native := filepath.FromSlash(p)
		native = strings.TrimSuffix(native, string(filepath.Separator)+"**")
		native = strings.TrimSuffix(native, "/**")
		clean := filepath.Clean(native)
		if clean != "" && clean != "." {
			key := strings.ToLower(clean)
			ignoredAbsDirs[key] = true
			log.Printf("[indexer] will ignore: %q (key=%q)", p, key)
		}
	}
	isIgnored := func(absPath string) bool {
		hit := ignoredAbsDirs[strings.ToLower(absPath)]
		if hit {
			log.Printf("[indexer] skipping dir: %s", absPath)
		}
		return hit
	}

	var paths []string
	err := filepath.WalkDir(root.Path, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable dirs
		}
		if d.IsDir() {
			if skipDirs[d.Name()] || strings.HasPrefix(d.Name(), ".") || isIgnored(path) {
				return filepath.SkipDir
			}
			return nil
		}
		if IsSupportedSourceFile(path) {
			paths = append(paths, path)
		}
		return nil
	})
	return paths, err
}

// ReconcileRoot catches the graph up with the filesystem after Axiom was not
// running.
//
// The watcher only sees edits while archd is alive. Without this pass, closing
// Axiom, letting agents work overnight, and reopening would produce an empty
// Morning Delta — the single case the delta exists for. Reconciliation replays
// what the watcher would have seen, through the exact same ReindexFile and
// RemoveFile paths, so journaling, choreography, and broadcasts all behave
// identically to a live edit.
//
// After the file catch-up settles, it runs the same guarded live-classification
// pass the watcher schedules after a burst. ClusterLive only acts when new
// unclassified files have enough semantic evidence to form a useful group; its
// reconciliation preserves authored systems and existing Floor layouts.
func ReconcileRoot(sqlDB *sql.DB, h *hub.Hub, root db.Root, ignoredPaths []string) (changed int, err error) {
	paths, err := collectSourcePaths(root, ignoredPaths)
	if err != nil {
		return 0, err
	}
	existing, err := buildExistingMap(sqlDB, root.ID)
	if err != nil {
		return 0, err
	}

	seen := make(map[string]struct{}, len(paths))
	for _, absPath := range paths {
		relPath, relErr := filepath.Rel(root.Path, absPath)
		if relErr != nil {
			continue
		}
		relPath = filepath.ToSlash(relPath)
		seen[relPath] = struct{}{}

		prev, known := existing[relPath]
		if known && !fileLooksModified(absPath, prev) {
			continue
		}
		if reindexErr := ReindexFile(sqlDB, h, root, absPath); reindexErr != nil {
			log.Printf("[reconcile] reindex %s: %v", relPath, reindexErr)
			continue
		}
		changed++
	}

	// Anything the database still knows about but the disk does not was
	// deleted while we were away.
	for relPath := range existing {
		if _, stillThere := seen[relPath]; stillThere {
			continue
		}
		absPath := filepath.Join(root.Path, filepath.FromSlash(relPath))
		if removeErr := RemoveFile(sqlDB, h, root, absPath); removeErr != nil {
			log.Printf("[reconcile] remove %s: %v", relPath, removeErr)
			continue
		}
		changed++
	}

	if changed > 0 {
		if classified, classifyErr := ClusterLive(sqlDB, root); classifyErr != nil {
			return changed, classifyErr
		} else if classified {
			log.Printf("[reconcile] root %s classified new files after catch-up", root.Path)
		}
		log.Printf("[reconcile] root %s caught up: %d files changed while Axiom was closed", root.Path, changed)
	}
	return changed, nil
}

// fileLooksModified is the cheap pre-filter: only files whose size or mtime
// moved are re-parsed. ReindexFile still hashes the content, so a touched but
// unchanged file costs one parse and produces no delta entry.
func fileLooksModified(absPath string, prev db.File) bool {
	info, err := os.Stat(absPath)
	if err != nil {
		return false
	}
	return info.ModTime().UnixMilli() > prev.IndexedAt
}
