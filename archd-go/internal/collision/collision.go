// Package collision projects branch divergence onto Axiom's semantic systems.
package collision

import (
	"sort"

	"axiom.local/archd/internal/delta"
)

type Boundary struct {
	SystemID   string
	SystemName string
}

type BranchInput struct {
	RootID      string
	Branch      string
	HeadCommit  string
	IsPrimary   bool
	PathSystems map[string]Boundary
	Claims      []delta.Claim
}

// PairInput contains each side's files changed since that pair's merge base.
// Pairwise divergence prevents inherited commits from looking like a collision
// when one active branch was created from another.
type PairInput struct {
	LeftRootID  string
	LeftPaths   []string
	RightRootID string
	RightPaths  []string
	Error       string
}

type SystemTouch struct {
	SystemID   string        `json:"systemId"`
	SystemName string        `json:"systemName"`
	Files      []string      `json:"files"`
	Claims     []delta.Claim `json:"claims"`
}

type Branch struct {
	RootID            string        `json:"rootId"`
	Branch            string        `json:"branch"`
	HeadCommit        string        `json:"headCommit"`
	IsPrimary         bool          `json:"isPrimary"`
	TouchedSystems    []SystemTouch `json:"touchedSystems"`
	UnclassifiedFiles []string      `json:"unclassifiedFiles"`
	Errors            []string      `json:"errors,omitempty"`
}

type CollisionBranch struct {
	RootID string        `json:"rootId"`
	Branch string        `json:"branch"`
	Files  []string      `json:"files"`
	Claims []delta.Claim `json:"claims"`
}

type BoundaryCollision struct {
	SystemID   string            `json:"systemId"`
	SystemName string            `json:"systemName"`
	Branches   []CollisionBranch `json:"branches"`
}

type Snapshot struct {
	WorkspaceID string              `json:"workspaceId"`
	GeneratedAt int64               `json:"generatedAt"`
	Branches    []Branch            `json:"branches"`
	Collisions  []BoundaryCollision `json:"collisions"`
}

type touchAccumulator struct {
	name   string
	files  map[string]struct{}
	claims []delta.Claim
}

type branchAccumulator struct {
	input        BranchInput
	touches      map[string]*touchAccumulator
	unclassified map[string]struct{}
	errors       map[string]struct{}
}

// Build creates a deterministic snapshot from pairwise Git divergence and
// branch-stamped architectural claims. Git establishes that work is still
// unmerged; indexed system membership establishes the collision boundary.
func Build(
	workspaceID string,
	generatedAt int64,
	inputs []BranchInput,
	pairs []PairInput,
) Snapshot {
	branches := make(map[string]*branchAccumulator, len(inputs))
	for _, input := range inputs {
		branches[input.RootID] = &branchAccumulator{
			input:        input,
			touches:      map[string]*touchAccumulator{},
			unclassified: map[string]struct{}{},
			errors:       map[string]struct{}{},
		}
	}

	collisions := map[string]map[string]*touchAccumulator{}
	for _, pair := range pairs {
		left, leftOK := branches[pair.LeftRootID]
		right, rightOK := branches[pair.RightRootID]
		if !leftOK || !rightOK {
			continue
		}
		if pair.Error != "" {
			left.errors[pair.Error] = struct{}{}
			right.errors[pair.Error] = struct{}{}
			continue
		}
		leftTouches := touchesForPaths(left, pair.LeftPaths)
		rightTouches := touchesForPaths(right, pair.RightPaths)
		for systemID, leftTouch := range leftTouches {
			rightTouch, overlaps := rightTouches[systemID]
			if !overlaps {
				continue
			}
			if collisions[systemID] == nil {
				collisions[systemID] = map[string]*touchAccumulator{}
			}
			mergeTouch(collisions[systemID], left.input.RootID, leftTouch)
			mergeTouch(collisions[systemID], right.input.RootID, rightTouch)
		}
	}

	snapshot := Snapshot{
		WorkspaceID: workspaceID,
		GeneratedAt: generatedAt,
		Branches:    make([]Branch, 0, len(branches)),
		Collisions:  make([]BoundaryCollision, 0, len(collisions)),
	}
	for _, accumulator := range branches {
		attachClaims(accumulator.input.Claims, accumulator.touches)
		branch := Branch{
			RootID:     accumulator.input.RootID,
			Branch:     accumulator.input.Branch,
			HeadCommit: accumulator.input.HeadCommit,
			IsPrimary:  accumulator.input.IsPrimary,
		}
		branch.TouchedSystems = materializeTouches(accumulator.touches)
		branch.UnclassifiedFiles = sortedSet(accumulator.unclassified)
		branch.Errors = sortedSet(accumulator.errors)
		snapshot.Branches = append(snapshot.Branches, branch)
	}
	sort.Slice(snapshot.Branches, func(i, j int) bool {
		if snapshot.Branches[i].IsPrimary != snapshot.Branches[j].IsPrimary {
			return snapshot.Branches[i].IsPrimary
		}
		if snapshot.Branches[i].Branch != snapshot.Branches[j].Branch {
			return snapshot.Branches[i].Branch < snapshot.Branches[j].Branch
		}
		return snapshot.Branches[i].RootID < snapshot.Branches[j].RootID
	})

	for systemID, collisionTouches := range collisions {
		collision := BoundaryCollision{SystemID: systemID}
		for rootID, touch := range collisionTouches {
			input := branches[rootID].input
			claims := claimsForSystem(input.Claims, systemID)
			if collision.SystemName == "" {
				collision.SystemName = touch.name
			}
			collision.Branches = append(collision.Branches, CollisionBranch{
				RootID: rootID,
				Branch: input.Branch,
				Files:  sortedSet(touch.files),
				Claims: claims,
			})
		}
		sort.Slice(collision.Branches, func(i, j int) bool {
			if collision.Branches[i].Branch != collision.Branches[j].Branch {
				return collision.Branches[i].Branch < collision.Branches[j].Branch
			}
			return collision.Branches[i].RootID < collision.Branches[j].RootID
		})
		snapshot.Collisions = append(snapshot.Collisions, collision)
	}
	sort.Slice(snapshot.Collisions, func(i, j int) bool {
		if snapshot.Collisions[i].SystemName != snapshot.Collisions[j].SystemName {
			return snapshot.Collisions[i].SystemName < snapshot.Collisions[j].SystemName
		}
		return snapshot.Collisions[i].SystemID < snapshot.Collisions[j].SystemID
	})
	return snapshot
}

