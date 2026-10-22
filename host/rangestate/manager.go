package rangestate

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"srdashboard/host/loader"
	"srdashboard/host/logicapi"
	"srdashboard/state"
)

type Broadcaster interface {
	BroadcastRange(rangeNum int, payload any)
	BroadcastAll(payload any)
}

// LiveSource provides live range snapshots for display-plugin view models.
type LiveSource interface {
	Snapshot() []state.RangeSnapshot
}

type Manager struct {
	mu             sync.RWMutex
	sessions       map[int]*RangePluginSession
	sharedState    logicapi.SessionState // used when mode=shared
	sharedMode     bool
	plugins        *loader.Manager
	numRanges      int
	inactiveRanges []int
	activeID       string
	broadcast      Broadcaster
	live           LiveSource
	tickStop       chan struct{}
	tickRunning    bool
	replaying      bool
}

func NewManager(numRanges int, pm *loader.Manager, activePluginID string) *Manager {
	s := make(map[int]*RangePluginSession)
	for i := 1; i <= numRanges; i++ {
		s[i] = &RangePluginSession{RangeNum: i, Phase: PhaseIdle}
	}
	return &Manager{
		sessions:  s,
		plugins:   pm,
		numRanges: numRanges,
		activeID:  activePluginID,
	}
}

func (m *Manager) SetBroadcaster(b Broadcaster)  { m.broadcast = b }
func (m *Manager) SetLiveSource(live LiveSource) { m.live = live }

// BeginReplay pauses the shared ticker and suppresses per-shot WebSocket
// notifies so a pasted log can drive game logic without flooding clients.
func (m *Manager) BeginReplay() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.replaying = true
	m.stopTickerLocked()
}

// InReplay is true between BeginReplay and EndReplay.
func (m *Manager) InReplay() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.replaying
}

// EndReplay rebuilds view models, resumes the ticker, and notifies clients once.
func (m *Manager) EndReplay() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.replaying = false
	if m.activeID == "" {
		return
	}
	ap, err := m.plugins.Get(m.activeID)
	if err == nil {
		if ap.Manifest.HasLogic() {
			m.refreshAllViewModelsLocked(ap)
		} else {
			now := time.Now()
			for i := 1; i <= m.numRanges; i++ {
				s := m.sessions[i]
				if s == nil || s.PluginID != m.activeID {
					continue
				}
				s.ViewModel = m.displayViewModelLocked(i, ap)
				s.UpdatedAt = now
			}
		}
		if m.sharedMode && ap.Manifest.HasLogic() {
			m.startTickerLocked()
		}
	}
	m.notifyLocked()
}

// SetNumRanges updates how many lanes the manager tracks and re-inits the
// active plugin so shared games (e.g. autorennen) drop/add cars to match.
func (m *Manager) SetNumRanges(n int) error {
	if n < 1 {
		return fmt.Errorf("numRanges must be >= 1")
	}
	m.mu.Lock()
	if m.numRanges == n {
		m.mu.Unlock()
		return nil
	}
	m.numRanges = n
	active := m.activeID
	m.mu.Unlock()
	if active == "" {
		return nil
	}
	return m.Activate(active)
}

func (m *Manager) NumRanges() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.numRanges
}

// SetInactiveRanges records side-menu membership and re-syncs the active game
// so only those lanes take part.
func (m *Manager) SetInactiveRanges(nums []int) {
	m.mu.Lock()
	m.inactiveRanges = append([]int(nil), nums...)
	active := m.activeID
	m.mu.Unlock()
	if active != "" {
		m.syncLiveReady(false)
	}
}

func (m *Manager) InactiveRanges() []int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return append([]int(nil), m.inactiveRanges...)
}

func (m *Manager) isInactiveLocked(n int) bool {
	for _, x := range m.inactiveRanges {
		if x == n {
			return true
		}
	}
	return false
}

func (m *Manager) ActivePluginID() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.activeID
}

