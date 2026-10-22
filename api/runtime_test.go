package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"srdashboard/config"
	"srdashboard/host/rangestate"
	"srdashboard/state"
	"srdashboard/udp"
)

func TestAllowShotDropsOutsideMaxAndInactive(t *testing.T) {
	h, _ := testHandlers(t, "")
	if !h.AllowShot(1) || !h.AllowShot(2) {
		t.Fatal("configured active lanes should apply")
	}
	if h.AllowShot(0) || h.AllowShot(3) || h.AllowShot(7) {
		t.Fatal("outside 1..N must drop")
	}
	h.Runtime.SetInactiveList([]int{2}, 2)
	if h.AllowShot(2) {
		t.Fatal("inactive lane must drop")
	}
	if !h.AllowShot(1) {
		t.Fatal("other active lane still applies")
	}
}

func TestPipelineDropsFunDartWhenDartsPluginIsNotActive(t *testing.T) {
	h, _ := testHandlers(t, "")
	applied := 0
	p := udp.Pipeline{
		State:  h.State,
		Filter: h,
		OnShot: func(_ int, _ state.Shot, _ int) { applied++ },
	}
	data := []byte(`{"MessageType":"Event","MessageVerb":"Shot","Ranges":1,"Objects":[{"Range":1,"X":0,"Y":0,"Distance":0,"FullValue":50,"DecValue":50,"DiscType":"fun_dart"}]}`)
	if n := p.Ingest(data); n != 0 {
		t.Fatalf("applied=%d, want 0 for fun_dart on classic-range", n)
	}
	if applied != 0 {
		t.Fatalf("OnShot called %d times for ignored fun_dart", applied)
	}
	if n := h.State.ShotNumber(1); n != 0 {
		t.Fatalf("live ShotNumber=%d, want 0 for ignored fun_dart", n)
	}
}

func TestAllowDiscTypeShotOnlyAllowsFunDartForDartsPlugin(t *testing.T) {
	h, _ := testHandlers(t, "")
	for _, discType := range []string{"fun_dart", "fun_biathlon", "FUN_OTHER", "fun-target", "FUN-DART"} {
		if h.AllowDiscTypeShot(1, discType, "") {
			t.Fatalf("%q should be rejected when classic-range is active", discType)
		}
	}
	if !h.AllowDiscTypeShot(1, "LG", "LG") {
		t.Fatal("normal LG shots should remain allowed outside Darts")
	}

	h.Cfg.Plugins.Active = "darts"
	if !h.AllowDiscTypeShot(1, "fun_dart", "fun_dart") {
		t.Fatal("exact fun_dart raw ID should be accepted by Darts")
	}
	if h.AllowDiscTypeShot(1, "", "fun_dart") {
		t.Fatal("Darts must reject fun_dart when DiscTypeRaw is missing, even if DiscType says fun_dart")
	}
	for _, discType := range []string{"LG", "LP", "KK", "fun_biathlon", "FUN_OTHER", "fun-target", "FUN-DART", "FUN_DART"} {
		if h.AllowDiscTypeShot(1, discType, "") {
			t.Fatalf("%q must be rejected by Darts; only exact fun_dart is valid", discType)
		}
	}
}

func TestDiscTypeFilterUsesPluginManagerActiveID(t *testing.T) {
	h, _ := testHandlers(t, "")
	// Deliberately make config.xml disagree with the runtime plugin manager.
	// The live plugin manager is authoritative for incoming shots.
	h.Cfg.Plugins.Active = "classic-range"
	h.PluginState = rangestate.NewManager(2, h.Plugins, "darts")
	if !h.AllowDiscTypeShot(1, "fun_dart", "LG") {
		t.Fatal("active Darts plugin must accept exact DiscTypeRaw fun_dart even if DiscType/config disagree")
	}
	if h.AllowDiscTypeShot(1, "LG", "LG") {
		t.Fatal("active Darts plugin must reject LG even if DiscType/config disagree")
	}

	h.Cfg.Plugins.Active = "darts"
	h.PluginState = rangestate.NewManager(2, h.Plugins, "classic-range")
	if h.AllowDiscTypeShot(1, "fun_dart", "fun_dart") {
		t.Fatal("active non-Darts plugin must reject fun_dart even if config says Darts")
	}
}

