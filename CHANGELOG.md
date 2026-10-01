# Changelog

All notable changes to Axiom are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Each release's section is shown
in the app as "What's New" after updating, so write it for users.

## [Unreleased]

### Added
- Work-order destinations for every supported agent: start a new Claude Code,
  Codex or Copilot CLI run from Send, or copy the handoff and open your editor.
  Managed runs show launch failures, local output and a Stop control.
- Command palette, keyboard shortcuts and a shortcut reference; full menus
  (File, Edit, View, Go, Map, Agent, Help) and right-click menus on the map.
- Settings: reopen last project, update checks, interface zoom, reduce
  motion, the editor used by Open in Editor, and more.
- Project Settings: rename a project, change which folders Axiom reads, and
  re-index in place. Changing folders never shows up as code changes in your
  review.
- Open projects with `axiom .` from a terminal, by dropping a folder on the
  window or dock, from the dock menu or Windows jump list, and from
  `axiom://` links.
- Agents keep working while Axiom is closed: Axiom's background service
  starts on demand and stops when idle.
- Remove Axiom from any agent, or from all of them, in one step.
- Moved or renamed project folders are detected; point Axiom at the new
  location and the map comes with it.
- Report a bug, Copy diagnostics and local log files; automatic updates.
- A warning before indexing a very large folder, and a Stop button while
  indexing.
- Clear all Axiom data from Settings.
- Recently Deleted: a deleted project map can be restored for 30 days.
- Automatic daily backups of every map, with Restore in Project Settings.
- Export a project's map to a file and import it on another computer
  (File → Export Map, Import Map).
- Infrastructure (databases, queues, caches, external APIs, hosting) is
  detected from code and config and shown in a sidebar; hosting appears as
  frames around the systems it runs.
- Send a sheet to an agent as a work order, and review what it built
  against the plan.

### Changed
- Axiom runs its agent connection on its own bundled runtime; Node.js no
  longer needs to be installed.
- Unlimited projects, with a short recent list and "Show all".
- Files over 1 MB and minified files are no longer indexed.
- Map shortcuts: Fit `⌘0`, Zoom `⌘=` / `⌘-`, Tidy Layout `⇧⌘L`,
  Infrastructure `⇧⌘E` (Ctrl on Windows and Linux). Interface zoom moved to
  `⌥⌘=` / `⌥⌘-` / `⌥⌘0`, and Agent Log to `⇧⌘A`.

### Fixed
- Edits made while Axiom was closed could be missed when a file's timestamp
  was too close to the last index.
- A second copy of Axiom, or another program on Axiom's ports, no longer
  breaks the connection to the map.

### Security
- The app window runs sandboxed under a strict content security policy, and
  source files are never opened with the system's default handler, which can
  run scripts.
- Fonts ship with the app; Axiom makes no network request to draw itself.
