// Package watcher uses fsnotify to detect source file changes and trigger re-indexing.
package watcher

import (
	"database/sql"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/fsnotify/fsnotify"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
	"axiom.local/archd/internal/indexer"
)

var skipDirs = map[string]bool{
	"node_modules": true, ".git": true, ".idea": true, ".vscode": true,
	"dist": true, "build": true, "out": true, ".next": true,
	"__pycache__": true, "vendor": true, "target": true,
}

var supportedExts = map[string]bool{
	".ts": true, ".tsx": true, ".js": true, ".mjs": true,
	".jsx": true, ".py": true, ".go": true, ".rs": true, ".cs": true,
}

const (
	fileChangeDebounce     = 150 * time.Millisecond
	classificationDebounce = 1500 * time.Millisecond
)

// Watcher wraps fsnotify and debounces rapid file saves.
type Watcher struct {
	fw               *fsnotify.Watcher
	sqlDB            *sql.DB
	h                *hub.Hub
	rootsMu          sync.RWMutex
	roots            []db.Root
	pendingMu        sync.Mutex
	pendingChanges   map[string]*time.Timer
	classificationMu sync.Mutex
	classifications  map[string]*time.Timer
	reclusterMu      sync.Mutex
	closed           atomic.Bool
}

// UpdateRoot refreshes branch/HEAD metadata without tearing down filesystem
// watches. Scheduled callbacks take a copy, so each event is stamped with the
// newest identity available when its path is resolved.
func (w *Watcher) UpdateRoot(updated db.Root) {
	w.rootsMu.Lock()
	defer w.rootsMu.Unlock()
	for index := range w.roots {
		if w.roots[index].ID == updated.ID {
			w.roots[index] = updated
			return
		}
	}
}

// New creates a Watcher and adds all root paths recursively.
func New(sqlDB *sql.DB, h *hub.Hub, roots []db.Root) (*Watcher, error) {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	w := &Watcher{
		fw:              fw,
		sqlDB:           sqlDB,
		h:               h,
		roots:           roots,
		pendingChanges:  make(map[string]*time.Timer),
		classifications: make(map[string]*time.Timer),
	}
	for _, root := range roots {
		if err := addRecursive(fw, root.Path, root.IgnoredPaths); err != nil {
			log.Printf("watcher: add %s: %v", root.Path, err)
		}
	}
	return w, nil
}

// Run starts the event loop. Call in a goroutine; returns when Close() is called.
func (w *Watcher) Run() {
	for {
		select {
		case event, ok := <-w.fw.Events:
			if !ok {
				return
			}
			// A directory that appears after startup (e.g. an agent scaffolding
			// src/components/) must start being watched, and any files created
			// alongside it indexed — fsnotify does not recurse into directories
			// added after the initial watch was established.
			if event.Op&fsnotify.Create != 0 {
				if fi, err := os.Stat(event.Name); err == nil && fi.IsDir() {
					w.watchNewDir(event.Name)
					continue
				}
			}
			if !isSourceFile(event.Name) {
				continue
			}
			if event.Op&(fsnotify.Write|fsnotify.Create|fsnotify.Remove|fsnotify.Rename) == 0 {
				continue
			}
			w.scheduleChange(filepath.Clean(event.Name))

		case err, ok := <-w.fw.Errors:
			if !ok {
				return
			}
			log.Printf("watcher: error: %v", err)
		}
	}
}

// Close shuts down the fsnotify watcher.
func (w *Watcher) Close() error {
	w.closed.Store(true)

	w.pendingMu.Lock()
	for path, timer := range w.pendingChanges {
		timer.Stop()
		delete(w.pendingChanges, path)
	}
	w.pendingMu.Unlock()

	w.classificationMu.Lock()
	for rootID, timer := range w.classifications {
		timer.Stop()
		delete(w.classifications, rootID)
	}
	w.classificationMu.Unlock()

	return w.fw.Close()
}

func (w *Watcher) scheduleChange(absPath string) {
	if w.closed.Load() {
		return
	}
	w.pendingMu.Lock()
	defer w.pendingMu.Unlock()

	if timer, exists := w.pendingChanges[absPath]; exists {
		timer.Stop()
		timer.Reset(fileChangeDebounce)
		return
	}
	w.pendingChanges[absPath] = time.AfterFunc(fileChangeDebounce, func() {
		w.pendingMu.Lock()
		delete(w.pendingChanges, absPath)
		w.pendingMu.Unlock()
		if w.closed.Load() {
			return
		}
		w.handleChange(absPath)
	})
}

