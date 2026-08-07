package gitworktree

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/fsnotify/fsnotify"
)

// MetadataWatcher reports changes to the shared Git administration data that
// determines worktree topology and branch heads. Source trees are watched by
// the indexer separately; object database churn is intentionally excluded.
type MetadataWatcher struct {
	watcher *fsnotify.Watcher
	common  string
	changes chan struct{}
	errors  chan error
	stop    chan struct{}
	done    chan struct{}
	once    sync.Once
}

func gitCommonDir(path string) (string, error) {
	command := exec.Command("git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir")
	output, err := command.Output()
	if err != nil {
		return "", fmt.Errorf("resolve git common directory for %s: %w", path, err)
	}
	common := strings.TrimSpace(string(output))
	if common == "" {
		return "", fmt.Errorf("resolve git common directory for %s: empty output", path)
	}
	return filepath.Clean(filepath.FromSlash(common)), nil
}

// WatchMetadata watches Git refs and linked-worktree administration files.
// A buffered, coalescing Changes channel keeps an event burst to at most one
// outstanding reconciliation.
func WatchMetadata(path string) (*MetadataWatcher, error) {
	common, err := gitCommonDir(path)
	if err != nil {
		return nil, err
	}
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	result := &MetadataWatcher{
		watcher: watcher,
		common:  common,
		changes: make(chan struct{}, 1),
		errors:  make(chan error, 1),
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
	}
	if err := result.addTree(common); err != nil {
		_ = watcher.Close()
		return nil, err
	}
	go result.run()
	return result, nil
}

func (w *MetadataWatcher) Changes() <-chan struct{} { return w.changes }
func (w *MetadataWatcher) Errors() <-chan error     { return w.errors }

func (w *MetadataWatcher) addTree(root string) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if !entry.IsDir() {
			return nil
		}
		if path != w.common && !w.relevantDirectory(path) {
			return filepath.SkipDir
		}
		if err := w.watcher.Add(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	})
}

func (w *MetadataWatcher) relevantDirectory(path string) bool {
	rel, err := filepath.Rel(w.common, path)
	if err != nil || rel == "." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	first, _, _ := strings.Cut(filepath.ToSlash(rel), "/")
	return first == "refs" || first == "worktrees"
}

func (w *MetadataWatcher) relevantPath(path string) bool {
	rel, err := filepath.Rel(w.common, path)
	if err != nil || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	rel = filepath.ToSlash(rel)
	return rel == "HEAD" || rel == "packed-refs" || rel == "worktrees" ||
		strings.HasPrefix(rel, "refs/") || strings.HasPrefix(rel, "worktrees/")
}

func (w *MetadataWatcher) run() {
	defer close(w.done)
	defer close(w.changes)
	defer close(w.errors)
	for {
		select {
		case <-w.stop:
			return
		case event, ok := <-w.watcher.Events:
			if !ok {
				return
			}
			if event.Op&fsnotify.Create != 0 {
				if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
					if err := w.addTree(event.Name); err != nil {
						w.reportError(err)
					}
				}
			}
			if w.relevantPath(event.Name) {
				select {
				case w.changes <- struct{}{}:
				default:
				}
			}
		case err, ok := <-w.watcher.Errors:
			if !ok {
				return
			}
			w.reportError(err)
		}
	}
}

func (w *MetadataWatcher) reportError(err error) {
	select {
	case w.errors <- err:
	default:
	}
}

func (w *MetadataWatcher) Close() error {
	w.once.Do(func() { close(w.stop) })
	err := w.watcher.Close()
	<-w.done
	return err
}