func (m *Manager) stopTickerLocked() {
	if m.tickRunning && m.tickStop != nil {
		close(m.tickStop)
		m.tickRunning = false
		m.tickStop = nil
	}
}

func (m *Manager) startTickerLocked() {
	if m.replaying {
		return
	}
	m.stopTickerLocked()
	stop := make(chan struct{})
	m.tickStop = stop
	m.tickRunning = true
	go m.tickLoop(stop)
}

func (m *Manager) tickLoop(stop <-chan struct{}) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case now := <-t.C:
			m.Tick(now)
		}
	}
}

// Activate binds the given plugin as the site-active plugin on all ranges.
func (m *Manager) Activate(pluginID string) error {
	ap, err := m.plugins.Get(pluginID)
	if err != nil {
		return fmt.Errorf("plugin %q not loaded: %w", pluginID, err)
	}

	cfg := m.plugins.MergedConfig(pluginID)
	if cfg == nil {
		cfg = map[string]any{}
	}
	now := time.Now()
	shared := ap.Manifest.Mode == loader.ModeShared

	m.mu.Lock()
	defer m.mu.Unlock()
	numRanges := m.numRanges
	cfg["numRanges"] = numRanges
	cfg["inactiveRanges"] = append([]int(nil), m.inactiveRanges...)

	// Build every session before touching manager state, so a plugin that
	// fails to initialise partway through leaves the previous plugin running
	// instead of a half-switched mix of old and new sessions.
	var sharedSess logicapi.SessionState
	if ap.Manifest.HasLogic() {
		sharedSess, err = ap.Logic.Init(cfg)
		if err != nil {
			return err
		}
	}

	staged := make(map[int]*RangePluginSession, numRanges)
	for i := 1; i <= numRanges; i++ {
		var sess logicapi.SessionState
		var vm map[string]any
		if ap.Manifest.HasLogic() {
			if shared {
				sess = sharedSess
			} else {
				sess, err = ap.Logic.Init(cfg)
				if err != nil {
					return fmt.Errorf("init range %d: %w", i, err)
				}
			}
			vm, err = ap.Logic.ViewModel(sess, i)
			if err != nil {
				return fmt.Errorf("view model range %d: %w", i, err)
			}
		} else {
			vm = m.displayViewModelLocked(i, ap)
		}
		staged[i] = &RangePluginSession{
			RangeNum:  i,
			PluginID:  pluginID,
			Phase:     PhaseActive,
			Config:    cfg,
			State:     sess,
			ViewModel: vm,
			ShotCount: 0,
			StartedAt: now,
			UpdatedAt: now,
		}
	}

	m.stopTickerLocked()
	m.sharedMode = shared
	m.sharedState = sharedSess
	m.sessions = staged
	m.activeID = pluginID
	if shared && ap.Manifest.HasLogic() {
		m.startTickerLocked()
	}
	m.notifyLocked()
	return nil
}

// EnsureActive starts the configured active plugin if sessions are idle.
func (m *Manager) EnsureActive() error {
	m.mu.RLock()
	id := m.activeID
	m.mu.RUnlock()
	if id == "" {
		id = "classic-range"
	}
	return m.Activate(id)
}

func (m *Manager) liveInfo(rangeNum int) logicapi.LiveRangeInfo {
	info := logicapi.LiveRangeInfo{}
	if m.live == nil {
		return info
	}
	for _, rs := range m.live.Snapshot() {
		if rs.RangeNum == rangeNum {
			info.IsWarmup = rs.IsWarmup
			info.TotalShotsToFire = rs.TotalShotsToFire
			info.Discipline = rs.Discipline
			info.ShooterName = rs.ShooterName
			return info
		}
	}
	return info
}

func (m *Manager) displayViewModelLocked(rangeNum int, ap *loader.ActivePlugin) map[string]any {
	vm := map[string]any{
		"rangeNum": rangeNum,
		"pluginId": ap.Manifest.ID,
		"kind":     ap.Manifest.Kind,
		"mode":     ap.Manifest.Mode,
		"label":    ap.Manifest.Label,
	}
	if m.live != nil {
		for _, rs := range m.live.Snapshot() {
			if rs.RangeNum == rangeNum {
				vm["range"] = rs
				break
			}
		}
	}
	return vm
}

