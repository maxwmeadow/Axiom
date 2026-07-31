package delta

import (
	"fmt"
	"math"
	"sort"
)

// A Claim is the unit of architectural review.
//
// The first version of this feature listed raw journal changes, and a single
// architectural fact — "Api now depends on Storage" — arrived as five separate
// rows: one per call site, plus the import that came with them. That is a log,
// not a diff. Nobody reviews five rows to learn one thing.
//
// A claim is the smallest statement that changes your understanding of the
// architecture. Call sites, imports, and individual files become EVIDENCE
// nested under the claim they support. Compaction is the whole point: twenty
// files newly importing one module is one claim with twenty pieces of
// evidence, never twenty claims.
//
// Claims are also where dispatched intent attaches. Once the forward loop
// exists (you draw what should be built, agents execute it), each corroborated
// claim can be classified as matched, flexed, drifted, or unknown. A claim
// already asserts something about the architecture, which is exactly what
// immutable intent can confirm or contradict.

type ClaimKind string

const (
	// A system depends on another system for the first time in this window.
	ClaimCoupling ClaimKind = "system.coupling"
	// A system no longer depends on another system.
	ClaimDecoupling ClaimKind = "system.decoupling"
	// A system crossed from ordinary participant to high-connectivity hub.
	ClaimHubTransition ClaimKind = "system.hub"
	// A still-existing system lost its final architectural connection.
	ClaimOrphaned      ClaimKind = "system.orphaned"
	ClaimSystemAdded   ClaimKind = "system.added"
	ClaimSystemRemoved ClaimKind = "system.removed"
	// A system gained or lost member files.
	ClaimMembership ClaimKind = "system.membership"
	// New files the classifier has not placed into any system yet.
	ClaimUnclassified ClaimKind = "file.unclassified"
	// Churn wholly inside one system's boundary. Real, but not architecture.
	ClaimInternal ClaimKind = "system.internal"
)

// Base severities. These rank what a change means structurally, before any
// evidence weighting. Deliberately coarse — precision here would be invented.
var claimSeverity = map[ClaimKind]int{
	ClaimCoupling:      7,
	ClaimHubTransition: 8,
	ClaimOrphaned:      8,
	ClaimSystemRemoved: 6,
	ClaimSystemAdded:   6,
	ClaimDecoupling:    5,
	ClaimMembership:    4,
	ClaimUnclassified:  3,
	ClaimInternal:      1,
}

// cycleSeverity replaces the base score when a new coupling closes a loop
// between systems. A cycle is the one structural change that is nearly always
// a mistake, so it outranks everything else in the delta.
const cycleSeverity = 10

// Evidence is one concrete fact supporting a claim: a call site, an import, a
// file that appeared. It is what you read after the claim convinces you to
// look closer.
type Evidence struct {
	Kind    string   `json:"kind"`
	Label   string   `json:"label"`
	Detail  string   `json:"detail,omitempty"`
	FileIDs []string `json:"fileIds,omitempty"`
}

// Claim is one reviewable architectural statement.
type Claim struct {
	ID       string    `json:"id"`
	Kind     ClaimKind `json:"kind"`
	Title    string    `json:"title"`
	Subtitle string    `json:"subtitle"`
	Severity int       `json:"severity"`
	Score    float64   `json:"score"`
	Actor    string    `json:"actor"`
	TS       int64     `json:"ts"`
	// CreatesCycle marks a coupling that closes a dependency loop.
	CreatesCycle bool `json:"createsCycle"`
	// Internal claims stay hidden until the user asks for internal churn.
	Internal bool `json:"internal"`
	// FocusSystemIDs are what the camera frames — for a boundary claim the
	// boundary IS the claim, so both systems must be on screen.
	FocusSystemIDs []string `json:"focusSystemIds,omitempty"`
	// FocusFileIDs are framed when no system context applies.
	FocusFileIDs []string   `json:"focusFileIds,omitempty"`
	Evidence     []Evidence `json:"evidence"`
	// Corroborated means the claim was derived from indexed structural facts.
	// Agent narration and reported mappings are never enough on their own.
	Corroborated bool `json:"corroborated"`
	// SessionID ties this claim to the work an agent said it was doing. Empty
	// means unexplained: the change is real but nobody narrated it.
	SessionID string `json:"sessionId,omitempty"`
	// RealizationState compares corroborated agent-produced facts with an
	// immutable Sheet spec. Human changes are left unclassified.
	RealizationState    RealizationState `json:"realizationState,omitempty"`
	RealizationEvidence []Evidence       `json:"realizationEvidence,omitempty"`
	IntentIDs           []string         `json:"intentIds,omitempty"`
	// IntentStatus is retained only for the command-deck aggregate while that
	// read-only surface migrates. It is intentionally excluded from the API.
	IntentStatus string `json:"-"`
}

