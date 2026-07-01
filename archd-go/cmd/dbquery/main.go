// dbquery prints a hierarchical view of the cluster index for analysis.
package main

import (
	"database/sql"
	"flag"
	"fmt"
	"os"
	"strings"

	_ "github.com/mattn/go-sqlite3"
)

func main() {
	dbPath := flag.String("db", "", "path to axiom.db")
	flag.Parse()
	if *dbPath == "" {
		fmt.Fprintln(os.Stderr, "usage: dbquery -db <path>")
		os.Exit(1)
	}

	db, err := sql.Open("sqlite3", *dbPath+"?_foreign_keys=on")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer db.Close()

	// ── Summary ───────────────────────────────────────────────────────────────
	var totalFiles, totalSystems, unassigned int
	db.QueryRow(`SELECT COUNT(*) FROM files`).Scan(&totalFiles)
	db.QueryRow(`SELECT COUNT(*) FROM systems WHERE source='cluster'`).Scan(&totalSystems)
	db.QueryRow(`SELECT COUNT(*) FROM files WHERE system_id IS NULL`).Scan(&unassigned)
	fmt.Printf("=== INDEX SUMMARY ===\n")
	fmt.Printf("Files: %d total, %d unassigned\n", totalFiles, unassigned)
	fmt.Printf("Cluster systems: %d\n\n", totalSystems)

	// ── Depth distribution ────────────────────────────────────────────────────
	fmt.Printf("=== SYSTEMS BY DEPTH ===\n")
	rows, _ := db.Query(`
		SELECT s.depth, COUNT(*) as sys_count, SUM(f.cnt) as file_count
		FROM systems s
		LEFT JOIN (SELECT system_id, COUNT(*) as cnt FROM files GROUP BY system_id) f ON f.system_id = s.id
		WHERE s.source='cluster'
		GROUP BY s.depth ORDER BY s.depth`)
	defer rows.Close()
	for rows.Next() {
		var depth, sysCnt int
		var fileCnt sql.NullInt64
		rows.Scan(&depth, &sysCnt, &fileCnt)
		fmt.Printf("  depth %d: %d systems, %d direct files\n", depth, sysCnt, fileCnt.Int64)
	}
	fmt.Println()

	// ── Full tree ─────────────────────────────────────────────────────────────
	fmt.Printf("=== FULL CLUSTER TREE ===\n")
	printTree(db, nil, 0)

	printEditorFiles(db)
	printLargeLeafFiles(db)

	// ── Problems ──────────────────────────────────────────────────────────────
	fmt.Printf("\n=== POTENTIAL ISSUES ===\n")

	// Single-file LEAF systems (no children, 1 direct file — not just 1 direct file on a parent)
	singleRows, _ := db.Query(`
		SELECT s.name, f.rel_path
		FROM systems s
		JOIN files f ON f.system_id = s.id
		WHERE s.source='cluster'
		  AND (SELECT COUNT(*) FROM systems c WHERE c.parent_id = s.id) = 0
		GROUP BY s.id HAVING COUNT(*) = 1`)
	defer singleRows.Close()
	singles := 0
	for singleRows.Next() {
		var sysName, relPath string
		singleRows.Scan(&sysName, &relPath)
		if singles == 0 { fmt.Printf("Single-file leaf systems:\n") }
		fmt.Printf("  [%s] → %s\n", sysName, relPath)
		singles++
	}

	// Large LEAF systems (no children, ≥10 direct files — non-leaf parents having direct files is normal)
	largeRows, _ := db.Query(`
		SELECT s.name, s.depth, COUNT(*) as cnt
		FROM systems s
		JOIN files f ON f.system_id = s.id
		WHERE s.source='cluster'
		  AND (SELECT COUNT(*) FROM systems c WHERE c.parent_id = s.id) = 0
		GROUP BY s.id HAVING cnt >= 10
		ORDER BY cnt DESC`)
	defer largeRows.Close()
	large := 0
	for largeRows.Next() {
		var name string
		var depth, cnt int
		largeRows.Scan(&name, &depth, &cnt)
		if large == 0 { fmt.Printf("Large leaf systems (≥10 files, may need sub-clustering):\n") }
		fmt.Printf("  [%s] depth=%d → %d files\n", name, depth, cnt)
		large++
	}

	// Systems with same name at same depth (duplicates)
	dupRows, _ := db.Query(`
		SELECT name, depth, COUNT(*) as cnt
		FROM systems WHERE source='cluster'
		GROUP BY name, depth HAVING cnt > 1
		ORDER BY cnt DESC`)
	defer dupRows.Close()
	dups := 0
	for dupRows.Next() {
		var name string
		var depth, cnt int
		dupRows.Scan(&name, &depth, &cnt)
		if dups == 0 { fmt.Printf("Duplicate system names at same depth:\n") }
		fmt.Printf("  [%s] depth=%d appears %d times\n", name, depth, cnt)
		dups++
	}
}

