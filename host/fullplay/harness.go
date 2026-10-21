package fullplay

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"

	_ "srdashboard/host/games/ansageduell"
	_ "srdashboard/host/games/autorennen"
	_ "srdashboard/host/games/bankoderrisiko"
	_ "srdashboard/host/games/barrikade"
	_ "srdashboard/host/games/biathlon"
	_ "srdashboard/host/games/darts"
	_ "srdashboard/host/games/foxontherun"
	_ "srdashboard/host/games/kettenreaktion"
	_ "srdashboard/host/games/kopokal"
	_ "srdashboard/host/games/kronenduell"
	_ "srdashboard/host/games/ludo"
	_ "srdashboard/host/games/schiessgolf"
	_ "srdashboard/host/games/schrumpfenderkreis"
	_ "srdashboard/host/games/tannebaum"
	_ "srdashboard/host/games/tauziehen"
	_ "srdashboard/host/games/turmbau"
	_ "srdashboard/host/games/zehnerbingo"
	"srdashboard/host/loader"
	"srdashboard/host/rangestate"
	"srdashboard/state"
	"srdashboard/udp"
)

// Host is one isolated dashboard: live ranges + plugin manager + active game.
type Host struct {
	T          *testing.T
	NumRanges  int
	PluginID   string
	Live       *state.LiveState
	Plugins    *loader.Manager
	PS         *rangestate.Manager
	shotIndex  map[int]int
	totalShots int
}

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
	if _, err := os.Stat(filepath.Join(root, "plugins")); err != nil {
		t.Fatalf("plugins dir missing under %s: %v", root, err)
	}
	return root
}

func pluginsRoot(t *testing.T) string {
	t.Helper()
	return filepath.Join(repoRoot(t), "plugins")
}