// SystemTopology is the CURRENT system-level dependency graph, supplied by the
// caller (which has database access). It exists so a new coupling can be
// checked for closing a cycle — the journal alone cannot know that.
type SystemTopology map[string]map[string]bool

// ArchitectureSnapshot is the exact system graph at one delta boundary.
// Journal events alone cannot prove consequences that depend on the whole
// before/after shape, such as becoming a hub or losing the final link.
type ArchitectureSnapshot struct {
	Systems  map[string]string `json:"systems"`
	Topology SystemTopology    `json:"topology"`
}

// reaches reports whether `from` can already get to `to` through the current
// system graph, ignoring the direct edge between them.
func (t SystemTopology) reaches(from, to string) bool {
	if t == nil || from == "" || to == "" {
		return false
	}
	seen := map[string]bool{from: true}
	queue := []string{}
	for next := range t[from] {
		if next == to {
			continue // the direct edge is the one being judged
		}
		queue = append(queue, next)
	}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		if current == to {
			return true
		}
		if seen[current] {
			continue
		}
		seen[current] = true
		for next := range t[current] {
			queue = append(queue, next)
		}
	}
	return false
}

type systemPair struct {
	srcID, dstID     string
	srcName, dstName string
}

type couplingGroup struct {
	systemPair
	change   string
	evidence []Evidence
	// callPairs suppresses the IMPORTS that merely accompanies a resolved
	// CALLS between the same two files. The living choreography already makes
	// this call: one code change should read as one fact.
	callPairs       map[string]bool
	imports         map[string]int
	actor           string
	sessionID       string
	sessionConflict bool
	ts              int64
}

func systemLabel(name, id string) string {
	if name != "" {
		return name
	}
	if id != "" {
		return id
	}
	return "unclassified"
}

func callSiteLabel(edge EdgeChange) string {
	if edge.CallerSymbol != "" && edge.CalleeSymbol != "" {
		return fmt.Sprintf("%s() → %s()", edge.CallerSymbol, edge.CalleeSymbol)
	}
	return fmt.Sprintf("imports %s", edge.DstLabel)
}

func pluralFiles(n int) string {
	if n == 1 {
		return "1 file"
	}
	return fmt.Sprintf("%d files", n)
}

// BuildClaims folds a net summary into ranked architectural claims.
func BuildClaims(summary Summary, topology SystemTopology) []Claim {
	return buildClaims(summary, topology, nil, nil)
}

// BuildClaimsWithSnapshots adds consequences that can only be proven by exact
// graph boundaries. Nil snapshots suppress those claims: missing evidence
// must never become an invented hub or orphan story.
func BuildClaimsWithSnapshots(
	summary Summary,
	before, after *ArchitectureSnapshot,
) []Claim {
	var topology SystemTopology
	if after != nil {
		topology = after.Topology
	}
	return buildClaims(summary, topology, before, after)
}

