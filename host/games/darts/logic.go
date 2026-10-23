package darts

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"srdashboard/host/games/gameutil"
	"srdashboard/host/loader"
	"srdashboard/host/logicapi"
	"srdashboard/state"
)

func init() {
	loader.RegisterBuiltin("darts", func(m *loader.Manifest) logicapi.Logic { return New(m) })
}

type Logic struct{ manifest *loader.Manifest }

func New(m *loader.Manifest) *Logic { return &Logic{manifest: m} }

func (l *Logic) ID() string {
	if l.manifest != nil && l.manifest.ID != "" {
		return l.manifest.ID
	}
	return "darts"
}
func (l *Logic) Label() string {
	if l.manifest != nil && l.manifest.Label != "" {
		return l.manifest.Label
	}
	return "Dart"
}
func (l *Logic) Version() string {
	if l.manifest != nil && l.manifest.Version != "" {
		return l.manifest.Version
	}
	return "1.0.0"
}

func defaultConfig() map[string]any {
	return map[string]any{
		"gameMode":              "x01",
		"startingScore":         501,
		"doubleIn":              false,
		"doubleOut":             false,
		"orderMode":             "range",
		"beginnerRange":         1,
		"autoStartWhenAllReady": false,
		"distanceUnitsPerMm":    100.0,
		"boardRadiusMm":         70.5,
		"tripleInnerRadiusMm":   36.0,
		"tripleOuterRadiusMm":   43.6,
		"doubleInnerRadiusMm":   62.7,
		"doubleOuterRadiusMm":   70,
		"outerBullRadiusMm":     9.57,
		"bullRadiusMm":          5.47,
	}
}

func (l *Logic) DefaultConfig() map[string]any { return defaultConfig() }

func (l *Logic) ConfigSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"gameMode":              map[string]any{"type": "string", "enum": []string{"x01", "cricket", "around_clock"}, "title": "Spielart"},
			"startingScore":         map[string]any{"type": "integer", "enum": []int{301, 501, 701}, "title": "Start-Spiel"},
			"doubleIn":              map[string]any{"type": "boolean", "title": "Double-In"},
			"doubleOut":             map[string]any{"type": "boolean", "title": "Double-Out"},
			"orderMode":             map[string]any{"type": "string", "enum": []string{"range", "beginner"}, "title": "Spielerreihenfolge"},
			"beginnerRange":         map[string]any{"type": "integer", "minimum": 1, "title": "Beginner-Stand"},
			"autoStartWhenAllReady": map[string]any{"type": "boolean", "title": "Automatisch starten"},
		},
	}
}

type Player struct {
	RangeNum        int            `json:"rangeNum"`
	Active          bool           `json:"active"`
	ShooterName     string         `json:"shooterName"`
	Color           string         `json:"color"`
	Score           int            `json:"score"`
	CricketMarks    map[string]int `json:"cricketMarks,omitempty"`
	CricketPoints   int            `json:"cricketPoints,omitempty"`
	ClockTarget     int            `json:"clockTarget"`
	Started         bool           `json:"started"`
	Finished        bool           `json:"finished"`
	RoundStartScore int            `json:"roundStartScore"`
	RoundScore      int            `json:"roundScore"`
	OpenDarts       int            `json:"openDarts"`
	RoundDarts      []DartMark     `json:"roundDarts"`
	LastRoundScore  int            `json:"lastRoundScore"`
	LastRoundDarts  []DartMark     `json:"lastRoundDarts,omitempty"`
	LastResult      string         `json:"lastResult,omitempty"`
}

type DartMark struct {
	Index           int     `json:"index"`
	X               int     `json:"x"`
	Y               int     `json:"y"`
	Distance        float64 `json:"distance"`
	DistanceMm      float64 `json:"distanceMm"`
	Value           int     `json:"value"`
	Multiplier      int     `json:"multiplier"`
	Score           int     `json:"score"`
	Ring            string  `json:"ring"`
	Notation        string  `json:"notation"`
	Counted         bool    `json:"counted"`
	DoubleInBlocked bool    `json:"doubleInBlocked,omitempty"`
}

type GameState struct {
	GameMode           string             `json:"gameMode"`
	Phase              string             `json:"phase"`
	NumRanges          int                `json:"numRanges"`
	Config             map[string]any     `json:"config"`
	Players            map[string]*Player `json:"players"`
	Order              []int              `json:"order"`
	OrderMode          string             `json:"orderMode"`
	BeginnerRange      int                `json:"beginnerRange"`
	CurrentPos         int                `json:"currentPos"`
	ActiveRange        int                `json:"activeRange"`
	TurnPending        bool               `json:"turnPending,omitempty"`
	WinnerRange        int                `json:"winnerRange"`
	StatusLine         string             `json:"statusLine"`
	FieldOpen          bool               `json:"fieldOpen"`
	StartBlockedReason string             `json:"startBlockedReason"`
	RecentDarts        []DartMark         `json:"recentDarts"`
	BoardRange         int                `json:"boardRange"`
	BoardDarts         []DartMark         `json:"boardDarts"`
}

