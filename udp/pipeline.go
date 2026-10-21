package udp

import (
	"log"
	"time"

	"srdashboard/state"
)

// ShotFilter decides whether a resolved range number may be applied.
type ShotFilter interface {
	AllowShot(rng int) bool
}

// DiscTypeShotFilter optionally rejects target types before they enter live
// state. Implementations can use the plugin assigned to a range to decide
// whether a target type belongs to the active game.
type DiscTypeShotFilter interface {
	AllowDiscTypeShot(rng int, discTypeRaw string, discType string) bool
}

// Pipeline is the shot path after the UDP socket: decode, validate, apply, notify.
// Live OpticScore and every synthetic injector must go through Ingest.
type Pipeline struct {
	State  *state.LiveState
	OnShot ShotNotifier
	Filter ShotFilter
}

// Ingest handles one OpticScore Event/Shot datagram (same as the listener read loop).
// It returns the number of shots applied to live state.
func (p *Pipeline) Ingest(data []byte) int {
	return p.ingest(data, true)
}

// IngestReplay is the same decode → filter → ValidateShot → ApplyShotAt → OnShot
// path as Ingest. Diagnostic logs for ignored envelopes are skipped so a pasted
// log can be applied in bulk; the recovery handler broadcasts once at the end.
func (p *Pipeline) IngestReplay(data []byte) int {
	return p.ingest(data, false)
}

func (p *Pipeline) ingest(data []byte, verbose bool) int {
	if p == nil || p.State == nil {
		return 0
	}
	var msg Message
	if err := decodeOpticScoreJSON(data, &msg); err != nil {
		if verbose {
			log.Printf("UDP: invalid JSON (len=%d): %v", len(data), err)
		}
		return 0
	}
	if msg.MessageType != "Event" || msg.MessageVerb != "Shot" {
		if verbose {
			log.Printf("UDP: ignored message MessageType=%q MessageVerb=%q (expected Event/Shot)", msg.MessageType, msg.MessageVerb)
		}
		return 0
	}
	if len(msg.Objects) == 0 {
		if verbose {
			log.Printf("UDP: Shot message has no Objects")
		}
		return 0
	}
	receivedAt := time.Now()
	applied := 0
	for oi, raw := range msg.Objects {
		var shot state.ShotPayload
		if err := decodeOpticScoreJSON(raw, &shot); err != nil {
			if verbose {
				log.Printf("UDP: failed to parse shot object[%d]: %v", oi, err)
			}
			continue
		}
		// Keep the incoming DiscTypeRaw distinct until the target filter has
		// decided whether the raw identifier itself is acceptable. In particular,
		// Darts must not accept a missing raw ID just because DiscType says fun_dart.
		if shot.Shooter != nil {
			warnIfReplacementInName(shot.Shooter.Firstname, shot.Shooter.Lastname)
		}
		rng := shot.Range
		if rng == 0 {
			rng = msg.Ranges
		}
		if rng == 0 {
			rng = 1
		}
		if p.Filter != nil && !p.Filter.AllowShot(rng) {
			if verbose {
				log.Printf("UDP: dropped shot for unconfigured or inactive range=%d", rng)
			}
			continue
		}
		if filter, ok := p.Filter.(DiscTypeShotFilter); ok && !filter.AllowDiscTypeShot(rng, shot.DiscTypeRaw, shot.DiscType) {
			if verbose {
				log.Printf("UDP: dropped disc type %q for range=%d (not accepted by active plugin)", shot.DiscTypeRaw, rng)
			}
			continue
		}
		// Legacy/normal targets may omit DiscTypeRaw. After the policy gate, use
		// DiscType as a display/logic fallback without losing the raw-ID distinction.
		if shot.DiscTypeRaw == "" {
			shot.DiscTypeRaw = shot.DiscType
		}
		if err := ValidateShot(&shot); err != nil {
			log.Printf("UDP: dropped inconsistent shot range=%d X=%d Y=%d Distance=%.1f FullValue=%d DecValue=%.1f: %v",
				rng, shot.X, shot.Y, shot.Distance, shot.FullValue, shot.DecValue, err)
			continue
		}
		shotAt, hasShotAt := shot.EventTime()
		if !hasShotAt {
			shotAt, hasShotAt = msg.EventTime()
		}
		applyReceived := receivedAt
		if !verbose && hasShotAt && !shotAt.IsZero() {
			applyReceived = shotAt
		}
		if !p.State.ApplyShotAt(rng, &shot, shotAt, applyReceived) {
			if verbose {
				log.Printf("UDP: dropped shot for unknown range=%d (check <ranges> in config.xml)", rng)
			}
			continue
		}
		applied++
		if verbose {
			log.Printf("UDP: shot applied range=%d X=%d Y=%d DecValue=%.1f at=%v", rng, shot.X, shot.Y, shot.DecValue, shotAtOrDash(shotAt, hasShotAt))
		}
		if p.OnShot != nil {
			s := state.Shot{
				X:           shot.X,
				Y:           shot.Y,
				Distance:    shot.Distance,
				FullValue:   shot.FullValue,
				DecValue:    shot.DecValue,
				DiscTypeRaw: shot.DiscTypeRaw,
				IsWarmup:    shot.IsWarmup,
				IsHot:       shot.IsHot,
				ReceivedAt:  applyReceived,
			}
			if hasShotAt {
				s.At = shotAt
			}
			p.OnShot(rng, s, p.State.ShotNumber(rng))
		}
	}
	return applied
}

// IngestPacket is the UDP pipeline without a socket — tests and simulators use this
// instead of ApplyShot + OnShot so they cannot bypass validation.
func IngestPacket(st *state.LiveState, onShot ShotNotifier, data []byte) int {
	p := Pipeline{State: st, OnShot: onShot}
	return p.Ingest(data)
}
