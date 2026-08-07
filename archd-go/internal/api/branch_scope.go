package api

import (
	"database/sql"
	"fmt"

	"axiom.local/archd/internal/db"
)

// resolveWorkspaceRoot gives every branch-aware API the same selection rules:
// explicit root ID wins, branch is an optional consistency check, and legacy
// unscoped callers retain the primary checkout.
func resolveWorkspaceRoot(
	sqlDB *sql.DB,
	workspaceID, rootID, branch string,
) (db.Root, error) {
	roots, err := db.GetRoots(sqlDB, workspaceID)
	if err != nil {
		return db.Root{}, err
	}
	if rootID != "" {
		for _, root := range roots {
			if root.ID != rootID {
				continue
			}
			if branch != "" && root.Branch != branch {
				return db.Root{}, fmt.Errorf(
					"root %q is on branch %q, not %q", rootID, root.Branch, branch,
				)
			}
			return root, nil
		}
		return db.Root{}, fmt.Errorf("root %q does not belong to workspace %q", rootID, workspaceID)
	}
	if branch != "" {
		var match *db.Root
		for i := range roots {
			if roots[i].IsActive && roots[i].Branch == branch {
				if match != nil {
					return db.Root{}, fmt.Errorf("branch %q has multiple active roots", branch)
				}
				match = &roots[i]
			}
		}
		if match != nil {
			return *match, nil
		}
		return db.Root{}, fmt.Errorf("branch %q has no active root in workspace %q", branch, workspaceID)
	}
	for _, root := range roots {
		if root.IsPrimary {
			return root, nil
		}
	}
	if len(roots) > 0 {
		return roots[0], nil
	}
	return db.Root{}, fmt.Errorf("workspace %q has no roots", workspaceID)
}
