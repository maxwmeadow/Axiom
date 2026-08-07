// Planned elements — authored UML for code that doesn't exist yet
// (UML_UX_PLAN.md REVISION 2). CRUD + reconciliation against reality.
package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
)

type RealizationState string

const (
	RealizationMatched RealizationState = "MATCHED"
	RealizationFlexed  RealizationState = "FLEXED"
	RealizationDrifted RealizationState = "DRIFTED"
	RealizationMissing RealizationState = "MISSING"
	RealizationUnknown RealizationState = "UNKNOWN"
)

type RealizationEvidence struct {
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

// PlannedMember is one declared function/method in a planned node.
type PlannedMember struct {
	Signature           string                `json:"signature"`        // "login(email, password)"
	Intent              string                `json:"intent,omitempty"` // one-line description
	Realized            bool                  `json:"realized"`         // true only for MATCHED or FLEXED
	RealizationState    RealizationState      `json:"realizationState,omitempty"`
	QualifiedSymbol     string                `json:"qualifiedSymbol,omitempty"`
	RealizationEvidence []RealizationEvidence `json:"realizationEvidence,omitempty"`
}

type PlannedNode struct {
	ID             string          `json:"id"`
	SheetID        string          `json:"sheetId"`
	WorkspaceID    string          `json:"workspaceId"`
	Kind           string          `json:"kind"`
	Name           string          `json:"name"`
	DeclaredPath   string          `json:"declaredPath"`
	Members        json.RawMessage `json:"members"`  // []PlannedMember
	Metadata       json.RawMessage `json:"metadata"` // versioned kind-specific UML metadata
	Status         string          `json:"status"`
	ApprovalStatus string          `json:"approvalStatus"` // pending|approved|rejected
	RealizedFileID *string         `json:"realizedFileId"`
	Notes          string          `json:"notes"`
	Shape          string          `json:"shape"` // ''=kind default | 'box'|'folder'|'cylinder'|'hexagon'
	Color          string          `json:"color"` // curated accent hex; '' = default
	PositionX      float64         `json:"positionX"`
	PositionY      float64         `json:"positionY"`
	Width          *float64        `json:"width"`
	Height         *float64        `json:"height"`
	Scale          float64         `json:"scale"`
	ParentSystemID *string         `json:"parentSystemId"`
	CreatedBy      string          `json:"createdBy"`
	CreatedAt      int64           `json:"createdAt"`
}

type PlannedEdge struct {
	ID          string  `json:"id"`
	SheetID     string  `json:"sheetId"`
	WorkspaceID string  `json:"workspaceId"`
	Kind        string  `json:"kind"`
	SrcPlanned  *string `json:"srcPlanned"`
	SrcLive     *string `json:"srcLive"`
	DstPlanned  *string `json:"dstPlanned"`
	DstLive     *string `json:"dstLive"`
	Note        string  `json:"note"`
}

const plannedCols = `id, sheet_id, workspace_id, kind, name, declared_path, members, metadata,
       status, approval_status, realized_file_id, notes, shape, color, position_x, position_y, width, height, scale, parent_system_id, created_by, created_at`

func UpsertPlannedNode(db *sql.DB, n *PlannedNode) error {
	if n.ID == "" {
		n.ID = uuid.New().String()
	}
	if n.Kind == "" {
		n.Kind = "class"
	}
	if n.Status == "" {
		n.Status = "planned"
	}
	if n.CreatedBy == "" {
		n.CreatedBy = "user"
	}
	if n.ApprovalStatus == "" {
		if n.CreatedBy == "agent" {
			n.ApprovalStatus = "pending"
		} else {
			n.ApprovalStatus = "approved"
		}
	}
	if n.ApprovalStatus != "pending" && n.ApprovalStatus != "approved" && n.ApprovalStatus != "rejected" {
		return fmt.Errorf("planned node approval must be pending, approved, or rejected")
	}
	if len(n.Members) == 0 {
		n.Members = json.RawMessage("[]")
	}
	if len(n.Metadata) == 0 {
		n.Metadata = json.RawMessage(`{"version":1}`)
	}
	if !json.Valid(n.Metadata) || strings.TrimSpace(string(n.Metadata))[0] != '{' {
		return fmt.Errorf("planned node metadata must be a JSON object")
	}
	if n.CreatedAt == 0 {
		n.CreatedAt = time.Now().UnixMilli()
	}
	n.Scale = normalizedScale(n.Scale)
	_, err := db.Exec(`
		INSERT INTO planned_nodes (`+plannedCols+`)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			kind=excluded.kind, name=excluded.name, declared_path=excluded.declared_path,
			members=excluded.members, metadata=excluded.metadata, status=excluded.status,
			approval_status=excluded.approval_status,
			realized_file_id=excluded.realized_file_id, notes=excluded.notes,
			shape=excluded.shape, color=excluded.color,
			position_x=excluded.position_x, position_y=excluded.position_y,
			width=excluded.width, height=excluded.height, scale=excluded.scale,
			parent_system_id=excluded.parent_system_id`,
		n.ID, n.SheetID, n.WorkspaceID, n.Kind, n.Name, n.DeclaredPath, string(n.Members), string(n.Metadata),
		n.Status, n.ApprovalStatus, n.RealizedFileID, n.Notes, n.Shape, n.Color, n.PositionX, n.PositionY, n.Width, n.Height, n.Scale, n.ParentSystemID, n.CreatedBy, n.CreatedAt)
	if err == nil {
		_ = TouchSheet(db, n.SheetID)
	}
	return err
}

func scanPlanned(rows *sql.Rows) ([]PlannedNode, error) {
	var out []PlannedNode
	for rows.Next() {
		var n PlannedNode
		var members, metadata string
		if err := rows.Scan(&n.ID, &n.SheetID, &n.WorkspaceID, &n.Kind, &n.Name,
			&n.DeclaredPath, &members, &metadata, &n.Status, &n.ApprovalStatus, &n.RealizedFileID, &n.Notes,
			&n.Shape, &n.Color, &n.PositionX, &n.PositionY, &n.Width, &n.Height, &n.Scale, &n.ParentSystemID, &n.CreatedBy, &n.CreatedAt); err != nil {
			return nil, err
		}
		n.Members = json.RawMessage(members)
		n.Metadata = json.RawMessage(metadata)
		out = append(out, n)
	}
	return out, rows.Err()
}

func GetPlannedNodes(db *sql.DB, sheetID string) ([]PlannedNode, error) {
	rows, err := db.Query(`SELECT `+plannedCols+` FROM planned_nodes WHERE sheet_id=?`, sheetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanPlanned(rows)
}

func GetPlannedNode(db *sql.DB, id string) (*PlannedNode, error) {
	rows, err := db.Query(`SELECT `+plannedCols+` FROM planned_nodes WHERE id=?`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	nodes, err := scanPlanned(rows)
	if err != nil || len(nodes) == 0 {
		return nil, err
	}
	return &nodes[0], nil
}

// GetOpenPlannedNodes returns unrealized planned nodes across all sheets —
// the reconciliation working set.
func GetOpenPlannedNodes(db *sql.DB, workspaceID string) ([]PlannedNode, error) {
	rows, err := db.Query(`SELECT `+plannedCols+` FROM planned_nodes
		WHERE workspace_id=? AND status IN ('planned','partial') AND approval_status='approved'`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanPlanned(rows)
}

func DeletePlannedNode(db *sql.DB, id string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var sheetID string
	if err := tx.QueryRow(`SELECT sheet_id FROM planned_nodes WHERE id=?`, id).Scan(&sheetID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM planned_nodes WHERE id=?`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM sheet_layouts WHERE sheet_id=? AND node_id=?`, sheetID, "planned:"+id); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`UPDATE sheets SET revision=revision+1,updated_at=? WHERE id=?`,
		time.Now().UnixMilli(), sheetID,
	); err != nil {
		return err
	}
	return tx.Commit()
}

func SetPlannedApproval(db *sql.DB, id, approval string) (*PlannedNode, error) {
	if approval != "approved" && approval != "rejected" {
		return nil, fmt.Errorf("approval must be approved or rejected")
	}
	result, err := db.Exec(
		`UPDATE planned_nodes SET approval_status=? WHERE id=? AND approval_status='pending'`,
		approval, id,
	)
	if err != nil {
		return nil, err
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		node, getErr := GetPlannedNode(db, id)
		if getErr != nil || node == nil {
			return nil, getErr
		}
		if node.ApprovalStatus != approval {
			return nil, fmt.Errorf("planned node is %s, not awaiting approval", node.ApprovalStatus)
		}
		return node, nil
	}
	return GetPlannedNode(db, id)
}

func UpdatePlannedPosition(db *sql.DB, id string, x, y float64) error {
	_, err := db.Exec(`UPDATE planned_nodes SET position_x=?, position_y=? WHERE id=?`, x, y, id)
	return err
}

func UpdatePlannedParent(db *sql.DB, id string, parentSystemID *string) error {
	var x, y float64
	if err := db.QueryRow(`SELECT position_x, position_y FROM planned_nodes WHERE id=?`, id).Scan(&x, &y); err != nil {
		return err
	}
	return UpdatePlannedLayout(db, id, x, y, parentSystemID, nil, nil, nil)
}

func UpdatePlannedLayout(db *sql.DB, id string, x, y float64, parentSystemID *string, width, height, scale *float64) error {
	var sheetID string
	if err := db.QueryRow(`SELECT sheet_id FROM planned_nodes WHERE id=?`, id).Scan(&sheetID); err != nil {
		return err
	}
	return UpdateSheetLayouts(db, sheetID, []SheetLayoutUpdate{{
		Kind: "planned", ID: id, X: x, Y: y, ParentSystemID: parentSystemID,
		Width: width, Height: height, Scale: scale,
	}})
}

func UpsertPlannedEdge(db *sql.DB, e *PlannedEdge) error {
	if e.ID == "" {
		e.ID = uuid.New().String()
	}
	if e.Kind == "" {
		e.Kind = "DEPENDS_ON"
	}
	_, err := db.Exec(`
		INSERT INTO planned_edges (id, sheet_id, workspace_id, kind, src_planned, src_live, dst_planned, dst_live, note)
		VALUES (?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, note=excluded.note`,
		e.ID, e.SheetID, e.WorkspaceID, e.Kind, e.SrcPlanned, e.SrcLive, e.DstPlanned, e.DstLive, e.Note)
	return err
}

func GetPlannedEdges(db *sql.DB, sheetID string) ([]PlannedEdge, error) {
	rows, err := db.Query(`
		SELECT id, sheet_id, workspace_id, kind, src_planned, src_live, dst_planned, dst_live, note
		FROM planned_edges WHERE sheet_id=?`, sheetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PlannedEdge
	for rows.Next() {
		var e PlannedEdge
		if err := rows.Scan(&e.ID, &e.SheetID, &e.WorkspaceID, &e.Kind,
			&e.SrcPlanned, &e.SrcLive, &e.DstPlanned, &e.DstLive, &e.Note); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func DeletePlannedEdge(db *sql.DB, id string) error {
	_, err := db.Exec(`DELETE FROM planned_edges WHERE id=?`, id)
	return err
}

// ─── Reconciliation ───────────────────────────────────────────────────────────

type plannedParameter struct {
	Name     string `json:"name"`
	DataType string `json:"dataType"`
}

type plannedMethod struct {
	Visibility string              `json:"visibility"`
	Name       string              `json:"name"`
	Parameters *[]plannedParameter `json:"parameters"`
	ReturnType string              `json:"returnType"`
}

type plannedRealization struct {
	State            RealizationState      `json:"state"`
	PathMatchQuality string                `json:"pathMatchQuality"`
	QualifiedSymbol  string                `json:"qualifiedSymbol,omitempty"`
	Evidence         []RealizationEvidence `json:"evidence"`
}

type plannedMetadata struct {
	Version     int                 `json:"version"`
	Path        string              `json:"path,omitempty"`
	Methods     *[]plannedMethod    `json:"methods,omitempty"`
	Endpoints   *[]plannedMethod    `json:"endpoints,omitempty"`
	Realization *plannedRealization `json:"realization,omitempty"`
}

type memberAssertion struct {
	Name       string
	Visibility string
	Parameters *[]plannedParameter
	ReturnType string
	Structured bool
}

type actualContract struct {
	ParameterTypes  []string
	ArityKnown      bool
	ReturnType      string
	ReturnKnown     bool
	Visibility      string
	VisibilityKnown bool
}

type pathMatch struct {
	File    *File
	Quality string
	Detail  string
}

func memberName(sig string) string {
	if i := strings.IndexAny(sig, "( "); i > 0 {
		return strings.TrimSpace(sig[:i])
	}
	return strings.TrimSpace(sig)
}

func normalizedPlannedPath(path string) string {
	path = filepath.ToSlash(strings.TrimSpace(path))
	path = strings.TrimPrefix(path, "./")
	return strings.ToLower(strings.Trim(path, "/"))
}

// matchPlannedPath refuses ambiguous suffix matches. A unique suffix is kept
// as explicit FLEXED evidence; it can never be reported as an exact match.
func matchPlannedPath(files []File, declared string) pathMatch {
	want := normalizedPlannedPath(declared)
	if want == "" {
		return pathMatch{Quality: "none", Detail: "no target path was declared"}
	}
	var suffixes []*File
	for i := range files {
		rel := normalizedPlannedPath(files[i].RelPath)
		if rel == want {
			return pathMatch{File: &files[i], Quality: "exact", Detail: files[i].RelPath}
		}
		if strings.HasSuffix(rel, "/"+want) {
			suffixes = append(suffixes, &files[i])
		}
	}
	if len(suffixes) == 1 {
		return pathMatch{
			File: suffixes[0], Quality: "unique-suffix",
			Detail: fmt.Sprintf("%s matched declared suffix %s", suffixes[0].RelPath, declared),
		}
	}
	if len(suffixes) > 1 {
		return pathMatch{
			Quality: "ambiguous-suffix",
			Detail:  fmt.Sprintf("%d indexed files end with %s", len(suffixes), declared),
		}
	}
	return pathMatch{Quality: "missing", Detail: fmt.Sprintf("no indexed file matches %s", declared)}
}

func structuredAssertions(metadata plannedMetadata) ([]memberAssertion, bool) {
	var methods []plannedMethod
	switch {
	case metadata.Methods != nil:
		methods = *metadata.Methods
	case metadata.Endpoints != nil:
		methods = *metadata.Endpoints
	default:
		return nil, false
	}
	out := make([]memberAssertion, 0, len(methods))
	for _, method := range methods {
		if strings.TrimSpace(method.Name) == "" {
			continue
		}
		out = append(out, memberAssertion{
			Name: strings.TrimSpace(method.Name), Visibility: strings.TrimSpace(method.Visibility),
			Parameters: method.Parameters, ReturnType: strings.TrimSpace(method.ReturnType),
			Structured: true,
		})
	}
	return out, true
}

func legacyAssertions(members []PlannedMember) []memberAssertion {
	out := make([]memberAssertion, 0, len(members))
	for _, member := range members {
		if name := memberName(member.Signature); name != "" {
			out = append(out, memberAssertion{Name: name})
		}
	}
	return out
}

func assertionSignature(assertion memberAssertion) string {
	if !assertion.Structured {
		return assertion.Name
	}
	params := []string{}
	if assertion.Parameters != nil {
		for _, parameter := range *assertion.Parameters {
			value := strings.TrimSpace(parameter.Name)
			if dataType := strings.TrimSpace(parameter.DataType); dataType != "" {
				if value != "" {
					value += ": "
				}
				value += dataType
			}
			params = append(params, value)
		}
	}
	signature := fmt.Sprintf("%s(%s)", assertion.Name, strings.Join(params, ", "))
	if assertion.ReturnType != "" {
		signature += ": " + assertion.ReturnType
	}
	return signature
}

func sourceLinesForSymbol(lines []string, symbol Symbol) string {
	start := max(0, symbol.LineStart-1)
	end := min(len(lines), max(symbol.LineEnd, symbol.LineStart))
	if start >= len(lines) || start >= end {
		return ""
	}
	return strings.Join(lines[start:end], "\n")
}

func identifierStart(value, name string) int {
	for offset := 0; offset < len(value); {
		index := strings.Index(value[offset:], name)
		if index < 0 {
			return -1
		}
		index += offset
		before, _ := utf8.DecodeLastRuneInString(value[:index])
		beforeOK := index == 0 || !isIdentifierRune(before)
		afterIndex := index + len(name)
		after, _ := utf8.DecodeRuneInString(value[afterIndex:])
		afterOK := afterIndex == len(value) || !isIdentifierRune(after)
		if beforeOK && afterOK {
			cursor := afterIndex
			for cursor < len(value) && unicode.IsSpace(rune(value[cursor])) {
				cursor++
			}
			if cursor < len(value) && (value[cursor] == '(' || value[cursor] == '<') {
				return index
			}
		}
		offset = index + len(name)
	}
	return -1
}

func isIdentifierRune(char rune) bool {
	return unicode.IsLetter(char) || unicode.IsDigit(char) || char == '_' || char == '$' || char == '#'
}

func stripDeclarationComments(value string) string {
	var result strings.Builder
	var quote byte
	escaped := false
	lineComment, blockComment := false, false
	for index := 0; index < len(value); index++ {
		char := value[index]
		next := byte(0)
		if index+1 < len(value) {
			next = value[index+1]
		}
		if lineComment {
			if char == '\n' {
				lineComment = false
				result.WriteByte(char)
			}
			continue
		}
		if blockComment {
			if char == '*' && next == '/' {
				blockComment = false
				index++
			}
			continue
		}
		if quote != 0 {
			result.WriteByte(char)
			if escaped {
				escaped = false
			} else if char == '\\' {
				escaped = true
			} else if char == quote {
				quote = 0
			}
			continue
		}
		if char == '/' && next == '/' {
			lineComment = true
			index++
			continue
		}
		if char == '/' && next == '*' {
			blockComment = true
			index++
			continue
		}
		result.WriteByte(char)
		if char == '\'' || char == '"' || char == '`' {
			quote = char
		}
	}
	return result.String()
}

func splitTopLevel(value string, separator rune) []string {
	var parts []string
	start, depth := 0, 0
	var quote rune
	escaped := false
	for index, char := range value {
		if quote != 0 {
			if escaped {
				escaped = false
			} else if char == '\\' {
				escaped = true
			} else if char == quote {
				quote = 0
			}
			continue
		}
		switch char {
		case '\'', '"', '`':
			quote = char
		case '(', '[', '{', '<':
			depth++
		case ')', ']', '}', '>':
			if depth > 0 {
				depth--
			}
		default:
			if char == separator && depth == 0 {
				parts = append(parts, strings.TrimSpace(value[start:index]))
				start = index + 1
			}
		}
	}
	parts = append(parts, strings.TrimSpace(value[start:]))
	return parts
}

func balancedParameters(declaration, name string) (before, parameters, after string, ok bool) {
	declaration = stripDeclarationComments(declaration)
	nameAt := identifierStart(declaration, name)
	if nameAt < 0 {
		return "", "", "", false
	}
	openOffset := strings.Index(declaration[nameAt+len(name):], "(")
	if openOffset < 0 {
		return "", "", "", false
	}
	open := nameAt + len(name) + openOffset
	depth := 0
	var quote byte
	escaped := false
	for index := open; index < len(declaration); index++ {
		char := declaration[index]
		if quote != 0 {
			if escaped {
				escaped = false
			} else if char == '\\' {
				escaped = true
			} else if char == quote {
				quote = 0
			}
			continue
		}
		if char == '\'' || char == '"' || char == '`' {
			quote = char
			continue
		}
		if char == '(' {
			depth++
		} else if char == ')' {
			depth--
			if depth == 0 {
				return declaration[:nameAt], declaration[open+1 : index], declaration[index+1:], true
			}
		}
	}
	return "", "", "", false
}

func stripDefault(value string) string {
	parts := splitTopLevel(value, '=')
	if len(parts) == 0 {
		return strings.TrimSpace(value)
	}
	return strings.TrimSpace(parts[0])
}

func trimTypeTail(value string) string {
	value = strings.TrimSpace(value)
	for _, token := range []string{"{", ";", "=>", "\n"} {
		if index := strings.Index(value, token); index >= 0 {
			value = value[:index]
		}
	}
	return strings.TrimSpace(value)
}

func canonicalType(value string) string {
	value = strings.TrimSpace(value)
	value = strings.TrimPrefix(value, "...")
	return strings.Map(func(char rune) rune {
		if unicode.IsSpace(char) {
			return -1
		}
		return char
	}, value)
}

func inferVisibility(language, name, before, containerKind string) (string, bool) {
	lower := " " + strings.ToLower(before) + " "
	for _, visibility := range []string{"public", "private", "protected", "package"} {
		if strings.Contains(lower, " "+visibility+" ") {
			return visibility, true
		}
	}
	switch language {
	case "typescript", "tsx", "javascript":
		return "public", true
	case "go":
		if name != "" && unicode.IsUpper([]rune(name)[0]) {
			return "public", true
		}
		return "package", true
	case "python":
		if strings.HasPrefix(name, "_") {
			return "private", true
		}
		return "public", true
	case "rust":
		if strings.Contains(lower, " pub ") {
			return "public", true
		}
		return "private", true
	case "java":
		if containerKind == "interface" {
			return "public", true
		}
		return "package", true
	case "csharp":
		if containerKind == "interface" {
			return "public", true
		}
		return "private", true
	default:
		return "", false
	}
}

func actualParameterTypes(language, parameters string) ([]string, bool) {
	if strings.TrimSpace(parameters) == "" {
		return []string{}, true
	}
	raw := splitTopLevel(parameters, ',')
	if language == "go" {
		out := make([]string, len(raw))
		pending := []int{}
		for index, parameter := range raw {
			value := stripDefault(strings.TrimSpace(parameter))
			fields := strings.Fields(value)
			if len(fields) < 2 {
				pending = append(pending, index)
				continue
			}
			dataType := canonicalType(strings.Join(fields[1:], ""))
			for _, pendingIndex := range pending {
				out[pendingIndex] = dataType
			}
			pending = pending[:0]
			out[index] = dataType
		}
		// A trailing run of single tokens is the standard anonymous-parameter
		// form: Allow(string, int). Each token is its own type.
		for _, pendingIndex := range pending {
			out[pendingIndex] = canonicalType(stripDefault(raw[pendingIndex]))
		}
		return out, true
	}
	out := make([]string, 0, len(raw))
	for _, parameter := range raw {
		value := stripDefault(strings.TrimSpace(parameter))
		if value == "" {
			continue
		}
		if (language == "python" || language == "rust") &&
			(value == "self" || value == "&self" || value == "&mut self" || value == "cls") {
			continue
		}
		var dataType string
		switch language {
		case "typescript", "tsx", "javascript", "python", "rust":
			if colon := strings.Index(value, ":"); colon >= 0 {
				dataType = strings.TrimSpace(value[colon+1:])
			}
		default:
			fields := strings.Fields(value)
			for len(fields) > 0 && (fields[0] == "final" || fields[0] == "ref" ||
				fields[0] == "out" || fields[0] == "in" || strings.HasPrefix(fields[0], "@")) {
				fields = fields[1:]
			}
			if len(fields) >= 2 {
				dataType = strings.Join(fields[:len(fields)-1], " ")
			}
		}
		out = append(out, canonicalType(dataType))
	}
	return out, true
}

func actualReturnType(language, before, after string) (string, bool) {
	switch language {
	case "typescript", "tsx", "javascript":
		after = strings.TrimSpace(after)
		if strings.HasPrefix(after, ":") {
			return canonicalType(trimTypeTail(strings.TrimPrefix(after, ":"))), true
		}
	case "python", "rust":
		if arrow := strings.Index(after, "->"); arrow >= 0 {
			value := trimTypeTail(after[arrow+2:])
			if colon := strings.LastIndex(value, ":"); language == "python" && colon >= 0 {
				value = value[:colon]
			}
			return canonicalType(value), true
		}
	case "go":
		value := trimTypeTail(after)
		if value != "" {
			return canonicalType(value), true
		}
	default:
		modifiers := map[string]bool{
			"public": true, "private": true, "protected": true, "package": true,
			"static": true, "final": true, "abstract": true, "async": true,
			"virtual": true, "override": true, "extern": true, "unsafe": true,
		}
		tokens := strings.Fields(strings.TrimSpace(before))
		for len(tokens) > 0 &&
			(modifiers[strings.ToLower(tokens[0])] || strings.HasPrefix(tokens[0], "@")) {
			tokens = tokens[1:]
		}
		if len(tokens) > 0 {
			return canonicalType(strings.Join(tokens, " ")), true
		}
	}
	return "", false
}

func parseActualContract(language, declaration, name, containerKind string) (actualContract, bool) {
	before, parameters, after, ok := balancedParameters(declaration, name)
	if !ok {
		return actualContract{}, false
	}
	parameterTypes, arityKnown := actualParameterTypes(language, parameters)
	returnType, returnKnown := actualReturnType(language, before, after)
	visibility, visibilityKnown := inferVisibility(language, name, before, containerKind)
	return actualContract{
		ParameterTypes: parameterTypes, ArityKnown: arityKnown,
		ReturnType: returnType, ReturnKnown: returnKnown,
		Visibility: visibility, VisibilityKnown: visibilityKnown,
	}, true
}

func compareContract(assertion memberAssertion, actual actualContract) (RealizationState, []RealizationEvidence) {
	evidence := []RealizationEvidence{}
	unknown := false
	if assertion.Parameters != nil {
		if !actual.ArityKnown {
			unknown = true
			evidence = append(evidence, RealizationEvidence{Kind: "contract.unknown", Detail: "parameter arity could not be parsed"})
		} else if len(*assertion.Parameters) != len(actual.ParameterTypes) {
			return RealizationDrifted, []RealizationEvidence{{
				Kind:   "contract.arity",
				Detail: fmt.Sprintf("planned %d parameters, indexed declaration has %d", len(*assertion.Parameters), len(actual.ParameterTypes)),
			}}
		} else {
			for index, parameter := range *assertion.Parameters {
				want := canonicalType(parameter.DataType)
				if want == "" {
					continue
				}
				got := actual.ParameterTypes[index]
				if got == "" {
					unknown = true
					evidence = append(evidence, RealizationEvidence{
						Kind:   "contract.unknown",
						Detail: fmt.Sprintf("parameter %d type is not explicit in code", index+1),
					})
				} else if got != want {
					return RealizationDrifted, []RealizationEvidence{{
						Kind:   "contract.parameter-type",
						Detail: fmt.Sprintf("parameter %d planned %s, indexed declaration has %s", index+1, want, got),
					}}
				}
			}
		}
	}
	if want := canonicalType(assertion.ReturnType); want != "" {
		if !actual.ReturnKnown || actual.ReturnType == "" {
			unknown = true
			evidence = append(evidence, RealizationEvidence{Kind: "contract.unknown", Detail: "return type is not explicit in code"})
		} else if actual.ReturnType != want {
			return RealizationDrifted, []RealizationEvidence{{
				Kind:   "contract.return-type",
				Detail: fmt.Sprintf("planned %s, indexed declaration has %s", want, actual.ReturnType),
			}}
		}
	}
	if want := strings.ToLower(strings.TrimSpace(assertion.Visibility)); want != "" {
		if !actual.VisibilityKnown {
			unknown = true
			evidence = append(evidence, RealizationEvidence{Kind: "contract.unknown", Detail: "visibility could not be proven"})
		} else if actual.Visibility != want {
			return RealizationDrifted, []RealizationEvidence{{
				Kind:   "contract.visibility",
				Detail: fmt.Sprintf("planned %s, indexed declaration is %s", want, actual.Visibility),
			}}
		}
	}
	if unknown {
		return RealizationUnknown, evidence
	}
	return RealizationMatched, evidence
}

func enclosingContainer(symbols []Symbol, node PlannedNode) (*Symbol, bool) {
	var matches []Symbol
	for _, symbol := range symbols {
		if symbol.Name == node.Name &&
			(symbol.Kind == "class" || symbol.Kind == "interface" || symbol.Kind == "type") {
			matches = append(matches, symbol)
		}
	}
	if len(matches) == 1 {
		return &matches[0], true
	}
	if len(matches) > 1 || node.Kind == "class" {
		return nil, false
	}
	return nil, true
}

func goReceiverType(declaration, name string) string {
	declaration = stripDeclarationComments(declaration)
	nameAt := identifierStart(declaration, name)
	if nameAt < 0 {
		return ""
	}
	prefix := declaration[:nameAt]
	funcAt := strings.Index(prefix, "func")
	if funcAt < 0 {
		return ""
	}
	open := strings.Index(prefix[funcAt+len("func"):], "(")
	if open < 0 {
		return ""
	}
	open += funcAt + len("func")
	close := strings.Index(prefix[open+1:], ")")
	if close < 0 {
		return ""
	}
	receiver := strings.Fields(prefix[open+1 : open+1+close])
	if len(receiver) == 0 {
		return ""
	}
	receiverType := strings.Trim(receiver[len(receiver)-1], "*[]")
	if dot := strings.LastIndex(receiverType, "."); dot >= 0 {
		receiverType = receiverType[dot+1:]
	}
	return receiverType
}

func qualifiedMemberCandidates(
	symbols []Symbol,
	container *Symbol,
	name, language string,
	sourceLines []string,
) []Symbol {
	out := []Symbol{}
	for _, symbol := range symbols {
		if symbol.Name != name || (symbol.Kind != "method" && symbol.Kind != "function") {
			continue
		}
		if container != nil {
			if language == "go" {
				declaration := sourceLinesForSymbol(sourceLines, symbol)
				if goReceiverType(declaration, symbol.Name) != container.Name {
					continue
				}
			} else if symbol.LineStart < container.LineStart || symbol.LineEnd > container.LineEnd {
				continue
			}
		}
		out = append(out, symbol)
	}
	return out
}

func reconcileMember(
	assertion memberAssertion,
	symbols []Symbol,
	container *Symbol,
	sourceLines []string,
	language string,
	path pathMatch,
) PlannedMember {
	qualified := path.File.RelPath + "::" + assertion.Name
	if container != nil {
		qualified = container.Name + "." + assertion.Name
	}
	member := PlannedMember{
		Signature:        assertionSignature(assertion),
		QualifiedSymbol:  qualified,
		RealizationState: RealizationMissing,
		RealizationEvidence: []RealizationEvidence{{
			Kind: "symbol.missing", Detail: fmt.Sprintf("indexed symbol %s was not found", qualified),
		}},
	}
	candidates := qualifiedMemberCandidates(symbols, container, assertion.Name, language, sourceLines)
	if len(candidates) > 1 && assertion.Structured {
		containerKind := ""
		if container != nil {
			containerKind = container.Kind
		}
		compatible := []Symbol{}
		unresolved := false
		for _, candidate := range candidates {
			declaration := sourceLinesForSymbol(sourceLines, candidate)
			actual, ok := parseActualContract(language, declaration, candidate.Name, containerKind)
			if !ok {
				unresolved = true
				continue
			}
			state, _ := compareContract(assertion, actual)
			if state == RealizationMatched {
				compatible = append(compatible, candidate)
			} else if state == RealizationUnknown {
				unresolved = true
			}
		}
		if len(compatible) == 1 {
			candidates = compatible
		} else if len(compatible) == 0 && !unresolved {
			member.RealizationState = RealizationDrifted
			member.RealizationEvidence = []RealizationEvidence{{
				Kind:   "contract.overload",
				Detail: fmt.Sprintf("%d indexed overloads exist for %s, but none implements the planned contract", len(candidates), qualified),
			}}
			return member
		}
	}
	if len(candidates) > 1 {
		member.RealizationState = RealizationUnknown
		member.RealizationEvidence = []RealizationEvidence{{
			Kind: "symbol.ambiguous", Detail: fmt.Sprintf("%d indexed symbols match %s", len(candidates), qualified),
		}}
		return member
	}
	if len(candidates) == 0 {
		return member
	}
	member.RealizationEvidence = []RealizationEvidence{{
		Kind:   "symbol.indexed",
		Detail: fmt.Sprintf("%s at %s:%d", qualified, path.File.RelPath, candidates[0].LineStart),
	}}
	if assertion.Structured {
		declaration := sourceLinesForSymbol(sourceLines, candidates[0])
		containerKind := ""
		if container != nil {
			containerKind = container.Kind
		}
		actual, ok := parseActualContract(language, declaration, candidates[0].Name, containerKind)
		if !ok {
			member.RealizationState = RealizationUnknown
			member.RealizationEvidence = append(member.RealizationEvidence, RealizationEvidence{
				Kind: "contract.unknown", Detail: "indexed declaration could not be parsed",
			})
			return member
		}
		state, evidence := compareContract(assertion, actual)
		member.RealizationState = state
		member.RealizationEvidence = append(member.RealizationEvidence, evidence...)
		if state == RealizationDrifted || state == RealizationUnknown {
			return member
		}
	}
	if path.Quality == "unique-suffix" {
		member.RealizationState = RealizationFlexed
		member.RealizationEvidence = append(member.RealizationEvidence, RealizationEvidence{
			Kind: "path.relocated", Detail: path.Detail,
		})
	} else {
		member.RealizationState = RealizationMatched
	}
	member.Realized = true
	return member
}

func stateForMembers(members []PlannedMember, fallback RealizationState) RealizationState {
	if len(members) == 0 {
		return fallback
	}
	state := RealizationMatched
	for _, member := range members {
		switch member.RealizationState {
		case RealizationDrifted:
			return RealizationDrifted
		case RealizationUnknown:
			state = RealizationUnknown
		case RealizationMissing:
			if state != RealizationUnknown {
				state = RealizationMissing
			}
		case RealizationFlexed:
			if state == RealizationMatched {
				state = RealizationFlexed
			}
		}
	}
	return state
}

func setMetadataRealization(raw json.RawMessage, realization plannedRealization) (json.RawMessage, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(realization)
	if err != nil {
		return nil, err
	}
	object["realization"] = encoded
	return json.Marshal(object)
}

// ReconcilePlanned treats indexed symbols as corroboration and source text at
// those exact ranges as contract evidence. Agent-provided paths or mappings are
// search hints only: without an indexed file and symbol the result cannot be
// MATCHED. Returns nodes whose persisted realization projection changed.
func ReconcilePlanned(sqlDB *sql.DB, workspaceID string) ([]PlannedNode, error) {
	open, err := GetOpenPlannedNodes(sqlDB, workspaceID)
	if err != nil || len(open) == 0 {
		return nil, err
	}
	files, err := GetFiles(sqlDB, workspaceID)
	if err != nil {
		return nil, err
	}

	var changed []PlannedNode
	for _, node := range open {
		var metadata plannedMetadata
		_ = json.Unmarshal(node.Metadata, &metadata)
		declaredPath := node.DeclaredPath
		if strings.TrimSpace(declaredPath) == "" {
			declaredPath = metadata.Path
		}
		path := matchPlannedPath(files, declaredPath)

		var existingMembers []PlannedMember
		_ = json.Unmarshal(node.Members, &existingMembers)
		assertions, structured := structuredAssertions(metadata)
		if !structured {
			assertions = legacyAssertions(existingMembers)
		}
		intents := map[string]string{}
		for _, member := range existingMembers {
			intents[memberName(member.Signature)] = member.Intent
		}

		nextMembers := make([]PlannedMember, 0, len(assertions))
		nodeState := RealizationUnknown
		nodeEvidence := []RealizationEvidence{{Kind: "path." + path.Quality, Detail: path.Detail}}
		qualifiedNode := node.Name
		var realizedFileID *string
		if path.File == nil {
			if path.Quality == "missing" {
				nodeState = RealizationMissing
			}
			for _, assertion := range assertions {
				nextMembers = append(nextMembers, PlannedMember{
					Signature: assertionSignature(assertion), Intent: intents[assertion.Name],
					QualifiedSymbol:  node.Name + "." + assertion.Name,
					RealizationState: nodeState, RealizationEvidence: nodeEvidence,
				})
			}
		} else {
			realizedFileID = &path.File.ID
			symbols, symbolsErr := GetSymbolsByFile(sqlDB, path.File.ID)
			source, sourceErr := os.ReadFile(path.File.Path)
			if symbolsErr != nil || sourceErr != nil {
				nodeState = RealizationUnknown
				detail := "indexed evidence could not be loaded"
				if symbolsErr != nil {
					detail = symbolsErr.Error()
				} else if sourceErr != nil {
					detail = sourceErr.Error()
				}
				nodeEvidence = append(nodeEvidence, RealizationEvidence{Kind: "evidence.unavailable", Detail: detail})
				for _, assertion := range assertions {
					nextMembers = append(nextMembers, PlannedMember{
						Signature: assertionSignature(assertion), Intent: intents[assertion.Name],
						QualifiedSymbol:  node.Name + "." + assertion.Name,
						RealizationState: RealizationUnknown, RealizationEvidence: nodeEvidence,
					})
				}
			} else {
				sourceLines := strings.Split(string(source), "\n")
				container, containerOK := enclosingContainer(symbols, node)
				if !containerOK {
					nodeState = RealizationMissing
					nodeEvidence = append(nodeEvidence, RealizationEvidence{
						Kind:   "symbol.missing",
						Detail: fmt.Sprintf("indexed container %s was not found uniquely in %s", node.Name, path.File.RelPath),
					})
					for _, assertion := range assertions {
						nextMembers = append(nextMembers, PlannedMember{
							Signature: assertionSignature(assertion), Intent: intents[assertion.Name],
							QualifiedSymbol:  node.Name + "." + assertion.Name,
							RealizationState: RealizationMissing, RealizationEvidence: nodeEvidence,
						})
					}
				} else {
					if container != nil {
						qualifiedNode = container.Name
					}
					for _, assertion := range assertions {
						member := reconcileMember(assertion, symbols, container, sourceLines, path.File.Language, path)
						member.Intent = intents[assertion.Name]
						nextMembers = append(nextMembers, member)
					}
					fallback := RealizationMatched
					if path.Quality == "unique-suffix" {
						fallback = RealizationFlexed
					}
					nodeState = stateForMembers(nextMembers, fallback)
				}
			}
		}

		allRealized := true
		for _, member := range nextMembers {
			if !member.Realized {
				allRealized = false
				break
			}
		}
		newStatus := "planned"
		if path.File != nil {
			newStatus = "partial"
			if allRealized && (nodeState == RealizationMatched || nodeState == RealizationFlexed) {
				newStatus = "realized"
			}
		}
		realization := plannedRealization{
			State: nodeState, PathMatchQuality: path.Quality,
			QualifiedSymbol: qualifiedNode, Evidence: nodeEvidence,
		}
		nextMetadata, metadataErr := setMetadataRealization(node.Metadata, realization)
		if metadataErr != nil {
			continue
		}
		nextMembersJSON, _ := json.Marshal(nextMembers)
		dirty := string(nextMembersJSON) != string(node.Members) ||
			string(nextMetadata) != string(node.Metadata) ||
			node.Status != newStatus ||
			(node.RealizedFileID == nil) != (realizedFileID == nil) ||
			(node.RealizedFileID != nil && realizedFileID != nil && *node.RealizedFileID != *realizedFileID)
		if !dirty {
			continue
		}
		node.Members = nextMembersJSON
		node.Metadata = nextMetadata
		node.Status = newStatus
		node.RealizedFileID = realizedFileID
		if err := UpsertPlannedNode(sqlDB, &node); err != nil {
			return changed, err
		}
		changed = append(changed, node)
	}
	return changed, nil
}
