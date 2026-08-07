package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"axiom.local/archd/internal/activity"
	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/delta"
)

// firstReviewLookbackMs bounds the very first delta a workspace ever shows.
// Without it, opening a project for the first time would present its entire
// initial classification as "what changed while you were away", which is both
// false and useless.
const firstReviewLookbackMs = 12 * 60 * 60 * 1000

// GET /api/delta?workspace=&since=
//
// Returns the net architectural diff since the caller's watermark. This is the
// Morning Delta: the answer to "what did my agents do while I wasn't looking?"
// Reading a delta never acknowledges it — the watermark only moves on ack, so
// closing the app without reviewing keeps the delta waiting for you.
func (s *Server) handleDelta(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	workspaceID := r.URL.Query().Get("workspace")
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}

	now := time.Now().UnixMilli()
	since, err := db.GetDeltaReviewedAt(sqlDB, workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	if since == 0 {
		since = now - firstReviewLookbackMs
	}
	// An explicit ?since wins, so the UI can widen the window ("show me the
	// last week") without disturbing the stored watermark.
	if raw := r.URL.Query().Get("since"); raw != "" {
		var explicit int64
		if _, scanErr := fmt.Sscanf(raw, "%d", &explicit); scanErr == nil && explicit >= 0 {
			since = explicit
		}
	}

	if err := db.PruneStructuralEvents(sqlDB, workspaceID, now); err != nil {
		log.Printf("api: prune journal for %s: %v", workspaceID, err)
	}
	if err := db.PruneDeltaSnapshots(sqlDB, workspaceID, now); err != nil {
		log.Printf("api: prune delta snapshots for %s: %v", workspaceID, err)
	}
	events, err := db.GetStructuralEvents(sqlDB, workspaceID, since)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}

	summary := delta.Aggregate(events, since, now)
	after, snapshotErr := s.saveDeltaSnapshot(sqlDB, workspaceID, now)
	if snapshotErr != nil {
		log.Printf("api: save delta snapshot for %s: %v", workspaceID, snapshotErr)
		summary.Claims = delta.BuildClaims(summary, s.systemTopology(sqlDB, workspaceID))
	} else {
		var before *delta.ArchitectureSnapshot
		if encoded, loadErr := db.GetDeltaSnapshot(sqlDB, workspaceID, since); loadErr != nil {
			log.Printf("api: load delta snapshot for %s at %d: %v", workspaceID, since, loadErr)
		} else if encoded != "" {
			var decoded delta.ArchitectureSnapshot
			if decodeErr := json.Unmarshal([]byte(encoded), &decoded); decodeErr != nil {
				log.Printf("api: decode delta snapshot for %s at %d: %v", workspaceID, since, decodeErr)
			} else {
				before = &decoded
			}
		}
		summary.Claims = delta.BuildClaimsWithSnapshots(summary, before, after)
	}
	summary.Claims = delta.ClassifyRealization(
		summary.Claims,
		dispatchedIntents(sqlDB, workspaceID),
	)
	if sessions, err := db.GetWorkSessions(sqlDB, workspaceID, since); err == nil {
		summary.Sessions = sessions
	} else {
		log.Printf("api: work sessions for %s: %v", workspaceID, err)
	}
	jsonOK(w, summary)
}

func dispatchedIntents(sqlDB *sql.DB, workspaceID string) []delta.Intent {
	messages, err := db.GetCanvasMessages(sqlDB, workspaceID)
	if err != nil {
		return nil
	}
	intents := []delta.Intent{}
	for _, message := range messages {
		if message.SheetContext == "" {
			continue
		}
		var context agentSheetContext
		if json.Unmarshal([]byte(message.SheetContext), &context) != nil {
			continue
		}
		for _, node := range context.Nodes {
			if !node.Planned {
				continue
			}
			intents = append(intents, delta.Intent{
				ID:           message.ID + ":" + node.ID,
				DispatchedAt: message.CreatedAt,
				Kind:         node.Type,
				Name:         node.Name,
				DeclaredPath: node.DeclaredPath,
				Metadata:     node.Metadata,
			})
		}
		for index, edge := range context.Edges {
			if !edge.Planned {
				continue
			}
			intents = append(intents, delta.Intent{
				ID:           fmt.Sprintf("%s:edge:%d", message.ID, index),
				DispatchedAt: message.CreatedAt,
				Kind:         "edge",
				Source:       edge.Source,
				Target:       edge.Target,
			})
		}
	}
	return intents
}