func (l *Logic) Init(cfg map[string]any) (logicapi.SessionState, error) {
	merged := gameutil.MergeConfig(defaultConfig(), cfg)

	gs := &GameState{
		GameMode:      gameutil.CfgString(merged, "gameMode", "x01"),
		Phase:         gameutil.PhaseWarmup,
		NumRanges:     gameutil.CfgInt(merged, "numRanges", 6),
		Config:        merged,
		Players:       map[string]*Player{},
		OrderMode:     gameutil.CfgString(merged, "orderMode", "range"),
		BeginnerRange: gameutil.CfgInt(merged, "beginnerRange", 1),
		StatusLine:    "Dart — bereit",
	}
	gs.ensure()
	return marshalState(gs)
}

func (l *Logic) OnShot(sess logicapi.SessionState, rangeNum int, shot state.Shot, shotIndex int) (logicapi.SessionState, []logicapi.PluginEvent, error) {
	return l.OnShotCtx(sess, logicapi.ShotContext{
		RangeNum: rangeNum, Shot: shot, ShotIndex: shotIndex,
		Live: logicapi.LiveRangeInfo{IsWarmup: shot.IsWarmup}, Now: time.Now(),
	})
}

func (l *Logic) OnShotCtx(sess logicapi.SessionState, ctx logicapi.ShotContext) (logicapi.SessionState, []logicapi.PluginEvent, error) {
	gs, err := unmarshalState(sess)
	if err != nil {
		return sess, nil, err
	}
	gs.ensure()

	if ctx.InactiveRanges != nil {
		gs.applyInactiveList(ctx.InactiveRanges)
	}
	p := gs.Players[strconv.Itoa(ctx.RangeNum)]
	if p != nil && ctx.Live.ShooterName != "" {
		p.ShooterName = ctx.Live.ShooterName
	}

	// The DISAG target type is the hard boundary for this game. Other target
	// types must never alter the Dart score or turn state.
	if strings.TrimSpace(ctx.Shot.DiscTypeRaw) != "fun_dart" {
		return marshalWithEvents(gs, nil)
	}

	// During warm-up / arming, show fun_dart impacts on the board but do not
	// add them to a player's round or alter any score. This preview is independent
	// of player activation because no game score is being changed.
	if gs.Phase == gameutil.PhaseWarmup || gs.Phase == gameutil.PhaseArming || ctx.Shot.IsWarmup {
		dart := classifyDart(ctx.Shot, len(gs.BoardDarts)+1, gs.Config)
		gs.BoardRange = ctx.RangeNum
		gs.BoardDarts = append(gs.BoardDarts, dart)
		if len(gs.BoardDarts) > 30 {
			gs.BoardDarts = gs.BoardDarts[len(gs.BoardDarts)-30:]
		}
		return marshalWithEvents(gs, nil)
	}

	if p == nil || !p.Active || gs.TurnPending {
		return marshalWithEvents(gs, nil)
	}
	if gs.Phase != gameutil.PhasePlaying || ctx.RangeNum != gs.ActiveRange {
		return marshalWithEvents(gs, nil)
	}

	if len(p.RoundDarts) == 0 && gs.BoardRange != ctx.RangeNum {
		gs.BoardRange = ctx.RangeNum
		gs.BoardDarts = nil
	}
	dart := classifyDart(ctx.Shot, len(p.RoundDarts)+1, gs.Config)
	p.RoundDarts = append(p.RoundDarts, dart)
	gs.BoardRange = ctx.RangeNum
	gs.BoardDarts = append([]DartMark(nil), p.RoundDarts...)
	p.OpenDarts = max(0, 3-len(p.RoundDarts))
	gs.RecentDarts = append(gs.RecentDarts, dart)
	if len(gs.RecentDarts) > 30 {
		gs.RecentDarts = gs.RecentDarts[len(gs.RecentDarts)-30:]
	}

	if gs.GameMode == "around_clock" {
		target := p.ClockTarget
		hitValue := 0
		if dart.Ring == "bullseye" || dart.Ring == "outer-bull" {
			hitValue = 21
		} else if dart.Multiplier > 0 {
			hitValue = dart.Value / dart.Multiplier
		}
		hit := (target <= 20 && hitValue == target && dart.Ring != "miss") || (target == 21 && hitValue == 21)
		if hit {
			p.ClockTarget++
		}
		events := []logicapi.PluginEvent{{Type: "dart", Data: map[string]any{"rangeNum": ctx.RangeNum, "index": dart.Index, "notation": dart.Notation, "score": 0, "ring": dart.Ring, "remaining": p.ClockTarget, "clockTarget": target, "clockHit": hit}}}
		if p.ClockTarget > 21 {
			p.OpenDarts = 0
			p.Finished = true
			gs.WinnerRange = p.RangeNum
			gs.Phase = gameutil.PhaseFinished
			gs.StatusLine = fmt.Sprintf("%s gewinnt Around the Clock!", playerLabel(p))
			events = append(events, logicapi.PluginEvent{Type: "checkout", Data: map[string]any{"rangeNum": p.RangeNum}}, logicapi.PluginEvent{Type: "match_finished", Data: map[string]any{"winnerRange": p.RangeNum}})
			return marshalWithEvents(gs, events)
		}
		if len(p.RoundDarts) >= 3 {
			p.LastResult = "Runde"
			return gs.finishTurn(events)
		}
		gs.StatusLine = fmt.Sprintf("%s: %s · Ziel %s", playerLabel(p), dart.Notation, clockTargetLabel(p.ClockTarget))
		return marshalWithEvents(gs, events)
	}

	if gs.GameMode == "cricket" {
		var events []logicapi.PluginEvent
		points, targetKey, marks := applyCricketDart(gs, p, dart)
		p.RoundScore += points
		p.CricketPoints += points
		p.RoundDarts[len(p.RoundDarts)-1] = dart
		events = append(events, logicapi.PluginEvent{Type: "dart", Data: map[string]any{"rangeNum": ctx.RangeNum, "index": dart.Index, "notation": dart.Notation, "score": points, "ring": dart.Ring, "remaining": p.CricketPoints, "cricketTarget": targetKey, "cricketMarks": marks}})
		if cricketWon(gs, p) {
			// The match-ending dart also deactivates the shooter, so no darts
			// should remain open after the game has finished.
			p.OpenDarts = 0
			p.Finished = true
			gs.WinnerRange = p.RangeNum
			gs.Phase = gameutil.PhaseFinished
			gs.StatusLine = fmt.Sprintf("%s gewinnt Cricket mit %d Punkten!", playerLabel(p), p.CricketPoints)
			events = append(events, logicapi.PluginEvent{Type: "checkout", Data: map[string]any{"rangeNum": p.RangeNum, "roundScore": p.RoundScore}}, logicapi.PluginEvent{Type: "match_finished", Data: map[string]any{"winnerRange": p.RangeNum}})
			return marshalWithEvents(gs, events)
		}
		if len(p.RoundDarts) >= 3 {
			p.LastResult = "Runde"
			return gs.finishTurn(events)
		}
		gs.StatusLine = fmt.Sprintf("%s: %s · %d Punkte", playerLabel(p), dart.Notation, p.CricketPoints)
		return marshalWithEvents(gs, events)
	}

	var events []logicapi.PluginEvent
	events = append(events, logicapi.PluginEvent{Type: "dart", Data: map[string]any{
		"rangeNum": ctx.RangeNum, "index": dart.Index, "notation": dart.Notation,
		"score": dart.Score, "ring": dart.Ring, "remaining": p.Score,
	}})

	if !p.Started {
		if dart.IsDouble() {
			p.Started = true
		} else {
			dart.DoubleInBlocked = gameutil.CfgBool(gs.Config, "doubleIn", false)
			dart.Counted = false
			p.RoundDarts[len(p.RoundDarts)-1] = dart
			gs.StatusLine = fmt.Sprintf("Stand %d: %s — Double In erforderlich", ctx.RangeNum, dart.Notation)
			return gs.finishOrContinueTurn(events)
		}
	}

	candidate := p.Score - dart.Score
	if gameutil.CfgBool(gs.Config, "doubleOut", false) {
		if candidate < 0 || candidate == 1 || (candidate == 0 && !dart.IsDouble()) {
			p.LastResult = "Bust"
			// A bust ends the turn immediately, even if fewer than three darts
			// have been thrown. Restore the score from the start of this round
			// before finalizing the turn and selecting the next player.
			p.Score = p.RoundStartScore
			gs.StatusLine = fmt.Sprintf("Stand %d: Bust — %d zurück", ctx.RangeNum, p.RoundStartScore)
			events = append(events, logicapi.PluginEvent{Type: "bust", Data: map[string]any{
				"rangeNum": ctx.RangeNum, "scoreBefore": p.RoundStartScore,
			}})
			return gs.finishTurn(events)
		}
	} else if candidate < 0 {
		p.LastResult = "Bust"
		// Bust immediately ends the round and restores its starting score.
		p.Score = p.RoundStartScore
		gs.StatusLine = fmt.Sprintf("Stand %d: Bust — %d zurück", ctx.RangeNum, p.RoundStartScore)
		events = append(events, logicapi.PluginEvent{Type: "bust", Data: map[string]any{
			"rangeNum": ctx.RangeNum, "scoreBefore": p.RoundStartScore,
		}})
		return gs.finishTurn(events)
	}

	p.Score = candidate
	dart.Counted = true
	p.RoundDarts[len(p.RoundDarts)-1] = dart
	p.RoundScore += dart.Score

	if candidate == 0 {
		// A checkout deactivates the shooter immediately; clear open darts
		// just as finishTurn does for an ordinary turn end.
		p.OpenDarts = 0
		p.Finished = true
		p.LastResult = "Checkout"
		p.LastRoundScore = p.RoundScore
		p.LastRoundDarts = append([]DartMark(nil), p.RoundDarts...)
		gs.BoardRange = p.RangeNum
		gs.BoardDarts = append([]DartMark(nil), p.RoundDarts...)
		gs.WinnerRange = p.RangeNum
		gs.Phase = gameutil.PhaseFinished
		gs.StatusLine = fmt.Sprintf("%s gewinnt mit %s!", playerLabel(p), dart.Notation)
		events = append(events,
			logicapi.PluginEvent{Type: "checkout", Data: map[string]any{"rangeNum": p.RangeNum, "notation": dart.Notation, "roundScore": p.RoundScore}},
			logicapi.PluginEvent{Type: "match_finished", Data: map[string]any{"winnerRange": p.RangeNum}},
		)
		return marshalWithEvents(gs, events)
	}

	if len(p.RoundDarts) >= 3 {
		p.LastResult = "Runde"
		return gs.finishTurn(events)
	}

	gs.StatusLine = fmt.Sprintf("%s: %s · Rest %d", playerLabel(p), dart.Notation, p.Score)
	return marshalWithEvents(gs, events)
}

