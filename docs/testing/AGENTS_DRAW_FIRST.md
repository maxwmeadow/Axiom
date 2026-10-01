# Draw-first host validation

The installer and MCP tests prove instruction delivery and the sheet/approval
contract. A language model following the instructions is a separate live check;
passing installation tests does not establish model behavior.

## Installed guidance

Use Settings → Agents → Reinstall/Repair with the project open. This updates
the existing mapping and inbox skills, adds the `axiom-build` skill on hosts
with a skill installer, and adds the following project instructions. Restart
or reload the host according to its setup instructions; use a fresh session.

| Host / supported surfaces | Project reminder | Other guidance |
|---|---|---|
| Claude Code, its VS Code and JetBrains extensions | `.claude/rules/axiom-draw-first.md` | `~/.claude/skills/axiom-build/SKILL.md` |
| Claude Desktop | No project-rule installer | MCP connection instructions, tool descriptions/results, and copied chat prompt |
| Codex CLI, IDE extension and desktop app | Managed block in `AGENTS.md` | `~/.agents/skills/axiom-build/SKILL.md` |
| Copilot in VS Code | Managed block in `.github/copilot-instructions.md` | `~/.copilot/skills/axiom-build/SKILL.md` |
| Copilot CLI | Managed block in `AGENTS.md` | Same Copilot skill |
| Cursor IDE / CLI | `.cursor/rules/axiom-draw-first.mdc`, `alwaysApply: true` | Cursor `axiom-build` skill |
| Windsurf Cascade / Devin Local | `.windsurf/rules/axiom-draw-first.md` and `.devin/rules/axiom-draw-first.md`, `trigger: always_on` | Skills in both installed workflow directories |
| Antigravity IDE / CLI | `.agents/rules/axiom-draw-first.md`, `trigger: always_on` | Antigravity `axiom-build` skill |
| JetBrains AI Assistant | `.aiassistant/rules/axiom-draw-first.md`, `type: always` | MCP guidance and copied chat prompt |
| Zed | Managed block in `.rules` | MCP guidance and copied chat prompt |

Rules are scoped to the project selected during installation. Installing
without a project installs skills/MCP guidance only; reinstall from an open
project to add its reminders. Rules start with "when Axiom tools are available
for this project" so a disconnected host can state the limitation.

These are instructions, not a write interceptor. Hosts differ in whether
they honor MCP initialization instructions or automatically select skills.
Project rules supply the reminder before the first tool call; tool descriptions
and `start_work` results reinforce it once the agent uses Axiom. Claude Desktop
has no installed always-on project file, so its reminder depends on its MCP
client or the supplied chat prompt. No executable hook or permission-bypass
setting is installed.

Shared instruction files keep authored text outside an Axiom-owned block.
The block carries a content hash: repair and uninstall preserve edited blocks
rather than overwriting them. Dedicated rule files also keep existing authored
content. Removing one host keeps instructions shared by another configured
host; removing the last deletes only the unmodified Axiom block. Missing build
skills or missing/edited project rules appear as a workflow needing repair.

Format references: [Claude rules](https://code.claude.com/docs/en/memory),
[Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md),
[Copilot instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions),
[Cursor rules](https://cursor.com/docs/context/rules),
[Windsurf rules](https://docs.windsurf.com/windsurf/cascade/memories),
[Antigravity rules](https://antigravity.google/docs/rules-workflows),
[JetBrains rules](https://www.jetbrains.com/help/ai-assistant/configure-project-rules.html),
[Zed compatibility instructions](https://github.com/zed-industries/zed/blob/main/docs/src/ai/rules.md).

## Automated checks

- `electron/agentRules.test.mjs`: installs all ten hosts; checks project
  reminders, build skills, repair, idempotency, CRLF, edited/unmanaged file
  preservation, shared-host removal, and secondary Windsurf cleanup.
- `mcp/e2e/drawFirst.e2e.mjs`: real stdio MCP and archd; initialization/prompt
  guidance, sheet creation, pending element and typed dependency, repeated
  connection, wrong-sheet endpoints, human approval, approved-spec exclusion
  of pending elements, comparison, and work-session reminder.
- Existing installer, uninstaller, tool-routing and token-budget checks also
  cover this change. The advertised tool count remains 15.

## Real CLI trial

This uses account credentials and model usage. Run explicitly on a machine
with the chosen CLI installed and authenticated:

```sh
AXIOM_LIVE_DRAW_FIRST_HOST=codex node --test mcp/e2e/drawFirst.live.mjs
AXIOM_LIVE_DRAW_FIRST_HOST=claude-code node --test mcp/e2e/drawFirst.live.mjs
AXIOM_LIVE_DRAW_FIRST_HOST=copilot-cli node --test mcp/e2e/drawFirst.live.mjs
```

Build archd first (`npm run build:archd`). The trial creates a throwaway Python
project and isolated daemon/MCP, installs only its project rules, and starts
two fresh host sessions. The first prompt asks for a CSV export service and an
API handler without explicitly requesting an Axiom diagram. It must draw one
sheet with pending elements and dependencies, identify that sheet to the
human, and leave Python source unchanged. The test then simulates human
approval through the existing approval API and asks the second session to
build the approved sheet. It must reuse the sheet, change source, and (in the
Codex structured transcript) call `edit_sheet(compare)`. Read the recorded
checks and remaining differences before marking the host validated; comparison
does not prove tests passed or architecture matched.

Recordings are written to the OS temporary directory under
`axiom-draw-first-recordings/<host>.json`; set `AXIOM_LIVE_RECORD_DIR` to retain
them elsewhere. Records include agent output, plans and tool activity, so
review them before sharing. No developer project, global host configuration,
or existing map is used. The trial times out rather than waiting indefinitely
for approval. It does not run in the default test suite or CI.

For editors and Claude Desktop, repeat the same two-stage task manually on
the fixture, record the conversation, and verify source remained unchanged
until approval. Also try a small in-boundary fix (no new sheet), an existing
approved sheet (no duplicate or repeated approval request), a rejected
proposal, and a resumed session with a revised plan.

## Recorded state (2026-09-30)

All-host installation and the real MCP lifecycle checks pass. A fresh Codex
CLI trial was attempted in the managed environment, but its provider rejected
authentication with HTTP 401 before model execution. No successful model run
is claimed. Claude Code and Copilot CLI are not installed here; desktop/editor
behavior is not live-validated. These checks remain tracked in WORK.md.
