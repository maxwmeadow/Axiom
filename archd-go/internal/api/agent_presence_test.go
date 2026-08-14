package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"axiom.local/archd/internal/hub"
	axiomruntime "axiom.local/archd/internal/runtime"
)

func TestAgentPresenceIsALiveLeaseNotPermanentHistory(t *testing.T) {
	now := time.UnixMilli(1_000_000)
	eventHub := hub.New()
	server := NewServer(t.TempDir(), eventHub, axiomruntime.NewManager(eventHub))
	server.presenceNow = func() time.Time { return now }
	server.agentPresenceTTL = 15 * time.Second

	body := []byte(`{"workspaceId":"ws","connectionId":"process-1","hostId":"codex"}`)
	post := httptest.NewRequest(http.MethodPost, "/api/agent/presence", bytes.NewReader(body))
	postResponse := httptest.NewRecorder()
	server.handleAgentPresence(postResponse, post)
	if postResponse.Code != http.StatusOK {
		t.Fatalf("POST status %d: %s", postResponse.Code, postResponse.Body.String())
	}
	var firstLease struct {
		NewLease bool `json:"newLease"`
	}
	if err := json.Unmarshal(postResponse.Body.Bytes(), &firstLease); err != nil {
		t.Fatal(err)
	}
	if !firstLease.NewLease {
		t.Fatal("first heartbeat should create a new lease")
	}

	renew := httptest.NewRequest(http.MethodPost, "/api/agent/presence", bytes.NewReader(body))
	renewResponse := httptest.NewRecorder()
	server.handleAgentPresence(renewResponse, renew)
	var renewedLease struct {
		NewLease bool `json:"newLease"`
	}
	if err := json.Unmarshal(renewResponse.Body.Bytes(), &renewedLease); err != nil {
		t.Fatal(err)
	}
	if renewedLease.NewLease {
		t.Fatal("renewing an active heartbeat should not create a new lease")
	}

	read := func() struct {
		Connected   bool            `json:"connected"`
		Connections []AgentPresence `json:"connections"`
	} {
		response := httptest.NewRecorder()
		server.handleAgentPresence(
			response,
			httptest.NewRequest(http.MethodGet, "/api/agent/presence?workspace=ws", nil),
		)
		if response.Code != http.StatusOK {
			t.Fatalf("GET status %d: %s", response.Code, response.Body.String())
		}
		var result struct {
			Connected   bool            `json:"connected"`
			Connections []AgentPresence `json:"connections"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}

	active := read()
	if !active.Connected || len(active.Connections) != 1 || active.Connections[0].HostID != "codex" {
		t.Fatalf("active lease = %#v", active)
	}

	now = now.Add(16 * time.Second)
	expired := read()
	if expired.Connected || len(expired.Connections) != 0 {
		t.Fatalf("expired lease = %#v", expired)
	}
}