func (l *Logic) Tick(sess logicapi.SessionState, now time.Time) (logicapi.SessionState, []logicapi.PluginEvent, bool, error) {
	return sess, nil, false, nil
}

func (l *Logic) Control(sess logicapi.SessionState, action string, params map[string]any) (logicapi.SessionState, []logicapi.PluginEvent, error) {
	gs, err := unmarshalState(sess)
	if err != nil {
		return sess, nil, err
	}
	gs.ensure()

	switch action {
	case "set_game_mode":
		if v, ok := params["gameMode"].(string); ok && (v == "x01" || v == "cricket" || v == "around_clock") {
			gs.GameMode = v
			gs.Config["gameMode"] = v
		}
	case "sync_live":
		gs.applyLive(params)
		if gs.Phase == gameutil.PhaseWarmup {
			gs.Phase = gameutil.PhaseArming
			gs.StatusLine = "Dart — Start wählen"
		}
		if gameutil.CfgBool(gs.Config, "autoStartWhenAllReady", false) && gs.Phase == gameutil.PhaseArming {
			return gs.startFromParams(params)
		}
	case "start":
		gs.applyLive(params)
		return gs.startFromParams(params)
	case "next_turn":
		if gs.TurnPending {
			return gs.advanceTurn(nil)
		}
	case "reset":
		resetCfg := gameutil.MergeConfig(map[string]any{}, gs.Config)
		resetCfg["doubleIn"] = false
		resetCfg["doubleOut"] = false

		fresh, err := l.Init(resetCfg)
		if err != nil {
			return sess, nil, err
		}
		gs2, err := unmarshalState(fresh)
		if err != nil {
			return sess, nil, err
		}
		gs2.NumRanges = gs.NumRanges
		gs2.ensure()
		return marshalWithEvents(gs2, []logicapi.PluginEvent{{Type: "reset"}})
	default:
		return sess, nil, fmt.Errorf("unknown darts action %q", action)
	}
	return marshalWithEvents(gs, nil)
}

