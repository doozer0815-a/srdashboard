package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"srdashboard/config"
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
)

func TestRulebooksAreServedAsPluginAssets(t *testing.T) {
	root := filepath.Join("..", "plugins")
	h := &Handlers{Plugins: loader.NewManager(root)}
	ids := []string{
		"autorennen", "ludo", "barrikade", "fox-on-the-run",
		"tannebaum-einzel", "tannebaum-team", "zehner-bingo",
		"tauziehen", "kettenreaktion", "biathlon", "schrumpfender-kreis",
		"kronen-duell", "bank-oder-risiko", "ko-pokal", "schiessgolf",
		"turmbau", "ansage-duell", "darts",
	}
	for _, id := range ids {
		path := "/plugins/" + id + "/rulebook.json"
		rec := httptest.NewRecorder()
		h.ServePlugin(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status %d — Regeln overlay would fail to load", path, rec.Code)
			continue
		}
		if rec.Body.Len() == 0 {
			t.Errorf("%s: empty body", path)
		}
		if !strings.Contains(rec.Body.String(), `"title"`) {
			t.Errorf("%s: missing title field", path)
		}
	}
}

func TestActiveGamePluginIncludesRulebookURL(t *testing.T) {
	root := filepath.Join("..", "plugins")
	pm := loader.NewManager(root)
	if err := pm.Reload(); err != nil {
		t.Fatal(err)
	}
	id := "autorennen"
	ps := rangestate.NewManager(2, pm, id)
	ps.SetLiveSource(state.NewLiveState(2))
	if err := ps.Activate(id); err != nil {
		t.Fatal(err)
	}
	h := &Handlers{
		Cfg:         &config.Config{Plugins: config.Plugins{Dir: root, Active: id}},
		Plugins:     pm,
		PluginState: ps,
	}
	rec := httptest.NewRecorder()
	h.PluginsActiveList(rec, httptest.NewRequest(http.MethodGet, "/api/plugins/active", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var list []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("active list len %d", len(list))
	}
	got, _ := list[0]["rulebookUrl"].(string)
	want := "/plugins/" + id + "/rulebook.json"
	if got != want {
		t.Fatalf("rulebookUrl=%q want %q — hall Regeln overlay would 404 or stay hidden", got, want)
	}
}

func TestDisplayPluginOmitsRulebookURL(t *testing.T) {
	root := filepath.Join("..", "plugins")
	pm := loader.NewManager(root)
	if err := pm.Reload(); err != nil {
		t.Fatal(err)
	}
	ps := rangestate.NewManager(2, pm, "classic-range")
	ps.SetLiveSource(state.NewLiveState(2))
	if err := ps.Activate("classic-range"); err != nil {
		t.Fatal(err)
	}
	h := &Handlers{
		Cfg:         &config.Config{Plugins: config.Plugins{Dir: root, Active: "classic-range"}},
		Plugins:     pm,
		PluginState: ps,
	}
	rec := httptest.NewRecorder()
	h.PluginsActiveList(rec, httptest.NewRequest(http.MethodGet, "/api/plugins/active", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var list []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("active list len %d", len(list))
	}
	if url, _ := list[0]["rulebookUrl"].(string); url != "" {
		t.Fatalf("classic-range rulebookUrl=%q — Regeln button must stay hidden on the display plugin", url)
	}
}
