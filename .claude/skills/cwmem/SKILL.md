---
name: cwmem
description: >
  Record decisions, changes, events into cwmem — repo-native institutional
  memory. Use in any git-managed repository. Triggers: meaningful changes
  (architecture decisions, process changes, meeting outcomes), user asks to
  "remember"/"record"/"log"/"track", mentions of "cwmem"/"institutional memory"/
  "decision log"/"knowledge base", or CLAUDE.md/AGENTS.md instructions.
  Proactively offer to record important decisions.
---

# cwmem

Institutional memory CLI. SQLite + checked-in `memory/` artifacts.

## Resolve

1. `pyproject.toml` has cwmem: `uv run cwmem`
2. On PATH: `cwmem`
3. Else: `uvx cwmem`

Store as `<cmd>`.

## Init

`<cmd> status` — if uninitialized, ask: 1) Repo kind? 2) Author? 3) Entities to track?

Then `<cmd> init`, `<cmd> entity-add --name "<name>" --type "<type>" "<desc>"` per entity, `<cmd> build`.

## Writes

**Entries** (note, decision, bug, change, risk, todo, adr):

```bash
<cmd> add --title "Adopt JWT auth" --type decision --tag security \
  --entity ent-000001 --relate mem-000003 \
  "Rationale and alternatives considered."
```

`--entity`/`--relate` optional.

**Events** (deployment, incident, review, milestone, release):

```bash
<cmd> event-add --event-type deployment --tag release "Deployed v2.1.0"
```

**Entities** (services, APIs, teams, standards):

```bash
<cmd> entity-add --name "AuthService" --type service "Handles authentication"
```

**Links** (relates_to, implements, depends_on, supersedes, caused_by, owned_by):

```bash
<cmd> link mem-000001 ent-000002 --relation-type implements
```

## Reads

```bash
<cmd> search "auth refactor" --type decision
<cmd> list --type decision --limit 10
```

After writes: `<cmd> sync export`.

## Proactive recording

Offer to record after meaningful work: architecture/process decisions, bug causes, refactoring rationale, meeting outcomes, dependency changes.

Concise: title, rationale, 6-month context.

## Safety

`references/commands.md` for full options. `--dry-run` before unfamiliar mutations, `--idempotency-key` for retries. Don't edit `memory/`. Parse `.ok` in JSON output.
