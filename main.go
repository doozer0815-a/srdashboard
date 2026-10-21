package main

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"srdashboard/api"
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
	"srdashboard/recovery"
	"srdashboard/state"
	"srdashboard/udp"
	"srdashboard/wettkampf"
)

//go:embed all:static
var staticFS embed.FS

func main() {
	configPath := "config.xml"
	if len(os.Args) > 1 {
		configPath = os.Args[1]
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	pm := loader.NewManager(cfg.Plugins.Dir)
	if err := pm.Reload(); err != nil {
		log.Printf("load plugins: %v", err)
	}

	st := state.NewLiveState(cfg.Ranges)
	ps := rangestate.NewManager(cfg.Ranges, pm, cfg.Plugins.Active)
	ps.SetLiveSource(st)
	hub := api.NewHub()
	ps.SetBroadcaster(hub)

	udpListener, err := udp.NewListener(cfg.UDPPort, st, cfg.UDPForward)
	if err != nil {
		log.Fatalf("UDP listener: %v", err)
	}
	sessionLog, err := recovery.OpenSessionLog("log")
	if err != nil {
		log.Printf("session log disabled: %v", err)
	} else {
		log.SetOutput(io.MultiWriter(os.Stdout, sessionLog))
		log.Printf("session log: %s", sessionLog.Path)
		defer sessionLog.Close()
	}

	rt, err := config.LoadRuntime(config.RuntimePath(configPath))
	if err != nil {
		log.Fatalf("load runtime: %v", err)
	}
	rt.Prune(cfg.Ranges)
	ps.SetInactiveRanges(rt.InactiveList(cfg.Ranges))

	wkStore, err := wettkampf.OpenSession(config.WettkampfPath(configPath))
	if err != nil {
		log.Fatalf("start wettkampf session: %v", err)
	}

	if err := ps.EnsureActive(); err != nil {
		log.Printf("activate plugin %q: %v", cfg.Plugins.Active, err)
	}

	handlers := &api.Handlers{
		State:       st,
		Cfg:         cfg,
		ConfigPath:  configPath,
		Runtime:     rt,
		Plugins:     pm,
		PluginState: ps,
		Hub:         hub,
		ReplayLog:   udpListener.ReplayLog,
		Wettkampf:   wkStore,
	}
	udpListener.SetShotFilter(handlers)
	udpListener.SetShotNotifier(func(rng int, shot state.Shot, shotIndex int) {
		ps.OnShot(rng, shot, shotIndex)
		// Only re-sync ready flags on warmup transitions — every shot used to
		// rebuild all shared view models twice.
		if shot.IsWarmup {
			ps.SyncLiveReady()
		} else {
			// Leaving warmup is detected inside game logic via Live.IsWarmup;
			// still sync once when a competition shot arrives after warmup.
			ps.SyncLiveReadyIfArming()
		}
		if rs, ok := st.RangeSnapshot(rng); ok {
			handlers.ObserveWettkampfShot(rs)
			if ps.InReplay() {
				return
			}
			hub.BroadcastRange(rng, map[string]any{
				"type":  "live",
				"range": rs,
			})
			handlers.BroadcastWettkampf()
		}
	})
	udpListener.Start()
	defer udpListener.Stop()

	staticOpt := buildStaticOptions()

	adminPort := cfg.Display.AdminPort
	if p := os.Getenv("PORT"); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 65535 {
			log.Fatalf("PORT env %q is not a valid TCP port", p)
		}
		adminPort = n
	}
	publicPort := cfg.Display.PublicPort
	if publicPort < 0 || publicPort > 65535 {
		log.Fatalf("display/publicPort must be 0 (off) or 1–65535, got %d", publicPort)
	}
	if publicPort != 0 && publicPort == adminPort {
		log.Fatalf("display/publicPort (%d) must differ from admin port (%d)", publicPort, adminPort)
	}

	adminMux := http.NewServeMux()
	api.RegisterAdminRoutes(adminMux, handlers, hub, staticOpt)
	adminServer := newHTTPServer(fmt.Sprintf(":%d", adminPort), adminMux)

	var publicServer *http.Server
	if publicPort > 0 {
		publicMux := http.NewServeMux()
		api.RegisterPublicRoutes(publicMux, handlers, hub, staticOpt)
		publicServer = newHTTPServer(fmt.Sprintf(":%d", publicPort), publicMux)
	}

	if cfg.Display.ControlToken == "" {
		log.Printf("WARNING: display/controlToken is not set in %s — anyone who can reach the admin port :%d may change plugins, config and live scores", configPath, adminPort)
	}
	log.Printf("admin HTTP on http://localhost:%d (active plugin: %s)", adminPort, cfg.Plugins.Active)
	if publicServer != nil {
		log.Printf("public HTTP on http://localhost:%d (read-only master + stands; publish this port only)", publicPort)
	}

	serverErr := make(chan error, 2)
	go serveHTTP(adminServer, "admin", serverErr)
	if publicServer != nil {
		go serveHTTP(publicServer, "public", serverErr)
	}

	// Shut down on Ctrl-C so in-flight config writes finish and the UDP socket
	// is released instead of being torn down mid-operation.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	select {
	case err := <-serverErr:
		if err != nil {
			log.Fatalf("HTTP server: %v", err)
		}
	case sig := <-stop:
		log.Printf("received %s, shutting down", sig)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := adminServer.Shutdown(ctx); err != nil {
			log.Printf("admin shutdown: %v", err)
		}
		if publicServer != nil {
			if err := publicServer.Shutdown(ctx); err != nil {
				log.Printf("public shutdown: %v", err)
			}
		}
	}
}

func newHTTPServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
	}
}

func serveHTTP(server *http.Server, name string, serverErr chan<- error) {
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		serverErr <- fmt.Errorf("%s: %w", name, err)
	}
}

func buildStaticOptions() api.StaticOptions {
	staticDir := "static"
	var staticHandler http.Handler
	if _, err := os.Stat(staticDir); err == nil {
		staticHandler = http.FileServer(http.Dir(staticDir))
	} else {
		sub, err := fs.Sub(staticFS, "static")
		if err != nil {
			log.Fatalf("embedded static assets: %v", err)
		}
		staticHandler = http.FileServer(http.FS(sub))
	}
	return api.StaticOptions{
		StaticDir:     staticDir,
		StaticHandler: staticHandler,
		AllowConfig:   true,
		ReadIndex: func() ([]byte, error) {
			return staticFS.ReadFile("static/index.html")
		},
	}
}
