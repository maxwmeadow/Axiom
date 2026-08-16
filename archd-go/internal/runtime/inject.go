// Injection (perturbation) lifecycle - the archd side of Inspect-Perturb-Validate.
//
// State machine:
//
//	pending_confirm ──user approves──▶ armed ──call happens──▶ fired
//	      │                              │                        (one-shot: also removed)
//	      ├──user denies──▶ denied       ├──adapter refuses──▶ error
//	      └──2min timeout──▶ expired     └──cancel──▶ removed
//
// The agent's inject_value MCP call returns immediately with pending_confirm;
// the user approves on the canvas (warn-and-confirm model - plan §Safe
// Perturbation). AXIOM_AUTO_CONFIRM_INJECT=1 skips confirmation for headless
// use and tests.
package runtime

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

const confirmTimeout = 2 * time.Minute

// Inject is one perturbation request and its observed outcome.
type Inject struct {
	ID          string          `json:"id"`
	WorkspaceID string          `json:"workspaceId"`
	FileID      string          `json:"fileId"`
	RelPath     string          `json:"relPath"`
	AbsPath     string          `json:"absPath"`
	Symbol      string          `json:"symbol"`
	LineStart   int             `json:"lineStart"`
	LineEnd     int             `json:"lineEnd"`
	ParamName   string          `json:"paramName"`
	Value       json.RawMessage `json:"value"`
	Once        bool            `json:"once"`
	Status      string          `json:"status"` // pending_confirm|armed|fired|denied|expired|removed|error
	Error       string          `json:"error,omitempty"`
	CreatedAt   int64           `json:"createdAt"`
	FiredAt     int64           `json:"firedAt,omitempty"`
	// Filled from the adapter's inject_fired event:
	OriginalValue json.RawMessage `json:"originalValue,omitempty"`
	InjectedValue json.RawMessage `json:"injectedValue,omitempty"`
}

// SetAutoConfirm skips the user confirmation step (headless/test mode).
func (m *Manager) SetAutoConfirm(v bool) {
	m.mu.Lock()
	m.autoConfirm = v
	m.mu.Unlock()
}

// RequestInject registers a perturbation. Unless auto-confirm is on, it waits
// in pending_confirm until the user approves on the canvas.
func (m *Manager) RequestInject(inj *Inject) *Inject {
	if inj.ID == "" {
		inj.ID = uuid.New().String()
	}
	inj.CreatedAt = time.Now().UnixMilli()
	inj.Status = "pending_confirm"

	m.mu.Lock()
	m.injects[inj.ID] = inj
	m.pruneInjectsLocked()
	auto := m.autoConfirm
	dto := *inj
	m.mu.Unlock()

	m.hub.Broadcast("runtime:inject_pending", map[string]any{
		"workspaceId": inj.WorkspaceID,
		"inject":      dto,
	})

	if auto {
		if _, err := m.ConfirmInject(inj.WorkspaceID, inj.ID, true); err != nil {
			m.setInjectError(inj.ID, err.Error())
		}
		m.mu.RLock()
		dto = *inj
		m.mu.RUnlock()
		return &dto
	}

	// Expire unconfirmed requests so a stale dialog can't fire days later.
	// AfterFunc holds no goroutine while waiting; the callback no-ops if the
	// injection was resolved in the meantime.
	id := inj.ID
	time.AfterFunc(confirmTimeout, func() {
		m.mu.Lock()
		if cur, ok := m.injects[id]; ok && cur.Status == "pending_confirm" {
			cur.Status = "expired"
			cp := *cur
			m.mu.Unlock()
			m.broadcastInject(cp)
			return
		}
		m.mu.Unlock()
	})
	return &dto
}

// pruneInjectsLocked evicts the oldest resolved injections beyond a retention
// cap so the map cannot grow forever. Pending/armed ones are never evicted.
func (m *Manager) pruneInjectsLocked() {
	const keepResolved = 50
	resolved := make([]*Inject, 0)
	for _, inj := range m.injects {
		switch inj.Status {
		case "pending_confirm", "armed":
		default:
			resolved = append(resolved, inj)
		}
	}
	for len(resolved) > keepResolved {
		oldest := 0
		for i, inj := range resolved {
			if inj.CreatedAt < resolved[oldest].CreatedAt {
				oldest = i
			}
		}
		delete(m.injects, resolved[oldest].ID)
		resolved = append(resolved[:oldest], resolved[oldest+1:]...)
	}
}

