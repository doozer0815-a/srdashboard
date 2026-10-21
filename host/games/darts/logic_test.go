package darts

import (
	"testing"

	"srdashboard/host/games/gameutil"
	"srdashboard/host/logicapi"
	"srdashboard/state"
)

func startTestGame(t *testing.T, cfg map[string]any, ranges int) (*Logic, *GameState) {
	t.Helper()
	l := New(nil)
	st, err := l.Init(cfg)
	if err != nil {
		t.Fatal(err)
	}
	params := map[string]any{
		"numRanges": ranges,
		"live": map[string]any{
			"1": map[string]any{"active": true, "shooterName": "Max"},
			"2": map[string]any{"active": true, "shooterName": "Peter"},
		},
		"orderMode": "range",
	}
	st, _, err = l.Control(st, "start", params)
	if err != nil {
		t.Fatal(err)
	}
	gs, err := unmarshalState(st)
	if err != nil {
		t.Fatal(err)
	}
	return l, gs
}

func dartShot(full int, distance float64, disc string) state.Shot {
	return state.Shot{
		X:           100,
		Y:           -200,
		FullValue:   full,
		Distance:    float64(distance),
		DiscTypeRaw: disc,
	}
}

func applyDart(t *testing.T, l *Logic, gs *GameState, shot state.Shot, rangeNum int) *GameState {
	t.Helper()
	st, err := marshalState(gs)
	if err != nil {
		t.Fatal(err)
	}
	st, _, err = l.OnShotCtx(st, logicapi.ShotContext{RangeNum: rangeNum, Shot: shot, NumRanges: gs.NumRanges})
	if err != nil {
		t.Fatal(err)
	}
	gs, err = unmarshalState(st)
	if err != nil {
		t.Fatal(err)
	}
	return gs
}

func TestClassifyDartUsesDistanceInHundredthsOfMillimetre(t *testing.T) {
	cfg := defaultConfig()

	tests := []struct {
		name       string
		distance   float64
		fullValue  int
		multiplier int
		ring       string
		score      int
	}{
		{
			name:       "single",
			distance:   2290,
			fullValue:  20,
			multiplier: 1,
			ring:       "single",
			score:      20,
		},
		{
			name:       "triple",
			distance:   4055,
			fullValue:  60,
			multiplier: 3,
			ring:       "triple",
			score:      60,
		},
		{
			name:       "double",
			distance:   6520,
			fullValue:  40,
			multiplier: 2,
			ring:       "double",
			score:      40,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyDart(
				dartShot(tt.fullValue, tt.distance, "fun_dart"),
				1,
				cfg,
			)

			if got.Ring != tt.ring {
				t.Fatalf(
					"got %s x%d, want %s x%d",
					got.Ring,
					got.Multiplier,
					tt.ring,
					tt.multiplier,
				)
			}

			if got.Multiplier != tt.multiplier {
				t.Fatalf(
					"multiplier=%d want %d",
					got.Multiplier,
					tt.multiplier,
				)
			}

			if got.Score != tt.score {
				t.Fatalf(
					"score=%d want %d",
					got.Score,
					tt.score,
				)
			}
		})
	}
}

func TestWarmupFunDartIsDisplayedWithoutScoring(t *testing.T) {
	l, gs := startTestGame(t, map[string]any{"startingScore": 501}, 2)
	// "Einschießen" can be either warmup or arming: sync_live moves the
	// initial warmup phase to arming before the game is started.
	gs.Phase = gameutil.PhaseArming
	beforeScore := gs.Players["1"].Score
	gs = applyDart(t, l, gs, dartShot(20, 2290, "fun_dart"), 1)

	if len(gs.BoardDarts) != 1 {
		t.Fatalf("warm-up hit not shown on board: got %d board darts, want 1", len(gs.BoardDarts))
	}
	if gs.BoardRange != 1 {
		t.Fatalf("board range=%d want 1", gs.BoardRange)
	}
	if gs.Players["1"].Score != beforeScore {
		t.Fatalf("warm-up hit changed score: got %d want %d", gs.Players["1"].Score, beforeScore)
	}
	if len(gs.Players["1"].RoundDarts) != 0 {
		t.Fatalf("warm-up hit was added to scored round")
	}
}

