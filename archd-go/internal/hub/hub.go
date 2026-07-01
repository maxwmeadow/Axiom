// Package hub manages WebSocket clients and broadcasts graph updates to the renderer.
package hub

import (
	"encoding/json"
	"log"
	"sync"

	"github.com/gorilla/websocket"
)

// Message is the envelope for all WebSocket events.
type Message struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type client struct {
	conn *websocket.Conn
	send chan []byte
}

// Hub maintains the set of active WebSocket connections.
type Hub struct {
	mu      sync.RWMutex
	clients map[*client]struct{}
}

func New() *Hub {
	return &Hub{clients: make(map[*client]struct{})}
}

// Register adds a new WebSocket connection and starts its write pump.
func (h *Hub) Register(conn *websocket.Conn) {
	c := &client{conn: conn, send: make(chan []byte, 64)}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	go c.writePump(func() {
		h.mu.Lock()
		delete(h.clients, c)
		h.mu.Unlock()
	})
}

func (c *client) writePump(onDone func()) {
	defer func() {
		c.conn.Close()
		onDone()
	}()
	for msg := range c.send {
		if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			return
		}
	}
}

// Broadcast sends a typed message to all connected clients.
func (h *Hub) Broadcast(msgType string, payload any) {
	raw, err := json.Marshal(payload)
	if err != nil {
		log.Printf("hub: marshal %s: %v", msgType, err)
		return
	}
	msg, err := json.Marshal(Message{Type: msgType, Payload: raw})
	if err != nil {
		log.Printf("hub: marshal envelope: %v", err)
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		select {
		case c.send <- msg:
		default:
			// slow client — drop message rather than block
			log.Printf("hub: dropping message for slow client")
		}
	}
}

// BroadcastSnapshot sends a full graph:snapshot event.
func (h *Hub) BroadcastSnapshot(payload any) {
	h.Broadcast("graph:snapshot", payload)
}

// BroadcastPatch sends a graph:patch event with incremental changes.
func (h *Hub) BroadcastPatch(payload any) {
	h.Broadcast("graph:patch", payload)
}

// BroadcastIndexingProgress reports indexing progress to the UI.
func (h *Hub) BroadcastIndexingProgress(indexed, total int) {
	h.Broadcast("indexing:progress", map[string]any{
		"indexed": indexed,
		"total":   total,
	})
}

// BroadcastIndexingComplete signals that initial indexing finished.
func (h *Hub) BroadcastIndexingComplete(workspaceID string) {
	h.Broadcast("indexing:complete", map[string]any{
		"workspaceId": workspaceID,
	})
}

// ClientCount returns the number of connected WebSocket clients.
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}
