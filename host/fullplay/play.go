package fullplay

import (
	"testing"

	"srdashboard/state"
	"srdashboard/udp"
)

func playClassicRange(t *testing.T, h *Host) {
	t.Helper()
	for i := 1; i <= h.NumRanges; i++ {
		h.Fire(i, 10.4)
	}
	h.requireBothRangesPaint()
	vm := h.VM(1)
	if vm["kind"] != "display" {
		t.Fatalf("classic-range kind=%v", vm["kind"])
	}
}

func playAnalyse(t *testing.T, h *Host) {
	t.Helper()
	fireAnna := func(dec float64) {
		h.firePacket(1, dec, udp.ShotPacketOpts{
			Shooter:  "Anna",
			Lastname: "Müller",
			MenuItem: "LG 2 Schuss",
		})
	}
	fireAnna(10.4)
	fireAnna(9.2)
	first := h.Live.SessionResults()
	if len(first) != 1 || !first[0].Live || first[0].ShotNumber != 2 {
		t.Fatalf("first Analyse start = %+v", first)
	}
	oldID := first[0].ID

	fireAnna(8.0)
	list := h.Live.SessionResults()
	if len(list) != 2 {
		t.Fatalf("same shooter new start should archive, got %+v", list)
	}
	if !list[0].Live || list[0].ID == oldID || list[0].ShotNumber != 1 {
		t.Fatalf("new live = %+v (old %s)", list[0], oldID)
	}
	if list[1].Live || list[1].ID != oldID || list[1].ShotNumber != 2 {
		t.Fatalf("archived first start = %+v, want id %s", list[1], oldID)
	}
	_, snap, ok := h.Live.SessionResult(oldID)
	if !ok || snap.ShotNumber != 2 {
		t.Fatalf("SessionResult(%s) = ok=%v snap=%+v", oldID, ok, snap)
	}
	info, liveSnap, ok := h.Live.SessionResult("live-1")
	if !ok || !info.Live || info.ID == oldID || liveSnap.ShotNumber != 1 {
		t.Fatalf("live-1 alias = ok=%v info=%+v snap=%+v", ok, info, liveSnap)
	}

	h.Fire(2, 10.4)
	h.requireBothRangesPaint()
	if h.VM(1)["kind"] != "display" {
		t.Fatalf("analyse kind=%v", h.VM(1)["kind"])
	}
}

func playLudo(t *testing.T, h *Host) {
	t.Helper()
	h.Start()
	game := nest(h.VM(1), "game")
	if game == nil {
		t.Fatal("missing game view model")
	}
	arms := asInt(game["boardArms"])
	ring := asInt(game["ringSize"])
	if h.NumRanges < 4 {
		if arms != 4 {
			t.Fatalf("2/3-player Ludo boardArms=%d want 4 (classic cross, not a 2-point star)", arms)
		}
		if ring < 40 {
			t.Fatalf("2-player Ludo ringSize=%d want >= 40 fields", ring)
		}
	} else if ring < h.NumRanges*8 {
		t.Fatalf("Ludo ringSize=%d too small for %d players", ring, h.NumRanges)
	}
	h.requireBothRangesPaint()

	h.Fire(1, 10.0)
	for i := 0; i < 80 && h.phase([]string{"game", "phase"}) != "finished"; i++ {
		h.Fire(1, 10.5)
	}
	h.requirePhase([]string{"game", "phase"}, "finished")
	if asInt(nest(h.VM(1), "game")["winnerRange"]) != 1 {
		t.Fatalf("winner=%v want stand 1", nest(h.VM(1), "game")["winnerRange"])
	}
}

func playBarrikade(t *testing.T, h *Host) {
	t.Helper()
	h.Start()
	h.requireBothRangesPaint()
	prev := -1
	for i := 0; i < 80 && h.phase([]string{"game", "phase"}) != "finished"; i++ {
		game := nest(h.VM(1), "game")
		cell := 0
		for _, p := range asSlice(game["players"]) {
			pm, _ := p.(map[string]any)
			if asInt(pm["rangeNum"]) == 1 {
				cell = asInt(pm["cell"])
				break
			}
		}
		if cell == prev {
			h.Fire(1, 10.0)
		} else {
			h.Fire(1, 10.5)
		}
		prev = cell
	}
	h.requirePhase([]string{"game", "phase"}, "finished")
}

func playBingo(t *testing.T, h *Host) {
	t.Helper()
	h.Start()
	h.requireBothRangesPaint()
	vals := bingoCardValues(nest(h.VM(1), "game"))
	if len(vals) < 5 {
		t.Fatalf("bingo card values=%d want 25", len(vals))
	}
	for _, v := range vals[:5] {
		h.Fire(1, v)
	}
	h.requirePhase([]string{"game", "phase"}, "finished")
}

