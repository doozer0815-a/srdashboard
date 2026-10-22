package api

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	wsSendQueue   = 64
	wsWriteWait   = 5 * time.Second
	wsPongWait    = 60 * time.Second
	wsPingPeriod  = 30 * time.Second
)

var upgrader = websocket.Upgrader{
	CheckOrigin: sameOrigin,
}

// sameOrigin rejects cross-site WebSocket connections. Kiosk displays and
// tablets always browse the dashboard directly, so their Origin matches Host;
// non-browser clients send no Origin at all and are allowed through.
func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, r.Host)
}

type wsClient struct {
	hub    *Hub
	conn   *websocket.Conn
	filter int // 0 = all ranges
	audioReceiver bool
	audioSource bool
	send   chan []byte
}

type Hub struct {
	mu      sync.RWMutex
	clients map[*wsClient]struct{}
}

func NewHub() *Hub {
	return &Hub{clients: make(map[*wsClient]struct{})}
}

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	rangeNum := parseIntQuery(r, "range", 0)
	audioReceiver := r.URL.Query().Get("audio") == "1"
	audioSource := r.URL.Query().Get("audioSource") == "1"
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := &wsClient{
		hub:    h,
		conn:   conn,
		filter: rangeNum,
		audioReceiver: audioReceiver,
		audioSource: audioSource,
		send:   make(chan []byte, wsSendQueue),
	}
	h.mu.Lock()
	h.clients[client] = struct{}{}
	h.mu.Unlock()

	go client.writePump()
	client.readPump()
}

func (c *wsClient) readPump() {
	defer func() {
		c.hub.unregister(c)
		_ = c.conn.Close()
	}()
	_ = c.conn.SetReadDeadline(time.Now().Add(wsPongWait))
	c.conn.SetPongHandler(func(string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(wsPongWait))
		return nil
	})
	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil { return }
		if !c.audioSource { continue }
		var event struct { Type string `json:"type"`; File string `json:"file"` }
		if json.Unmarshal(message, &event) != nil || event.Type != "audio_play" || !validAudioEventFile(event.File) { continue }
		c.hub.broadcastAudio(event.File)
	}
}

func (c *wsClient) writePump() {
	ticker := time.NewTicker(wsPingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()
	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				log.Printf("websocket write: %v", err)
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (h *Hub) unregister(c *wsClient) {
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.send)
	}
	h.mu.Unlock()
}

// enqueue never blocks the caller. If the client is slow, drop the oldest queued
// message so the latest live state still arrives (UDP must not wait on browsers).
func (c *wsClient) enqueue(b []byte) {
	select {
	case c.send <- b:
		return
	default:
	}
	select {
	case <-c.send:
	default:
	}
	select {
	case c.send <- b:
	default:
		log.Printf("websocket: drop message for slow client")
	}
}

func (h *Hub) BroadcastRange(rangeNum int, payload any) {
	b, err := json.Marshal(payload)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		if c.filter != 0 && c.filter != rangeNum {
			continue
		}
		c.enqueue(b)
	}
}

func (h *Hub) BroadcastAll(payload any) {
	b, err := json.Marshal(payload)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		c.enqueue(b)
	}
}

func parseIntQuery(r *http.Request, key string, def int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}


func validAudioEventFile(file string) bool {
	if file == "busted.mp3" || file == "next-player.mp3" || file == "bullseye.mp3" || file == "tripple17.mp3" || file == "tripple18.mp3" || file == "tripple19.mp3" || file == "tripple20.mp3" { return true }
	if !strings.HasSuffix(file, ".mp3") { return false }
	n, err := strconv.Atoi(strings.TrimSuffix(file, ".mp3"))
	return err == nil && n >= 1 && n <= 180
}

func (h *Hub) broadcastAudio(file string) {
	b, err := json.Marshal(map[string]string{"type":"audio_play", "file":file})
	if err != nil { return }
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients { if c.audioReceiver { c.enqueue(b) } }
}
