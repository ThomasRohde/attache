# cwmem Command Reference

## Output format

Every command returns a JSON envelope on stdout:

```json
{
  "ok": true,
  "command": "memory.add",
  "result": { ... },
  "warnings": [],
  "errors": []
}
```

Parse `.ok` to check success. Diagnostics go to stderr.

---

## System commands

### `cwmem init [--cwd PATH]`
Create `.cwmem/` runtime directory, `memory/` artifact directory, and seed taxonomy.

### `cwmem status [--cwd PATH]`
Report bootstrap status — whether the database exists, paths, taxonomy.

### `cwmem guide`
Return full machine-readable CLI documentation as JSON.

### `cwmem build [--dry-run] [--wait-lock SECS] [--cwd PATH]`
Build/rebuild FTS index and semantic embeddings. Run after bulk writes.

### `cwmem stats [--cwd PATH]`
Show counts: entries, events, entities, edges, embeddings, last build time.

### `cwmem verify [--plan FILE] [--cwd PATH]`
Verify runtime and exported state are aligned.

---

## Read commands

### `cwmem get <PUBLIC_ID> [--cwd PATH]`
Retrieve one item by ID (e.g. `mem-000001`, `evt-000001`, `ent-000001`).

### `cwmem list [OPTIONS]`
List entries with filters.

| Option | Description |
|--------|-------------|
| `--tag TAG` | Filter by tag (repeatable) |
| `--type TYPE` | Filter by entry type |
| `--status STATUS` | Filter by status |
| `--author AUTHOR` | Filter by author |
| `--limit N` | Max results (default 50, max 500) |
| `--cwd PATH` | Repository root |

### `cwmem search <QUERY> [OPTIONS]`
Hybrid lexical + semantic search.

| Option | Description |
|--------|-------------|
| `--tag TAG` | Filter by tag |
| `--type TYPE` | Filter by entry type |
| `--author AUTHOR` | Filter by author |
| `--from DATE` | Start date (ISO 8601) |
| `--to DATE` | End date (ISO 8601) |
| `--lexical-only` | FTS only (no embeddings needed) |
| `--semantic-only` | Embedding search only |
| `--expand-graph` | Include graph neighbors |
| `--limit N` | Max results (default 20, max 200) |
| `--cwd PATH` | Repository root |

### `cwmem related <RESOURCE_ID> [OPTIONS]`
Find related items via graph traversal.

| Option | Description |
|--------|-------------|
| `--relation TYPE` | Filter by relation type |
| `--depth N` | Traversal depth (1-4, default 1) |
| `--limit N` | Max results (default 50) |
| `--include-provenance` | Show edge provenance |
| `--cwd PATH` | Repository root |

### `cwmem log [OPTIONS]`
Read the append-only event log.

| Option | Description |
|--------|-------------|
| `--resource ID` | Filter by resource |
| `--event-type TYPE` | Filter by event type |
| `--tag TAG` | Filter by tag (repeatable) |
| `--limit N` | Max events (default 50) |
| `--cwd PATH` | Repository root |

### `cwmem graph <RESOURCE_ID> [OPTIONS]`
Inspect graph neighborhood around a resource. Same options as `related`.

---

## Write commands

All write commands support: `--dry-run`, `--idempotency-key KEY`, `--wait-lock SECS`, `--cwd PATH`.

### `cwmem add [OPTIONS] [BODY]`
Create a memory entry.

| Option | Description |
|--------|-------------|
| `--title TEXT` | Entry title |
| `--type TYPE` | Entry type (default: note) |
| `--status STATUS` | Status (default: active) |
| `--author TEXT` | Author name |
| `--tag TAG` | Tag (repeatable) |
| `--relate ID` | Related entry ID (repeatable) |
| `--entity ID` | Entity reference (repeatable) |
| `--provenance JSON` | Provenance object |
| `--metadata JSON` | Custom metadata |
| `--body TEXT` | Body (alternative to positional) |
| `--body-from-stdin` | Read body from stdin |

Body can also be a file path (auto-detected).

### `cwmem update <PUBLIC_ID> [OPTIONS]`
Patch an existing entry. Same options as `add` plus `--expected-fingerprint`.

### `cwmem event-add [OPTIONS] [BODY]`
Append an event record.

| Option | Description |
|--------|-------------|
| `--event-type TYPE` | Event type |
| `--summary TEXT` | Brief summary |
| `--actor TEXT` | Actor/author |
| `--tag TAG` | Tag (repeatable) |
| `--resource ID` | Involved resource (repeatable) |
| `--relate ID` | Related ID (repeatable) |
| `--entity ID` | Entity reference (repeatable) |
| `--metadata JSON` | Custom metadata |
| `--occurred-at ISO` | Timestamp (default: now) |

### `cwmem entity-add [OPTIONS] [DESCRIPTION]`
Create a graph entity.

| Option | Description |
|--------|-------------|
| `--name TEXT` | Entity name |
| `--type TYPE` | Entity type |
| `--status STATUS` | Status (default: active) |
| `--alias TEXT` | Alias (repeatable) |
| `--tag TAG` | Tag (repeatable) |
| `--provenance JSON` | Provenance object |
| `--metadata JSON` | Custom metadata |

### `cwmem link <SOURCE_ID> <TARGET_ID> [OPTIONS]`
Create a graph edge between two resources.

| Option | Description |
|--------|-------------|
| `--relation TYPE` | Relation type |
| `--provenance TEXT` | Edge provenance (default: explicit_user) |
| `--confidence FLOAT` | Confidence 0.0-1.0 (default: 1.0) |
| `--metadata JSON` | Custom metadata |

### `cwmem tag-add <RESOURCE_ID> --tag TAG [--tag ...]`
Add tags to any resource.

### `cwmem tag-remove <RESOURCE_ID> --tag TAG [--tag ...]`
Remove tags from any resource.

---

## Sync commands

### `cwmem sync export [OPTIONS]`
Export database state to checked-in `memory/` artifacts.

| Option | Description |
|--------|-------------|
| `--dry-run` | Preview changes |
| `--check` | Validate only |
| `--output-dir PATH` | Target directory |

### `cwmem sync import [OPTIONS]`
Rebuild database from checked-in artifacts.

| Option | Description |
|--------|-------------|
| `--dry-run` | Preview |
| `--fail-on-drift` | Error if artifacts drifted |
| `--input-dir PATH` | Source directory |

---

## ID formats

- Entries: `mem-NNNNNN` (e.g. `mem-000001`)
- Events: `evt-NNNNNN`
- Entities: `ent-NNNNNN`
- Edges: `edg-NNNNNN`
