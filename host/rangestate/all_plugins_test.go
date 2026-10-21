package rangestate

import (
	"os"
	"path/filepath"
	"testing"

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
	"srdashboard/state"
)

func bundledPluginsRoot(t *testing.T) string {
	t.Helper()
	root := filepath.Join("..", "..", "plugins")
	if _, err := os.Stat(root); err != nil {
		t.Fatalf("plugins dir: %v", err)
	}
	return root
}

func TestAllBundledPluginsLoadAndActivate(t *testing.T) {
	pm := loader.NewManager(bundledPluginsRoot(t))
	if err := pm.Reload(); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"analyse", "ansage-duell", "autorennen", "bank-oder-risiko", "barrikade", "biathlon",
		"classic-range", "classic-range-condensed", "darts", "fox-on-the-run", "kettenreaktion", "ko-pokal",
		"kronen-duell", "ludo", "schiessgolf", "schrumpfender-kreis",
		"tannebaum-einzel", "tannebaum-team", "tauziehen", "turmbau", "zehner-bingo",
	}
	wantSet := map[string]bool{}
	for _, id := range want {
		wantSet[id] = true
		ap, err := pm.Get(id)
		if err != nil {
			t.Errorf("Get(%s): %v", id, err)
			continue
		}
		if ap.Manifest.ID != id {
			t.Errorf("%s: loaded id %q != folder %q", id, ap.Manifest.ID, id)
		}
		if ap.Logic == nil {
			t.Errorf("%s: no logic (builtin factory miss after rename)", id)
		}
	}
	listed, err := pm.ListInstalled()
	if err != nil {
		t.Fatal(err)
	}
	for _, info := range listed {
		if !wantSet[info.ID] {
			t.Errorf("unexpected bundled plugin %q", info.ID)
		}
	}

	live := state.NewLiveState(2)
	ps := NewManager(2, pm, "classic-range")
	ps.SetLiveSource(live)
	for _, id := range want {
		if err := ps.Activate(id); err != nil {
			t.Errorf("Activate(%s): %v — GUI would keep the previous plugin / blank host", id, err)
			continue
		}
		if ps.ActivePluginID() != id {
			t.Errorf("active after %s = %q", id, ps.ActivePluginID())
		}
		snap := ps.SnapshotRange(1)
		if snap.PluginID != id {
			t.Errorf("%s session pluginId = %q", id, snap.PluginID)
		}
		if snap.ViewModel == nil {
			t.Errorf("%s: nil view model — hall/shooter paint has nothing to render", id)
		}
	}
}

func TestActivateLudoAndBarrikadeProduceSharedViewModels(t *testing.T) {
	for _, id := range []string{"ludo", "barrikade"} {
		t.Run(id, func(t *testing.T) {
			dir := t.TempDir()
			pluginsRoot := filepath.Join(dir, "plugins")
			src := filepath.Join("..", "..", "plugins", id)
			if err := copyDir(src, filepath.Join(pluginsRoot, id)); err != nil {
				t.Fatal(err)
			}
			pm := loader.NewManager(pluginsRoot)
			if err := pm.Reload(); err != nil {
				t.Fatal(err)
			}
			ps := NewManager(2, pm, id)
			ps.SetLiveSource(state.NewLiveState(2))
			if err := ps.Activate(id); err != nil {
				t.Fatal(err)
			}
			if !ps.sharedMode {
				t.Fatalf("%s expected shared mode", id)
			}
			if err := ps.Control("start", map[string]any{
				"live": map[string]any{
					"1": map[string]any{"totalShotsToFire": 40, "isWarmup": false},
					"2": map[string]any{"totalShotsToFire": 40, "isWarmup": false},
				},
			}); err != nil {
				t.Fatal(err)
			}
			if snap := ps.SnapshotRange(1); snap.ViewModel == nil {
				t.Fatal("nil view model after start")
			}
			if snap := ps.SnapshotRange(2); snap.ViewModel == nil {
				t.Fatal("range 2 missing shared view model")
			}
		})
	}
}
