package db

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func plannedFixture(t *testing.T, relPath, source string, symbols []Symbol, metadata string) (*PlannedNode, func() *PlannedNode) {
	t.Helper()
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	rootPath := t.TempDir()
	if err := UpsertRoot(sqlDB, Root{ID: "root", WorkspaceID: "ws", Path: rootPath}); err != nil {
		t.Fatal(err)
	}
	absolute := filepath.Join(rootPath, filepath.FromSlash(relPath))
	if err := os.MkdirAll(filepath.Dir(absolute), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(absolute, []byte(source), 0o644); err != nil {
		t.Fatal(err)
	}
	file := File{
		ID: "file", RootID: "root", Path: absolute, RelPath: relPath,
		Language: "typescript", LineCount: 3,
	}
	if err := UpsertFile(sqlDB, file); err != nil {
		t.Fatal(err)
	}
	if err := UpsertSymbols(sqlDB, file.ID, symbols); err != nil {
		t.Fatal(err)
	}
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "plan"}
	if err := CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}
	node := &PlannedNode{
		ID: "planned", SheetID: sheet.ID, WorkspaceID: "ws",
		Kind: "class", Name: "RateLimiter", DeclaredPath: relPath,
		Metadata: json.RawMessage(metadata),
	}
	if err := UpsertPlannedNode(sqlDB, node); err != nil {
		t.Fatal(err)
	}
	load := func() *PlannedNode {
		t.Helper()
		got, getErr := GetPlannedNode(sqlDB, node.ID)
		if getErr != nil {
			t.Fatal(getErr)
		}
		return got
	}
	if _, err := ReconcilePlanned(sqlDB, "ws"); err != nil {
		t.Fatal(err)
	}
	return node, load
}

func decodedMembers(t *testing.T, node *PlannedNode) []PlannedMember {
	t.Helper()
	var members []PlannedMember
	if err := json.Unmarshal(node.Members, &members); err != nil {
		t.Fatal(err)
	}
	return members
}

func TestReconcilePlannedMatchesQualifiedStructuredContract(t *testing.T) {
	_, load := plannedFixture(
		t,
		"src/rateLimiter.ts",
		"interface RateLimiter {\n  allow(key: string): boolean\n}\n",
		[]Symbol{
			{Name: "RateLimiter", Kind: "interface", LineStart: 1, LineEnd: 3},
			{Name: "allow", Kind: "method", LineStart: 2, LineEnd: 2},
			// A same-name symbol outside the planned container is not eligible.
			{Name: "allow", Kind: "function", LineStart: 5, LineEnd: 5},
		},
		`{"version":1,"classKind":"interface","methods":[{"visibility":"public","name":"allow","parameters":[{"name":"key","dataType":"string"}],"returnType":"boolean"}]}`,
	)
	got := load()
	members := decodedMembers(t, got)
	if got.Status != "realized" || len(members) != 1 {
		t.Fatalf("structured contract should realize: status=%s members=%+v", got.Status, members)
	}
	if members[0].RealizationState != RealizationMatched || !members[0].Realized {
		t.Fatalf("expected corroborated MATCHED member, got %+v", members[0])
	}
	if members[0].QualifiedSymbol != "RateLimiter.allow" {
		t.Fatalf("member was not qualified to its container: %+v", members[0])
	}
}

func TestReconcilePlannedReportsContractDrift(t *testing.T) {
	_, load := plannedFixture(
		t,
		"src/rateLimiter.ts",
		"interface RateLimiter {\n  allow(key: number): string\n}\n",
		[]Symbol{
			{Name: "RateLimiter", Kind: "interface", LineStart: 1, LineEnd: 3},
			{Name: "allow", Kind: "method", LineStart: 2, LineEnd: 2},
		},
		`{"version":1,"methods":[{"visibility":"public","name":"allow","parameters":[{"name":"key","dataType":"string"}],"returnType":"boolean"}]}`,
	)
	got := load()
	member := decodedMembers(t, got)[0]
	if got.Status != "partial" || member.RealizationState != RealizationDrifted || member.Realized {
		t.Fatalf("a contradictory interface must not turn green: status=%s member=%+v", got.Status, member)
	}
	if len(member.RealizationEvidence) == 0 || member.RealizationEvidence[len(member.RealizationEvidence)-1].Kind != "contract.parameter-type" {
		t.Fatalf("drift needs explicit contract evidence: %+v", member.RealizationEvidence)
	}
}