func buildClaims(
	summary Summary,
	topology SystemTopology,
	before, after *ArchitectureSnapshot,
) []Claim {
	claims := []Claim{}

	// ── Boundary changes, grouped by system pair ────────────────────────────
	groups := map[string]*couplingGroup{}
	order := []string{}
	// Internal edge churn is counted per system, never listed per edge.
	internalEdges := map[string]int{}
	internalNames := map[string]string{}

	for _, edge := range summary.Edges {
		if edge.Unclassified {
			// One endpoint has no system, so there is no boundary story to
			// tell. It surfaces through the unclassified-files claim instead.
			continue
		}
		if !edge.Cross {
			internalEdges[edge.SrcSystemID]++
			internalNames[edge.SrcSystemID] = edge.SrcSystem
			continue
		}
		key := edge.Change + "\x00" + edge.SrcSystemID + "\x00" + edge.DstSystemID
		group, ok := groups[key]
		if !ok {
			group = &couplingGroup{
				systemPair: systemPair{
					srcID: edge.SrcSystemID, dstID: edge.DstSystemID,
					srcName: edge.SrcSystem, dstName: edge.DstSystem,
				},
				change:    edge.Change,
				callPairs: map[string]bool{},
				imports:   map[string]int{},
			}
			groups[key] = group
			order = append(order, key)
		}
		group.actor = mergeActor(group.actor, edge.Actor)
		group.sessionID, group.sessionConflict = mergeSession(
			group.sessionID, group.sessionConflict, edge.SessionID,
		)
		if edge.TS > group.ts {
			group.ts = edge.TS
		}
		filePair := edge.SrcID + "\x00" + edge.DstID
		if edge.CallerSymbol != "" || edge.CalleeSymbol != "" {
			group.callPairs[filePair] = true
			group.evidence = append(group.evidence, Evidence{
				Kind:    "call",
				Label:   callSiteLabel(edge),
				Detail:  fmt.Sprintf("%s → %s", edge.SrcLabel, edge.DstLabel),
				FileIDs: []string{edge.SrcID, edge.DstID},
			})
			continue
		}
		group.imports[filePair]++
	}

	for _, key := range order {
		group := groups[key]
		// Only surface an import as its own evidence when no call between the
		// same files already explains it.
		importPairs := make([]string, 0, len(group.imports))
		for pair := range group.imports {
			if !group.callPairs[pair] {
				importPairs = append(importPairs, pair)
			}
		}
		sort.Strings(importPairs)
		if len(importPairs) > 0 {
			group.evidence = append(group.evidence, Evidence{
				Kind:  "import",
				Label: fmt.Sprintf("%s newly imported", pluralFiles(len(importPairs))),
			})
		}
		sort.SliceStable(group.evidence, func(i, j int) bool {
			return group.evidence[i].Label < group.evidence[j].Label
		})

		src := systemLabel(group.srcName, group.srcID)
		dst := systemLabel(group.dstName, group.dstID)
		kind := ClaimCoupling
		title := fmt.Sprintf("%s now depends on %s", src, dst)
		if group.change == ChangeRemoved {
			kind = ClaimDecoupling
			title = fmt.Sprintf("%s no longer depends on %s", src, dst)
		}
		cycle := kind == ClaimCoupling && topology.reaches(group.dstID, group.srcID)
		severity := claimSeverity[kind]
		if cycle {
			severity = cycleSeverity
			title = fmt.Sprintf("Cycle: %s ⇄ %s", src, dst)
		}
		count := len(group.evidence)
		claims = append(claims, Claim{
			ID:             "claim:" + key,
			Kind:           kind,
			Title:          title,
			Subtitle:       evidenceSubtitle(count, group.change),
			Severity:       severity,
			Score:          score(severity, count),
			Actor:          group.actor,
			TS:             group.ts,
			CreatesCycle:   cycle,
			FocusSystemIDs: []string{group.srcID, group.dstID},
			Evidence:       group.evidence,
			SessionID:      group.sessionID,
		})
	}

	// ── System births and deaths ────────────────────────────────────────────
	for _, system := range summary.Systems {
		kind := ClaimSystemAdded
		title := fmt.Sprintf("New system · %s", system.Name)
		if system.Change == ChangeDeleted {
			kind = ClaimSystemRemoved
			title = fmt.Sprintf("System dissolved · %s", system.Name)
		}
		focus := []string{}
		if kind == ClaimSystemAdded {
			focus = append(focus, system.ID)
		}
		claims = append(claims, Claim{
			ID:             "claim:system:" + system.ID,
			Kind:           kind,
			Title:          title,
			Subtitle:       "the classifier reshaped a boundary",
			Severity:       claimSeverity[kind],
			Score:          score(claimSeverity[kind], 1),
			Actor:          system.Actor,
			TS:             system.TS,
			FocusSystemIDs: focus,
			Evidence:       []Evidence{},
			SessionID:      system.SessionID,
		})
	}

	// ── Membership: which systems gained or lost files ──────────────────────
	claims = append(claims, membershipClaims(summary)...)

	// ── Internal churn, one claim per system, hidden by default ─────────────
	claims = append(claims, internalClaims(summary, internalEdges, internalNames)...)
	if before != nil && after != nil {
		claims = append(claims, architectureConsequences(summary, *before, *after)...)
	}
	for index := range claims {
		claims[index].Corroborated = true
	}

	// Highest consequence first; ties break newest-first so a busy delta still
	// reads chronologically within a severity band.
	sort.SliceStable(claims, func(i, j int) bool {
		if claims[i].Internal != claims[j].Internal {
			return !claims[i].Internal
		}
		if claims[i].Score != claims[j].Score {
			return claims[i].Score > claims[j].Score
		}
		return claims[i].TS > claims[j].TS
	})
	return claims
}

