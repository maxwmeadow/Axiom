package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func corsResponse(t *testing.T, method, origin string, preflight bool) *httptest.ResponseRecorder {
	t.Helper()
	handler := AllowLoopbackOrigins(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	request := httptest.NewRequest(method, "/api/registry/services", nil)
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	if preflight {
		request.Header.Set("Access-Control-Request-Method", "GET")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestLoopbackOriginsMayReadTheAPI(t *testing.T) {
	// The dev renderer is served from localhost:5173; these are the spellings
	// a loopback page can legitimately arrive with.
	for _, origin := range []string{
		"http://localhost:5173",
		"http://127.0.0.1:5173",
		"http://[::1]:5173",
		"https://localhost:1234",
	} {
		response := corsResponse(t, http.MethodGet, origin, false)
		if got := response.Header().Get("Access-Control-Allow-Origin"); got != origin {
			t.Fatalf("origin %q: allow-origin = %q, want the origin echoed", origin, got)
		}
		if response.Header().Get("Vary") != "Origin" {
			t.Fatalf("origin %q: a per-origin response must set Vary: Origin", origin)
		}
	}
}

func TestNonLoopbackOriginsAreNeverAllowed(t *testing.T) {
	// archd listens on 127.0.0.1, but any page the user opens can still reach
	// it. CORS is the only thing stopping that page reading the response.
	for _, origin := range []string{
		"https://evil.com",
		"http://localhost.evil.com",
		"http://127.0.0.1.evil.com",
		"http://192.168.1.10:5173",
		"file://",
		"null",
	} {
		response := corsResponse(t, http.MethodGet, origin, false)
		if got := response.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("origin %q must not be allowed, got %q", origin, got)
		}
	}
}

func TestRequestsWithoutAnOriginAreUntouched(t *testing.T) {
	// A packaged build loads from file:// and sends no Origin at all.
	response := corsResponse(t, http.MethodGet, "", false)
	if got := response.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("no Origin should mean no CORS header, got %q", got)
	}
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want the request served normally", response.Code)
	}
}

func TestPreflightIsAnsweredWithoutReachingTheRoute(t *testing.T) {
	response := corsResponse(t, http.MethodOptions, "http://localhost:5173", true)
	if response.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want %d", response.Code, http.StatusNoContent)
	}
	if response.Body.Len() != 0 {
		t.Fatalf("preflight should not reach the handler, body = %q", response.Body.String())
	}
	if response.Header().Get("Access-Control-Allow-Methods") == "" {
		t.Fatal("preflight must advertise the allowed methods")
	}
}
