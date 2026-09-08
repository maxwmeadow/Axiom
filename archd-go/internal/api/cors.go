package api

import (
	"net"
	"net/http"
	"net/url"
)

// AllowLoopbackOrigins permits browser requests from a loopback origin, and
// only from a loopback origin.
//
// archd binds 127.0.0.1, but binding is not access control where a browser is
// involved: any page the user has open can issue requests to 127.0.0.1 from
// their own machine. CORS is what decides whether that page may READ the
// response. Answering "*", or echoing whatever Origin arrives, would let any
// site on the internet read this user's architecture, file paths and source
// excerpts. So the allowance is exactly the loopback host set.
//
// This exists because the renderer is served from http://localhost:5173 in
// development, which is a different origin from http://127.0.0.1:7743. A
// packaged build loads from file:// and sends no Origin at all, which is left
// untouched.
func AllowLoopbackOrigins(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); isLoopbackOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			// The response differs per origin, so a cache must never hand one
			// origin's response to another.
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Max-Age", "600")
		}

		// A preflight is answered here and never reaches a route handler.
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// isLoopbackOrigin reports whether an Origin header names a loopback host.
// "null" - what a file:// page sends - is deliberately not loopback: opaque
// origins are shared by every sandboxed context, so allowing it would allow
// far more than this application.
func isLoopbackOrigin(origin string) bool {
	if origin == "" || origin == "null" {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return false
	}
	host := parsed.Hostname()
	if host == "localhost" {
		return true
	}
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
}