const hubDegreeThreshold = 3

func architectureNeighbors(snapshot ArchitectureSnapshot, systemID string) map[string]bool {
	neighbors := map[string]bool{}
	for dst := range snapshot.Topology[systemID] {
		if dst != systemID {
			neighbors[dst] = true
		}
	}
	for src, outgoing := range snapshot.Topology {
		if src != systemID && outgoing[systemID] {
			neighbors[src] = true
		}
	}
	return neighbors
}

func consequenceEvidence(summary Summary, systemID string) (
	[]Evidence, string, string, int64,
) {
	evidence := []Evidence{}
	actor, sessionID := "", ""
	sessionConflict := false
	var ts int64
	for _, edge := range summary.Edges {
		if edge.SrcSystemID != systemID && edge.DstSystemID != systemID {
			continue
		}
		actor = mergeActor(actor, edge.Actor)
		sessionID, sessionConflict = mergeSession(
			sessionID, sessionConflict, edge.SessionID,
		)
		if edge.TS > ts {
			ts = edge.TS
		}
		evidence = append(evidence, Evidence{
			Kind:    "topology." + edge.Change,
			Label:   callSiteLabel(edge),
			Detail:  fmt.Sprintf("%s -> %s", edge.SrcLabel, edge.DstLabel),
			FileIDs: []string{edge.SrcID, edge.DstID},
		})
	}
	if len(evidence) == 0 {
		evidence = append(evidence, Evidence{
			Kind: "topology.changed", Label: "system connectivity changed",
		})
	}
	return evidence, actor, sessionID, ts
}

func architectureConsequences(
	summary Summary,
	before, after ArchitectureSnapshot,
) []Claim {
	claims := []Claim{}
	systemIDs := make([]string, 0, len(after.Systems))
	for systemID := range after.Systems {
		systemIDs = append(systemIDs, systemID)
	}
	sort.Strings(systemIDs)
	for _, systemID := range systemIDs {
		name := after.Systems[systemID]
		if _, existed := before.Systems[systemID]; !existed {
			continue // a new system is already explained by its birth claim
		}
		beforeDegree := len(architectureNeighbors(before, systemID))
		afterDegree := len(architectureNeighbors(after, systemID))
		evidence, actor, sessionID, ts := consequenceEvidence(summary, systemID)
		label := systemLabel(name, systemID)

		switch {
		case beforeDegree < hubDegreeThreshold && afterDegree >= hubDegreeThreshold:
			claims = append(claims, Claim{
				ID:             "claim:hub:" + systemID,
				Kind:           ClaimHubTransition,
				Title:          fmt.Sprintf("%s became an architectural hub", label),
				Subtitle:       fmt.Sprintf("now connects %d systems (was %d)", afterDegree, beforeDegree),
				Severity:       claimSeverity[ClaimHubTransition],
				Score:          score(claimSeverity[ClaimHubTransition], len(evidence)),
				Actor:          actor,
				TS:             ts,
				FocusSystemIDs: []string{systemID},
				Evidence:       evidence,
				SessionID:      sessionID,
			})
		case beforeDegree > 0 && afterDegree == 0:
			connectionLabel := "connections"
			if beforeDegree == 1 {
				connectionLabel = "connection"
			}
			claims = append(claims, Claim{
				ID:             "claim:orphaned:" + systemID,
				Kind:           ClaimOrphaned,
				Title:          fmt.Sprintf("%s became disconnected", label),
				Subtitle:       fmt.Sprintf("lost its final %s", connectionLabel),
				Severity:       claimSeverity[ClaimOrphaned],
				Score:          score(claimSeverity[ClaimOrphaned], len(evidence)),
				Actor:          actor,
				TS:             ts,
				FocusSystemIDs: []string{systemID},
				Evidence:       evidence,
				SessionID:      sessionID,
			})
		}
	}
	return claims
}

