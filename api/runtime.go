package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"srdashboard/config"
)

type runtimeRequest struct {
	InactiveRanges   []int `json:"inactiveRanges"`
	WettkampfVisible *bool `json:"wettkampfVisible,omitempty"`
}

func (h *Handlers) runtimePath() string {
	return config.RuntimePath(h.ConfigPath)
}

func (h *Handlers) inactiveRangeList() []int {
	max := 0
	if h.Cfg != nil {
		max = h.cfgSnapshot().Ranges
	}
	h.runtimeMu.RLock()
	defer h.runtimeMu.RUnlock()
	if h.Runtime == nil {
		return []int{}
	}
	list := h.Runtime.InactiveList(max)
	if list == nil {
		return []int{}
	}
	return list
}

func (h *Handlers) isRangeInactive(rng int) bool {
	h.runtimeMu.RLock()
	defer h.runtimeMu.RUnlock()
	return h.Runtime != nil && h.Runtime.IsInactive(rng)
}

func (h *Handlers) pruneRuntime(max int) {
	h.runtimeMu.Lock()
	defer h.runtimeMu.Unlock()
	if h.Runtime == nil {
		h.Runtime = &config.Runtime{}
	}
	before := h.Runtime.InactiveRanges
	h.Runtime.Prune(max)
	if h.Runtime.InactiveRanges == before {
		return
	}
	if err := config.SaveRuntime(h.runtimePath(), h.Runtime); err != nil {
		log.Printf("runtime: prune save: %v", err)
	}
}

// AllowShot is the UDP membership gate: configured 1..N and not inactive on this instance.
func (h *Handlers) AllowShot(rng int) bool {
	if h == nil || rng < 1 {
		return false
	}
	n := h.cfgSnapshot().Ranges
	if n < 1 || rng > n {
		return false
	}
	return !h.isRangeInactive(rng)
}

// AllowDiscTypeShot rejects all fun_* target types before they enter live state,
// except fun_dart on a range assigned to the Darts plugin. Darts must not count
// any other fun_* target, and other plugins must not count any fun_* target.
func (h *Handlers) AllowDiscTypeShot(rng int, discTypeRaw string, discType string) bool {
	// Use the plugin manager's active ID as the source of truth. A per-range
	// snapshot can be stale while a plugin activation is being switched.
	pluginID := ""
	if h != nil && h.PluginState != nil {
		pluginID = h.PluginState.ActivePluginID()
	}
	if pluginID == "" && h != nil {
		pluginID = h.cfgSnapshot().Plugins.Active
	}

	raw := strings.TrimSpace(discTypeRaw)
	fallback := strings.TrimSpace(discType)
	if raw == "" {
		// Non-Darts plugins still need to reject fun_* targets on older payloads
		// that omit DiscTypeRaw. Darts does not use this fallback for acceptance.
		raw = fallback
	}
	normalized := normalizeDiscTypeID(raw)
	allowed := true
	if strings.EqualFold(strings.TrimSpace(pluginID), "darts") {
		// Darts is deliberately strict: only the actual DiscTypeRaw identifier
		// "fun_dart" is allowed. LG/LP/KK, missing/aliased IDs and every other
		// fun_* target must be dropped before LiveState is changed.
		allowed = strings.TrimSpace(discTypeRaw) == "fun_dart"
	} else {
		// All other plugins ignore every fun_* target, including case and
		// separator variants, but keep normal target types.
		allowed = !strings.HasPrefix(normalized, "fun_")
	}
	if !allowed {
		log.Printf("UDP target filter: rejected DiscTypeRaw=%q DiscType=%q range=%d activePlugin=%q", discTypeRaw, discType, rng, pluginID)
	}
	return allowed
}

func normalizeDiscTypeID(raw string) string {
	discType := strings.ToLower(strings.TrimSpace(raw))
	return strings.NewReplacer("-", "_", " ", "_").Replace(discType)
}

// ServeRuntime handles GET/PUT /api/runtime — this process's inactive lanes.
func (h *Handlers) ServeRuntime(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		vis := h.wettkampfVisible()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(runtimeRequest{InactiveRanges: h.inactiveRangeList(), WettkampfVisible: &vis})
	case http.MethodPut:
		if !h.checkControlToken(r) {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		var req runtimeRequest
		if !decodeJSONBody(w, r, &req) {
			return
		}
		h.applyInactiveRanges(req.InactiveRanges)
		if req.WettkampfVisible != nil {
			h.setWettkampfVisible(*req.WettkampfVisible)
		}
		if h.Hub != nil {
			h.Hub.BroadcastAll(map[string]any{"type": "config_changed", "config": h.configResponse()})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(h.configResponse())
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (h *Handlers) applyInactiveRanges(nums []int) {
	max := h.cfgSnapshot().Ranges
	h.runtimeMu.Lock()
	if h.Runtime == nil {
		h.Runtime = &config.Runtime{}
	}
	old := make(map[int]bool)
	for _, n := range h.Runtime.InactiveList(max) {
		old[n] = true
	}
	h.Runtime.SetInactiveList(nums, max)
	newly := make([]int, 0)
	for _, n := range h.Runtime.InactiveList(max) {
		if !old[n] {
			newly = append(newly, n)
		}
	}
	list := h.Runtime.InactiveList(max)
	path := h.runtimePath()
	rt := *h.Runtime
	h.runtimeMu.Unlock()

	if err := config.SaveRuntime(path, &rt); err != nil {
		log.Printf("runtime: save: %v", err)
	}
	for _, n := range newly {
		if h.State != nil && h.State.ResetRange(n) {
			h.broadcastLiveRange(n)
		}
	}
	if h.PluginState != nil {
		h.PluginState.SetInactiveRanges(list)
	}
}

func (h *Handlers) wettkampfVisible() bool {
	h.runtimeMu.RLock()
	defer h.runtimeMu.RUnlock()
	if h.Runtime == nil {
		return true
	}
	return h.Runtime.WettkampfIsVisible()
}

func (h *Handlers) setWettkampfVisible(on bool) {
	h.runtimeMu.Lock()
	if h.Runtime == nil {
		h.Runtime = &config.Runtime{}
	}
	v := on
	h.Runtime.WettkampfVisible = &v
	path := h.runtimePath()
	rt := *h.Runtime
	h.runtimeMu.Unlock()
	if err := config.SaveRuntime(path, &rt); err != nil {
		log.Printf("runtime: wettkampfVisible save: %v", err)
	}
}