func (m *Manager) OnShot(rangeNum int, shot state.Shot, shotIndex int) {
	m.mu.Lock()
	s, ok := m.sessions[rangeNum]
	if !ok || s.PluginID == "" || s.Phase == PhaseIdle {
		m.mu.Unlock()
		return
	}
	pluginID := s.PluginID
	shared := m.sharedMode
	m.mu.Unlock()

	// Enforce the target contract before any plugin callback or ShotCount update.
	// Darts accepts exactly DiscTypeRaw == "fun_dart"; it must not count LG/LP/KK
	// or any other target. Every other plugin rejects all fun_* targets.
	if strings.EqualFold(strings.TrimSpace(pluginID), "darts") {
		if strings.TrimSpace(shot.DiscTypeRaw) != "fun_dart" {
			return
		}
	} else if isFunTargetShot(shot) {
		return
	}

	ap, err := m.plugins.Get(pluginID)
	if err != nil {
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok = m.sessions[rangeNum]
	if !ok || s.PluginID != pluginID {
		return
	}
	if m.isInactiveLocked(rangeNum) {
		return
	}

	if ap.Manifest.HasLogic() {
		now := time.Now()
		if m.replaying {
			if !shot.At.IsZero() {
				now = shot.At
			} else if !shot.ReceivedAt.IsZero() {
				now = shot.ReceivedAt
			}
		}
		live := m.liveInfo(rangeNum)
		if m.replaying && live.TotalShotsToFire <= 0 {
			// Console logs have no OpticScore program length.
			live.TotalShotsToFire = 60
		}
		ctx := logicapi.ShotContext{
			RangeNum:       rangeNum,
			Shot:           shot,
			ShotIndex:      shotIndex,
			Live:           live,
			NumRanges:      m.numRanges,
			InactiveRanges: append([]int(nil), m.inactiveRanges...),
			Now:            now,
			Replay:         m.replaying,
		}
		var newState logicapi.SessionState
		var events []logicapi.PluginEvent
		if ext, ok := ap.Logic.(logicapi.ExtendedLogic); ok {
			newState, events, err = ext.OnShotCtx(m.sessionStateLocked(s), ctx)
		} else {
			newState, events, err = ap.Logic.OnShot(m.sessionStateLocked(s), rangeNum, shot, shotIndex)
		}
		if err != nil {
			return
		}
		if shared {
			m.applyStateLocked(newState, true)
		} else {
			s.State = newState
		}
		s.ShotCount++
		s.UpdatedAt = time.Now()
		if m.replaying {
			return
		}
		if shared {
			// Shared games broadcast range 1's session to every client
			// (hall + all tablets). Events must live on that session, not
			// only on the lane that shot, or stands 2+ stay silent.
			m.appendEventsAllLocked(events)
			m.refreshAllViewModelsLocked(ap)
			m.notifyAllSessionsLocked()
		} else {
			s.appendEvents(events)
			vm, _ := ap.Logic.ViewModel(s.State, rangeNum)
			s.ViewModel = vm
			m.notifyRangeLocked(rangeNum)
		}
		return
	}
	s.ShotCount++
	s.UpdatedAt = time.Now()
	if m.replaying {
		return
	}
	s.ViewModel = m.displayViewModelLocked(rangeNum, ap)
}

// normalizedDiscType normalizes the raw OpticScore disc type without guessing
// from score values or geometry. DiscTypeRaw is the authoritative ID.
func normalizedDiscType(shot state.Shot) string {
	discType := strings.ToLower(strings.TrimSpace(shot.DiscTypeRaw))
	return strings.NewReplacer("-", "_", " ", "_").Replace(discType)
}

func isFunTargetShot(shot state.Shot) bool {
	return strings.HasPrefix(normalizedDiscType(shot), "fun_")
}

func (m *Manager) sessionStateLocked(s *RangePluginSession) logicapi.SessionState {
	if m.sharedMode {
		return m.sharedState
	}
	return s.State
}

func (m *Manager) applyStateLocked(newState logicapi.SessionState, shared bool) {
	if shared {
		m.sharedState = newState
		for i := 1; i <= m.numRanges; i++ {
			if sess := m.sessions[i]; sess != nil {
				sess.State = newState
			}
		}
		return
	}
}

func (m *Manager) appendEventsAllLocked(events []logicapi.PluginEvent) {
	if len(events) == 0 {
		return
	}
	now := time.Now()
	for i := 1; i <= m.numRanges; i++ {
		if s := m.sessions[i]; s != nil {
			s.appendEvents(events)
			s.UpdatedAt = now
		}
	}
}

func (m *Manager) refreshAllViewModelsLocked(ap *loader.ActivePlugin) {
	now := time.Now()
	for i := 1; i <= m.numRanges; i++ {
		s := m.sessions[i]
		if s == nil || s.PluginID != m.activeID {
			continue
		}
		vm, err := ap.Logic.ViewModel(m.sessionStateLocked(s), i)
		if err != nil {
			continue
		}
		s.ViewModel = vm
		s.UpdatedAt = now
	}
}

func (m *Manager) notifyAllSessionsLocked() {
	if m.sharedMode {
		// One broadcast for the whole field — clients already share state.
		// Prefer range 1's session payload (full race viewModel).
		m.notifyRangeLocked(1)
		if m.broadcast != nil {
			m.broadcast.BroadcastAll(map[string]any{"type": "plugin_race", "pluginId": m.activeID})
		}
		// Drain events on the other range sessions so they do not replay later.
		for i := 2; i <= m.numRanges; i++ {
			if s := m.sessions[i]; s != nil {
				s.clearEvents()
			}
		}
		return
	}
	for i := 1; i <= m.numRanges; i++ {
		m.notifyRangeLocked(i)
	}
}

// Tick advances shared game clocks (round deadlines, field events).
func (m *Manager) Tick(now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.replaying || !m.sharedMode || m.activeID == "" {
		return
	}
	ap, err := m.plugins.Get(m.activeID)
	if err != nil {
		return
	}
	ext, ok := ap.Logic.(logicapi.ExtendedLogic)
	if !ok {
		return
	}
	newState, events, changed, err := ext.Tick(m.sharedState, now)
	if err != nil || !changed {
		return
	}
	m.applyStateLocked(newState, true)
	m.appendEventsAllLocked(events)
	m.refreshAllViewModelsLocked(ap)
	m.notifyAllSessionsLocked()
}

// Control handles master actions: start, reset, field_event.
func (m *Manager) Control(action string, params map[string]any) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.activeID == "" {
		return fmt.Errorf("no active plugin")
	}
	ap, err := m.plugins.Get(m.activeID)
	if err != nil {
		return err
	}
	ext, ok := ap.Logic.(logicapi.ExtendedLogic)
	if !ok {
		return fmt.Errorf("plugin does not support control")
	}
	if params == nil {
		params = map[string]any{}
	}
	params["numRanges"] = m.numRanges
	params["inactiveRanges"] = append([]int(nil), m.inactiveRanges...)
	// Attach live totals for start gate
	if _, has := params["live"]; !has {
		params["live"] = m.liveMapLocked()
	} else if live, ok := params["live"].(map[string]any); ok {
		m.stampLiveActiveLocked(live)
	}
	if _, has := params["now"]; !has {
		params["now"] = time.Now().UTC().Format(time.RFC3339Nano)
	}

	sess := m.sessions[1]
	if sess == nil {
		return fmt.Errorf("no session for range 1")
	}
	newState, events, err := ext.Control(m.sessionStateLocked(sess), action, params)
	if err != nil {
		return err
	}
	if m.sharedMode {
		m.applyStateLocked(newState, true)
	} else if s := m.sessions[1]; s != nil {
		s.State = newState
	}
	m.appendEventsAllLocked(events)
	m.refreshAllViewModelsLocked(ap)
	m.notifyAllSessionsLocked()
	return nil
}