func evidenceSubtitle(count int, change string) string {
	verb := "call sites"
	if change == ChangeRemoved {
		verb = "links removed"
	}
	if count == 1 {
		if change == ChangeRemoved {
			return "1 link removed"
		}
		return "1 call site"
	}
	return fmt.Sprintf("%d %s", count, verb)
}

// score keeps evidence sub-linear: fifty new call sites matter more than one,
// but nowhere near fifty times more.
func score(severity, evidenceCount int) float64 {
	return float64(severity) + math.Log2(1+float64(evidenceCount))
}

// membershipClaims groups created and deleted files by the system that gained
// or lost them, so a large agent run reads as "Storage gained 12 files" rather
// than twelve identical rows. Files with no system become their own claim,
// because "unclassified" is a state to resolve, not a boundary.
func membershipClaims(summary Summary) []Claim {
	type bucket struct {
		systemID, systemName string
		gained, lost         []FileChange
		actor                string
		sessionID            string
		sessionConflict      bool
		ts                   int64
	}
	buckets := map[string]*bucket{}
	order := []string{}
	homeless := []FileChange{}
	homelessActor := ""
	homelessSession := ""
	homelessSessionConflict := false
	var homelessTS int64

	for _, file := range summary.Files {
		if file.Change == ChangeUpdated {
			continue // edits are internal churn, not membership
		}
		if file.SystemID == "" {
			if file.Change == ChangeCreated {
				homeless = append(homeless, file)
				homelessActor = mergeActor(homelessActor, file.Actor)
				homelessSession, homelessSessionConflict = mergeSession(
					homelessSession, homelessSessionConflict, file.SessionID,
				)
				if file.TS > homelessTS {
					homelessTS = file.TS
				}
			}
			continue
		}
		b, ok := buckets[file.SystemID]
		if !ok {
			b = &bucket{systemID: file.SystemID, systemName: file.SystemName}
			buckets[file.SystemID] = b
			order = append(order, file.SystemID)
		}
		b.actor = mergeActor(b.actor, file.Actor)
		b.sessionID, b.sessionConflict = mergeSession(
			b.sessionID, b.sessionConflict, file.SessionID,
		)
		if file.TS > b.ts {
			b.ts = file.TS
		}
		if file.Change == ChangeCreated {
			b.gained = append(b.gained, file)
		} else {
			b.lost = append(b.lost, file)
		}
	}

	claims := []Claim{}
	for _, id := range order {
		b := buckets[id]
		name := systemLabel(b.systemName, b.systemID)
		parts := []string{}
		evidence := []Evidence{}
		for _, file := range b.gained {
			evidence = append(evidence, Evidence{
				Kind: "file.created", Label: file.RelPath,
				Detail: "created", FileIDs: []string{file.ID},
			})
		}
		for _, file := range b.lost {
			evidence = append(evidence, Evidence{
				Kind: "file.deleted", Label: file.RelPath,
				Detail: "deleted", FileIDs: []string{file.ID},
			})
		}
		if len(b.gained) > 0 {
			parts = append(parts, "+"+pluralFiles(len(b.gained)))
		}
		if len(b.lost) > 0 {
			parts = append(parts, "−"+pluralFiles(len(b.lost)))
		}

		title := fmt.Sprintf("%s gained %s", name, pluralFiles(len(b.gained)))
		switch {
		case len(b.gained) == 0:
			title = fmt.Sprintf("%s lost %s", name, pluralFiles(len(b.lost)))
		case len(b.gained) == 1 && len(b.lost) == 0:
			title = fmt.Sprintf("%s gained %s", name, b.gained[0].RelPath)
		case len(b.lost) > 0:
			title = fmt.Sprintf("%s membership changed", name)
		}
		focusFiles := []string{}
		for _, file := range b.gained {
			focusFiles = append(focusFiles, file.ID)
		}

		claims = append(claims, Claim{
			ID:             "claim:membership:" + b.systemID,
			Kind:           ClaimMembership,
			Title:          title,
			Subtitle:       joinParts(parts),
			Severity:       claimSeverity[ClaimMembership],
			Score:          score(claimSeverity[ClaimMembership], len(evidence)),
			Actor:          b.actor,
			TS:             b.ts,
			FocusSystemIDs: []string{b.systemID},
			FocusFileIDs:   focusFiles,
			Evidence:       evidence,
			SessionID:      b.sessionID,
		})
	}

	if len(homeless) > 0 {
		evidence := make([]Evidence, 0, len(homeless))
		focus := make([]string, 0, len(homeless))
		for _, file := range homeless {
			evidence = append(evidence, Evidence{
				Kind: "file.created", Label: file.RelPath,
				Detail: "awaiting classification", FileIDs: []string{file.ID},
			})
			focus = append(focus, file.ID)
		}
		claims = append(claims, Claim{
			ID:           "claim:unclassified",
			Kind:         ClaimUnclassified,
			Title:        fmt.Sprintf("%s awaiting classification", pluralFiles(len(homeless))),
			Subtitle:     "not yet placed in any system",
			Severity:     claimSeverity[ClaimUnclassified],
			Score:        score(claimSeverity[ClaimUnclassified], len(evidence)),
			Actor:        homelessActor,
			TS:           homelessTS,
			FocusFileIDs: focus,
			Evidence:     evidence,
			SessionID:    homelessSession,
		})
	}
	return claims
}

