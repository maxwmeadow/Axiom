package db

import (
	"database/sql"
	"encoding/json"
	"time"
)

// The agent action log is the record of what an agent DID, as opposed to what
// changed on disk.
//
// The structural journal answers "how is the architecture different now" — it
// deliberately ignores anything that changed nothing. This log answers a
// different question: "what is my agent doing right now, and what did it do?"
// A read changes nothing and still matters enormously, because watching an
// agent trace a call path across your systems is the whole point of a living
// canvas. So reads are first-class here and absent from the journal.
//
// Kept separate from structural_events for that reason: different question,
// different lifecycle, different retention.

// Action kinds, coarse enough to drive distinct canvas choreography.
const (
	ActionRead    = "read"    // inspecting the graph — an attention signal
	ActionTrace   = "trace"   // following a path through the code
	ActionWrite   = "write"   // curating the architecture itself
	ActionPlan    = "plan"    // forward loop: planning, dispatch, replies
	ActionDebug   = "debug"   // runtime, injection, investigation
	ActionNarrate = "narrate" // work sessions and notes
)

// agentLogRetentionMs bounds the log. Beyond this it is history, not activity.
const agentLogRetentionMs = 7 * 24 * 60 * 60 * 1000

// AgentAction is one thing an agent did, with the canvas nodes it touched so
// the map can show it happening.
type AgentAction struct {
	ID          int64    `json:"id"`
	WorkspaceID string   `json:"workspaceId"`
	TS          int64    `json:"ts"`
	SessionID   string   `json:"sessionId,omitempty"`
	Agent       string   `json:"agent,omitempty"`
	Tool        string   `json:"tool"`
	Kind        string   `json:"kind"`
	Summary     string   `json:"summary"`
	// Targets are canvas node IDs (files, systems, infra) this action touched.
	// They are what lets the renderer light up the right part of the map.
	Targets    []string `json:"targets"`
	Detail     string   `json:"detail,omitempty"` // JSON, tool-specific
	DurationMs int64    `json:"durationMs"`
	Status     string   `json:"status"` // ok|error
	Error      string   `json:"error,omitempty"`
}

// RecordAgentAction appends one action to the log.
func RecordAgentAction(db *sql.DB, action AgentAction) (AgentAction, error) {
	if action.TS == 0 {
		action.TS = time.Now().UnixMilli()
	}
	if action.Status == "" {
		action.Status = "ok"
	}
	if action.Targets == nil {
		action.Targets = []string{}
	}
	targets, err := json.Marshal(action.Targets)
	if err != nil {
		return action, err
	}
	res, err := db.Exec(`
		INSERT INTO agent_actions
			(workspace_id, ts, session_id, agent, tool, kind, summary,
			 targets, detail, duration_ms, status, error)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		action.WorkspaceID, action.TS, action.SessionID, action.Agent,
		action.Tool, action.Kind, action.Summary, string(targets),
		action.Detail, action.DurationMs, action.Status, action.Error)
	if err != nil {
		return action, err
	}
	if id, idErr := res.LastInsertId(); idErr == nil {
		action.ID = id
	}
	return action, nil
}

// GetAgentActions returns the most recent actions, newest first. The log is
// read for display, so a bounded page is always enough.
func GetAgentActions(db *sql.DB, workspaceID string, since int64, limit int) ([]AgentAction, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := db.Query(`
		SELECT id, workspace_id, ts, session_id, agent, tool, kind, summary,
		       targets, detail, duration_ms, status, error
		FROM agent_actions
		WHERE workspace_id = ? AND ts > ?
		ORDER BY ts DESC, id DESC
		LIMIT ?`, workspaceID, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	actions := []AgentAction{}
	for rows.Next() {
		var action AgentAction
		var targets string
		if err := rows.Scan(
			&action.ID, &action.WorkspaceID, &action.TS, &action.SessionID,
			&action.Agent, &action.Tool, &action.Kind, &action.Summary,
			&targets, &action.Detail, &action.DurationMs,
			&action.Status, &action.Error,
		); err != nil {
			return nil, err
		}
		action.Targets = []string{}
		_ = json.Unmarshal([]byte(targets), &action.Targets)
		actions = append(actions, action)
	}
	return actions, rows.Err()
}

// PruneAgentActions drops log rows past the retention horizon.
func PruneAgentActions(db *sql.DB, workspaceID string, nowMs int64) error {
	if nowMs == 0 {
		nowMs = time.Now().UnixMilli()
	}
	_, err := db.Exec(
		`DELETE FROM agent_actions WHERE workspace_id = ? AND ts < ?`,
		workspaceID, nowMs-agentLogRetentionMs)
	return err
}