func (l *Logic) ViewModel(sess logicapi.SessionState, rangeNum int) (map[string]any, error) {
	gs, err := unmarshalState(sess)
	if err != nil {
		return nil, err
	}
	gs.ensure()

	players := make([]map[string]any, 0, gs.NumRanges)
	for i := 1; i <= gs.NumRanges; i++ {
		p := gs.Players[strconv.Itoa(i)]
		if p == nil {
			continue
		}
		players = append(players, playerVM(p, gs))
	}
	return map[string]any{
		"pluginId": l.ID(),
		"kind":     "game",
		"mode":     "shared",
		"label":    l.Label(),
		"rangeNum": rangeNum,
		"game": map[string]any{
			"phase":              gs.Phase,
			"gameMode":           gs.GameMode,
			"clockTargetOrder":   append([]int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21}, []int{}...),
			"cricketTargets":     []string{"20", "19", "18", "17", "16", "15", "B"},
			"statusLine":         gs.StatusLine,
			"startBlockedReason": gs.StartBlockedReason,
			"startingScore":      gameutil.CfgInt(gs.Config, "startingScore", 501),
			"doubleIn":           gameutil.CfgBool(gs.Config, "doubleIn", false),
			"doubleOut":          gameutil.CfgBool(gs.Config, "doubleOut", false),
			"orderMode":          gs.OrderMode,
			"beginnerRange":      gs.BeginnerRange,
			"order":              gs.Order,
			"activeRange":        gs.ActiveRange,
			"winnerRange":        gs.WinnerRange,
			"players":            players,
			"recentDarts":        recentDartVM(gs.RecentDarts),
			"boardRange":         gs.BoardRange,
			"boardDarts":         recentDartVM(gs.BoardDarts),
		},
		"me": playerVM(gs.Players[strconv.Itoa(rangeNum)], gs),
	}, nil
}