// internalClaims collapses everything that happened strictly inside one
// system into a single muted row per system. This is the largest source of
// noise in a real delta and the reason the first version was unreadable.
func internalClaims(summary Summary, internalEdges map[string]int, names map[string]string) []Claim {
	edited := map[string]int{}
	editedNames := map[string]string{}
	evidence := map[string][]Evidence{}
	actors := map[string]string{}
	stamps := map[string]int64{}
	sessionIDs := map[string]string{}
	sessionConflicts := map[string]bool{}

	for _, file := range summary.Files {
		if file.Change != ChangeUpdated {
			continue
		}
		key := file.SystemID
		edited[key]++
		editedNames[key] = file.SystemName
		actors[key] = mergeActor(actors[key], file.Actor)
		sessionIDs[key], sessionConflicts[key] = mergeSession(
			sessionIDs[key], sessionConflicts[key], file.SessionID,
		)
		if file.TS > stamps[key] {
			stamps[key] = file.TS
		}
		detail := "edited"
		if file.Saves > 1 {
			detail = fmt.Sprintf("edited · %d saves", file.Saves)
		}
		evidence[key] = append(evidence[key], Evidence{
			Kind: "file.updated", Label: file.RelPath,
			Detail: detail, FileIDs: []string{file.ID},
		})
	}
	for systemID, count := range internalEdges {
		if _, seen := edited[systemID]; !seen {
			edited[systemID] = 0
			editedNames[systemID] = names[systemID]
		}
		evidence[systemID] = append(evidence[systemID], Evidence{
			Kind:  "edge.internal",
			Label: fmt.Sprintf("%d internal link change(s)", count),
		})
	}

	keys := make([]string, 0, len(edited))
	for key := range edited {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	claims := make([]Claim, 0, len(keys))
	for _, key := range keys {
		name := systemLabel(editedNames[key], key)
		count := edited[key]
		title := fmt.Sprintf("%s · internal changes", name)
		if count > 0 {
			title = fmt.Sprintf("%s · %s edited", name, pluralFiles(count))
		}
		focus := []string{}
		if key != "" {
			focus = append(focus, key)
		}
		claims = append(claims, Claim{
			ID:             "claim:internal:" + key,
			Kind:           ClaimInternal,
			Title:          title,
			Subtitle:       "no boundary crossed",
			Severity:       claimSeverity[ClaimInternal],
			Score:          score(claimSeverity[ClaimInternal], len(evidence[key])),
			Actor:          actors[key],
			TS:             stamps[key],
			Internal:       true,
			FocusSystemIDs: focus,
			Evidence:       evidence[key],
			SessionID:      sessionIDs[key],
		})
	}
	return claims
}

func joinParts(parts []string) string {
	switch len(parts) {
	case 0:
		return ""
	case 1:
		return parts[0]
	default:
		return parts[0] + " · " + parts[1]
	}
}