func (w *Watcher) handleChange(absPath string) {
	if w.closed.Load() {
		return
	}
	root := w.rootFor(absPath)
	if root == nil {
		return
	}
	if _, err := os.Stat(absPath); os.IsNotExist(err) {
		log.Printf("watcher: removed %s", absPath)
		if err := indexer.RemoveFile(w.sqlDB, w.h, *root, absPath); err != nil {
			log.Printf("watcher: remove %s: %v", absPath, err)
			return
		}
		w.scheduleClassification(*root)
		return
	}
	log.Printf("watcher: changed %s", absPath)
	if err := indexer.ReindexFile(w.sqlDB, w.h, *root, absPath); err != nil {
		log.Printf("watcher: reindex %s: %v", absPath, err)
		return
	}
	w.scheduleClassification(*root)
}

// scheduleClassification waits for the entire write burst to settle. Files
// still materialize immediately through file:updated patches; only their
// architectural organization is batched, avoiding a camera/layout churn for
// every file an agent writes.
func (w *Watcher) scheduleClassification(root db.Root) {
	if w.closed.Load() {
		return
	}
	w.classificationMu.Lock()
	defer w.classificationMu.Unlock()

	if timer, exists := w.classifications[root.ID]; exists {
		timer.Stop()
		timer.Reset(classificationDebounce)
		return
	}
	w.classifications[root.ID] = time.AfterFunc(classificationDebounce, func() {
		w.classificationMu.Lock()
		delete(w.classifications, root.ID)
		w.classificationMu.Unlock()
		if w.closed.Load() {
			return
		}
		w.runClassification(root)
	})
}

func (w *Watcher) runClassification(root db.Root) {
	if w.closed.Load() {
		return
	}
	// SQLite already serializes writes, but keeping the expensive planning pass
	// single-flight prevents two roots from racing snapshots and event order.
	w.reclusterMu.Lock()
	defer w.reclusterMu.Unlock()

	changed, err := indexer.ClusterLive(w.sqlDB, root)
	if err != nil {
		log.Printf("watcher: live classification %s: %v", root.Path, err)
		return
	}
	if !changed {
		return
	}
	snapshot, err := db.GetCanvasSnapshot(w.sqlDB, root.WorkspaceID)
	if err != nil {
		log.Printf("watcher: classification snapshot %s: %v", root.Path, err)
		return
	}
	w.h.BroadcastClassification(snapshot)
}

// watchNewDir begins watching a directory that appeared after startup and
// indexes any source files already inside it. Files written in the same instant
// the directory is created never fire their own Create event (the watch isn't
// attached yet), so we scan once; later edits reindex idempotently.
func (w *Watcher) watchNewDir(dir string) {
	root := w.rootFor(dir)
	if root == nil {
		return
	}
	name := filepath.Base(dir)
	if skipDirs[name] || strings.HasPrefix(name, ".") {
		return
	}
	if err := addRecursive(w.fw, dir, root.IgnoredPaths); err != nil {
		log.Printf("watcher: watch new dir %s: %v", dir, err)
	}
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if isIgnoredPath(p, root.IgnoredPaths) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if isSourceFile(p) {
			w.handleChange(filepath.Clean(p))
		}
		return nil
	})
}

func (w *Watcher) rootFor(absPath string) *db.Root {
	w.rootsMu.RLock()
	defer w.rootsMu.RUnlock()
	for i, r := range w.roots {
		if strings.HasPrefix(absPath, filepath.Clean(r.Path)+string(filepath.Separator)) {
			if isIgnoredPath(absPath, r.IgnoredPaths) {
				return nil
			}
			root := w.roots[i]
			return &root
		}
	}
	return nil
}

// addRecursive watches path and all non-skipped, source-boundary-approved
// subdirectories.
func addRecursive(fw *fsnotify.Watcher, path string, ignoredPaths []string) error {
	return filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		if isIgnoredPath(p, ignoredPaths) {
			return filepath.SkipDir
		}
		name := filepath.Base(p)
		if skipDirs[name] || strings.HasPrefix(name, ".") {
			return filepath.SkipDir
		}
		return fw.Add(p)
	})
}

func isIgnoredPath(path string, ignoredPaths []string) bool {
	cleanPath := filepath.Clean(path)
	for _, ignored := range ignoredPaths {
		cleanIgnored := filepath.FromSlash(ignored)
		cleanIgnored = strings.TrimSuffix(cleanIgnored, string(filepath.Separator)+"**")
		cleanIgnored = strings.TrimSuffix(cleanIgnored, "/**")
		cleanIgnored = filepath.Clean(cleanIgnored)
		relative, err := filepath.Rel(cleanIgnored, cleanPath)
		if err != nil {
			continue
		}
		if relative == "." || (relative != ".." &&
			!strings.HasPrefix(relative, ".."+string(filepath.Separator))) {
			return true
		}
	}
	return false
}

func isSourceFile(path string) bool {
	return supportedExts[strings.ToLower(filepath.Ext(path))]
}
