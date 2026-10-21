package fullplay

import (
	"testing"
)

// Scenario is one full match (or display session) plus the file contracts
// that keep its UI from regressing. Append to Catalog; never reuse an ID.
type Scenario struct {
	ID         string
	PluginID   string
	NumRanges  int
	TotalShots int // OpticScore programme size (Autorennen start gate)
	PhasePath  []string
	Finished   string
	Play       func(t *testing.T, h *Host)
	UI         []FileCheck
}

// FileCheck locks a plugin CSS/JS invariant that already failed in the hall.
type FileCheck struct {
	Rel    []string
	Has    []string
	HasNot []string
	Why    string
}

// frozenIDs is the append-only list of scenarios that must keep running.
// Adding a game: append here AND in Catalog(). Removing an ID is a regression.
var frozenIDs = []string{
	"classic-range",
	"classic-range-condensed",
	"ludo-2p",
	"ludo-6p",
	"barrikade-2p",
	"zehner-bingo-2p",
	"tannebaum-einzel-6p",
	"tannebaum-team-4p",
	"fox-on-the-run-2p",
	"autorennen-2p",
	"darts-2p",
	"tauziehen-2p",
	"kettenreaktion-2p",
	"biathlon-2p",
	"schrumpfender-kreis-2p",
	"kronen-duell-2p",
	"bank-oder-risiko-2p",
	"ko-pokal-2p",
	"schiessgolf-2p",
	"turmbau-2p",
	"ansage-duell-2p",
	"analyse",
}