func playerVM(p *Player, gs *GameState) map[string]any {
	if p == nil {
		return nil
	}
	return map[string]any{
		"rangeNum":       p.RangeNum,
		"active":         p.Active,
		"activeTurn":     p.RangeNum == gs.ActiveRange && gs.Phase == gameutil.PhasePlaying,
		"shooterName":    p.ShooterName,
		"label":          playerLabel(p),
		"color":          p.Color,
		"score":          p.Score,
		"cricketMarks":   p.CricketMarks,
		"cricketPoints":  p.CricketPoints,
		"clockTarget":    p.ClockTarget,
		"started":        p.Started,
		"finished":       p.Finished,
		"roundScore":     p.RoundScore,
		"openDarts":      p.OpenDarts,
		"roundDarts":     recentDartVM(p.RoundDarts),
		"lastRoundScore": p.LastRoundScore,
		"lastResult":     p.LastResult,
	}
}

func recentDartVM(in []DartMark) []map[string]any {
	out := make([]map[string]any, 0, len(in))
	for _, d := range in {
		out = append(out, map[string]any{
			"index": d.Index, "x": d.X, "y": d.Y, "distance": d.Distance,
			"distanceMm": d.DistanceMm, "value": d.Value, "multiplier": d.Multiplier,
			"score": d.Score, "ring": d.Ring, "notation": d.Notation,
			"counted": d.Counted, "doubleInBlocked": d.DoubleInBlocked,
		})
	}
	return out
}

func (gs *GameState) startFromParams(params map[string]any) (logicapi.SessionState, []logicapi.PluginEvent, error) {
	if v, ok := params["gameMode"].(string); ok && (v == "x01" || v == "cricket" || v == "around_clock") {
		gs.GameMode = v
		gs.Config["gameMode"] = v
	}
	if v, ok := params["startingScore"]; ok {
		gs.Config["startingScore"] = gameutil.CfgInt(map[string]any{"v": v}, "v", gameutil.CfgInt(gs.Config, "startingScore", 501))
	}
	if v, ok := params["doubleIn"].(bool); ok {
		gs.Config["doubleIn"] = v
	}
	if v, ok := params["doubleOut"].(bool); ok {
		gs.Config["doubleOut"] = v
	}
	if v, ok := params["orderMode"].(string); ok && (v == "range" || v == "beginner") {
		gs.OrderMode = v
	}
	if v, ok := params["beginnerRange"]; ok {
		gs.BeginnerRange = gameutil.CfgInt(map[string]any{"v": v}, "v", gs.BeginnerRange)
	}
	gs.Config["orderMode"] = gs.OrderMode
	gs.Config["beginnerRange"] = gs.BeginnerRange

	order := gs.activeOrder()
	if len(order) == 0 {
		return nil, nil, fmt.Errorf("keine aktiven Stände für das Dartspiel")
	}
	if gs.OrderMode == "beginner" {
		idx := sort.SearchInts(order, gs.BeginnerRange)
		if idx >= len(order) || order[idx] != gs.BeginnerRange {
			return nil, nil, fmt.Errorf("Beginner-Stand %d ist nicht aktiv", gs.BeginnerRange)
		}
		rotated := append([]int{}, order[idx:]...)
		rotated = append(rotated, order[:idx]...)
		order = rotated
	}

	target := gameutil.CfgInt(gs.Config, "startingScore", 501)
	if gs.GameMode == "cricket" || gs.GameMode == "around_clock" {
		target = 0
	}
	if gs.GameMode != "cricket" && gs.GameMode != "around_clock" && target != 301 && target != 501 && target != 701 {
		return nil, nil, fmt.Errorf("ungültiger Startwert %d", target)
	}

	gs.Phase = gameutil.PhasePlaying
	gs.FieldOpen = true
	gs.Order = order
	gs.CurrentPos = 0
	gs.ActiveRange = order[0]
	gs.TurnPending = false
	gs.WinnerRange = 0
	gs.StartBlockedReason = ""
	gs.RecentDarts = nil
	gs.BoardRange = gs.ActiveRange
	gs.BoardDarts = nil
	if gs.GameMode == "cricket" {
		gs.StatusLine = fmt.Sprintf("Dart Standard Cricket — %s beginnt", playerLabel(gs.Players[strconv.Itoa(gs.ActiveRange)]))
	} else if gs.GameMode == "around_clock" {
		gs.StatusLine = fmt.Sprintf("Around the Clock — %s beginnt (Ziel 1)", playerLabel(gs.Players[strconv.Itoa(gs.ActiveRange)]))
	} else {
		gs.StatusLine = fmt.Sprintf("Dart %d — %s beginnt", target, playerLabel(gs.Players[strconv.Itoa(gs.ActiveRange)]))
	}

	for i := 1; i <= gs.NumRanges; i++ {
		p := gs.Players[strconv.Itoa(i)]
		if p == nil {
			continue
		}
		p.Finished = false
		p.Started = !gameutil.CfgBool(gs.Config, "doubleIn", false)
		p.Score = target
		p.CricketPoints = 0
		p.ClockTarget = 1
		p.CricketMarks = map[string]int{"20": 0, "19": 0, "18": 0, "17": 0, "16": 0, "15": 0, "B": 0}
		p.RoundStartScore = target
		p.RoundScore = 0
		p.OpenDarts = 3
		p.RoundDarts = nil
		p.LastRoundScore = 0
		p.LastRoundDarts = nil
		p.LastResult = ""
	}
	return marshalWithEvents(gs, []logicapi.PluginEvent{{
		Type: "match_start",
		Data: map[string]any{"startingScore": target, "activeRange": gs.ActiveRange, "order": gs.Order},
	}})
}