func TestReconcilePlannedDisambiguatesOverloadsByContract(t *testing.T) {
	_, load := plannedFixture(
		t,
		"src/rateLimiter.ts",
		"interface RateLimiter {\n  allow(key: string): boolean\n  allow(key: number): string\n}\n",
		[]Symbol{
			{Name: "RateLimiter", Kind: "interface", LineStart: 1, LineEnd: 4},
			{Name: "allow", Kind: "method", LineStart: 2, LineEnd: 2},
			{Name: "allow", Kind: "method", LineStart: 3, LineEnd: 3},
		},
		`{"version":1,"methods":[{"visibility":"public","name":"allow","parameters":[{"name":"key","dataType":"string"}],"returnType":"boolean"}]}`,
	)
	got := load()
	member := decodedMembers(t, got)[0]
	if got.Status != "realized" || member.RealizationState != RealizationMatched {
		t.Fatalf("the planned overload should resolve by its full contract: status=%s member=%+v", got.Status, member)
	}
	if len(member.RealizationEvidence) == 0 ||
		!strings.Contains(member.RealizationEvidence[0].Detail, ":2") {
		t.Fatalf("overload evidence should identify the compatible indexed declaration: %+v", member.RealizationEvidence)
	}
}

func TestReconcilePlannedLegacyNameOnlyStillRealizes(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	rootPath := t.TempDir()
	if err := UpsertRoot(sqlDB, Root{ID: "root", WorkspaceID: "ws", Path: rootPath}); err != nil {
		t.Fatal(err)
	}
	absolute := filepath.Join(rootPath, "legacy.ts")
	if err := os.WriteFile(absolute, []byte("function ping(value: unknown) {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := UpsertFile(sqlDB, File{
		ID: "file", RootID: "root", Path: absolute, RelPath: "legacy.ts",
		Language: "typescript", LineCount: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertSymbols(sqlDB, "file", []Symbol{{Name: "ping", Kind: "function", LineStart: 1, LineEnd: 1}}); err != nil {
		t.Fatal(err)
	}
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "legacy"}
	if err := CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}
	node := &PlannedNode{
		ID: "planned", SheetID: "sheet", WorkspaceID: "ws", Kind: "file",
		Name: "legacy", DeclaredPath: "legacy.ts",
		Members: json.RawMessage(`[{"signature":"ping","realized":false}]`),
	}
	if err := UpsertPlannedNode(sqlDB, node); err != nil {
		t.Fatal(err)
	}
	if _, err := ReconcilePlanned(sqlDB, "ws"); err != nil {
		t.Fatal(err)
	}
	got, err := GetPlannedNode(sqlDB, node.ID)
	if err != nil {
		t.Fatal(err)
	}
	member := decodedMembers(t, got)[0]
	if got.Status != "realized" || member.RealizationState != RealizationMatched || !member.Realized {
		t.Fatalf("legacy name-only plan should retain compatibility: status=%s member=%+v", got.Status, member)
	}
}

func TestMatchPlannedPathRequiresUniqueSuffix(t *testing.T) {
	files := []File{
		{ID: "a", RelPath: "packages/a/src/service.ts"},
		{ID: "b", RelPath: "packages/b/src/service.ts"},
	}
	if got := matchPlannedPath(files, "src/service.ts"); got.File != nil || got.Quality != "ambiguous-suffix" {
		t.Fatalf("ambiguous suffix must not select the first file: %+v", got)
	}
	got := matchPlannedPath(files[:1], "src/service.ts")
	if got.File == nil || got.Quality != "unique-suffix" {
		t.Fatalf("unique relocation should be explicit FLEXED evidence: %+v", got)
	}
}

func TestCompareContractChecksEveryDeclaredDimension(t *testing.T) {
	parameters := []plannedParameter{{Name: "key", DataType: "string"}}
	assertion := memberAssertion{
		Name: "allow", Structured: true, Visibility: "public",
		Parameters: &parameters, ReturnType: "boolean",
	}
	base := actualContract{
		ParameterTypes: []string{"string"}, ArityKnown: true,
		ReturnType: "boolean", ReturnKnown: true,
		Visibility: "public", VisibilityKnown: true,
	}
	if state, _ := compareContract(assertion, base); state != RealizationMatched {
		t.Fatalf("matching full contract should pass, got %s", state)
	}
	cases := map[string]actualContract{
		"arity": {
			ParameterTypes: []string{"string", "number"}, ArityKnown: true,
			ReturnType: "boolean", ReturnKnown: true, Visibility: "public", VisibilityKnown: true,
		},
		"return": {
			ParameterTypes: []string{"string"}, ArityKnown: true,
			ReturnType: "string", ReturnKnown: true, Visibility: "public", VisibilityKnown: true,
		},
		"visibility": {
			ParameterTypes: []string{"string"}, ArityKnown: true,
			ReturnType: "boolean", ReturnKnown: true, Visibility: "private", VisibilityKnown: true,
		},
	}
	for name, actual := range cases {
		t.Run(name, func(t *testing.T) {
			if state, evidence := compareContract(assertion, actual); state != RealizationDrifted || len(evidence) == 0 {
				t.Fatalf("declared %s contradiction needs DRIFTED evidence: state=%s evidence=%+v", name, state, evidence)
			}
		})
	}
}

