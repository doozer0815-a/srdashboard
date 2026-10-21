package udp

import (
	"encoding/json"
	"math"
	"net"
	"strings"
	"time"

	"srdashboard/state"
)

// ShotPacketOpts describes one synthetic OpticScore Shot UDP payload.
type ShotPacketOpts struct {
	Range     int
	X         int
	Y         int
	Distance  float64
	DecValue  float64
	FullValue int
	IsWarmup  bool
	Shooter   string
	Lastname  string
	Club      string
	Team      string
	ShotAt    time.Time // zero → omit ShotDateTime (server uses receive time)
	MenuItem  string
	DiscType  string // LG / LP / KK; empty → LG for synthetic packets
}

// BuildShotPacket returns JSON bytes for a DISAG Event/Shot message.
func BuildShotPacket(opts ShotPacketOpts) ([]byte, error) {
	rng := opts.Range
	if rng <= 0 {
		rng = 1
	}

	x, y, dist := opts.X, opts.Y, opts.Distance
	if dist == 0 {
		dist = math.Hypot(float64(x), float64(y))
	}

	disc := opts.DiscType
	if disc == "" {
		disc = "LG"
	}

	fullValue := FullValueOf(opts.DecValue)
	if strings.EqualFold(strings.TrimSpace(disc), "fun_dart") && opts.FullValue >= 0 {
		fullValue = opts.FullValue
	}

	probe := &state.ShotPayload{
		X:         x,
		Y:         y,
		Distance:  dist,
		FullValue: fullValue,
		DecValue:  opts.DecValue,
		DiscType:  disc,
	}

	if err := ValidateShot(probe); err != nil {
		x, y, dist = PlaceShotForDisc(disc, opts.DecValue, opts.Range)
	}

	obj := map[string]any{
		"X":           x,
		"Y":           y,
		"Distance":    dist,
		"FullValue":   fullValue,
		"DecValue":    opts.DecValue,
		"Range":       rng,
		"IsWarmup":    opts.IsWarmup,
		"IsHot":       !opts.IsWarmup,
		"DiscType":    disc,
		"DiscTypeRaw": disc,
	}

	if !opts.ShotAt.IsZero() {
		obj["ShotDateTime"] = state.FormatOpticScoreTime(opts.ShotAt)
	}

	if opts.Shooter != "" || opts.Lastname != "" || opts.Club != "" || opts.Team != "" {
		sh := map[string]any{
			"Firstname": opts.Shooter,
			"Lastname":  opts.Lastname,
		}

		if opts.Club != "" {
			sh["Club"] = map[string]any{"Name": opts.Club}
		}

		if opts.Team != "" {
			sh["Team"] = map[string]any{"Name": opts.Team}
		}

		obj["Shooter"] = sh
	}

	if opts.MenuItem != "" {
		obj["MenuItem"] = map[string]any{
			"MenuItemName": opts.MenuItem,
		}
	}

	msg := map[string]any{
		"MessageType": "Event",
		"MessageVerb": "Shot",
		"Ranges":      rng,
		"Objects":     []any{obj},
	}

	return json.Marshal(msg)
}

// SendShotPacket dials UDP and sends one shot packet.
func SendShotPacket(addr string, opts ShotPacketOpts) error {
	data, err := BuildShotPacket(opts)
	if err != nil {
		return err
	}
	return SendRawPacket(addr, data)
}

// SendRawPacket sends pre-built JSON to a UDP host:port (e.g. "127.0.0.1:30169").
func SendRawPacket(addr string, data []byte) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	udpAddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(host, port))
	if err != nil {
		return err
	}
	conn, err := net.DialUDP("udp", nil, udpAddr)
	if err != nil {
		return err
	}
	defer conn.Close()
	_, err = conn.Write(data)
	return err
}