func (gs *GameState) finishOrContinueTurn(events []logicapi.PluginEvent) (logicapi.SessionState, []logicapi.PluginEvent, error) {
	if p := gs.Players[strconv.Itoa(gs.ActiveRange)]; p != nil && len(p.RoundDarts) >= 3 {
		return gs.finishTurn(events)
	}
	return marshalWithEvents(gs, events)
}

func (gs *GameState) finishTurn(events []logicapi.PluginEvent) (logicapi.SessionState, []logicapi.PluginEvent, error) {
	p := gs.Players[strconv.Itoa(gs.ActiveRange)]
	if p == nil {
		return marshalWithEvents(gs, events)
	}
	p.LastRoundScore = p.RoundScore
	p.LastRoundDarts = append([]DartMark(nil), p.RoundDarts...)
	if p.LastResult == "" {
		p.LastResult = "Runde"
	}
	if p.LastResult == "Bust" {
		p.Score = p.RoundStartScore
	}

	events = append(events, logicapi.PluginEvent{Type: "turn_end", Data: map[string]any{
		"rangeNum": p.RangeNum, "roundScore": p.RoundScore, "remaining": p.Score, "result": p.LastResult,
	}})
	gs.BoardRange = p.RangeNum
	gs.BoardDarts = append([]DartMark(nil), p.RoundDarts...)
	// Keep the hit display visible while the turn is inactive and the audio
	// sequence is playing, but no throws remain once the shooter is deactivated.
	// The hit display and counter are initialized for the next round in advanceTurn.
	p.OpenDarts = 0
	p.RoundStartScore = p.Score

	// Deactivate the current turn immediately. The frontend plays the complete
	// audio sequence and then calls Control("next_turn") to activate the next player.
	if p.Finished || gs.Phase == gameutil.PhaseFinished || len(gs.Order) == 0 {
		gs.ActiveRange = 0
		gs.TurnPending = false
		return marshalWithEvents(gs, events)
	}
	gs.ActiveRange = 0
	gs.TurnPending = true
	// Keep the completed turn's result in the header until advanceTurn activates
	// the next player. Use the final score after all three darts, not the status
	// line from the previous dart.
	if gs.GameMode != "cricket" {
		lastNotation := ""
		if len(p.LastRoundDarts) > 0 {
			lastNotation = p.LastRoundDarts[len(p.LastRoundDarts)-1].Notation
		}
		if p.LastResult == "Bust" {
			gs.StatusLine = fmt.Sprintf("%s: %s · Rest %d (Bust)", playerLabel(p), lastNotation, p.Score)
		} else {
			gs.StatusLine = fmt.Sprintf("%s: %s · Rest %d", playerLabel(p), lastNotation, p.Score)
		}
	} else {
		lastNotation := ""
		if len(p.LastRoundDarts) > 0 {
			lastNotation = p.LastRoundDarts[len(p.LastRoundDarts)-1].Notation
		} else if len(p.RoundDarts) > 0 {
			lastNotation = p.RoundDarts[len(p.RoundDarts)-1].Notation
		}
		gs.StatusLine = fmt.Sprintf("%s: %s · %d Punkte", playerLabel(p), lastNotation, p.CricketPoints)
	}
	return marshalWithEvents(gs, events)
}

func (gs *GameState) advanceTurn(events []logicapi.PluginEvent) (logicapi.SessionState, []logicapi.PluginEvent, error) {
	if !gs.TurnPending || len(gs.Order) == 0 {
		return marshalWithEvents(gs, events)
	}
	for step := 1; step <= len(gs.Order); step++ {
		pos := (gs.CurrentPos + step) % len(gs.Order)
		rn := gs.Order[pos]
		next := gs.Players[strconv.Itoa(rn)]
		if next == nil || !next.Active || next.Finished {
			continue
		}
		gs.CurrentPos = pos
		gs.ActiveRange = rn
		gs.TurnPending = false
		next.RoundStartScore = next.Score
		next.RoundScore = 0
		next.OpenDarts = 3
		next.RoundDarts = nil
		gs.StatusLine = fmt.Sprintf("%s ist dran", playerLabel(next))
		events = append(events, logicapi.PluginEvent{Type: "turn_start", Data: map[string]any{"rangeNum": rn}})
		return marshalWithEvents(gs, events)
	}
	gs.TurnPending = false
	return marshalWithEvents(gs, events)
}

