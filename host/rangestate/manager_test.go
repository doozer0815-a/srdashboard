package rangestate

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "srdashboard/host/games/darts"
	_ "srdashboard/host/games/ludo"
	"srdashboard/host/loader"
	"srdashboard/state"
)

func TestActivateDisplayPlugin(t *testing.T) {
	dir := t.TempDir()
	pluginsRoot := filepath.Join(dir, "plugins")
	src := filepath.Join("..", "..", "plugins", "classic-range")
	if _, err := os.Stat(src); err != nil {
		t.Skip("classic-range not present")
	}
	if err := copyDir(src, filepath.Join(pluginsRoot, "classic-range")); err != nil {
		t.Fatal(err)
	}

	pm := loader.NewManager(pluginsRoot)
	if err := pm.Reload(); err != nil {
		t.Fatal(err)
	}

	live := state.NewLiveState(2)
	ps := NewManager(2, pm, "classic-range")
	ps.SetLiveSource(live)

	if err := ps.EnsureActive(); err != nil {
		t.Fatal(err)
	}
	if ps.ActivePluginID() != "classic-range" {
		t.Fatalf("active = %q", ps.ActivePluginID())
	}

	snap := ps.SnapshotRange(1)
	if snap.PluginID != "classic-range" || snap.Phase != PhaseActive {
		t.Fatalf("session = %+v", snap)
	}
	if snap.ViewModel == nil || snap.ViewModel["kind"] != "display" {
		t.Fatalf("viewModel = %#v", snap.ViewModel)
	}

	shot := state.Shot{X: 1, Y: 2, DecValue: 10.5, ReceivedAt: time.Now()}
	ps.OnShot(1, shot, 0)
	snap = ps.SnapshotRange(1)
	if snap.ShotCount != 1 {
		t.Fatalf("shotCount = %d", snap.ShotCount)
	}
}

func TestSetInactiveRangesPassedToSharedGame(t *testing.T) {
	dir := t.TempDir()
	pluginsRoot := filepath.Join(dir, "plugins")
	src := filepath.Join("..", "..", "plugins", "ludo")
	if _, err := os.Stat(src); err != nil {
		t.Skip("ludo not present")
	}
	if err := copyDir(src, filepath.Join(pluginsRoot, "ludo")); err != nil {
		t.Fatal(err)
	}
	pm := loader.NewManager(pluginsRoot)
	if err := pm.Reload(); err != nil {
		t.Fatal(err)
	}
	ps := NewManager(3, pm, "ludo")
	ps.SetLiveSource(state.NewLiveState(3))
	ps.SetInactiveRanges([]int{3})
	if err := ps.Activate("ludo"); err != nil {
		t.Fatal(err)
	}
	snap := ps.SnapshotRange(1)
	game, _ := snap.ViewModel["game"].(map[string]any)
	if game == nil {
		t.Fatalf("game missing: %#v", snap.ViewModel)
	}
	players, _ := game["players"].([]map[string]any)
	foundInactive := false
	activeCount := 0
	for _, p := range players {
		if p["rangeNum"] == 3 || p["rangeNum"] == float64(3) {
			if p["active"] != false {
				t.Fatalf("range 3 should be inactive: %#v", p)
			}
			foundInactive = true
		}
		if p["active"] != false {
			activeCount++
		}
	}
	if !foundInactive {
		t.Fatalf("range 3 missing from players: %#v", players)
	}
	if activeCount != 2 {
		t.Fatalf("activeCount=%d want 2", activeCount)
	}
}

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		return os.WriteFile(target, data, 0644)
	})
}

func TestFunDartShotIgnoredByNonDartsPlugin(t *testing.T) {
	dir := t.TempDir()
	pluginsRoot := filepath.Join(dir, "plugins")
	src := filepath.Join("..", "..", "plugins", "classic-range")
	if _, err := os.Stat(src); err != nil {
		t.Skip("classic-range not present")
	}
	if err := copyDir(src, filepath.Join(pluginsRoot, "classic-range")); err != nil {
		t.Fatal(err)
	}

	pm := loader.NewManager(pluginsRoot)
	if err := pm.Reload(); err != nil {
		t.Fatal(err)
	}
	ps := NewManager(1, pm, "classic-range")
	if err := ps.EnsureActive(); err != nil {
		t.Fatal(err)
	}

	for _, discType := range []string{"fun_dart", "FUN_DART", "fun-dart", "Fun Dart", "fun_biathlon", "FUN_OTHER", "fun-target"} {
		ps.OnShot(1, state.Shot{DiscTypeRaw: discType, DecValue: 50, FullValue: 50}, 1)
		if got := ps.SnapshotRange(1).ShotCount; got != 0 {
			t.Fatalf("DiscTypeRaw %q counted as a shot: ShotCount=%d", discType, got)
		}
	}

	ps.OnShot(1, state.Shot{DiscTypeRaw: "LG", DecValue: 10.5, FullValue: 10}, 1)
	if got := ps.SnapshotRange(1).ShotCount; got != 1 {
		t.Fatalf("normal LG shot should count; ShotCount=%d", got)
	}
}

func TestDartsManagerIgnoresEveryShotExceptExactFunDart(t *testing.T) {
	dir := t.TempDir()
	pluginsRoot := filepath.Join(dir, "plugins")
	src := filepath.Join("..", "..", "plugins", "darts")
	if _, err := os.Stat(src); err != nil {
		t.Skip("darts plugin assets not present")
	}
	if err := copyDir(src, filepath.Join(pluginsRoot, "darts")); err != nil {
		t.Fatal(err)
	}
	pm := loader.NewManager(pluginsRoot)
	if err := pm.Reload(); err != nil {
		t.Fatal(err)
	}
	ps := NewManager(1, pm, "darts")
	if err := ps.EnsureActive(); err != nil {
		t.Fatal(err)
	}

	for _, discType := range []string{"LG", "LP", "KK", "fun_biathlon", "FUN-DART", "FUN_DART"} {
		ps.OnShot(1, state.Shot{DiscTypeRaw: discType, DecValue: 10.5, FullValue: 10}, 1)
		if got := ps.SnapshotRange(1).ShotCount; got != 0 {
			t.Fatalf("DiscTypeRaw %q must be ignored by Darts, ShotCount=%d", discType, got)
		}
	}
	ps.OnShot(1, state.Shot{DiscTypeRaw: "fun_dart", DecValue: 50, FullValue: 50}, 1)
	if got := ps.SnapshotRange(1).ShotCount; got != 1 {
		t.Fatalf("exact fun_dart should be accepted by Darts, ShotCount=%d", got)
	}
}
