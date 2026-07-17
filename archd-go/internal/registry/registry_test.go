package registry

import "testing"

func TestServicesInheritCategoryCapabilities(t *testing.T) {
	r := &Registry{services: make(map[string]Service)}
	r.addFile([]byte(`[
		{"id":"test/host","name":"Host","category":"platform","provider":"test","brand":{"icon":"","color":"#fff"}},
		{"id":"test/db","name":"Database","category":"database","provider":"test","brand":{"icon":"","color":"#fff"}}
	]`), "test", "test.json")

	host, ok := r.Get("test/host")
	if !ok || !containsCapability(host.Capabilities, "container") || !containsCapability(host.Capabilities, "environment") {
		t.Fatalf("platform capabilities = %v", host.Capabilities)
	}
	database, ok := r.Get("test/db")
	if !ok || !containsCapability(database.Capabilities, "schema") {
		t.Fatalf("database capabilities = %v", database.Capabilities)
	}
}

func containsCapability(capabilities []string, wanted string) bool {
	for _, capability := range capabilities {
		if capability == wanted {
			return true
		}
	}
	return false
}