var cricketTargetOrder = []string{"20", "19", "18", "17", "16", "15", "B"}

func applyCricketDart(gs *GameState, p *Player, d DartMark) (int, string, int) {
	if p.CricketMarks == nil {
		p.CricketMarks = map[string]int{}
	}
	key, hits := "", 0
	if d.Ring == "bullseye" {
		key, hits = "B", 2
	} else if d.Ring == "outer-bull" {
		key, hits = "B", 1
	} else if d.Value > 0 {
		mult := max(1, d.Multiplier)
		value := d.Value / mult
		if d.Value%mult == 0 && value >= 15 && value <= 20 {
			key, hits = strconv.Itoa(value), mult
		}
	}
	if key == "" {
		return 0, "", 0
	}
	before := p.CricketMarks[key]
	remaining := max(0, 3-before)
	counted := minInt(hits, remaining)
	p.CricketMarks[key] = minInt(3, before+hits)
	points := 0
	if hits > remaining && opponentsOpen(gs, p.RangeNum, key) {
		points = (hits - remaining) * cricketValue(key)
	}
	return points, key, counted
}
func opponentsOpen(gs *GameState, rangeNum int, key string) bool {
	for _, other := range gs.Players {
		if other != nil && other.Active && other.RangeNum != rangeNum && other.CricketMarks[key] < 3 {
			return true
		}
	}
	return false
}
func clockTargetLabel(target int) string {
	if target == 21 {
		return "Bullseye"
	}
	if target > 21 {
		return "fertig"
	}
	return strconv.Itoa(target)
}

func cricketValue(key string) int {
	if key == "B" {
		return 25
	}
	n, _ := strconv.Atoi(key)
	return n
}
func cricketWon(gs *GameState, p *Player) bool {
	for _, key := range cricketTargetOrder {
		if p.CricketMarks[key] < 3 {
			return false
		}
	}
	for _, other := range gs.Players {
		if other != nil && other.Active && other.RangeNum != p.RangeNum && p.CricketPoints < other.CricketPoints {
			return false
		}
	}
	return true
}
func cricketProgress(p *Player) string {
	parts := make([]string, 0, len(cricketTargetOrder))
	for _, key := range cricketTargetOrder {
		marks := p.CricketMarks[key]
		if marks > 3 {
			marks = 3
		}
		parts = append(parts, key+":"+strings.Repeat("/", marks)+strings.Repeat("·", 3-marks))
	}
	return strings.Join(parts, " ")
}
func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func classifyDart(shot state.Shot, index int, cfg map[string]any) DartMark {
	units := gameutil.CfgFloat(cfg, "distanceUnitsPerMm", 100)
	if units <= 0 {
		units = 100
	}

	distMm := shot.Distance / units
	fullValue := shot.FullValue

	d := DartMark{
		Index:      index,
		X:          shot.X,
		Y:          shot.Y,
		Distance:   shot.Distance,
		DistanceMm: distMm,
		Value:      fullValue,
		Multiplier: 1,
		Ring:       "miss",
		Notation:   "MISS",
		Score:      0,
	}

	boardRadius := gameutil.CfgFloat(cfg, "boardRadiusMm", 70.5)
	bull := gameutil.CfgFloat(cfg, "bullRadiusMm", 5.47)
	outerBull := gameutil.CfgFloat(cfg, "outerBullRadiusMm", 9.57)
	tripleInner := gameutil.CfgFloat(cfg, "tripleInnerRadiusMm", 36.0)
	tripleOuter := gameutil.CfgFloat(cfg, "tripleOuterRadiusMm", 43.6)
	doubleInner := gameutil.CfgFloat(cfg, "doubleInnerRadiusMm", 62.7)
	doubleOuter := gameutil.CfgFloat(cfg, "doubleOuterRadiusMm", 70)

	if fullValue == 50 && distMm <= bull {
		d.Ring = "bullseye"
		d.Multiplier = 2
		d.Score = 50
		d.Notation = "BULL"
		return d
	}

	if fullValue == 25 && distMm <= outerBull {
		d.Ring = "outer-bull"
		d.Multiplier = 1
		d.Score = 25
		d.Notation = "25"
		return d
	}

	if fullValue < 1 || fullValue > 60 || distMm > boardRadius {
		return d
	}

	switch {
	case distMm >= tripleInner && distMm <= tripleOuter:
		d.Ring = "triple"
		d.Multiplier = 3

	case distMm >= doubleInner && distMm <= doubleOuter:
		d.Ring = "double"
		d.Multiplier = 2

	default:
		d.Ring = "single"
		d.Multiplier = 1
	}

	// OpticScore liefert FullValue bereits als fertigen Punktwert.
	d.Score = fullValue

	// Segmentnummer für die Notation zurückrechnen.
	segmentValue := fullValue / d.Multiplier

	if fullValue%d.Multiplier != 0 ||
		segmentValue < 1 ||
		segmentValue > 20 {

		d.Ring = "miss"
		d.Multiplier = 1
		d.Score = 0
		d.Notation = "MISS"

		return d
	}

	switch d.Multiplier {
	case 3:
		d.Notation = "T" + strconv.Itoa(segmentValue)
	case 2:
		d.Notation = "D" + strconv.Itoa(segmentValue)
	default:
		d.Notation = "S" + strconv.Itoa(segmentValue)
	}

	return d
}