func TestMissingStructuredDetailIsNotAsserted(t *testing.T) {
	assertion := memberAssertion{Name: "ping", Structured: true}
	actual := actualContract{ParameterTypes: []string{"anything"}, ArityKnown: true}
	if state, evidence := compareContract(assertion, actual); state != RealizationMatched || len(evidence) != 0 {
		t.Fatalf("omitted contract detail must not become a mismatch: state=%s evidence=%+v", state, evidence)
	}
}

func TestExplicitlyEmptyStructuredMethodsDoNotResurrectLegacyMembers(t *testing.T) {
	var metadata plannedMetadata
	if err := json.Unmarshal([]byte(`{"version":1,"methods":[]}`), &metadata); err != nil {
		t.Fatal(err)
	}
	assertions, structured := structuredAssertions(metadata)
	if !structured || len(assertions) != 0 {
		t.Fatalf("an authored empty method list is distinct from absent legacy metadata: structured=%v assertions=%+v", structured, assertions)
	}
}

func TestServiceUsesNamedContainerWhenIndexerProvidesOne(t *testing.T) {
	symbols := []Symbol{
		{Name: "AuthService", Kind: "class", LineStart: 1, LineEnd: 5},
		{Name: "login", Kind: "method", LineStart: 2, LineEnd: 2},
		{Name: "login", Kind: "function", LineStart: 8, LineEnd: 8},
	}
	container, ok := enclosingContainer(symbols, PlannedNode{Kind: "service", Name: "AuthService"})
	if !ok || container == nil {
		t.Fatal("service should use its uniquely indexed implementation container")
	}
	got := qualifiedMemberCandidates(symbols, container, "login", "typescript", nil)
	if len(got) != 1 || got[0].LineStart != 2 {
		t.Fatalf("service endpoint must not match a same-name symbol outside its container: %+v", got)
	}
}

func TestGoMethodQualificationUsesIndexedReceiver(t *testing.T) {
	source := []byte("type RateLimiter struct{}\nfunc (r *RateLimiter) Allow(key string) bool { return true }\nfunc (o *Other) Allow(key string) bool { return false }\n")
	container := &Symbol{Name: "RateLimiter", Kind: "type", LineStart: 1, LineEnd: 1}
	symbols := []Symbol{
		{Name: "Allow", Kind: "method", LineStart: 2, LineEnd: 2},
		{Name: "Allow", Kind: "method", LineStart: 3, LineEnd: 3},
	}
	got := qualifiedMemberCandidates(symbols, container, "Allow", "go", strings.Split(string(source), "\n"))
	if len(got) != 1 || got[0].LineStart != 2 {
		t.Fatalf("same-name Go methods must qualify by receiver: %+v", got)
	}
}

func TestGoParameterTypesCoverSharedAndAnonymousForms(t *testing.T) {
	for signature, want := range map[string][]string{
		"a, b string, c int": {"string", "string", "int"},
		"string, int":        {"string", "int"},
	} {
		got, known := actualParameterTypes("go", signature)
		if !known || !reflect.DeepEqual(got, want) {
			t.Fatalf("%q: got %+v, want %+v", signature, got, want)
		}
	}
}

func TestGenericAndCompoundReturnTypesArePreserved(t *testing.T) {
	for before, want := range map[string]string{
		"public async Task<bool> ": "Task<bool>",
		"virtual unsigned int ":    "unsignedint",
	} {
		got, known := actualReturnType("csharp", before, "")
		if !known || got != want {
			t.Fatalf("%q: got %q, want %q", before, got, want)
		}
	}
}

func TestDeclarationLookupIgnoresCommentMentionsAndSubstrings(t *testing.T) {
	declaration := "// Allow explains the operation\nfunc (r *AllowStruct) Allow(key string) bool { return true }"
	before, parameters, _, ok := balancedParameters(declaration, "Allow")
	if !ok || !strings.Contains(before, "func (r *AllowStruct)") || parameters != "key string" {
		t.Fatalf("method declaration was not isolated: before=%q params=%q ok=%v", before, parameters, ok)
	}
	if got := goReceiverType(declaration, "Allow"); got != "AllowStruct" {
		t.Fatalf("receiver substring confused qualification: %q", got)
	}
}
