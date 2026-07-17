package api

import "testing"

func TestLineCount(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    int
	}{
		{name: "empty", content: "", want: 0},
		{name: "one line", content: "package main", want: 1},
		{name: "two lines", content: "one\ntwo", want: 2},
		{name: "trailing newline", content: "one\ntwo\n", want: 2},
		{name: "blank line", content: "one\n\ntwo", want: 3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := lineCount([]byte(tt.content)); got != tt.want {
				t.Fatalf("lineCount(%q) = %d, want %d", tt.content, got, tt.want)
			}
		})
	}
}