func (d DartMark) IsDouble() bool {
	return d.Ring == "double" || d.Ring == "bullseye"
}

func playerLabel(p *Player) string {
	if p != nil && strings.TrimSpace(p.ShooterName) != "" {
		return p.ShooterName
	}
	if p != nil {
		return "Stand " + strconv.Itoa(p.RangeNum)
	}
	return "Stand"
}

func (gs *GameState) activeOrder() []int {
	out := make([]int, 0, gs.NumRanges)
	for i := 1; i <= gs.NumRanges; i++ {
		p := gs.Players[strconv.Itoa(i)]
		if p != nil && p.Active {
			out = append(out, i)
		}
	}
	return out
}

func (gs *GameState) ensure() {
	if gs.Config == nil {
		gs.Config = defaultConfig()
	}
	if gs.GameMode == "" {
		gs.GameMode = gameutil.CfgString(gs.Config, "gameMode", "x01")
	}
	if gs.GameMode != "cricket" && gs.GameMode != "around_clock" {
		gs.GameMode = "x01"
	}
	if gs.NumRanges < 1 {
		gs.NumRanges = 6
	}
	if gs.Players == nil {
		gs.Players = map[string]*Player{}
	}
	if gs.OrderMode == "" {
		gs.OrderMode = gameutil.CfgString(gs.Config, "orderMode", "range")
	}
	if gs.BeginnerRange < 1 {
		gs.BeginnerRange = gameutil.CfgInt(gs.Config, "beginnerRange", 1)
	}
	for i := 1; i <= gs.NumRanges; i++ {
		k := strconv.Itoa(i)
		if gs.Players[k] == nil {
			gs.Players[k] = &Player{RangeNum: i, Active: true, Color: gameutil.LaneColor(i), OpenDarts: 3}
		}
		p := gs.Players[k]
		if p.Color == "" {
			p.Color = gameutil.LaneColor(i)
		}
		if p.OpenDarts < 0 || p.OpenDarts > 3 {
			p.OpenDarts = 3
		}
	}
}

func (gs *GameState) applyLive(params map[string]any) {
	if params == nil {
		return
	}
	if n, ok := params["numRanges"]; ok {
		gs.NumRanges = gameutil.CfgInt(map[string]any{"n": n}, "n", gs.NumRanges)
		gs.ensure()
	}
	gs.applyMembership(params)
	live, _ := params["live"].(map[string]any)
	for k, raw := range live {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		rn, _ := strconv.Atoi(k)
		if rn < 1 {
			continue
		}
		p := gs.Players[strconv.Itoa(rn)]
		if p == nil {
			p = &Player{RangeNum: rn, Active: true, Color: gameutil.LaneColor(rn), OpenDarts: 3}
			gs.Players[strconv.Itoa(rn)] = p
		}
		if name, ok := m["shooterName"].(string); ok && name != "" {
			p.ShooterName = name
		}
		p.Active = gameutil.LiveActive(m, p.Active)
	}
}

func (gs *GameState) applyMembership(params map[string]any) {
	skip, ok := gameutil.InactiveSetFromParams(params)
	if !ok {
		return
	}
	for i := 1; i <= gs.NumRanges; i++ {
		if p := gs.Players[strconv.Itoa(i)]; p != nil {
			p.Active = !skip[i]
		}
	}
}

func (gs *GameState) applyInactiveList(nums []int) {
	gs.applyInactiveListFromSet(gameutil.IntSet(nums))
}

func (gs *GameState) applyInactiveListFromSet(skip map[int]bool) {
	for i := 1; i <= gs.NumRanges; i++ {
		if p := gs.Players[strconv.Itoa(i)]; p != nil {
			p.Active = !skip[i]
		}
	}
}

func marshalState(gs *GameState) (logicapi.SessionState, error) {
	b, err := json.Marshal(gs)
	if err != nil {
		return nil, err
	}
	return logicapi.SessionState(b), nil
}

func unmarshalState(sess logicapi.SessionState) (*GameState, error) {
	var gs GameState
	if len(sess) == 0 {
		return &GameState{Players: map[string]*Player{}, Config: defaultConfig()}, nil
	}
	if err := json.Unmarshal(sess, &gs); err != nil {
		return nil, err
	}
	gs.ensure()
	return &gs, nil
}

func marshalWithEvents(gs *GameState, events []logicapi.PluginEvent) (logicapi.SessionState, []logicapi.PluginEvent, error) {
	st, err := marshalState(gs)
	return st, events, err
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

var _ logicapi.ExtendedLogic = (*Logic)(nil)