// ConfirmInject resolves the user's decision. On approval the injection is
// pushed to every connected session in the workspace.
func (m *Manager) ConfirmInject(workspaceID, id string, approved bool) (*Inject, error) {
	m.mu.Lock()
	inj, ok := m.injects[id]
	if !ok || inj.WorkspaceID != workspaceID {
		m.mu.Unlock()
		return nil, fmt.Errorf("injection %s not found", id)
	}
	if inj.Status != "pending_confirm" {
		m.mu.Unlock()
		return nil, fmt.Errorf("injection %s is %s, not awaiting confirmation", id, inj.Status)
	}
	if !approved {
		inj.Status = "denied"
		cp := *inj
		m.mu.Unlock()
		m.broadcastInject(cp)
		return &cp, nil
	}
	sessions := m.sessionsForLocked(workspaceID)
	if len(sessions) == 0 {
		inj.Status = "error"
		inj.Error = "no runtime session connected - launch the target first"
		cp := *inj
		m.mu.Unlock()
		m.broadcastInject(cp)
		return &cp, fmt.Errorf("%s", inj.Error)
	}
	inj.Status = "armed" // optimistic; adapter reports inject_armed / inject_error
	cp := *inj
	m.mu.Unlock()

	for _, s := range sessions {
		go m.sendOrDrop(s, map[string]any{"type": "inject", "inject": cp})
	}
	m.broadcastInject(cp)
	return &cp, nil
}

// CancelInject removes an armed injection from the adapters.
func (m *Manager) CancelInject(workspaceID, id string) (*Inject, error) {
	m.mu.Lock()
	inj, ok := m.injects[id]
	if !ok || inj.WorkspaceID != workspaceID {
		m.mu.Unlock()
		return nil, fmt.Errorf("injection %s not found", id)
	}
	inj.Status = "removed"
	cp := *inj
	sessions := m.sessionsForLocked(workspaceID)
	m.mu.Unlock()

	for _, s := range sessions {
		go m.sendOrDrop(s, map[string]any{"type": "uninject", "injectId": id})
	}
	m.broadcastInject(cp)
	return &cp, nil
}

func (m *Manager) setInjectError(id, msg string) {
	m.mu.Lock()
	if inj, ok := m.injects[id]; ok {
		inj.Status = "error"
		inj.Error = msg
		cp := *inj
		m.mu.Unlock()
		m.broadcastInject(cp)
		return
	}
	m.mu.Unlock()
}

func (m *Manager) broadcastInject(cp Inject) {
	m.hub.Broadcast("runtime:inject", map[string]any{
		"workspaceId": cp.WorkspaceID,
		"inject":      cp,
	})
}

// handleInjectEvent processes inject_* events reported by an adapter.
func (m *Manager) handleInjectEvent(sess *Session, ae AdapterEvent) {
	m.mu.Lock()
	inj, ok := m.injects[ae.InjectID]
	if !ok {
		m.mu.Unlock()
		return
	}
	switch ae.Kind {
	case "inject_armed":
		// Already optimistically armed; nothing to change.
	case "inject_fired":
		inj.Status = "fired"
		inj.FiredAt = ae.TS
		inj.OriginalValue = ae.Original
		inj.InjectedValue = ae.Injected
	case "inject_removed":
		if inj.Status != "fired" { // one-shot fired+removed keeps 'fired' as outcome
			inj.Status = "removed"
		}
	case "inject_error":
		// With several sessions in a workspace, one process may lack the
		// module while another armed and fired successfully - a session's
		// error must not overwrite a fired outcome.
		if inj.Status != "fired" {
			inj.Status = "error"
			inj.Error = ae.Message
		}
	}
	cp := *inj
	ev := Event{
		AdapterEvent: ae,
		SessionID:    sess.ID,
		WorkspaceID:  inj.WorkspaceID,
		FileID:       inj.FileID,
		RelPath:      inj.RelPath,
		Symbol:       inj.Symbol,
	}
	m.appendEventLocked(ev)
	m.mu.Unlock()

	m.broadcastInject(cp)
}

// injectsForLocked returns value copies of a workspace's injections.
func (m *Manager) injectsForLocked(workspaceID string) []Inject {
	out := make([]Inject, 0)
	for _, inj := range m.injects {
		if inj.WorkspaceID == workspaceID {
			out = append(out, *inj)
		}
	}
	return out
}