// GET  /api/work/active?workspace=...
// POST /api/work/start  {workspaceId, ownerKey, agent, goal, focusSystemIds, focusFileIds}
// POST /api/work/note   {workspaceId, sessionId, text}
// POST /api/work/finish {workspaceId, sessionId, summary}
//
// Narration is the bidirectional half of the delta. Topology alone says what
// moved; only the agent that moved it can say why. These are deliberately
// forgiving — a missing session is never an error worth failing a tool call
// over, because losing narration must never block the work itself.
func (s *Server) handleWork(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/active") {
		workspaceID := r.URL.Query().Get("workspace")
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 404)
			return
		}
		sessions, err := db.GetActiveWorkSessions(sqlDB, workspaceID)
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		jsonOK(w, sessions)
		return
	}
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID    string   `json:"workspaceId"`
		RootID         string   `json:"rootId"`
		Branch         string   `json:"branch"`
		SessionID      string   `json:"sessionId"`
		OwnerKey       string   `json:"ownerKey"`
		Agent          string   `json:"agent"`
		Goal           string   `json:"goal"`
		Text           string   `json:"text"`
		Summary        string   `json:"summary"`
		FocusSystemIDs []string `json:"focusSystemIds"`
		FocusFileIDs   []string `json:"focusFileIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid body", 400)
		return
	}
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}

	switch {
	case strings.HasSuffix(r.URL.Path, "/start"):
		if strings.TrimSpace(body.Goal) == "" {
			jsonError(w, "goal is required", 400)
			return
		}
		session, err := db.StartWorkSession(sqlDB, db.WorkSession{
			ID:             uuid.NewString(),
			WorkspaceID:    body.WorkspaceID,
			RootID:         body.RootID,
			Branch:         body.Branch,
			OwnerKey:       body.OwnerKey,
			Agent:          body.Agent,
			Goal:           body.Goal,
			FocusSystemIDs: body.FocusSystemIDs,
			FocusFileIDs:   body.FocusFileIDs,
		})
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		activity.MarkAgent(body.WorkspaceID)
		s.hub.Broadcast("work:session", session)
		jsonOK(w, session)

	case strings.HasSuffix(r.URL.Path, "/note"):
		if strings.TrimSpace(body.SessionID) == "" {
			jsonError(w, "sessionId is required", 400)
			return
		}
		if err := db.AppendWorkSessionNoteByID(
			sqlDB, body.WorkspaceID, body.SessionID, body.Text,
		); err != nil {
			jsonError(w, "no active work session — call start_work first", 409)
			return
		}
		session, err := db.GetWorkSession(sqlDB, body.WorkspaceID, body.SessionID)
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		activity.MarkAgent(body.WorkspaceID)
		s.hub.Broadcast("work:session", session)
		jsonOK(w, session)

	case strings.HasSuffix(r.URL.Path, "/finish"):
		if strings.TrimSpace(body.SessionID) == "" {
			jsonError(w, "sessionId is required", 400)
			return
		}
		if err := db.FinishWorkSessionByID(
			sqlDB, body.WorkspaceID, body.SessionID, body.Summary,
		); err != nil {
			jsonError(w, "no active work session", 409)
			return
		}
		session, err := db.GetWorkSession(sqlDB, body.WorkspaceID, body.SessionID)
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		s.hub.Broadcast("work:session", session)
		jsonOK(w, session)

	default:
		http.NotFound(w, r)
	}
}

// systemTopology projects the current file-level dependency graph up to the
// system level. Claims need it for one question the journal cannot answer:
// does this new dependency close a loop between systems? A best-effort empty
// topology simply means no cycle is reported, never a failed delta.
func (s *Server) systemTopology(sqlDB *sql.DB, workspaceID string) delta.SystemTopology {
	snapshot, err := s.architectureSnapshot(sqlDB, workspaceID)
	if err != nil {
		return nil
	}
	return snapshot.Topology
}

func (s *Server) architectureSnapshot(
	sqlDB *sql.DB,
	workspaceID string,
) (*delta.ArchitectureSnapshot, error) {
	systems, err := db.GetSystems(sqlDB, workspaceID)
	if err != nil {
		return nil, err
	}
	files, err := db.GetFiles(sqlDB, workspaceID)
	if err != nil {
		return nil, err
	}
	systemOf := make(map[string]string, len(files))
	for _, file := range files {
		if file.SystemID != nil {
			systemOf[file.ID] = *file.SystemID
		}
	}
	dependencies, err := db.GetDependencies(sqlDB, workspaceID)
	if err != nil {
		return nil, err
	}
	snapshot := &delta.ArchitectureSnapshot{
		Systems:  make(map[string]string, len(systems)),
		Topology: delta.SystemTopology{},
	}
	for _, system := range systems {
		snapshot.Systems[system.ID] = system.Name
	}
	addEdge := func(srcFileID, dstFileID string) {
		src, dst := systemOf[srcFileID], systemOf[dstFileID]
		if src == "" || dst == "" || src == dst {
			return
		}
		if snapshot.Topology[src] == nil {
			snapshot.Topology[src] = map[string]bool{}
		}
		snapshot.Topology[src][dst] = true
	}
	for _, dep := range dependencies {
		addEdge(dep.Src, dep.Dst)
	}
	roots, err := db.GetRoots(sqlDB, workspaceID)
	if err != nil {
		return nil, err
	}
	for _, root := range roots {
		calls, callErr := db.GetCallEdgesByRoot(sqlDB, root.ID)
		if callErr != nil {
			return nil, callErr
		}
		for _, call := range calls {
			addEdge(call.CallerFile, call.CalleeFile)
		}
	}
	return snapshot, nil
}

func (s *Server) saveDeltaSnapshot(
	sqlDB *sql.DB,
	workspaceID string,
	at int64,
) (*delta.ArchitectureSnapshot, error) {
	snapshot, err := s.architectureSnapshot(sqlDB, workspaceID)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	if err := db.SaveDeltaSnapshot(sqlDB, workspaceID, at, string(encoded)); err != nil {
		return nil, err
	}
	return snapshot, nil
}

// POST /api/delta/ack {workspaceId, until}
//
// Marks the delta reviewed up to a point in time. The renderer sends back the
// Until it was actually shown, never "now", so events that landed while the
// user was reading survive into the next delta instead of being silently
// swallowed.
func (s *Server) handleDeltaAck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		Until       int64  `json:"until"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid body", 400)
		return
	}
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	if body.Until <= 0 {
		body.Until = time.Now().UnixMilli()
	}
	if err := db.SetDeltaReviewedAt(sqlDB, body.WorkspaceID, body.Until); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	jsonOK(w, map[string]any{"reviewedAt": body.Until})
}
