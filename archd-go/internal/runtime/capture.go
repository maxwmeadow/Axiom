// Investigation Capture (plan Phase 8). Records the agent's live investigation
// - every trace, watch, call/return/exception, perturbation, data-flow slice,
// and note - into an ordered, replayable document linked to a git commit SHA.
//
// Named "Investigation Capture", NOT "replay-as-in-time-travel": it is a
// recording of what the agent did and the values it observed, not a
// re-executable program (plan critical-issue resolution #7). The canvas plays
// the captured events back in order so a teammate watches the bug unfold.
//
// Mechanism: the recorder is registered as the hub's single tap, so it sees
// every broadcast event with zero changes to the emitters. It appends the
// relevant ones (runtime:*, call:trace, data:flow, agent:activity, note) to
// the workspace's active investigation with a relative timestamp.
package runtime

import (
	"crypto/rand"
	"encoding/json"
	"time"
)

// recordableTypes are the WS event types captured into an investigation.
// graph:snapshot / graph:patch / indexing:* are excluded - an investigation
// records the agent's dynamic activity, not static graph churn.
var recordableTypes = map[string]bool{
	"runtime:call":           true,
	"runtime:return":         true,
	"runtime:exception":      true,
	"runtime:rate_limit":     true,
	"runtime:watch":          true,
	"runtime:unwatch":        true,
	"runtime:session":        true,
	"runtime:inject":         true,
	"runtime:inject_pending": true,
	"call:trace":             true,
	"data:flow":              true,
	"agent:activity":         true,
	"investigation:note":     true,
}

// CapturedEvent is one entry in an investigation timeline.
type CapturedEvent struct {
	Type     string          `json:"type"`
	OffsetMs int64           `json:"offsetMs"` // ms since investigation start
	Payload  json.RawMessage `json:"payload"`
}

// Investigation is a recorded (or recording) agent session.
type Investigation struct {
	ID          string          `json:"id"`
	WorkspaceID string          `json:"workspaceId"`
	Name        string          `json:"name"`
	Commit      string          `json:"commit"` // git SHA at capture time
	Branch      string          `json:"branch"`
	CreatedAt   int64           `json:"createdAt"`
	DurationMs  int64           `json:"durationMs"`
	Status      string          `json:"status"` // 'recording' | 'saved'
	Events      []CapturedEvent `json:"events"`

	// CanvasSnapshot is attached at save time so a fresh viewer can position
	// nodes even if the live graph has since changed. Opaque to the recorder.
	CanvasSnapshot json.RawMessage `json:"canvasSnapshot,omitempty"`

	// start carries Go's monotonic clock reading, so event offsets and duration
	// are immune to wall-clock/NTP adjustments during a long investigation.
	start time.Time
}

const maxCaptureEvents = 20000 // hard cap so a runaway hot loop can't OOM

// recordTap is the hub tap. It appends recordable events to the workspace's
// active investigation. Runs inline inside hub.Broadcast - kept cheap.
func (m *Manager) recordTap(msgType string, payload json.RawMessage) {
	if !recordableTypes[msgType] {
		return
	}
	var env struct {
		WorkspaceID string `json:"workspaceId"`
	}
	_ = json.Unmarshal(payload, &env)
	if env.WorkspaceID == "" {
		return
	}
	m.captureMu.Lock()
	inv := m.activeInvestigations[env.WorkspaceID]
	if inv != nil && len(inv.Events) < maxCaptureEvents {
		inv.Events = append(inv.Events, CapturedEvent{
			Type:     msgType,
			OffsetMs: time.Since(inv.start).Milliseconds(),
			Payload:  append(json.RawMessage(nil), payload...),
		})
	}
	m.captureMu.Unlock()
}

// StartInvestigation begins recording for a workspace. commit/branch are
// resolved by the caller (git in the workspace root). Only one recording per
// workspace; starting a new one supersedes any in progress.
func (m *Manager) StartInvestigation(workspaceID, name, commit, branch string) *Investigation {
	if name == "" {
		name = "Investigation " + time.Now().Format("2006-01-02 15:04")
	}
	inv := &Investigation{
		ID:          shortID(),
		WorkspaceID: workspaceID,
		Name:        name,
		Commit:      commit,
		Branch:      branch,
		CreatedAt:   time.Now().UnixMilli(),
		Status:      "recording",
		Events:      make([]CapturedEvent, 0, 64),
		start:       time.Now(),
	}
	m.captureMu.Lock()
	m.activeInvestigations[workspaceID] = inv
	m.captureMu.Unlock()

	m.hub.Broadcast("investigation:started", map[string]any{
		"workspaceId": workspaceID,
		"id":          inv.ID,
		"name":        inv.Name,
	})
	return inv
}

// AnnotateInvestigation adds an agent note to the active timeline. The note is
// broadcast (so a live viewer sees it) and captured via the tap.
func (m *Manager) AnnotateInvestigation(workspaceID, text string) bool {
	m.captureMu.Lock()
	active := m.activeInvestigations[workspaceID] != nil
	m.captureMu.Unlock()
	if !active {
		return false
	}
	m.hub.Broadcast("investigation:note", map[string]any{
		"workspaceId": workspaceID,
		"text":        text,
		"ts":          time.Now().UnixMilli(),
	})
	return true
}

// StopInvestigation finalizes and returns the recording (status=saved). The
// caller persists it and may attach a canvas snapshot first. Returns nil if
// no investigation was active.
func (m *Manager) StopInvestigation(workspaceID string) *Investigation {
	m.captureMu.Lock()
	inv := m.activeInvestigations[workspaceID]
	delete(m.activeInvestigations, workspaceID)
	m.captureMu.Unlock()
	if inv == nil {
		return nil
	}
	inv.Status = "saved"
	inv.DurationMs = time.Since(inv.start).Milliseconds()
	m.hub.Broadcast("investigation:stopped", map[string]any{
		"workspaceId": workspaceID,
		"id":          inv.ID,
		"eventCount":  len(inv.Events),
	})
	return inv
}

// ActiveInvestigation returns the in-progress recording for a workspace (or nil).
func (m *Manager) ActiveInvestigation(workspaceID string) *Investigation {
	m.captureMu.Lock()
	defer m.captureMu.Unlock()
	inv := m.activeInvestigations[workspaceID]
	if inv == nil {
		return nil
	}
	cp := *inv
	cp.Events = nil // callers that want events use the returned recording from Stop
	return &cp
}

// shortID returns a URL-safe 8-char base32 id (Crockford-ish, no ambiguous
// chars). Falls back to a time-seeded id if the CSPRNG is unavailable, so a
// failed read can never yield a constant "00000000" that silently collides.
func shortID() string {
	const alphabet = "0123456789abcdefghjkmnpqrstvwxyz"
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		seed := time.Now().UnixNano()
		for i := range b {
			b[i] = byte(seed >> (uint(i) * 8))
		}
	}
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b)
}