func TestWarmupFlagDisplaysFunDartWithoutScoringDuringPlaying(t *testing.T) {
	l, gs := startTestGame(t, map[string]any{"startingScore": 501}, 2)
	shot := dartShot(20, 2290, "fun_dart")
	shot.IsWarmup = true
	beforeScore := gs.Players["1"].Score
	gs = applyDart(t, l, gs, shot, 1)

	if len(gs.BoardDarts) != 1 {
		t.Fatalf("warm-up-flagged hit not shown: got %d board darts, want 1", len(gs.BoardDarts))
	}
	if gs.Players["1"].Score != beforeScore || len(gs.Players["1"].RoundDarts) != 0 {
		t.Fatalf("warm-up-flagged hit was scored")
	}
}

func TestNonFunDartIsIgnored(t *testing.T) {
	l, gs := startTestGame(t, map[string]any{"startingScore": 501}, 2)
	before := gs.Players["1"].Score
	gs = applyDart(t, l, gs, dartShot(20, 1650, "LG"), 1)
	if got := gs.Players["1"].Score; got != before {
		t.Fatalf("score changed for non-dart target: got %d want %d", got, before)
	}
	if len(gs.Players["1"].RoundDarts) != 0 {
		t.Fatalf("non-dart shot was added to round")
	}
}

func TestThreeDartsAdvanceToNextRange(t *testing.T) {
	l, gs := startTestGame(t, map[string]any{"startingScore": 501}, 2)
	gs = applyDart(t, l, gs, dartShot(20, 2290, "fun_dart"), 1)
	gs = applyDart(t, l, gs, dartShot(60, 4055, "fun_dart"), 1)
	gs = applyDart(t, l, gs, dartShot(40, 6520, "fun_dart"), 1)

	if gs.Players["1"].Score != 381 { // 20 + 60 + 40
		t.Fatalf("score=%d want 381", gs.Players["1"].Score)
	}
	if gs.ActiveRange != 0 || !gs.TurnPending {
		t.Fatalf("turn should be inactive while audio plays: active=%d pending=%v", gs.ActiveRange, gs.TurnPending)
	}
	st, err := marshalState(gs)
	if err != nil {
		t.Fatal(err)
	}
	st, _, err = l.Control(st, "next_turn", nil)
	if err != nil {
		t.Fatal(err)
	}
	gs, err = unmarshalState(st)
	if err != nil {
		t.Fatal(err)
	}
	if gs.ActiveRange != 2 {
		t.Fatalf("active range after audio=%d want 2", gs.ActiveRange)
	}
	if len(gs.Players["1"].RoundDarts) != 3 {
		t.Fatalf("completed player's darts should remain visible until their next activation: got %d want 3", len(gs.Players["1"].RoundDarts))
	}
	if gs.Players["1"].OpenDarts != 0 {
		t.Fatalf("open darts should remain at 0 until player's next activation: got %d", gs.Players["1"].OpenDarts)
	}
	if gs.Players["1"].LastRoundScore != 120 {
		t.Fatalf("last round=%d want 120", gs.Players["1"].LastRoundScore)
	}
	// After player 2 finishes, player 1 is activated again and their turn data resets.
	gs = applyDart(t, l, gs, dartShot(20, 2290, "fun_dart"), 2)
	gs = applyDart(t, l, gs, dartShot(20, 2290, "fun_dart"), 2)
	gs = applyDart(t, l, gs, dartShot(20, 2290, "fun_dart"), 2)
	st, err = marshalState(gs)
	if err != nil {
		t.Fatal(err)
	}
	st, _, err = l.Control(st, "next_turn", nil)
	if err != nil {
		t.Fatal(err)
	}
	gs, err = unmarshalState(st)
	if err != nil {
		t.Fatal(err)
	}
	if gs.ActiveRange != 1 {
		t.Fatalf("active range after second audio=%d want 1", gs.ActiveRange)
	}
	if len(gs.Players["1"].RoundDarts) != 0 || gs.Players["1"].OpenDarts != 3 {
		t.Fatalf("player 1 should reset on activation: darts=%d openDarts=%d", len(gs.Players["1"].RoundDarts), gs.Players["1"].OpenDarts)
	}
}

func TestDoubleInBlocksUntilDouble(t *testing.T) {
	l, gs := startTestGame(t, map[string]any{"startingScore": 501, "doubleIn": true}, 2)
	gs = applyDart(t, l, gs, dartShot(20, 2290, "fun_dart"), 1)
	if gs.Players["1"].Score != 501 || gs.Players["1"].Started {
		t.Fatalf("single should not start Double In: score=%d started=%v", gs.Players["1"].Score, gs.Players["1"].Started)
	}
	gs = applyDart(t, l, gs, dartShot(40, 6520, "fun_dart"), 1)
	if gs.Players["1"].Score != 461 || !gs.Players["1"].Started {
		t.Fatalf("double should start game: score=%d started=%v", gs.Players["1"].Score, gs.Players["1"].Started)
	}
}