func TestPipelineDartsOnlyAcceptsExactFunDartRawID(t *testing.T) {
	h, _ := testHandlers(t, "")
	h.Cfg.Plugins.Active = "darts"
	applied := 0
	p := udp.Pipeline{
		State:  h.State,
		Filter: h,
		OnShot: func(_ int, _ state.Shot, _ int) { applied++ },
	}

	validDart := []byte(`{"MessageType":"Event","MessageVerb":"Shot","Ranges":1,"Objects":[{"Range":1,"X":0,"Y":0,"Distance":0,"FullValue":50,"DecValue":50,"DiscType":"LG","DiscTypeRaw":"fun_dart"}]}`)
	if n := p.Ingest(validDart); n != 1 {
		t.Fatalf("exact fun_dart should pass pipeline on Darts; applied=%d", n)
	}
	if applied != 1 || h.State.ShotNumber(1) != 1 {
		t.Fatalf("fun_dart not applied correctly: callbacks=%d shotNumber=%d", applied, h.State.ShotNumber(1))
	}

	for _, discType := range []string{"LG", "LP", "KK", "fun_biathlon", "FUN-DART", "FUN_DART"} {
		packet := []byte(`{"MessageType":"Event","MessageVerb":"Shot","Ranges":1,"Objects":[{"Range":1,"X":0,"Y":0,"Distance":0,"FullValue":10,"DecValue":10.5,"DiscType":"LG","DiscTypeRaw":"` + discType + `"}]}`)
		if n := p.Ingest(packet); n != 0 {
			t.Fatalf("DiscTypeRaw %q should be dropped by Darts; applied=%d", discType, n)
		}
	}
	if applied != 1 || h.State.ShotNumber(1) != 1 {
		t.Fatalf("rejected shots changed live state: callbacks=%d shotNumber=%d", applied, h.State.ShotNumber(1))
	}
}

func TestRuntimePutDeactivatesAndResets(t *testing.T) {
	h, _ := testHandlers(t, "s3cret")
	body := `{"inactiveRanges":[2]}`
	req := httptest.NewRequest(http.MethodPut, "/api/runtime", strings.NewReader(body))
	req.Header.Set("X-SR-Control-Token", "s3cret")
	rec := httptest.NewRecorder()
	h.ServeRuntime(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if !h.isRangeInactive(2) || h.isRangeInactive(1) {
		t.Fatalf("inactive = %v", h.inactiveRangeList())
	}
	var resp ConfigResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.InactiveRanges) != 1 || resp.InactiveRanges[0] != 2 {
		t.Fatalf("response = %#v", resp.InactiveRanges)
	}
	got, err := config.LoadRuntime(config.RuntimePath(h.ConfigPath))
	if err != nil {
		t.Fatal(err)
	}
	if !got.IsInactive(2) {
		t.Fatal("runtime.xml not persisted")
	}
}

func TestRuntimePutRequiresToken(t *testing.T) {
	h, _ := testHandlers(t, "s3cret")
	rec := httptest.NewRecorder()
	h.ServeRuntime(rec, httptest.NewRequest(http.MethodPut, "/api/runtime", strings.NewReader(`{"inactiveRanges":[1]}`)))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

func TestPipelineDropsBeforeApply(t *testing.T) {
	h, _ := testHandlers(t, "")
	h.Runtime.SetInactiveList([]int{1}, 2)
	data, err := udp.BuildShotPacket(udp.ShotPacketOpts{Range: 1, DecValue: 10.1})
	if err != nil {
		t.Fatal(err)
	}
	applied := 0
	p := udp.Pipeline{
		State:  h.State,
		Filter: h,
		OnShot: func(_ int, _ state.Shot, _ int) { applied++ },
	}
	p.Ingest(data)
	if applied != 0 {
		t.Fatalf("applied = %d", applied)
	}
	if n := h.State.ShotNumber(1); n != 0 {
		t.Fatalf("shotNumber = %d", n)
	}

	data7, err := udp.BuildShotPacket(udp.ShotPacketOpts{Range: 7, DecValue: 10.1})
	if err != nil {
		t.Fatal(err)
	}
	p.Ingest(data7)
	for _, s := range h.State.Snapshot() {
		if s.RangeNum == 7 {
			t.Fatal("must not grow live state for range 7")
		}
	}
}

func TestLiveGetOmitsInactive(t *testing.T) {
	h, _ := testHandlers(t, "")
	h.Runtime.SetInactiveList([]int{2}, 2)
	rec := httptest.NewRecorder()
	h.Live(rec, httptest.NewRequest(http.MethodGet, "/api/live", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var resp LiveResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Ranges) != 1 || resp.Ranges[0].RangeNum != 1 {
		t.Fatalf("ranges = %#v", resp.Ranges)
	}
	rec = httptest.NewRecorder()
	h.Live(rec, httptest.NewRequest(http.MethodGet, "/api/live?range=2", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("inactive single range status = %d, want 404", rec.Code)
	}
}
