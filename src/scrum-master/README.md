# Scrum Master MCP Server

A prompt-based scrum master and agent-to-agent communication channel for cooperating coding agents. It keeps a shared sprint board (tasks, messages, standups, sprint goal) in a single JSON file, so multiple agents working on the same project can coordinate without any of them having to play scrum master — and without ever spending an extra prompt or turn just to understand communication context.

## Why agents never need a second turn

The whole design serves one principle: **every tool response is self-contained**, so agents learn everything relevant as a side effect of calls they were already making.

1. **Self-contained messages, enforced at write time.** The `post_message` schema coaches the sender to include all context (what they were doing, what happened, exact errors, file paths, IDs) in the body, and *requires* a `needs` field — the concrete action that would resolve the message — whenever the signal is `blocked`, `confused`, `help_wanted`, or `handoff`. Completeness is forced when the message is written, not negotiated when it is read.
2. **Digests piggybacked on every response.** Every tool response appends the caller's unread inbox digest (one dense line per message) and a one-line board summary. Agents catch up on team state as a by-product of posting a message, recording a standup, or updating a task — no polling turn required.
3. **Ceremonies as data transforms.** Posting a standup returns the entire team's standup digest, open blockers, and stale tasks in the same response. Sprint planning, retrospectives, unblocking, and handoffs are MCP prompts whose text embeds the live board state server-side — the full ceremony context arrives in a single message, with zero LLM turns spent gathering it.

## Core Concepts

### Agents
Each agent identifies itself via an `agent` parameter on every tool call (no authentication — this is for cooperating local agents). Agents are registered implicitly on first contact.

### Tasks
Tasks live on a sprint board with columns `todo` / `doing` / `review` / `done`, an optional owner, and a blocker list. Ownership is pull-based: agents `claim` tasks rather than being assigned.

### Messages
Messages carry a `signal` (`blocked`, `confused`, `frustrated`, `praise`, `handoff`, `help_wanted`, `fyi`, `done`), an optional task reference, optional mentions (empty mentions = broadcast), and the mandatory-when-it-matters `needs` field. A `blocked` message tied to a task also records the blocker on the task itself. Delivery counts as read: once a digest containing a message has been returned to an agent, it will not be shown to that agent again.

### Standups
Standup entries (`did` / `doing` / `blockers`) accumulate per agent. A task in `doing` is flagged as stale once its owner has posted 3 standups without the task changing.

## API

### Tools

- **post_message**
  - Send a self-contained message to other agents
  - Input: `agent` (string), `signal` (enum), `task_id` (string, optional), `body` (string), `needs` (string, required for `blocked`/`confused`/`help_wanted`/`handoff`), `mentions` (string[], optional; empty = broadcast)
  - Returns: ack + the sender's unread inbox digest + board summary

- **check_inbox**
  - Read all unread messages addressed to you, mentioning you, or broadcast
  - Input: `agent` (string)
  - Returns: messages grouped by signal, one dense line each (`[signal] from <agent> re <task>: <body> | needs: <needs>`), marked read on delivery, plus a board summary
  - Rarely needed — every other tool already piggybacks this digest

- **standup**
  - Post your standup and receive the whole team's status in one call
  - Input: `agent` (string), `did` (string), `doing` (string), `blockers` (string[], may be empty)
  - Returns: team standup digest (every agent's latest entry), all open blockers, stale tasks, your inbox digest, board summary

- **manage_task**
  - Create, claim, update, block, unblock, or complete a task
  - Input: `agent` (string), `action` (`create` | `claim` | `update` | `block` | `unblock` | `complete`), `task_id` (string, all actions except `create`), `title` (string, for `create`), `detail` (string, optional; required for `block`), `status` (`todo` | `doing` | `review` | `done`, for `update`)
  - Returns: the updated task + board summary + your inbox digest

- **get_board**
  - Full sprint board view
  - Input: `agent` (string)
  - Returns: tasks by column with owners and blockers, sprint goal, unread message counts per agent

### Prompts

Each prompt renders **live board state server-side**, so the invoking agent receives complete ceremony context in a single message.

- **sprint-planning** (`goal`) — records the sprint goal on the board, renders the current backlog and known agents, and instructs how to slice the goal into self-contained tasks and notify owners via `manage_task` / `post_message`
- **daily-standup** — renders the team standup digest and open blockers, then instructs the agent to post its own entry via `standup`
- **retrospective** — renders completed/blocked task history and the `frustrated`/`praise` signals from the message log, prompting a structured what-went-well / what-didn't / action-items review
- **unblock** (`task_id`) — renders the task, its blocker chain, and every related message, then prompts a triage decision: resolve, reassign, or escalate to a human
- **handoff** (`task_id`, `to_agent`) — renders a complete handoff brief (task detail, full message history, board state) so the receiving agent can claim and start immediately

### Resources

- **scrum://board** (`application/json`) — the full board state: agents, tasks, messages, standups, sprint
- **scrum://standup/latest** (`text/plain`) — each agent's most recent standup entry, open blockers, and stale tasks
- **scrum://messages** (`application/json`) — the complete message log

## Configuration

- `SCRUM_BOARD_PATH`: path to the JSON state file (default: `scrum-board.json` next to the server script; relative paths are resolved against the script directory). Writes are atomic (temp file + rename).

### Usage with Claude Desktop

Add this to your `claude_desktop_config.json` (after running `npm install` and `npm run build` in this directory):

```json
{
  "mcpServers": {
    "scrum-master": {
      "command": "node",
      "args": ["/path/to/servers/src/scrum-master/dist/index.js"],
      "env": {
        "SCRUM_BOARD_PATH": "/path/to/shared/scrum-board.json"
      }
    }
  }
}
```

### Usage in a project `.mcp.json`

Point every cooperating agent at the **same** `SCRUM_BOARD_PATH` so they share one board:

```json
{
  "mcpServers": {
    "scrum-master": {
      "command": "node",
      "args": ["/path/to/servers/src/scrum-master/dist/index.js"],
      "env": {
        "SCRUM_BOARD_PATH": "/path/to/project/scrum-board.json"
      }
    }
  }
}
```

## Part of the Music Data Science system

This server is part 1 of the three-repo **Music Data Science (MDS)** system, a multi-agent AI music production setup:

- **Python application**: [cazador0/ACE-Step-1.5](https://github.com/cazador0/ACE-Step-1.5/tree/claude/peaceful-dijkstra-m0sycf) (branch `claude/peaceful-dijkstra-m0sycf`)
- **Obsidian vault / planning docs**: [cazador0/awesome-python-audio](https://github.com/cazador0/awesome-python-audio/tree/claude/peaceful-dijkstra-m0sycf) (branch `claude/peaceful-dijkstra-m0sycf`)

## License

This MCP server is licensed under the MIT License. This means you are free to use, modify, and distribute the software, subject to the terms and conditions of the MIT License. For more details, please see the LICENSE file in the project repository.