func printLargeLeafFiles(db *sql.DB) {
	fmt.Printf("\n=== LARGE LEAF SYSTEM FILES (≥8 direct files, no subsystems) ===\n")
	rows, _ := db.Query(`
		SELECT s.name, s.depth, f.rel_path
		FROM systems s
		JOIN files f ON f.system_id = s.id
		WHERE s.source='cluster'
		  AND s.id IN (
		    SELECT s2.id FROM systems s2
		    JOIN files f2 ON f2.system_id = s2.id
		    WHERE s2.source='cluster'
		      AND (SELECT COUNT(*) FROM systems c WHERE c.parent_id = s2.id) = 0
		    GROUP BY s2.id HAVING COUNT(f2.id) >= 8
		  )
		ORDER BY s.depth, s.name, f.rel_path`)
	if rows == nil { return }
	defer rows.Close()
	prev := ""
	for rows.Next() {
		var sysName, relPath string
		var depth int
		rows.Scan(&sysName, &depth, &relPath)
		key := fmt.Sprintf("%s@%d", sysName, depth)
		if key != prev {
			fmt.Printf("  [%s] depth=%d:\n", sysName, depth)
			prev = key
		}
		fmt.Printf("    %s\n", relPath)
	}
}

func printEditorFiles(db *sql.DB) {
	fmt.Printf("\n=== EDITOR SYSTEM FILES (by system) ===\n")
	rows, _ := db.Query(`
		WITH RECURSIVE tree(id, name, depth, path) AS (
			SELECT id, name, depth, name FROM systems WHERE source='cluster' AND name='Editor' AND parent_id IS NULL
			UNION ALL
			SELECT s.id, s.name, s.depth, tree.path || ' > ' || s.name
			FROM systems s JOIN tree ON s.parent_id = tree.id WHERE s.source='cluster'
		)
		SELECT t.path, f.rel_path
		FROM tree t
		JOIN files f ON f.system_id = t.id
		ORDER BY t.depth, f.rel_path`)
	if rows == nil { return }
	defer rows.Close()
	for rows.Next() {
		var path, relPath string
		rows.Scan(&path, &relPath)
		fmt.Printf("  [%s] %s\n", path, relPath)
	}
}

func printTree(db *sql.DB, parentID interface{}, indent int) {
	var rows *sql.Rows
	if parentID == nil {
		rows, _ = db.Query(`
			SELECT s.id, s.name, s.depth,
			       COUNT(f.id) as direct_files,
			       (SELECT COUNT(*) FROM systems c WHERE c.parent_id = s.id) as child_sys
			FROM systems s
			LEFT JOIN files f ON f.system_id = s.id
			WHERE s.source='cluster' AND s.parent_id IS NULL
			GROUP BY s.id ORDER BY s.name`)
	} else {
		rows, _ = db.Query(`
			SELECT s.id, s.name, s.depth,
			       COUNT(f.id) as direct_files,
			       (SELECT COUNT(*) FROM systems c WHERE c.parent_id = s.id) as child_sys
			FROM systems s
			LEFT JOIN files f ON f.system_id = s.id
			WHERE s.source='cluster' AND s.parent_id = ?
			GROUP BY s.id ORDER BY s.name`, parentID)
	}
	if rows == nil { return }
	defer rows.Close()

	prefix := strings.Repeat("  ", indent)
	for rows.Next() {
		var id, name string
		var depth, directFiles, childSys int
		rows.Scan(&id, &name, &depth, &directFiles, &childSys)
		marker := "├─"
		if childSys > 0 {
			fmt.Printf("%s%s [%s] (%d subsystems", prefix, marker, name, childSys)
			if directFiles > 0 {
				fmt.Printf(", %d direct files", directFiles)
			}
			fmt.Printf(")\n")
			printTree(db, id, indent+1)
		} else {
			fmt.Printf("%s%s [%s] → %d files\n", prefix, marker, name, directFiles)
		}
	}
}