// Catalog is the single list of full games. go test ./host/fullplay runs all of them.
func Catalog() []Scenario {
	return []Scenario{
		{
			ID:        "classic-range",
			PluginID:  "classic-range",
			NumRanges: 2,
			Play:      playClassicRange,
			UI: []FileCheck{{
				Rel: []string{"plugins", "classic-range", "view.js"},
				Has: []string{"SRPluginViews['classic-range']"},
				Why: "classic-range hall/shooter lookup must keep the current plugin id",
			}},
		},
		{
			ID:        "classic-range-condensed",
			PluginID:  "classic-range-condensed",
			NumRanges: 2,
			Play:      playClassicRange,
			UI: []FileCheck{{
				Rel: []string{"plugins", "classic-range-condensed", "view.js"},
				Has: []string{"const PLUGIN_ID = 'classic-range-condensed'", "SRPluginViews[PLUGIN_ID]"},
				Why: "condensed hall/shooter lookup must keep the current plugin id",
			}},
		},
		{
			ID:        "ludo-2p",
			PluginID:  "ludo",
			NumRanges: 2,
			PhasePath: []string{"game", "phase"},
			Finished:  "finished",
			Play:      playLudo,
			UI: []FileCheck{{
				Rel: []string{"plugins", "ludo", "view.js"},
				Has: []string{"game.boardArms", "const classic = n === 4", "ld-compact-layout"},
				Why: "2-player Ludo must draw the 4-arm classic board, not a 2-point star",
			}},
		},
		{
			ID:        "ludo-6p",
			PluginID:  "ludo",
			NumRanges: 6,
			PhasePath: []string{"game", "phase"},
			Finished:  "finished",
			Play:      playLudo,
			UI: []FileCheck{
				{
					Rel: []string{"plugins", "ludo", "view.js"},
					Has: []string{"starRingPts", "ld-who", "ld-hint"},
					Why: "6-player Ludo keeps the star track; standings must tag name/hint so they cannot wrap in the 4-col grid",
				},
				{
					Rel: []string{"plugins", "ludo", "theme.css"},
					Has: []string{".ld-standings .ld-hint", "white-space: nowrap"},
					Why: "Ludo Stand hint '9+ geht, 10.5 geht zwei' wrapped 'zwei' onto its own line in the compact rail",
				},
			},
		},
		{
			ID:        "barrikade-2p",
			PluginID:  "barrikade",
			NumRanges: 2,
			PhasePath: []string{"game", "phase"},
			Finished:  "finished",
			Play:      playBarrikade,
			UI: []FileCheck{{
				Rel: []string{"plugins", "barrikade", "view.js"},
				Has: []string{"const PLUGIN_ID = 'barrikade'", "SRPluginViews[PLUGIN_ID]", "br-compact-layout"},
				Why: "barrikade paint must stay registered under the current id",
			}},
		},
		{
			ID:        "zehner-bingo-2p",
			PluginID:  "zehner-bingo",
			NumRanges: 2,
			PhasePath: []string{"game", "phase"},
			Finished:  "finished",
			Play:      playBingo,
			UI: []FileCheck{{
				Rel: []string{"plugins", "zehner-bingo", "view.js"},
				Has: []string{"const PLUGIN_ID = 'zehner-bingo'", "SRPluginViews[PLUGIN_ID]", "zb-compact-layout", "zb-cards-"},
				Why: "bingo paint must stay registered under the current id",
			}},
		},
		{
			ID:        "tannebaum-einzel-6p",
			PluginID:  "tannebaum-einzel",
			NumRanges: 6,
			PhasePath: []string{"tree", "phase"},
			Finished:  "finished",
			Play:      playTannebaumEinzel,
			UI: []FileCheck{
				{
					Rel: []string{"plugins", "tannebaum-einzel", "view.js"},
					Has: []string{"tb-trees-gallery", "SRPluginViews['tannebaum-einzel']", "tb-compact-layout"},
					Why: "hall must show every stand's tree at equal size",
				},
				{
					Rel:    []string{"plugins", "tannebaum-einzel", "theme.css"},
					HasNot: []string{"max-height: 36%", "max-height: 220px"},
					Why:    "mini-tree max-height plus overflow clipped trunks on the bottom-left",
				},
			},
		},
		{
			ID:        "tannebaum-team-4p",
			PluginID:  "tannebaum-team",
			NumRanges: 4,
			PhasePath: []string{"tree", "phase"},
			Finished:  "finished",
			Play:      playTannebaumTeam,
			UI: []FileCheck{{
				Rel: []string{"plugins", "tannebaum-team", "view.js"},
				Has: []string{"tb-trees-duo", "SRPluginViews['tannebaum-team']", "tb-compact-layout"},
				Why: "team mode paints two equal trees, never a clipped mini row",
			}},
		},
		{
			ID:        "fox-on-the-run-2p",
			PluginID:  "fox-on-the-run",
			NumRanges: 2,
			PhasePath: []string{"hunt", "phase"},
			Finished:  "finished",
			Play:      playFox,
			UI: []FileCheck{
				{
					Rel:    []string{"plugins", "fox-on-the-run", "theme.css"},
					Has:    []string{".fox-scheibe-frame", "aspect-ratio: 1", "100cqmin"},
					HasNot: []string{"100cqi", "100cqb"},
					Why:    "fox disc must sit in a square frame like classic-range; a rectangular SVG box stretches the rings",
				},
				{
					Rel:    []string{"plugins", "fox-on-the-run", "view.js"},
					Has:    []string{"fox-scheibe-frame", "xMidYMid meet", "huntIsLive", "SRPluginViews['fox-on-the-run']", "fox-compact-layout"},
					HasNot: []string{"Fuchs S' + esc(hunt && hunt.currentFox)"},
					Why:    "calibration must not print Fuchs S0; disc must keep a square meet frame",
				},
				{
					Rel: []string{"plugins", "fox-on-the-run", "view.js"},
					Has: []string{"esc(fmt1(p.foxScore))", "esc(out) + '</span></li>'"},
					Why: "fox score and gestellt/Bau must stay in separate cells so 0.0 cannot sit on the status word",
				},
				{
					Rel: []string{"plugins", "fox-on-the-run", "theme.css"},
					Has: []string{"grid-template-columns: 14px 1.4rem 1fr auto auto"},
					Why: "fox standings keep score and gestellt/Bau in their own auto columns",
				},
			},
		},
		{
			ID:         "autorennen-2p",
			PluginID:   "autorennen",
			NumRanges:  2,
			TotalShots: 10,
			PhasePath:  []string{"race", "phase"},
			Finished:   "finished",
			Play:       playAutorennen,
			UI: []FileCheck{{
				Rel:    []string{"plugins", "autorennen", "theme.css"},
				HasNot: []string{"max-height: 22%"},
				Why:    "capping shooter standings at 22% forced a leftover-space scrollbar",
			}},
		},
		{
			ID:        "darts-2p",
			PluginID:  "darts",
			NumRanges: 2,
			PhasePath: []string{"game", "phase"},
			Finished:  "finished",
			Play:      playDarts,
			UI: []FileCheck{
				{
					Rel: []string{"plugins", "darts", "view.js"},
					Has: []string{
						"const PLUGIN_ID = 'darts'",
						"SRPluginViews[PLUGIN_ID]",
						"game.boardDarts",
						"data-order-mode",
						"data-beginner-range",
					},
					Why: "Dart hall view must keep board hits and selectable beginner order",
				},
				{
					Rel: []string{"plugins", "darts", "theme.css"},
					Has: []string{".dt-board-svg", ".dt-player.active"},
					Why: "Dart board and active shooter highlighting must stay styled",
				},
			},
		}, conceptScenario("tauziehen-2p", "tauziehen", playTauziehen),
		conceptScenario("kettenreaktion-2p", "kettenreaktion", playHighValueProgram),
		conceptScenario("biathlon-2p", "biathlon", playHighValueProgram),
		conceptScenario("schrumpfender-kreis-2p", "schrumpfender-kreis", playHighValueProgram),
		conceptScenario("kronen-duell-2p", "kronen-duell", playHighValueProgram),
		conceptScenario("bank-oder-risiko-2p", "bank-oder-risiko", playBankOderRisiko),
		conceptScenario("ko-pokal-2p", "ko-pokal", playKoPokal),
		conceptScenario("schiessgolf-2p", "schiessgolf", playHighValueProgram),
		conceptScenario("turmbau-2p", "turmbau", playHighValueProgram),
		conceptScenario("ansage-duell-2p", "ansage-duell", playHighValueProgram),
		{
			ID:         "analyse",
			PluginID:   "analyse",
			NumRanges:  2,
			TotalShots: 2,
			Play:       playAnalyse,
			UI: []FileCheck{{
				Rel: []string{"plugins", "analyse", "view.js"},
				Has: []string{"const PLUGIN_ID = 'analyse'", "SRPluginViews[PLUGIN_ID]", "analyse-select", "renderClassicRangeView", "pickDefaultId", "sessionResultLive"},
				Why: "Analyse hall must register as a shared display, reuse Classic Range paint, and keep frozen starts selectable",
			}},
		},
	}
}

func conceptScenario(id, pluginID string, play func(*testing.T, *Host)) Scenario {
	return Scenario{
		ID:        id,
		PluginID:  pluginID,
		NumRanges: 2,
		PhasePath: []string{"game", "phase"},
		Finished:  "finished",
		Play:      play,
		UI: []FileCheck{{
			Rel: []string{"plugins", pluginID, "view.js"},
			Has: []string{"const PLUGIN_ID = '" + pluginID + "'", "SRPluginViews[PLUGIN_ID]", "classList.add('shared-master-host')", "compact-layout"},
			Why: pluginID + " hall paint must keep the shared host class and current plugin id",
		}},
	}
}
