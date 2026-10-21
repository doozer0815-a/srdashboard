package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
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

func TestRenamedPluginAssetsServedForGUI(t *testing.T) {
	root := filepath.Join("..", "plugins")
	h := &Handlers{Plugins: loader.NewManager(root)}

	paths := []string{
		"/plugins/autorennen/view.js",
		"/plugins/autorennen/theme.css",
		"/plugins/autorennen/assets/circuits/bergsee.svg",
		"/plugins/autorennen/assets/circuits/steinring.svg",
		"/plugins/autorennen/assets/circuits/hafenpark.svg",
		"/plugins/autorennen/assets/circuits/langring.svg",
		"/plugins/ludo/view.js",
		"/plugins/darts/view.js",
		"/plugins/darts/theme.css",
		"/plugins/ludo/theme.css",
		"/plugins/barrikade/view.js",
		"/plugins/barrikade/theme.css",
	}
	for _, path := range paths {
		rec := httptest.NewRecorder()
		h.ServePlugin(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status %d (GUI script/theme load would fail)", path, rec.Code)
			continue
		}
		if rec.Body.Len() == 0 {
			t.Errorf("%s: empty body", path)
		}
	}

	autorennen := httptest.NewRecorder()
	h.ServePlugin(autorennen, httptest.NewRequest(http.MethodGet, "/plugins/autorennen/view.js", nil))
	body := autorennen.Body.String()
	if !strings.Contains(body, "SRPluginViews['autorennen']") {
		t.Error("served autorennen view.js does not register SRPluginViews['autorennen']")
	}
}

func TestPluginsListUsesRenamedIds(t *testing.T) {
	root := filepath.Join("..", "plugins")
	h := &Handlers{Plugins: loader.NewManager(root)}
	rec := httptest.NewRecorder()
	h.PluginsList(rec, httptest.NewRequest(http.MethodGet, "/api/plugins", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var list []loader.PluginInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, p := range list {
		got[p.ID] = p.Label
	}
	want := map[string]string{
		"autorennen": "Autorennen",
		"ludo":       "Ludo",
		"barrikade":  "Barrikade",
	}
	for id, label := range want {
		if got[id] != label {
			t.Errorf("list %s: got %q, want label %q — plugin picker would show the wrong name or omit the game", id, got[id], label)
		}
	}
}

func TestActivePluginPayloadUsesNewIdsAndAssetURLs(t *testing.T) {
	root := filepath.Join("..", "plugins")
	pm := loader.NewManager(root)
	if err := pm.Reload(); err != nil {
		t.Fatal(err)
	}
	ids := []string{"autorennen", "ludo", "barrikade"}
	for _, id := range ids {
		t.Run(id, func(t *testing.T) {
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
			item := list[0]
			if item["id"] != id {
				t.Fatalf("id=%v want %s — plugin-shell would look up the wrong SRPluginViews key", item["id"], id)
			}
			viewURL, _ := item["viewUrl"].(string)
			wantPrefix := "/plugins/" + id + "/"
			if !strings.HasPrefix(viewURL, wantPrefix) {
				t.Fatalf("viewUrl=%q does not start with %s — plugin-shell refuses foreign URLs and the hall stays blank", viewURL, wantPrefix)
			}
			themeURL, _ := item["themeUrl"].(string)
			if themeURL != "" && !strings.HasPrefix(themeURL, wantPrefix) {
				t.Fatalf("themeUrl=%q does not start with %s", themeURL, wantPrefix)
			}
			assets, _ := item["assetsBase"].(string)
			if assets != "" && !strings.HasPrefix(assets, "/plugins/"+id) {
				t.Fatalf("assetsBase=%q", assets)
			}
		})
	}
}

func TestPluginActivateKeepsClassicRangeStartup(t *testing.T) {
	root := filepath.Join("..", "plugins")
	pm := loader.NewManager(root)
	if err := pm.Reload(); err != nil {
		t.Fatal(err)
	}
	cfgPath := filepath.Join(t.TempDir(), "config.xml")
	cfg := &config.Config{
		UDPPort:       30169,
		Ranges:        2,
		LayoutColumns: 2,
		Plugins:       config.Plugins{Dir: root, Active: "classic-range"},
	}
	if err := config.Save(cfgPath, cfg); err != nil {
		t.Fatal(err)
	}
	ps := rangestate.NewManager(2, pm, "classic-range")
	ps.SetLiveSource(state.NewLiveState(2))
	if err := ps.Activate("classic-range"); err != nil {
		t.Fatal(err)
	}
	h := &Handlers{
		State:       state.NewLiveState(2),
		Cfg:         cfg,
		ConfigPath:  cfgPath,
		Plugins:     pm,
		PluginState: ps,
	}
	req := httptest.NewRequest(http.MethodPost, "/api/plugins/activate", strings.NewReader(`{"id":"barrikade"}`))
	rec := httptest.NewRecorder()
	h.PluginActivate(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if ps.ActivePluginID() != "barrikade" {
		t.Fatalf("live plugin = %q", ps.ActivePluginID())
	}
	if got := h.cfgSnapshot().Plugins.Active; got != "classic-range" {
		t.Fatalf("in-memory startup plugin = %q", got)
	}
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if !strings.Contains(text, `active="classic-range"`) {
		t.Fatalf("config.xml lost classic-range:\n%s", text)
	}
	if strings.Contains(text, `active="barrikade"`) {
		t.Fatal("hall switch wrote the live game into config.xml")
	}
	crec := httptest.NewRecorder()
	h.Config(crec, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	var resp ConfigResponse
	if err := json.Unmarshal(crec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.ActivePlugin != "classic-range" {
		t.Fatalf("config editor activePlugin=%q — saving settings would change the startup game", resp.ActivePlugin)
	}
}