func bingoCardValues(game map[string]any) []float64 {
	if game == nil {
		return nil
	}
	switch t := game["cardValues"].(type) {
	case []float64:
		return t
	case []any:
		out := make([]float64, 0, len(t))
		for _, x := range t {
			switch n := x.(type) {
			case float64:
				out = append(out, n)
			case int:
				out = append(out, float64(n))
			}
		}
		return out
	default:
		return nil
	}
}

var tannebaumClear = []float64{
	5, 6, 7, 8.0, 8.5, 9.0, 9.5, 10.0, 8.1, 9.1, 10.1, 10.5, 10.6, 10.7, 10.8, 10.9,
}

func playTannebaumEinzel(t *testing.T, h *Host) {
	t.Helper()
	h.Start()
	tree := nest(h.VM(1), "tree")
	if tree == nil {
		t.Fatal("missing tree view model")
	}
	if n := len(asSlice(tree["contenders"])); n != h.NumRanges {
		t.Fatalf("einzel contenders=%d want %d (hall gallery needs every stand)", n, h.NumRanges)
	}
	h.requireBothRangesPaint()
	for _, v := range tannebaumClear {
		h.Fire(1, v)
	}
	h.requirePhase([]string{"tree", "phase"}, "finished")
}

func playTannebaumTeam(t *testing.T, h *Host) {
	t.Helper()
	h.Start()
	tree := nest(h.VM(1), "tree")
	if n := len(asSlice(tree["contenders"])); n != 2 {
		t.Fatalf("team contenders=%d want 2", n)
	}
	h.requireBothRangesPaint()
	for _, v := range tannebaumClear {
		h.Fire(1, v)
	}
	h.requirePhase([]string{"tree", "phase"}, "finished")
}

func playFox(t *testing.T, h *Host) {
	t.Helper()
	for i := 0; i < 5; i++ {
		for r := 1; r <= h.NumRanges; r++ {
			h.Fire(r, 8.0)
		}
	}
	if h.phase([]string{"hunt", "phase"}) != "opening" && h.phase([]string{"hunt", "phase"}) != "chase" {
		h.Start()
	}
	h.requireBothRangesPaint()
	for i := 0; i < 400 && h.phase([]string{"hunt", "phase"}) != "finished"; i++ {
		hunt := nest(h.VM(1), "hunt")
		turn := asInt(hunt["turnRange"])
		fox := asInt(hunt["currentFox"])
		if turn < 1 {
			h.Start()
			continue
		}
		val := 10.0
		if turn == fox {
			val = 1.2
		}
		h.Fire(turn, val)
	}
	h.requirePhase([]string{"hunt", "phase"}, "finished")
	shots := asSlice(nest(h.VM(1), "hunt")["recentShots"])
	if len(shots) == 0 {
		t.Fatal("fox finished without shots on the disc")
	}
	last, _ := shots[len(shots)-1].(map[string]any)
	if last == nil || (asInt(last["x"]) == 0 && asInt(last["y"]) == 0) {
		t.Fatalf("fox disc shots missing coordinates: %#v", last)
	}
}

func playAutorennen(t *testing.T, h *Host) {
	t.Helper()
	h.Start()
	if p := h.phase([]string{"race", "phase"}); p != "racing" && p != "finished" {
		t.Fatalf("autorennen after start phase=%q", p)
	}
	h.requireBothRangesPaint()
	budget := h.totalShots
	if budget < 1 {
		budget = 10
	}
	for n := 0; n < budget; n++ {
		if h.phase([]string{"race", "phase"}) == "finished" {
			break
		}
		for r := 1; r <= h.NumRanges; r++ {
			h.Fire(r, 10.3)
		}
	}
	h.requirePhase([]string{"race", "phase"}, "finished")
}

func playUntilFinished(t *testing.T, h *Host, fire func(round int)) {
	t.Helper()
	h.Start()
	h.requireBothRangesPaint()
	path := []string{"game", "phase"}
	for i := 0; i < 500 && h.phase(path) != "finished"; i++ {
		fire(i)
	}
	h.requirePhase(path, "finished")
}

func playHighValueProgram(t *testing.T, h *Host) {
	t.Helper()
	playUntilFinished(t, h, func(round int) {
		for r := 1; r <= h.NumRanges; r++ {
			if h.phase([]string{"game", "phase"}) == "finished" {
				return
			}
			h.Fire(r, 10.9)
		}
	})
}

func playTauziehen(t *testing.T, h *Host) {
	t.Helper()
	playUntilFinished(t, h, func(round int) {
		h.Fire(1, 10.9)
		if h.NumRanges >= 2 && h.phase([]string{"game", "phase"}) != "finished" {
			h.Fire(2, 5.0)
		}
	})
	if asString(nest(h.VM(1), "game")["winnerTeam"]) != "A" {
		t.Fatalf("tauziehen winnerTeam=%v want A", nest(h.VM(1), "game")["winnerTeam"])
	}
}

