package udp

import (
	"testing"

	"srdashboard/state"
)

func TestValidateShotAcceptsPlacedLG(t *testing.T) {
	x, y, d := PlaceShot(10.3, 4)
	sp := &state.ShotPayload{X: x, Y: y, Distance: d, FullValue: 10, DecValue: 10.3}
	if err := ValidateShot(sp); err != nil {
		t.Fatalf("placed 10.3 rejected: %v (X=%d Y=%d D=%.1f)", err, x, y, d)
	}
}

func TestValidateShotRejectsScoreHoleMismatch(t *testing.T) {
	// 10.3 in the 7-ring (the UI-regression artefact).
	sp := &state.ShotPayload{X: 800, Y: -200, Distance: 0.2, FullValue: 10, DecValue: 10.3}
	if err := ValidateShot(sp); err == nil {
		t.Fatal("expected reject: 10.3 with 7-ring coordinates")
	}
}

func TestValidateShotRejectsFullValueMismatch(t *testing.T) {
	x, y, d := PlaceShot(8.2, 1)
	sp := &state.ShotPayload{X: x, Y: y, Distance: d, FullValue: 10, DecValue: 8.2}
	if err := ValidateShot(sp); err == nil {
		t.Fatal("expected reject: FullValue 10 with DecValue 8.2")
	}
}

func TestValidateShotRejectsHypotMismatch(t *testing.T) {
	sp := &state.ShotPayload{X: 0, Y: 160, Distance: 0.2, FullValue: 10, DecValue: 10.3}
	if err := ValidateShot(sp); err == nil {
		t.Fatal("expected reject: Distance 0.2 vs hypot 160")
	}
}

func TestValidateShotAllowsIntegerRounding(t *testing.T) {
	// Distance rounded to 0.1, hypot of ints may differ by < 1.5 DSG.
	sp := &state.ShotPayload{X: 150, Y: 40, Distance: 155.2, FullValue: 10, DecValue: 10.3}
	hyp := 155.2417
	if abs(hyp-155.2) > distRoundSlack {
		t.Fatalf("fixture hypot slack: %v", hyp-155.2)
	}
	if err := ValidateShot(sp); err != nil {
		t.Fatal(err)
	}
}

func TestValidateShotAcceptsRealOpticScoreKK(t *testing.T) {
	// From exampledata/KK-10-Schuss.txt — 10.3 with hole at hypot 542.
	sp := &state.ShotPayload{
		X: -274, Y: 468, Distance: 542.3, FullValue: 10, DecValue: 10.3,
		DiscType: "KK", DiscTypeRaw: "kk",
	}
	if err := ValidateShot(sp); err != nil {
		t.Fatal(err)
	}
}

func TestValidateShotAcceptsLPBand(t *testing.T) {
	x, y, d := PlaceShotForDisc("LP", 10.3, 3)
	sp := &state.ShotPayload{
		X: x, Y: y, Distance: d, FullValue: 10, DecValue: 10.3,
		DiscType: "LP",
	}
	if err := ValidateShot(sp); err != nil {
		t.Fatalf("LP 10.3 rejected: %v (X=%d Y=%d D=%.1f)", err, x, y, d)
	}
}

func TestValidateShotRejectsZeroAtCentre(t *testing.T) {
	sp := &state.ShotPayload{X: 0, Y: 0, Distance: 0, FullValue: 0, DecValue: 0}
	if err := ValidateShot(sp); err == nil {
		t.Fatal("a 0.0 at the bullseye is a 10.9, not a miss")
	}
}

func TestValidateShotAcceptsFunDartBullseye(t *testing.T) {
	sp := &state.ShotPayload{
		X:           0,
		Y:           0,
		Distance:    0,
		FullValue:   50,
		DecValue:    50.0,
		DiscTypeRaw: "fun_dart",
	}
	if err := ValidateShot(sp); err != nil {
		t.Fatalf("fun_dart bullseye rejected: %v", err)
	}
}

func TestValidateShotStillRejects50OnNormalDisc(t *testing.T) {
	sp := &state.ShotPayload{
		X:         0,
		Y:         0,
		Distance:  0,
		FullValue: 50,
		DecValue:  50.0,
	}
	if err := ValidateShot(sp); err == nil {
		t.Fatal("normal shooting disc must still reject DecValue 50.0")
	}
}
func TestValidateShotAccepts10_9Centre(t *testing.T) {
	sp := &state.ShotPayload{X: 0, Y: 0, Distance: 0, FullValue: 10, DecValue: 10.9}
	if err := ValidateShot(sp); err != nil {
		t.Fatal(err)
	}
}

func TestIngestReplayDropsInconsistentAndKeepsValid(t *testing.T) {
	st := state.NewLiveState(1)
	n := 0
	p := Pipeline{State: st, OnShot: func(int, state.Shot, int) { n++ }}
	if p.IngestReplay([]byte(
		`{"MessageType":"Event","MessageVerb":"Shot","Ranges":1,"Objects":[{"X":800,"Y":0,"Distance":0.2,"FullValue":10,"DecValue":10.3,"Range":1}]}`)) != 0 {
		t.Fatal("inconsistent shot applied via IngestReplay")
	}
	if n != 0 || len(st.Snapshot()[0].Shots) != 0 {
		t.Fatalf("inconsistent shot leaked: notify=%d shots=%d", n, len(st.Snapshot()[0].Shots))
	}
	x, y, d := PlaceShot(10.3, 2)
	data, err := BuildShotPacket(ShotPacketOpts{Range: 1, X: x, Y: y, Distance: d, DecValue: 10.3})
	if err != nil {
		t.Fatal(err)
	}
	if p.IngestReplay(data) != 1 {
		t.Fatal("valid shot dropped by IngestReplay")
	}
	if n != 1 {
		t.Fatalf("IngestReplay must call OnShot, notify=%d", n)
	}
	if len(st.Snapshot()[0].Shots) != 1 {
		t.Fatalf("valid replay shot missing, shots=%d", len(st.Snapshot()[0].Shots))
	}
}

func TestIngestDropsInconsistentAndKeepsValid(t *testing.T) {
	st := state.NewLiveState(1)
	n := 0
	IngestPacket(st, func(int, state.Shot, int) { n++ }, []byte(
		`{"MessageType":"Event","MessageVerb":"Shot","Ranges":1,"Objects":[{"X":800,"Y":0,"Distance":0.2,"FullValue":10,"DecValue":10.3,"Range":1}]}`))
	if n != 0 || len(st.Snapshot()[0].Shots) != 0 {
		t.Fatalf("inconsistent shot leaked: notify=%d shots=%d", n, len(st.Snapshot()[0].Shots))
	}
	x, y, d := PlaceShot(10.3, 2)
	data, err := BuildShotPacket(ShotPacketOpts{Range: 1, X: x, Y: y, Distance: d, DecValue: 10.3})
	if err != nil {
		t.Fatal(err)
	}
	IngestPacket(st, func(int, state.Shot, int) { n++ }, data)
	if n != 1 || len(st.Snapshot()[0].Shots) != 1 {
		t.Fatalf("valid shot dropped: notify=%d shots=%d", n, len(st.Snapshot()[0].Shots))
	}
}

func abs(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}