func TestDoubleOutRequiresDouble(t *testing.T) {
	l, gs := startTestGame(t, map[string]any{"startingScore": 501, "doubleOut": true}, 2)
	p := gs.Players["1"]
	p.Score = 40
	p.RoundStartScore = 40

	gs = applyDart(t, l, gs, dartShot(20, 2290, "fun_dart"), 1)
	if gs.Players["1"].Score != 20 {
		t.Fatalf("first single should leave 20, got %d", gs.Players["1"].Score)
	}
	gs = applyDart(t, l, gs, dartShot(20, 2290, "fun_dart"), 1)
	if gs.ActiveRange != 0 || !gs.TurnPending {
		t.Fatalf("invalid checkout should deactivate turn pending audio")
	}
	if gs.Players["1"].Score != 40 {
		t.Fatalf("invalid checkout should bust back to 40, got %d", gs.Players["1"].Score)
	}
	if gs.Players["1"].LastResult != "Bust" {
		t.Fatalf("last result=%q", gs.Players["1"].LastResult)
	}
	st, err := marshalState(gs)
	if err != nil {
		t.Fatal(err)
	}
	st, _, err = l.Control(st, "next_turn", nil)
	if err != nil {
		t.Fatal(err)
	}
	gs, err = unmarshalState(st)
	if err != nil {
		t.Fatal(err)
	}
	if gs.ActiveRange != 2 {
		t.Fatalf("next player not activated after audio, active=%d", gs.ActiveRange)
	}
}

func TestBustOnFirstDartImmediatelyEndsTurnAndRestoresScore(t *testing.T) {
	// Use a supported starting score, then arrange a 20-point remainder to
	// exercise a bust on the first dart.
	l, gs := startTestGame(t, map[string]any{"startingScore": 301}, 2)
	gs.Players["1"].Score = 20
	gs.Players["1"].RoundStartScore = 20
	gs = applyDart(t, l, gs, dartShot(60, 4055, "fun_dart"), 1)

	if gs.ActiveRange != 0 || !gs.TurnPending {
		t.Fatalf("bust should deactivate current player pending audio, active=%d pending=%v", gs.ActiveRange, gs.TurnPending)
	}
	p := gs.Players["1"]
	if p.Score != 20 {
		t.Fatalf("score after bust=%d want 20", p.Score)
	}
	if p.LastResult != "Bust" {
		t.Fatalf("last result=%q want Bust", p.LastResult)
	}
	if len(p.LastRoundDarts) != 1 {
		t.Fatalf("last round darts=%d want 1 (bust dart should remain visible)", len(p.LastRoundDarts))
	}
	st, err := marshalState(gs)
	if err != nil {
		t.Fatal(err)
	}
	st, _, err = l.Control(st, "next_turn", nil)
	if err != nil {
		t.Fatal(err)
	}
	gs, err = unmarshalState(st)
	if err != nil {
		t.Fatal(err)
	}
	if gs.ActiveRange != 2 || gs.TurnPending {
		t.Fatalf("next player not activated after audio: active=%d pending=%v", gs.ActiveRange, gs.TurnPending)
	}
}