func touchesForPaths(branch *branchAccumulator, paths []string) map[string]*touchAccumulator {
	touches := map[string]*touchAccumulator{}
	for _, path := range paths {
		boundary, ok := branch.input.PathSystems[path]
		if !ok || boundary.SystemID == "" {
			branch.unclassified[path] = struct{}{}
			continue
		}
		touch := touches[boundary.SystemID]
		if touch == nil {
			touch = &touchAccumulator{name: boundary.SystemName, files: map[string]struct{}{}}
			touches[boundary.SystemID] = touch
		}
		touch.files[path] = struct{}{}
		mergeTouch(branch.touches, boundary.SystemID, touch)
	}
	return touches
}

func mergeTouch(target map[string]*touchAccumulator, key string, incoming *touchAccumulator) {
	touch := target[key]
	if touch == nil {
		touch = &touchAccumulator{name: incoming.name, files: map[string]struct{}{}}
		target[key] = touch
	}
	if touch.name == "" {
		touch.name = incoming.name
	}
	for file := range incoming.files {
		touch.files[file] = struct{}{}
	}
}

func attachClaims(claims []delta.Claim, touches map[string]*touchAccumulator) {
	for systemID, touch := range touches {
		touch.claims = claimsForSystem(claims, systemID)
	}
}

func claimsForSystem(claims []delta.Claim, systemID string) []delta.Claim {
	result := make([]delta.Claim, 0)
	seen := map[string]struct{}{}
	for _, claim := range claims {
		for _, focusID := range claim.FocusSystemIDs {
			if focusID == systemID {
				if _, exists := seen[claim.ID]; !exists {
					seen[claim.ID] = struct{}{}
					result = append(result, claim)
				}
				break
			}
		}
	}
	sort.SliceStable(result, func(i, j int) bool {
		if result[i].Score != result[j].Score {
			return result[i].Score > result[j].Score
		}
		return result[i].ID < result[j].ID
	})
	return result
}

func materializeTouches(touches map[string]*touchAccumulator) []SystemTouch {
	result := make([]SystemTouch, 0, len(touches))
	for systemID, touch := range touches {
		result = append(result, SystemTouch{
			SystemID: systemID, SystemName: touch.name,
			Files: sortedSet(touch.files), Claims: touch.claims,
		})
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].SystemName != result[j].SystemName {
			return result[i].SystemName < result[j].SystemName
		}
		return result[i].SystemID < result[j].SystemID
	})
	return result
}

func sortedSet(values map[string]struct{}) []string {
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}