func readRepoFile(t *testing.T, parts ...string) string {
	t.Helper()
	path := filepath.Join(append([]string{repoRoot(t)}, parts...)...)
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

func bundledPluginIDs(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(pluginsRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, err := os.Stat(filepath.Join(pluginsRoot(t), e.Name(), "manifest.xml")); err != nil {
			continue
		}
		ids = append(ids, e.Name())
	}
	return ids
}

func openHost(t *testing.T, pluginID string, numRanges, totalShots int) *Host {
	t.Helper()
	if numRanges < 1 {
		numRanges = 1
	}
	if totalShots < 1 {
		totalShots = 40
	}
	pm := loader.NewManager(pluginsRoot(t))
	if err := pm.Reload(); err != nil {
		t.Fatalf("load plugins: %v", err)
	}
	live := state.NewLiveState(numRanges)
	for i := 1; i <= numRanges; i++ {
		ok := live.ReplaceRange(state.RangeSnapshot{
			RangeNum:         i,
			ShooterName:      fmt.Sprintf("Test B%d", i),
			Discipline:       "Luftgewehr",
			DiscType:         "LG",
			IsWarmup:         false,
			TotalShotsToFire: totalShots,
		})
		if !ok {
			t.Fatalf("seed range %d", i)
		}
	}
	ps := rangestate.NewManager(numRanges, pm, pluginID)
	ps.SetLiveSource(live)
	if err := ps.Activate(pluginID); err != nil {
		t.Fatalf("activate %s: %v", pluginID, err)
	}
	return &Host{
		T:          t,
		NumRanges:  numRanges,
		PluginID:   pluginID,
		Live:       live,
		Plugins:    pm,
		PS:         ps,
		shotIndex:  map[int]int{},
		totalShots: totalShots,
	}
}

func (h *Host) Start() {
	h.T.Helper()
	if err := h.PS.Control("start", nil); err != nil {
		h.T.Fatalf("start %s: %v", h.PluginID, err)
	}
}

func (h *Host) Control(action string, params map[string]any) {
	h.T.Helper()
	if err := h.PS.Control(action, params); err != nil {
		h.T.Fatalf("%s control %s: %v", h.PluginID, action, err)
	}
}

func (h *Host) Fire(rangeNum int, dec float64) {
	h.T.Helper()
	h.firePacket(rangeNum, dec, udp.ShotPacketOpts{})
}

func (h *Host) firePacket(rangeNum int, dec float64, opts udp.ShotPacketOpts) {
	h.T.Helper()
	before := h.Live.ShotNumber(rangeNum)
	x, y, dist := udp.PlaceShot(dec, rangeNum*100+before+1)
	opts.Range = rangeNum
	opts.X = x
	opts.Y = y
	opts.Distance = dist
	opts.DecValue = dec
	if opts.DiscType == "" {
		opts.DiscType = "LG"
	}
	if opts.ShotAt.IsZero() {
		opts.ShotAt = time.Now()
	}
	data, err := udp.BuildShotPacket(opts)
	if err != nil {
		h.T.Fatalf("build shot: %v", err)
	}
	udp.IngestPacket(h.Live, func(rng int, shot state.Shot, idx int) {
		h.shotIndex[rng] = idx
		h.PS.OnShot(rng, shot, idx)
	}, data)
	if h.Live.ShotNumber(rangeNum) == before {
		h.T.Fatalf("udp pipeline dropped shot range=%d dec=%.1f", rangeNum, dec)
	}
}

func (h *Host) firePacketExplicit(rangeNum int, opts udp.ShotPacketOpts) {
	h.T.Helper()

	before := h.Live.ShotNumber(rangeNum)

	opts.Range = rangeNum

	if opts.DiscType == "" {
		opts.DiscType = "LG"
	}

	if opts.ShotAt.IsZero() {
		opts.ShotAt = time.Now()
	}

	data, err := udp.BuildShotPacket(opts)
	if err != nil {
		h.T.Fatalf("build explicit shot: %v", err)
	}

	udp.IngestPacket(h.Live, func(rng int, shot state.Shot, idx int) {
		h.shotIndex[rng] = idx
		h.PS.OnShot(rng, shot, idx)
	}, data)

	if h.Live.ShotNumber(rangeNum) == before {
		h.T.Fatalf("udp pipeline dropped explicit shot range=%d value=%d", rangeNum, opts.FullValue)
	}
}
func (h *Host) VM(rangeNum int) map[string]any {
	h.T.Helper()
	snap := h.PS.SnapshotRange(rangeNum)
	if snap.ViewModel == nil {
		h.T.Fatalf("%s range %d: nil view model", h.PluginID, rangeNum)
	}
	if id, _ := snap.ViewModel["pluginId"].(string); id != "" && id != h.PluginID {
		h.T.Fatalf("view model pluginId=%q want %q", id, h.PluginID)
	}
	return snap.ViewModel
}

func nest(m map[string]any, keys ...string) map[string]any {
	cur := m
	for _, k := range keys {
		if cur == nil {
			return nil
		}
		next, _ := cur[k].(map[string]any)
		cur = next
	}
	return cur
}

func asString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case fmt.Stringer:
		return t.String()
	default:
		if v == nil {
			return ""
		}
		return fmt.Sprint(v)
	}
}

func asInt(v any) int {
	switch t := v.(type) {
	case int:
		return t
	case int32:
		return int(t)
	case int64:
		return int(t)
	case float64:
		return int(t)
	case float32:
		return int(t)
	case string:
		n, _ := strconv.Atoi(t)
		return n
	default:
		return 0
	}
}

func asSlice(v any) []any {
	switch t := v.(type) {
	case []any:
		return t
	case []map[string]any:
		out := make([]any, len(t))
		for i := range t {
			out[i] = t[i]
		}
		return out
	default:
		return nil
	}
}

func (h *Host) phase(path []string) string {
	vm := h.VM(1)
	if len(path) == 0 {
		return asString(vm["phase"])
	}
	obj := nest(vm, path[:len(path)-1]...)
	if obj == nil {
		return ""
	}
	return asString(obj[path[len(path)-1]])
}

func (h *Host) requirePhase(path []string, want string) {
	h.T.Helper()
	got := h.phase(path)
	if got != want {
		h.T.Fatalf("%s phase=%q want %q", h.PluginID, got, want)
	}
}

func (h *Host) requireBothRangesPaint() {
	h.T.Helper()
	_ = h.VM(1)
	if h.NumRanges >= 2 {
		_ = h.VM(2)
	}
}
