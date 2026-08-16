// Package activity is the live edit-activity engine: the heartbeat of the
// "always-true map". Every watcher-detected save becomes a weighted edit
// burst; scores decay exponentially so yesterday's hotspot cools off on its
// own. This replaces git-commit churn - commits capture finished work, but
// most of the interesting signal is live edits (especially agent edits)
// between commits.
//
// Design (2026-07, reviewed):
//   - Weight = log10(1 + |Δlines|) + Δsymbols, minimum 0.25 when the content
//     hash changed at all. Format-only saves (no content change) weigh 0 and
//     are dropped, so editor auto-save and formatters never inflate heat.
//   - Exponential decay with a 24h half-life. Memoryless: only (score, at)
//     is stored; the current value is derived on read.
//   - Edit bursts: events for the same file+actor within 5 minutes collapse
//     into one log row. The log table powers future time-lapse/history views.
//   - Actor-aware: edits while an agent session is active are tagged 'agent'
//     and weighted 0.5x so automated refactoring loops don't pin every file
//     red; human edits weigh 1.0x.
//
// This package is a leaf - it deliberately imports no other axiom packages so
// db, indexer, and api can all use it without cycles.
package activity

import (
	"database/sql"
	"math"
	"sort"
	"sync"
	"time"
)

// halfLifeMs is the decay half-life: a score halves every 24 hours.
const halfLifeMs = 24 * 60 * 60 * 1000

// Lambda is the exponential decay constant (per millisecond).
var Lambda = math.Ln2 / float64(halfLifeMs)

// burstWindowMs - saves within this window collapse into one logged burst.
const burstWindowMs = 5 * 60 * 1000

// agentWindowMs - an edit within this long after agent MCP activity is
// attributed to the agent.
const agentWindowMs = 90 * 1000

// minContentWeight is the floor for any save whose content actually changed,
// so in-place edits (same line count, same symbols) still register.
const minContentWeight = 0.25

// Decayed returns the current value of a score recorded at atMs.
func Decayed(score float64, atMs, nowMs int64) float64 {
	if score <= 0 || atMs <= 0 || nowMs <= atMs {
		return score
	}
	return score * math.Exp(-Lambda*float64(nowMs-atMs))
}

// Weight computes a burst's weight from what actually changed.
// linesDelta is the |line count change|, symbolsDelta the number of added,
// removed, or moved symbols. Returns 0 when nothing changed. The symbol
// contribution is clamped: an edit near the top of a file shifts every
// symbol below it, and that must not weigh like rewriting the whole file.
func Weight(linesDelta, symbolsDelta int, contentChanged bool, actor string) float64 {
	if !contentChanged {
		return 0
	}
	if symbolsDelta > 8 {
		symbolsDelta = 8
	}
	w := math.Log10(1+float64(linesDelta)) + float64(symbolsDelta)
	if w < minContentWeight {
		w = minContentWeight
	}
	if actor == "agent" {
		w *= 0.5
	}
	return w
}

// ─── Actor tracking ───────────────────────────────────────────────────────────

var (
	agentMu   sync.Mutex
	agentSeen = map[string]int64{} // workspaceID → last agent MCP activity (ms)
)

// MarkAgent records that an agent performed MCP activity in the workspace.
// Called by the /api/agent/activity handler (the MCP server posts there on
// every tool call).
func MarkAgent(workspaceID string) {
	agentMu.Lock()
	agentSeen[workspaceID] = time.Now().UnixMilli()
	agentMu.Unlock()
}

// ActorFor attributes an edit happening now: 'agent' if agent MCP activity
// was seen recently in the workspace, else 'human'.
func ActorFor(workspaceID string) string {
	agentMu.Lock()
	last := agentSeen[workspaceID]
	agentMu.Unlock()
	if last > 0 && time.Now().UnixMilli()-last <= agentWindowMs {
		return "agent"
	}
	return "human"
}

// ─── Recording ────────────────────────────────────────────────────────────────

// RecordBurst logs an edit burst in the activity log and returns the file's
// new raw score + its decay anchor (now). The caller persists the pair on the
// file row (db.UpdateFileActivity) and broadcasts - this package never writes
// tables it doesn't own.
func RecordBurst(db *sql.DB, workspaceID, fileID, actor string, weight float64, linesDelta, symbolsDelta int, prevScore float64, prevAt int64) (newScore float64, nowMs int64, err error) {
	now := time.Now().UnixMilli()

	// Collapse into the last burst if same file+actor within the window.
	res, err := db.Exec(`
		UPDATE file_activity
		SET weight = weight + ?, ts = ?, lines_delta = lines_delta + ?, symbols_delta = symbols_delta + ?
		WHERE id = (
			SELECT id FROM file_activity
			WHERE file_id = ? AND actor = ? AND ts >= ?
			ORDER BY ts DESC LIMIT 1
		)`, weight, now, linesDelta, symbolsDelta, fileID, actor, now-burstWindowMs)
	if err != nil {
		return 0, 0, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		if _, err := db.Exec(`
			INSERT INTO file_activity (workspace_id, file_id, ts, actor, weight, lines_delta, symbols_delta)
			VALUES (?,?,?,?,?,?,?)`,
			workspaceID, fileID, now, actor, weight, linesDelta, symbolsDelta); err != nil {
			return 0, 0, err
		}
	}

	return Decayed(prevScore, prevAt, now) + weight, now, nil
}

// ─── Normalization ────────────────────────────────────────────────────────────

// minDisplayScore - files below this decayed score render as cold (0).
// Prevents a quiet project from painting its only recent edit red.
const minDisplayScore = 0.25

// ScoreEntry is one file's raw stored score + decay anchor.
type ScoreEntry struct {
	ID    string
	Score float64
	AtMs  int64
}

// Normalize maps raw decayed scores to 0..1 percentile ranks within the
// workspace, so red/orange thresholds work on quiet and busy projects alike.
// Files under the absolute floor are omitted (render cold). A single hot file
// ranks 1.0 - it IS the hotspot of this workspace.
func Normalize(entries []ScoreEntry, nowMs int64) map[string]float64 {
	type hotEntry struct {
		id string
		v  float64
	}
	var hot []hotEntry
	for _, e := range entries {
		v := Decayed(e.Score, e.AtMs, nowMs)
		if v >= minDisplayScore {
			hot = append(hot, hotEntry{e.ID, v})
		}
	}
	out := make(map[string]float64, len(hot))
	if len(hot) == 0 {
		return out
	}
	sort.Slice(hot, func(i, j int) bool { return hot[i].v < hot[j].v })
	for i, e := range hot {
		if len(hot) == 1 {
			out[e.id] = 1.0
		} else {
			out[e.id] = float64(i) / float64(len(hot)-1)
		}
	}
	return out
}