func TestBeginnerOrderRotatesRangeOrder(t *testing.T) {
	l := New(nil)
	st, err := l.Init(map[string]any{"startingScore": 301})
	if err != nil {
		t.Fatal(err)
	}
	st, _, err = l.Control(st, "start", map[string]any{
		"numRanges":     4,
		"orderMode":     "beginner",
		"beginnerRange": 3,
		"live": map[string]any{
			"1": map[string]any{"active": true},
			"2": map[string]any{"active": true},
			"3": map[string]any{"active": true},
			"4": map[string]any{"active": true},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	gs, err := unmarshalState(st)
	if err != nil {
		t.Fatal(err)
	}
	want := []int{3, 4, 1, 2}
	for i := range want {
		if gs.Order[i] != want[i] {
			t.Fatalf("order=%v want %v", gs.Order, want)
		}
	}
	if gs.ActiveRange != 3 {
		t.Fatalf("active=%d want 3", gs.ActiveRange)
	}
}
func TestClassifyDartOpticScoreFullValue(t *testing.T) {
	cfg := defaultConfig()

	tests := []struct {
		name         string
		fullValue    int
		distance     float64
		wantRing     string
		wantMult     int
		wantScore    int
		wantNotation string
	}{
		{
			name:         "single 6",
			fullValue:    6,
			distance:     2880,
			wantRing:     "single",
			wantMult:     1,
			wantScore:    6,
			wantNotation: "S6",
		},
		{
			name:         "triple 6",
			fullValue:    18,
			distance:     4000,
			wantRing:     "triple",
			wantMult:     3,
			wantScore:    18,
			wantNotation: "T6",
		},
		{
			name:         "double 6",
			fullValue:    12,
			distance:     6500,
			wantRing:     "double",
			wantMult:     2,
			wantScore:    12,
			wantNotation: "D6",
		},
		{
			name:         "triple 6 alternative distance",
			fullValue:    18,
			distance:     3880,
			wantRing:     "triple",
			wantMult:     3,
			wantScore:    18,
			wantNotation: "T6",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyDart(
				dartShot(tt.fullValue, tt.distance, "fun_dart"),
				1,
				cfg,
			)

			if got.Ring != tt.wantRing {
				t.Fatalf("Ring=%q want %q", got.Ring, tt.wantRing)
			}

			if got.Multiplier != tt.wantMult {
				t.Fatalf("Multiplier=%d want %d", got.Multiplier, tt.wantMult)
			}

			if got.Score != tt.wantScore {
				t.Fatalf("Score=%d want %d", got.Score, tt.wantScore)
			}

			if got.Notation != tt.wantNotation {
				t.Fatalf("Notation=%q want %q", got.Notation, tt.wantNotation)
			}
		})
	}
}
func TestClassifyDartRealOpticScoreDouble(t *testing.T) {
	cfg := defaultConfig()

	// Real OpticScore example:
	// Distance 6584.6 = 65.846 mm.
	d := classifyDart(
		dartShot(40, 6584.6, "fun_dart"),
		1,
		cfg,
	)

	if d.Ring != "double" {
		t.Fatalf(
			"ring=%q, want double; distanceMm=%.3f",
			d.Ring,
			d.DistanceMm,
		)
	}

	if d.Multiplier != 2 {
		t.Fatalf("multiplier=%d, want 2", d.Multiplier)
	}

	if d.Score != 40 {
		t.Fatalf("score=%d, want 40", d.Score)
	}
}

func TestClassifyDartFullBull(t *testing.T) {
	cfg := defaultConfig()

	d := classifyDart(
		dartShot(50, 0, "fun_dart"),
		1,
		cfg,
	)

	if d.Ring != "bullseye" {
		t.Fatalf("ring=%q, want bullseye", d.Ring)
	}

	if d.Multiplier != 2 {
		t.Fatalf("multiplier=%d, want 2", d.Multiplier)
	}

	if d.Score != 50 {
		t.Fatalf("score=%d", d.Score)
	}

	if d.Notation != "BULL" {
		t.Fatalf("notation=%q, want BULL", d.Notation)
	}
}

func TestCricketClosesTripleAndScoresOnlyAfterClosed(t *testing.T) {
	l, gs := startTestGame(t, map[string]any{"gameMode": "cricket"}, 2)
	gs.GameMode = "cricket"
	gs.Phase = gameutil.PhasePlaying
	gs.ActiveRange = 1
	gs.Order = []int{1, 2}
	gs.Players["1"].CricketMarks = map[string]int{"20": 0, "19": 0, "18": 0, "17": 0, "16": 0, "15": 0, "B": 0}
	gs.Players["2"].CricketMarks = map[string]int{"20": 0, "19": 0, "18": 0, "17": 0, "16": 0, "15": 0, "B": 0}
	gs = applyDart(t, l, gs, dartShot(60, 4055, "fun_dart"), 1)
	if gs.Players["1"].CricketMarks["20"] != 3 {
		t.Fatalf("triple 20 marks=%d want 3", gs.Players["1"].CricketMarks["20"])
	}
	if gs.Players["1"].CricketPoints != 0 {
		t.Fatalf("points after just closing 20=%d want 0", gs.Players["1"].CricketPoints)
	}
	gs = applyDart(t, l, gs, dartShot(20, 2290, "fun_dart"), 1)
	if gs.Players["1"].CricketPoints != 20 {
		t.Fatalf("extra 20 should score 20 while opponent open, got %d", gs.Players["1"].CricketPoints)
	}
}
