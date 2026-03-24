# pi-coord

A lightweight multi-agent coordination extension for [pi coding agent](https://github.com/badlogic/pi-mono).

Lets multiple pi agents — working on **different projects in different terminals** — coordinate via named channels. No daemon, no server, just files in `~/.pi/agent/coord/`.

## Concept

```
~/team007 terminal          ~/git/taql terminal
  agent: "team007"    ←──────→   agent: "taql"
        └──── channel: CH-to-PG-migration ────┘
```

You create a named **channel** (e.g. `CH-to-PG-migration`) and invite agents to join with human-readable aliases. Agents can then:

- **Ask** each other questions and wait for replies (`coord_ask` — blocking)
- **Send** fire-and-forget messages (`coord_send`)
- **Reply** to specific messages (`coord_reply`)
- **Request user approval** for destructive actions (`coord_approve`) — the confirm dialog appears in whichever terminal you're focused on

Agents only coordinate when the LLM decides to call a tool or when you issue a slash command. No background mesh, no autonomous wakeups you didn't ask for.

## Installation

Copy (or symlink) this directory into your global pi extensions folder:

```bash
# Clone
git clone https://github.com/bytecraft-ai/pi-coord ~/.pi/agent/extensions/pi-coord

# Or symlink if you already have it locally
ln -s /path/to/pi-coord ~/.pi/agent/extensions/pi-coord
```

Then run `/reload` in any running pi session, or restart pi.

## Quick Start

**In each terminal, join a channel with an alias:**

```
/coord join CH-to-PG-migration taql
/coord join CH-to-PG-migration team007
```

The agent is now registered. The status bar shows `coord: taql (CH-to-PG-migration)`.

**The LLM can now coordinate autonomously:**

```typescript
// team007 agent asks taql a question and waits for the answer
coord_ask({ channel: "CH-to-PG-migration", toAlias: "taql", message: "What pg_vector index type are you using?" })

// taql agent wakes up, answers
coord_reply({ messageId: "<id>", message: "We use ivfflat with 100 lists." })

// team007 gets the reply back in the same turn
```

**For actions needing your approval:**

```typescript
// taql wants to make a breaking change — sends with requiresApproval: true
coord_send({ channel: "CH-to-PG-migration", toAlias: "team007", message: "Need to DROP TABLE legacy_vectors", requiresApproval: true })

// team007 receives it and asks YOU
coord_approve({ action: "taql wants to DROP TABLE legacy_vectors", requestedBy: "taql", channel: "CH-to-PG-migration" })
// → confirm dialog appears in your active terminal

// team007 relays result back
coord_reply({ messageId: "<id>", message: "Approved. You may proceed." })
```

## Slash Commands

| Command | Description |
|---|---|
| `/coord` | Show your alias, channels, and inbox count |
| `/coord join <channel> <alias>` | Join a channel with a human-readable alias |
| `/coord leave <channel>` | Leave a channel |
| `/coord channels` | List all channels and their current members |

## LLM Tools

| Tool | Description |
|---|---|
| `coord_status` | See who's in a channel — used by the LLM to decide routing |
| `coord_send` | Fire-and-forget message to a channel or specific agent |
| `coord_ask` | Blocking send — waits for a reply (default 120s timeout) |
| `coord_reply` | Reply to a message by its id |
| `coord_approve` | Show the user a confirm dialog; returns `approved: true/false` |

## How It Works

- **State**: `~/.pi/agent/coord/registry.json` — channels, members, inboxes. Shared across all projects.
- **Locking**: Simple spin-lock via `.lock` file — safe for concurrent local access.
- **Inbox polling**: Every 3 seconds. On new message, injects a steering prompt with `triggerTurn: true` — agent wakes and processes immediately.
- **Dead agent pruning**: Members are checked via `process.kill(pid, 0)` — stale entries are removed before routing.
- **Approval flow**: Either agent can call `coord_approve`. The confirm dialog appears in that agent's terminal — so it works best from whichever session you're actively watching.

## Storage Layout

```
~/.pi/agent/coord/
  registry.json     ← channels + inboxes (all agents share this file)
  .lock             ← spin-lock for concurrent writes
```

## License

MIT