// RefreshDisplayViewModels rebuilds display view models from live state (e.g. after live poll).
func (m *Manager) RefreshDisplayViewModels() {
	m.mu.Lock()
	defer m.mu.Unlock()
	ap, err := m.plugins.Get(m.activeID)
	if err != nil || ap.Manifest.HasLogic() {
		return
	}
	for i := 1; i <= m.numRanges; i++ {
		s := m.sessions[i]
		if s == nil || s.PluginID != m.activeID {
			continue
		}
		s.ViewModel = m.displayViewModelLocked(i, ap)
		s.UpdatedAt = time.Now()
	}
}

func (m *Manager) SnapshotAll() ([]SessionSnapshot, ActiveSnapshot) {
	m.mu.RLock()
	n := m.numRanges
	m.mu.RUnlock()
	out := make([]SessionSnapshot, 0, n)
	for i := 1; i <= n; i++ {
		out = append(out, m.snapshotRangeInternal(i))
	}
	return out, m.activeSnapshot()
}

func (m *Manager) SnapshotRange(rangeNum int) SessionSnapshot {
	return m.snapshotRangeInternal(rangeNum)
}

func (m *Manager) snapshotRangeInternal(rangeNum int) SessionSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[rangeNum]
	if !ok {
		return SessionSnapshot{RangeNum: rangeNum, Phase: PhaseIdle}
	}
	if ap, err := m.plugins.Get(s.PluginID); err == nil && ap.Manifest.IsDisplay() {
		s.ViewModel = m.displayViewModelLocked(rangeNum, ap)
	}
	snap := s.snapshot()
	if snap.ViewModel != nil {
		cp := make(map[string]any, len(snap.ViewModel)+1)
		for k, v := range snap.ViewModel {
			cp[k] = v
		}
		cp["rangeNum"] = rangeNum
		snap.ViewModel = cp
	}
	s.clearEvents()
	return snap
}

