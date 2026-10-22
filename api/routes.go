package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Role names returned by GET /api/mode.
const (
	RoleAdmin  = "admin"
	RolePublic = "public"
)

// ModeAdmin reports that this listener is the full-control admin port.
func ModeAdmin(w http.ResponseWriter, r *http.Request) {
	writeMode(w, r, RoleAdmin)
}

// ModePublic reports that this listener is the read-only public port.
func ModePublic(w http.ResponseWriter, r *http.Request) {
	writeMode(w, r, RolePublic)
}

func writeMode(w http.ResponseWriter, r *http.Request, role string) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"role": role})
}

// PluginGet is a read-only plugin metadata handler for the public mux
// (no config PUT, no uninstall).
func (h *Handlers) PluginGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/plugins/")
	path = strings.Trim(path, "/")
	parts := strings.Split(path, "/")
	if len(parts) != 1 || parts[0] == "" {
		http.NotFound(w, r)
		return
	}
	ap, err := h.Plugins.Get(parts[0])
	if err != nil {
		http.NotFound(w, r)
		return
	}
	resp := map[string]any{
		"id":          parts[0],
		"label":       ap.Manifest.Label,
		"version":     ap.Manifest.Version,
		"description": ap.Manifest.Description,
		"kind":        ap.Manifest.Kind,
		"mode":        ap.Manifest.Mode,
		"defaults":    h.Plugins.MergedConfig(parts[0]),
		"manifest":    ap.Manifest,
		"viewUrl":     pluginAssetURL(parts[0], ap.Manifest.Entrypoints.View),
		"assetsBase":  pluginAssetURL(parts[0], ap.Manifest.AssetsDir),
		"rulebookUrl": h.pluginRulebookURL(ap),
	}
	if ap.Logic != nil {
		resp["configSchema"] = ap.Logic.ConfigSchema()
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

var rangePath = regexp.MustCompile(`^/(\d+)/?$`)
var compactPath = regexp.MustCompile(`^/compact/?$`)
var allPath = regexp.MustCompile(`^/all/?$`)

// StaticOptions configures SPA + static file serving for a mux.
type StaticOptions struct {
	StaticDir     string
	StaticHandler http.Handler
	ReadIndex     func() ([]byte, error) // fallback when StaticDir has no index.html
	AllowConfig   bool                   // serve /config SPA (admin only)
}

// RegisterAdminRoutes mounts the full-control HTTP surface.
func RegisterAdminRoutes(mux *http.ServeMux, h *Handlers, hub *Hub, static StaticOptions) {
	mux.HandleFunc("/api/mode", ModeAdmin)
	mux.HandleFunc("/api/live", h.Live)
	mux.HandleFunc("/api/live/reset", h.LiveReset)
	mux.HandleFunc("/api/runtime", h.ServeRuntime)
	mux.HandleFunc("/api/wettkampf", h.ServeWettkampf)
	mux.HandleFunc("/api/qr", h.QR)
	mux.HandleFunc("/api/qr.png", h.QR)
	mux.HandleFunc("/api/qr/formats", h.QRFormats)
	mux.HandleFunc("/api/analyse/results", h.AnalyseResults)
	mux.HandleFunc("/api/config", h.Config)
	mux.HandleFunc("/api/historic", h.Historic)
	mux.HandleFunc("/api/recovery/replay", h.RecoveryReplay)
	mux.HandleFunc("/api/plugins/active", h.PluginsActiveList)
	mux.HandleFunc("/api/plugins/session", h.PluginSession)
	mux.HandleFunc("/api/plugins/control", h.PluginControl)
	mux.HandleFunc("/api/plugins", h.PluginsList)
	mux.HandleFunc("/api/plugins/activate", h.PluginActivate)
	mux.HandleFunc("/api/plugins/reload", h.PluginReload)
	mux.HandleFunc("/api/plugins/", h.PluginByID)
	mux.HandleFunc("/ws", hub.ServeWS)
	mux.HandleFunc("/plugins/", h.ServePlugin)
	registerStatic(mux, static)
}

// RegisterPublicRoutes mounts the read-only view surface (master + stands).
func RegisterPublicRoutes(mux *http.ServeMux, h *Handlers, hub *Hub, static StaticOptions) {
	mux.HandleFunc("/api/mode", ModePublic)
	mux.HandleFunc("/api/live", methodGetOnly(h.Live))
	mux.HandleFunc("/api/runtime", methodGetOnly(h.ServeRuntime))
	mux.HandleFunc("/api/wettkampf", methodGetOnly(h.ServeWettkampf))
	mux.HandleFunc("/api/qr", methodGetOnly(h.QR))
	mux.HandleFunc("/api/qr.png", methodGetOnly(h.QR))
	mux.HandleFunc("/api/qr/formats", methodGetOnly(h.QRFormats))
	mux.HandleFunc("/api/analyse/results", methodGetOnly(h.AnalyseResults))
	mux.HandleFunc("/api/config", methodGetOnly(h.Config))
	mux.HandleFunc("/api/historic", methodGetOnly(h.Historic))
	mux.HandleFunc("/api/plugins/active", h.PluginsActiveList)
	mux.HandleFunc("/api/plugins/session", h.PluginSession)
	mux.HandleFunc("/api/plugins", h.PluginsList)
	// Explicitly absent on public (do not fall through to PluginGet as id=activate).
	mux.HandleFunc("/api/plugins/activate", http.NotFound)
	mux.HandleFunc("/api/plugins/control", http.NotFound)
	mux.HandleFunc("/api/plugins/reload", http.NotFound)
	mux.HandleFunc("/api/recovery/replay", http.NotFound)
	mux.HandleFunc("/api/plugins/", h.PluginGet)
	mux.HandleFunc("/ws", hub.ServeWS)
	mux.HandleFunc("/plugins/", h.ServePlugin)
	static.AllowConfig = false
	registerStatic(mux, static)
}

func methodGetOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		next(w, r)
	}
}

func registerStatic(mux *http.ServeMux, opt StaticOptions) {
	serveIndex := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, must-revalidate")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if opt.StaticDir != "" {
			path := filepath.Join(opt.StaticDir, "index.html")
			if _, err := os.Stat(path); err == nil {
				http.ServeFile(w, r, path)
				return
			}
		}
		if opt.ReadIndex != nil {
			data, err := opt.ReadIndex()
			if err != nil {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write(data)
			return
		}
		http.NotFound(w, r)
	}

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/config" || path == "/config/" {
			if !opt.AllowConfig {
				http.NotFound(w, r)
				return
			}
			serveIndex(w, r)
			return
		}
		if rangePath.MatchString(path) || compactPath.MatchString(path) || allPath.MatchString(path) || path == "/" || path == "/index.html" {
			serveIndex(w, r)
			return
		}
		if strings.HasSuffix(path, ".js") || strings.HasSuffix(path, ".css") || strings.HasSuffix(path, ".html") ||
			strings.HasSuffix(path, ".mp3") || strings.HasSuffix(path, ".ogg") ||
			strings.HasSuffix(path, ".wav") || strings.HasSuffix(path, ".m4a") {
			w.Header().Set("Cache-Control", "no-cache, must-revalidate")
		}
		if opt.StaticHandler != nil {
			opt.StaticHandler.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	})
}
