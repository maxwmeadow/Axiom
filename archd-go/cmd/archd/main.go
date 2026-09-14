// archd - Axiom parser daemon.
//
// Usage:
//
//	archd -data <dir> [-ws-port 7744] [-api-port 7743]
//
// The daemon:
//  1. Opens (or creates) the SQLite graph database at <data>/axiom.db
//  2. Starts an HTTP server on api-port (REST API + WebSocket on /ws)
//  3. Reads JSON commands from stdin (sent by Electron main process via IPC pipe)
//  4. On receiving an "open:project" command, indexes the root and watches for changes
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"axiom.local/archd/internal/api"
	"axiom.local/archd/internal/hub"
	"axiom.local/archd/internal/runtime"
)

func main() {
	dataDir := flag.String("data", "", "directory for axiom.db (required)")
	wsPort := flag.Int("ws-port", 7744, "WebSocket port")
	apiPort := flag.Int("api-port", 7743, "HTTP API port")
	runtimePort := flag.Int("runtime-port", 7745, "runtime adapter TCP port")
	flag.Parse()

	if *dataDir == "" {
		fmt.Fprintln(os.Stderr, "archd: -data flag required")
		os.Exit(1)
	}

	// ── Hub ───────────────────────────────────────────────────────────────────
	h := hub.New()

	// ── Runtime adapter server ────────────────────────────────────────────────
	// Language adapters running inside target processes connect here over TCP
	// (newline-delimited JSON) to stream call/return events.
	rt := runtime.NewManager(h)
	if os.Getenv("AXIOM_AUTO_CONFIRM_INJECT") == "1" {
		log.Println("archd: AXIOM_AUTO_CONFIRM_INJECT=1 - injections skip user confirmation")
		rt.SetAutoConfirm(true)
	}
	if err := rt.Listen(*runtimePort); err != nil {
		log.Fatalf("archd: runtime: %v", err)
	}

	// ── HTTP server ───────────────────────────────────────────────────────────
	// Each project gets its own database at <dataDir>/<workspaceId>/axiom.db,
	// opened on demand when POST /api/workspace is called. No global DB here.
	srv := api.NewServer(*dataDir, h, rt)
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	addr := fmt.Sprintf("127.0.0.1:%d", *apiPort)
	// Loopback-origin CORS: the dev renderer is served from localhost:5173,
	// a different origin from this port. See api.AllowLoopbackOrigins.
	handler := api.AllowLoopbackOrigins(mux)
	httpServer := &http.Server{Addr: addr, Handler: handler}
	go func() {
		log.Printf("archd: HTTP API listening on %s", addr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("archd: http: %v", err)
		}
	}()

	// WebSocket runs on the same mux (the /ws route), so we also listen on wsPort
	// if it differs from apiPort. Electron may connect either port.
	if *wsPort != *apiPort {
		wsAddr := fmt.Sprintf("127.0.0.1:%d", *wsPort)
		wsServer := &http.Server{Addr: wsAddr, Handler: handler}
		go func() {
			log.Printf("archd: WebSocket listening on %s", wsAddr)
			if err := wsServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Fatalf("archd: ws: %v", err)
			}
		}()
	}

	// ── Stdin IPC loop ────────────────────────────────────────────────────────
	// Electron sends newline-delimited JSON commands to our stdin.
	// We respond by writing JSON to stdout (one line per response).
	go runIPCLoop(h, srv)

	// ── Signals ───────────────────────────────────────────────────────────────
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("archd: shutting down")
}

// IPCCommand is the envelope for all stdin commands from Electron.
type IPCCommand struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// IPCResponse is the envelope for stdout responses.
type IPCResponse struct {
	Type    string `json:"type"`
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
	Payload any    `json:"payload,omitempty"`
}

func respond(v IPCResponse) {
	line, _ := json.Marshal(v)
	fmt.Println(string(line))
}

func runIPCLoop(_ *hub.Hub, _ *api.Server) {
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := scanner.Bytes()
		var cmd IPCCommand
		if err := json.Unmarshal(line, &cmd); err != nil {
			log.Printf("ipc: bad command: %v", err)
			continue
		}
		switch cmd.Type {
		case "ping":
			respond(IPCResponse{Type: "pong", Success: true})
		default:
			// Most commands go through the REST API directly (Electron uses fetch).
			// The IPC pipe is only for commands that need process-level awareness.
			log.Printf("ipc: unknown command type: %s", cmd.Type)
		}
	}
	if err := scanner.Err(); err != nil {
		log.Printf("ipc: stdin error: %v", err)
	}
}
