package gitworktree

import (
	"bytes"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// MergeBase returns the common ancestor used to measure each side's own
// branch changes. This is not conflict detection; it only defines the durable
// pre-merge window whose files Axiom projects onto semantic systems.
func MergeBase(worktreePath, leftCommit, rightCommit string) (string, error) {
	output, err := gitOutput(worktreePath, "merge-base", leftCommit, rightCommit)
	if err != nil {
		return "", err
	}
	base := strings.TrimSpace(string(output))
	if base == "" {
		return "", fmt.Errorf("git merge-base returned no commit")
	}
	return base, nil
}

// CommittedChangedPaths lists files changed on head since base.
func CommittedChangedPaths(worktreePath, base, head string) ([]string, error) {
	output, err := gitOutput(
		worktreePath, "diff", "--name-only", "-z", "--find-renames", base+".."+head,
	)
	if err != nil {
		return nil, err
	}
	return normalizedPaths(output), nil
}

// WorkingChangedPaths includes tracked staged/unstaged changes and untracked
// files. Agents often create a file before their first commit, and that must
// still participate in a pre-merge semantic collision.
func WorkingChangedPaths(worktreePath string) ([]string, error) {
	tracked, err := gitOutput(worktreePath, "diff", "--name-only", "-z", "HEAD")
	if err != nil {
		return nil, err
	}
	untracked, err := gitOutput(
		worktreePath, "ls-files", "--others", "--exclude-standard", "-z",
	)
	if err != nil {
		return nil, err
	}
	return mergePaths(normalizedPaths(tracked), normalizedPaths(untracked)), nil
}

func gitOutput(worktreePath string, args ...string) ([]byte, error) {
	command := exec.Command("git", append([]string{"-C", worktreePath}, args...)...)
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("git %s in %s: %w", strings.Join(args, " "), worktreePath, err)
	}
	return output, nil
}

func normalizedPaths(output []byte) []string {
	paths := make([]string, 0)
	for _, raw := range bytes.Split(output, []byte{0}) {
		if len(raw) == 0 {
			continue
		}
		paths = append(paths, filepath.ToSlash(filepath.Clean(string(raw))))
	}
	return mergePaths(paths)
}

func mergePaths(groups ...[]string) []string {
	seen := map[string]struct{}{}
	for _, paths := range groups {
		for _, path := range paths {
			if path != "" && path != "." {
				seen[path] = struct{}{}
			}
		}
	}
	paths := make([]string, 0, len(seen))
	for path := range seen {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}