// ActiveSnapshot describes the site-active plugin (replaces old match snapshot).
type ActiveSnapshot struct {
	Active   bool   `json:"active"`
	PluginID string `json:"pluginId,omitempty"`
	Kind     string `json:"kind,omitempty"`
	Label    string `json:"label,omitempty"`
	Mode     string `json:"mode,omitempty"`
}

func (m *Manager) activeSnapshot() ActiveSnapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.activeSnapshotUnlocked()
}

func (m *Manager) Notify() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.notifyLocked()
}

func (m *Manager) notifyLocked() {
	if m.replaying || m.broadcast == nil {
		return
	}
	active := m.activeSnapshotUnlocked()
	m.broadcast.BroadcastAll(map[string]any{"type": "active_plugin", "active": active})
	m.broadcast.BroadcastAll(map[string]any{
		"type":  "match",
		"match": map[string]any{"active": active.Active, "pluginId": active.PluginID},
	})
	for i := 1; i <= m.numRanges; i++ {
		m.notifyRangeLocked(i)
	}
}

func (m *Manager) activeSnapshotUnlocked() ActiveSnapshot {
	if m.activeID == "" {
		return ActiveSnapshot{Active: false}
	}
	snap := ActiveSnapshot{Active: true, PluginID: m.activeID}
	if ap, err := m.plugins.Get(m.activeID); err == nil {
		snap.Kind = ap.Manifest.Kind
		snap.Label = ap.Manifest.Label
		snap.Mode = ap.Manifest.Mode
	}
	return snap
}

