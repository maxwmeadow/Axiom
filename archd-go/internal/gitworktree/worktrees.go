// Package gitworktree discovers the linked checkouts that share a Git repository.
package gitworktree

import (
	"bytes"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
)

const DetachedBranch = "(detached)"

type Worktree struct {
	Path       string
	Branch     string
	HeadCommit string
	Primary    bool
	bare       bool
}

// Discover returns Git's stable porcelain view of every worktree belonging to
// the repository containing path. The first record is Git's primary checkout.
func Discover(path string) ([]Worktree, error) {
	command := exec.Command("git", "-C", path, "worktree", "list", "--porcelain", "-z")
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("git worktree list for %s: %w", path, err)
	}
	worktrees, err := parsePorcelain(output)
	if err != nil {
		return nil, fmt.Errorf("parse git worktrees for %s: %w", path, err)
	}
	return worktrees, nil
}

func parsePorcelain(output []byte) ([]Worktree, error) {
	fields := bytes.Split(output, []byte{0})
	worktrees := make([]Worktree, 0)
	current := Worktree{}
	flush := func() error {
		if current.Path == "" {
			return nil
		}
		if current.bare {
			current = Worktree{}
			return nil
		}
		if current.HeadCommit == "" {
			return fmt.Errorf("worktree %s has no HEAD", current.Path)
		}
		current.Primary = len(worktrees) == 0
		worktrees = append(worktrees, current)
		current = Worktree{}
		return nil
	}

	for _, raw := range fields {
		if len(raw) == 0 {
			if err := flush(); err != nil {
				return nil, err
			}
			continue
		}
		field := string(raw)
		key, value, _ := strings.Cut(field, " ")
		switch key {
		case "worktree":
			if current.Path != "" {
				if err := flush(); err != nil {
					return nil, err
				}
			}
			current.Path = filepath.Clean(filepath.FromSlash(value))
		case "HEAD":
			current.HeadCommit = value
		case "branch":
			current.Branch = strings.TrimPrefix(value, "refs/heads/")
		case "detached":
			current.Branch = DetachedBranch
		case "bare":
			current.bare = true
		}
	}
	if err := flush(); err != nil {
		return nil, err
	}
	if len(worktrees) == 0 {
		return nil, fmt.Errorf("porcelain output contained no worktrees")
	}
	return worktrees, nil
}
