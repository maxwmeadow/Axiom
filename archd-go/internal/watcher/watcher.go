// Package watcher uses fsnotify to detect source file changes and trigger re-indexing.
package watcher

import (
	"database/sql"
	"io/fs"
	"log"
	"path/filepath"
	"strings"
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

// Watcher wraps fsnotify and debounces rapid file saves.
type Watcher struct {
	fw    *fsnotify.Watcher
	sqlDB *sql.DB
	h     *hub.Hub
	roots []db.Root
}

// New creates a Watcher and adds all root paths recursively.
func New(sqlDB *sql.DB, h *hub.Hub, roots []db.Root) (*Watcher, error) {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	w := &Watcher{fw: fw, sqlDB: sqlDB, h: h, roots: roots}
	for _, root := range roots {
		if err := addRecursive(fw, root.Path); err != nil {
			log.Printf("watcher: add %s: %v", root.Path, err)
		}
	}
	return w, nil
}

// Run starts the event loop. Call in a goroutine; returns when Close() is called.
func (w *Watcher) Run() {
	// Debounce map: absPath → timer
	pending := make(map[string]*time.Timer)

	for {
		select {
		case event, ok := <-w.fw.Events:
			if !ok {
				return
			}
			if !isSourceFile(event.Name) {
				continue
			}
			if event.Op&(fsnotify.Write|fsnotify.Create) == 0 {
				continue
			}
			absPath := filepath.Clean(event.Name)
			if t, exists := pending[absPath]; exists {
				t.Reset(150 * time.Millisecond)
			} else {
				pending[absPath] = time.AfterFunc(150*time.Millisecond, func() {
					delete(pending, absPath)
					w.handleChange(absPath)
				})
			}

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
	return w.fw.Close()
}

func (w *Watcher) handleChange(absPath string) {
	root := w.rootFor(absPath)
	if root == nil {
		return
	}
	log.Printf("watcher: changed %s", absPath)
	if err := indexer.ReindexFile(w.sqlDB, w.h, *root, absPath); err != nil {
		log.Printf("watcher: reindex %s: %v", absPath, err)
	}
}

func (w *Watcher) rootFor(absPath string) *db.Root {
	for i, r := range w.roots {
		if strings.HasPrefix(absPath, filepath.Clean(r.Path)+string(filepath.Separator)) {
			return &w.roots[i]
		}
	}
	return nil
}

// addRecursive watches path and all non-skipped subdirectories.
func addRecursive(fw *fsnotify.Watcher, path string) error {
	return filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		name := filepath.Base(p)
		if skipDirs[name] || strings.HasPrefix(name, ".") {
			return filepath.SkipDir
		}
		return fw.Add(p)
	})
}

func isSourceFile(path string) bool {
	return supportedExts[strings.ToLower(filepath.Ext(path))]
}
