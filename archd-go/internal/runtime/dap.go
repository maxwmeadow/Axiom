// Minimal Debug Adapter Protocol client - just enough of DAP to drive delve
// for the Go tracing spike. Messages are Content-Length framed JSON (same
// framing as LSP). A single reader goroutine demultiplexes responses (matched
// to requests by seq) from events (delivered on a channel).
package runtime

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// maxDAPMessageBytes bounds a single DAP frame so a malformed/hostile
// Content-Length can't trigger a huge allocation.
const maxDAPMessageBytes = 32 << 20 // 32 MiB

type dapMessage struct {
	Seq     int    `json:"seq"`
	Type    string `json:"type"` // request|response|event
	Command string `json:"command,omitempty"`
	Event   string `json:"event,omitempty"`
	// response fields
	RequestSeq int             `json:"request_seq,omitempty"`
	Success    bool            `json:"success,omitempty"`
	Message    string          `json:"message,omitempty"`
	Body       json.RawMessage `json:"body,omitempty"`
	Arguments  json.RawMessage `json:"arguments,omitempty"`
}

type dapEvent struct {
	Event string
	Body  json.RawMessage
}

// dapClient speaks DAP over any reader/writer pair: a TCP net.Conn (delve) or
// a subprocess's stdout/stdin pipes (netcoredbg, whose TCP --server mode is
// unreliable, so we drive it over stdio the way VS Code does).
type dapClient struct {
	rd     io.Reader
	w      *bufio.Writer
	closer func() error
	writeM sync.Mutex

	seq     int
	seqM    sync.Mutex
	pending map[int]chan dapMessage
	pendM   sync.Mutex

	events chan dapEvent
	closed chan struct{}
	closeM sync.Once
}

// newDAPClientConn drives DAP over a TCP connection.
func newDAPClientConn(conn net.Conn) *dapClient {
	return newDAPClient(conn, conn, conn.Close)
}

// newDAPClient drives DAP over an arbitrary reader/writer with a close hook.
func newDAPClient(rd io.Reader, wr io.Writer, closer func() error) *dapClient {
	c := &dapClient{
		rd:      rd,
		w:       bufio.NewWriter(wr),
		closer:  closer,
		pending: make(map[int]chan dapMessage),
		events:  make(chan dapEvent, 1024), // headroom for chatty startup (gdb banner, module/thread events) before the event loop drains
		closed:  make(chan struct{}),
	}
	go c.readLoop()
	return c
}

func (c *dapClient) nextSeq() int {
	c.seqM.Lock()
	defer c.seqM.Unlock()
	c.seq++
	return c.seq
}

// request sends a DAP request and blocks for its response (or timeout/close).
func (c *dapClient) request(command string, args any) (dapMessage, error) {
	seq := c.nextSeq()
	ch := make(chan dapMessage, 1)
	c.pendM.Lock()
	c.pending[seq] = ch
	c.pendM.Unlock()
	defer func() {
		c.pendM.Lock()
		delete(c.pending, seq)
		c.pendM.Unlock()
	}()

	var rawArgs json.RawMessage
	if args != nil {
		b, err := json.Marshal(args)
		if err != nil {
			return dapMessage{}, err
		}
		rawArgs = b
	}
	msg := dapMessage{Seq: seq, Type: "request", Command: command, Arguments: rawArgs}
	if err := c.send(msg); err != nil {
		return dapMessage{}, err
	}

	select {
	case resp := <-ch:
		if !resp.Success {
			return resp, fmt.Errorf("dap %s failed: %s", command, resp.Message)
		}
		return resp, nil
	case <-time.After(15 * time.Second):
		return dapMessage{}, fmt.Errorf("dap %s timed out", command)
	case <-c.closed:
		return dapMessage{}, fmt.Errorf("dap connection closed")
	}
}

func (c *dapClient) send(msg dapMessage) error {
	body, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	c.writeM.Lock()
	defer c.writeM.Unlock()
	if _, err := fmt.Fprintf(c.w, "Content-Length: %d\r\n\r\n", len(body)); err != nil {
		return err
	}
	if _, err := c.w.Write(body); err != nil {
		return err
	}
	return c.w.Flush()
}

func (c *dapClient) readLoop() {
	r := bufio.NewReader(c.rd)
	defer c.close()
	for {
		length, err := readDAPHeader(r)
		if err != nil {
			return
		}
		if length < 0 || length > maxDAPMessageBytes {
			return // malformed / hostile Content-Length - bail rather than OOM
		}
		buf := make([]byte, length)
		if _, err := io.ReadFull(r, buf); err != nil {
			return
		}
		var msg dapMessage
		if err := json.Unmarshal(buf, &msg); err != nil {
			continue
		}
		switch msg.Type {
		case "response":
			c.pendM.Lock()
			ch := c.pending[msg.RequestSeq]
			c.pendM.Unlock()
			if ch != nil {
				ch <- msg
			}
		case "event":
			select {
			case c.events <- dapEvent{Event: msg.Event, Body: msg.Body}:
			case <-c.closed:
				return
			}
		}
	}
}

func readDAPHeader(r *bufio.Reader) (int, error) {
	length := -1
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return 0, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if length < 0 {
				return 0, fmt.Errorf("missing Content-Length")
			}
			return length, nil
		}
		if strings.HasPrefix(line, "Content-Length:") {
			n, err := strconv.Atoi(strings.TrimSpace(line[len("Content-Length:"):]))
			if err != nil {
				return 0, err
			}
			length = n
		}
	}
}

func (c *dapClient) close() {
	c.closeM.Do(func() {
		close(c.closed)
		if c.closer != nil {
			c.closer()
		}
	})
}
