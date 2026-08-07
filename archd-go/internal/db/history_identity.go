package db

import "database/sql"

func nullableHistoryIdentity(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func primaryRootIdentity(db *sql.DB, workspaceID string) (rootID, branch string) {
	_ = db.QueryRow(`
		SELECT id, branch FROM roots
		WHERE workspace_id=?
		ORDER BY is_primary DESC, is_active DESC, path
		LIMIT 1`, workspaceID).Scan(&rootID, &branch)
	return rootID, branch
}

func effectiveRootID(db *sql.DB, workspaceID, rootID string) string {
	if rootID != "" {
		return rootID
	}
	rootID, _ = primaryRootIdentity(db, workspaceID)
	return rootID
}

func completeHistoryIdentity(db *sql.DB, workspaceID, rootID, branch string) (string, string) {
	if rootID == "" {
		return primaryRootIdentity(db, workspaceID)
	}
	if branch == "" {
		_ = db.QueryRow(`SELECT branch FROM roots WHERE workspace_id=? AND id=?`, workspaceID, rootID).
			Scan(&branch)
	}
	return rootID, branch
}