func (m *Manager) notifyRangeLocked(rangeNum int) {
	s, ok := m.sessions[rangeNum]
	if !ok {
		return
	}
	if m.replaying {
		s.clearEvents()
		return
	}
	if m.broadcast == nil {
		return
	}
	snap := s.snapshot()
	if snap.ViewModel != nil {
		cp := make(map[string]any, len(snap.ViewModel)+1)
		for k, v := range snap.ViewModel {
			cp[k] = v
		}
		cp["rangeNum"] = rangeNum
		snap.ViewModel = cp
	}
	msg := map[string]any{"type": "plugin_session", "session": snap}
	if m.sharedMode {
		// Shared games: every client needs every range, and BroadcastAll
		// already covers the range-filtered subscribers.
		m.broadcast.BroadcastAll(msg)
	} else {
		m.broadcast.BroadcastRange(rangeNum, msg)
	}
	// Events are one-shot notifications. Dropping them here keeps the buffer
	// from growing for the whole session and stops WebSocket clients from
	// replaying the same event in every later update.
	s.clearEvents()
}

// SyncLiveReady marks ranges ready when leaving warmup (called optionally from live path).
func (m *Manager) SyncLiveReady() {
	m.syncLiveReady(false)
}

// SyncLiveReadyIfArming only runs the sync when the shared game is still
// collecting ready signals, so competition shots do not rebuild every view model.
func (m *Manager) SyncLiveReadyIfArming() {
	m.syncLiveReady(true)
}

func (m *Manager) syncLiveReady(onlyIfArming bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.sharedMode || m.activeID == "" || m.live == nil {
		return
	}
	if onlyIfArming {
		// Peek shared phase without a full unmarshal when possible.
		phase := sharedPhase(m.sharedState)
		if phase != "" && phase != "warmup_collect" && phase != "arming" {
			return
		}
	}
	ap, err := m.plugins.Get(m.activeID)
	if err != nil {
		return
	}
	ext, ok := ap.Logic.(logicapi.ExtendedLogic)
	if !ok {
		return
	}
	lives := m.liveMapLocked()
	newState, events, err := ext.Control(m.sharedState, "sync_live", map[string]any{
		"live":           lives,
		"numRanges":      m.numRanges,
		"inactiveRanges": append([]int(nil), m.inactiveRanges...),
		"now":            time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		return
	}
	m.applyStateLocked(newState, true)
	if m.replaying {
		return
	}
	m.appendEventsAllLocked(events)
	m.refreshAllViewModelsLocked(ap)
	m.notifyAllSessionsLocked()
}

func (m *Manager) liveMapLocked() map[string]any {
	inactive := map[int]bool{}
	for _, n := range m.inactiveRanges {
		inactive[n] = true
	}
	lives := map[string]any{}
	for i := 1; i <= m.numRanges; i++ {
		lives[fmt.Sprintf("%d", i)] = map[string]any{"active": !inactive[i]}
	}
	if m.live == nil {
		return lives
	}
	for _, rs := range m.live.Snapshot() {
		k := fmt.Sprintf("%d", rs.RangeNum)
		entry, _ := lives[k].(map[string]any)
		if entry == nil {
			entry = map[string]any{}
			lives[k] = entry
		}
		entry["totalShotsToFire"] = rs.TotalShotsToFire
		entry["discipline"] = rs.Discipline
		entry["discType"] = rs.DiscType
		entry["isWarmup"] = rs.IsWarmup
		entry["shooterName"] = rs.ShooterName
		entry["active"] = !inactive[rs.RangeNum]
	}
	return lives
}

func (m *Manager) stampLiveActiveLocked(live map[string]any) {
	if live == nil {
		return
	}
	inactive := map[int]bool{}
	for _, n := range m.inactiveRanges {
		inactive[n] = true
	}
	for i := 1; i <= m.numRanges; i++ {
		k := fmt.Sprintf("%d", i)
		entry, _ := live[k].(map[string]any)
		if entry == nil {
			live[k] = map[string]any{"active": !inactive[i]}
			continue
		}
		if _, has := entry["active"]; !has {
			entry["active"] = !inactive[i]
		}
	}
}

func sharedPhase(sess logicapi.SessionState) string {
	if len(sess) == 0 {
		return ""
	}
	var peek struct {
		Phase string `json:"phase"`
	}
	if err := json.Unmarshal(sess, &peek); err != nil {
		return ""
	}
	return peek.Phase
}
