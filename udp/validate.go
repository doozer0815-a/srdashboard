package udp

import (
	"fmt"
	"math"
	"strings"

	"srdashboard/state"
)

const (
	decMax         = 10.9
	coordLimit     = 9000
	rifleBandDSG   = 25.0 // LG: 25 DSG per 0.1 DecValue (100 DSG/mm)
	pistolBandDSG  = 80.0 // LP / KK
	distRoundSlack = 1.5  // X/Y are ints; hypot vs Distance may differ by ~1 DSG
	decRoundSlack  = 0.051
)

// FullValueOf is the integer ring OpticScore sends with DecValue (10.9 → 10).
func FullValueOf(dec float64) int {
	if dec < 0 {
		return 0
	}
	full := int(math.Floor(dec + 1e-9))
	if full > 10 {
		return 10
	}
	return full
}

// PlaceShot returns DISAG X/Y/Distance on the LG teiler band for dec.
// seed spreads shots around the ring so groups are not a single stacked hole.
func PlaceShot(dec float64, seed int) (x, y int, distance float64) {
	return PlaceShotForDisc("LG", dec, seed)
}

// PlaceShotForDisc places a synthetic hole on the LG or LP/KK teiler band.
func PlaceShotForDisc(disc string, dec float64, seed int) (x, y int, distance float64) {
	return placeShotBand(dec, seed, bandForDisc(disc))
}

func bandForDisc(disc string) float64 {
	label := strings.ToLower(strings.TrimSpace(disc))
	if strings.Contains(label, "lp") || strings.Contains(label, "pistole") ||
		strings.Contains(label, "kk") || strings.Contains(label, "klein") {
		return pistolBandDSG
	}
	return rifleBandDSG
}

func placeShotBand(dec float64, seed int, band float64) (x, y int, distance float64) {
	if dec > decMax {
		dec = decMax
	}
	if dec < 0 {
		dec = 0
	}
	if band <= 0 {
		band = rifleBandDSG
	}
	step := int(math.Round((decMax - dec) * 10))
	if step < 0 {
		step = 0
	}
	lo := float64(step) * band
	hi := lo + band
	t := float64((seed*17)%1000) / 1000
	if seed < 0 {
		t = 0.5
	}
	if dec >= decMax {
		distance = t * band * 0.4
	} else {
		distance = lo + t*(hi-lo)
	}
	ang := float64((seed*47)%360) * math.Pi / 180
	x = int(math.Round(math.Cos(ang) * distance))
	y = int(math.Round(math.Sin(ang) * distance))
	distance = math.Round(math.Hypot(float64(x), float64(y))*10) / 10
	return x, y, distance
}

// ValidateShot reports whether a DISAG shot may enter live state.
// X/Y, Distance (Teiler), FullValue and DecValue must agree, with a small
// rounding allowance for integer coordinates and 0.1 scoring.
func ValidateShot(sp *state.ShotPayload) error {
	if sp == nil {
		return fmt.Errorf("nil shot")
	}
	if sp.X < -coordLimit || sp.X > coordLimit || sp.Y < -coordLimit || sp.Y > coordLimit {
		return fmt.Errorf("coordinates X=%d Y=%d outside ±%d", sp.X, sp.Y, coordLimit)
	}

	// fun_dart uses real dart scores (for example 50 for bullseye) instead
	// of the normal 0.0...10.9 shooting score scale. Keep only the generic
	// geometry sanity checks for this disc type and skip LG/LP score checks.
	if strings.TrimSpace(sp.DiscTypeRaw) == "fun_dart" {
		if sp.Distance < 0 {
			return fmt.Errorf("Distance %.3f is negative", sp.Distance)
		}
		hyp := math.Hypot(float64(sp.X), float64(sp.Y))
		if math.Abs(hyp-sp.Distance) > distRoundSlack {
			return fmt.Errorf("Distance %.1f does not match hypot(X,Y)=%.1f (X=%d Y=%d)", sp.Distance, hyp, sp.X, sp.Y)
		}
		return nil
	}

	dec := sp.DecValue
	if dec < -decRoundSlack || dec > decMax+decRoundSlack {
		return fmt.Errorf("DecValue %.3f outside 0…%.1f", dec, decMax)
	}
	if snap := math.Round(dec*10) / 10; math.Abs(dec-snap) > decRoundSlack {
		return fmt.Errorf("DecValue %.3f is not a 0.1 step", dec)
	}
	dec = math.Round(dec*10) / 10
	if dec < 0 {
		dec = 0
	}
	if dec > decMax {
		dec = decMax
	}
	wantFull := FullValueOf(dec)
	if sp.FullValue != wantFull {
		return fmt.Errorf("FullValue %d does not match DecValue %.1f (want %d)", sp.FullValue, dec, wantFull)
	}

	hyp := math.Hypot(float64(sp.X), float64(sp.Y))
	dist := sp.Distance
	if dist < 0 {
		return fmt.Errorf("Distance %.3f is negative", dist)
	}
	if math.Abs(hyp-dist) > distRoundSlack {
		return fmt.Errorf("Distance %.1f does not match hypot(X,Y)=%.1f (X=%d Y=%d)", dist, hyp, sp.X, sp.Y)
	}
	// Prefer the measured hole; Distance is allowed to be the 0.1-rounded hypot.
	radius := hyp
	if radius == 0 {
		radius = dist
	}

	bands := teilerBandsFor(sp)
	var last error
	for _, band := range bands {
		if err := decMatchesRadius(dec, radius, band); err == nil {
			return nil
		} else {
			last = err
		}
	}
	if last == nil {
		last = fmt.Errorf("DecValue %.1f does not match Teiler %.1f", dec, radius)
	}
	return last
}

func teilerBandsFor(sp *state.ShotPayload) []float64 {
	label := strings.ToLower(strings.TrimSpace(sp.DiscType + " " + sp.DiscTypeRaw))
	if sp.MenuItem != nil {
		label += " " + strings.ToLower(sp.MenuItem.MenuItemName+" "+sp.MenuItem.MenuPointName)
	}
	switch {
	case strings.Contains(label, "lp") || strings.Contains(label, "pistole") ||
		strings.Contains(label, "kk") || strings.Contains(label, "klein"):
		return []float64{pistolBandDSG}
	case strings.Contains(label, "lg") || strings.Contains(label, "luftgewehr") || strings.Contains(label, "rifle"):
		return []float64{rifleBandDSG}
	default:
		return []float64{rifleBandDSG, pistolBandDSG}
	}
}

func decMatchesRadius(dec, radius, band float64) error {
	step := int(math.Round((decMax - dec) * 10))
	if step < 0 {
		step = 0
	}
	lo := float64(step) * band
	hi := lo + band
	// Integer X/Y can push hypot just outside the 25 DSG window.
	if dec <= 0 {
		if radius+distRoundSlack < lo {
			return fmt.Errorf("DecValue 0.0 is too close to centre (Teiler %.1f, %s band %.0f)", radius, bandName(band), band)
		}
		return nil
	}
	if radius < lo-distRoundSlack || radius > hi+distRoundSlack {
		return fmt.Errorf("DecValue %.1f expects Teiler %.0f–%.0f %s, got %.1f", dec, lo, hi, bandName(band), radius)
	}
	return nil
}

func bandName(band float64) string {
	if band == pistolBandDSG {
		return "DSG (LP/KK)"
	}
	return "DSG (LG)"
}