func playKoPokal(t *testing.T, h *Host) {
	t.Helper()
	playUntilFinished(t, h, func(round int) {
		h.Fire(1, 10.9)
		if h.NumRanges >= 2 && h.phase([]string{"game", "phase"}) != "finished" {
			h.Fire(2, 8.0)
		}
	})
}

func playBankOderRisiko(t *testing.T, h *Host) {
	t.Helper()
	h.Start()
	h.requireBothRangesPaint()
	path := []string{"game", "phase"}
	for i := 0; i < 80 && h.phase(path) != "finished"; i++ {
		for r := 1; r <= h.NumRanges; r++ {
			if h.phase(path) == "finished" {
				break
			}
			h.Fire(r, 10.9)
			if i%4 == 3 {
				h.Control("bank", map[string]any{"rangeNum": r})
			}
		}
	}
	h.requirePhase(path, "finished")
}
func playDarts(t *testing.T, h *Host) {
	t.Helper()

	h.Control("start", map[string]any{
		"startingScore": 301,
		"doubleIn":      false,
		"doubleOut":     false,
		"orderMode":     "beginner",
		"beginnerRange": 1,
	})

	h.requireBothRangesPaint()

	game := nest(h.VM(1), "game")
	if game == nil {
		t.Fatal("missing darts game view model")
	}
	if got := asInt(game["activeRange"]); got != 1 {
		t.Fatalf("darts activeRange=%d want 1", got)
	}

	fire := func(rangeNum, value int, distance float64, discTypeRaw string) {
		idx := h.shotIndex[rangeNum] + 1
		h.shotIndex[rangeNum] = idx
		h.PS.OnShot(rangeNum, state.Shot{
			X:           100,
			Y:           -100,
			Distance:    distance,
			FullValue:   value,
			DecValue:    float64(value),
			DiscTypeRaw: discTypeRaw,
		}, idx)
	}

	playerScore := func(rangeNum int) int {
		game := nest(h.VM(1), "game")
		for _, raw := range asSlice(game["players"]) {
			p, _ := raw.(map[string]any)
			if asInt(p["rangeNum"]) == rangeNum {
				return asInt(p["score"])
			}
		}
		return -1
	}

	// Nicht-Dart-Scheiben dürfen den Spielstand nicht verändern.
	before := playerScore(1)
	fire(1, 20, 1030, "LG")
	if got := playerScore(1); got != before {
		t.Fatalf("non-fun_dart changed score: got %d want %d", got, before)
	}

	// Stand 1: T20 + T20 + T20 = 180; 301 -> 121.
	for i := 0; i < 3; i++ {
		fire(1, 60, 4000, "fun_dart")
	}
	if got := playerScore(1); got != 121 {
		t.Fatalf("stand 1 after first round score=%d want 121", got)
	}
	// Nach dem dritten Dart ist zunächst kein Spieler aktiv, solange die
	// Audioansagen laufen. Der Frontend-Callback simulieren wir hier mit
	// next_turn und prüfen danach den tatsächlich aktivierten Spieler.
	if got := asInt(nest(h.VM(1), "game")["activeRange"]); got != 0 {
		t.Fatalf("after stand 1 turn activeRange=%d want 0 while audio plays", got)
	}
	h.Control("next_turn", nil)
	if got := asInt(nest(h.VM(1), "game")["activeRange"]); got != 2 {
		t.Fatalf("after audio for stand 1 activeRange=%d want 2", got)
	}

	// Stand 2: drei Misses, danach läuft ebenfalls erst die Audiosequenz.
	for i := 0; i < 3; i++ {
		fire(2, 0, 2300, "fun_dart")
	}
	if got := asInt(nest(h.VM(1), "game")["activeRange"]); got != 0 {
		t.Fatalf("after stand 2 turn activeRange=%d want 0 while audio plays", got)
	}
	h.Control("next_turn", nil)
	if got := asInt(nest(h.VM(1), "game")["activeRange"]); got != 1 {
		t.Fatalf("after audio for stand 2 activeRange=%d want 1", got)
	}

	// Stand 1: T20 + T20 + S1 = 121 -> 0.
	fire(1, 60, 4000, "fun_dart")
	fire(1, 60, 4000, "fun_dart")
	fire(1, 1, 2000, "fun_dart")

	h.requirePhase([]string{"game", "phase"}, "finished")

	game = nest(h.VM(1), "game")
	if got := asInt(game["winnerRange"]); got != 1 {
		t.Fatalf("darts winnerRange=%d want 1", got)
	}
	if n := len(asSlice(game["boardDarts"])); n != 3 {
		t.Fatalf("darts boardDarts=%d want 3 final-round hits", n)
	}
}
