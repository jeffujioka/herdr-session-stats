# opencode session format

What the opencode provider reads, and the answer to the open fact D8 (f) of the spec: the cache and compaction fields in opencode's database.

Source checked on 2026-11-15: `~/.local/share/opencode/opencode.db` (opencode 1.18.31 and 1.18.32; 600 sessions, 25,108 messages), opened with `sqlite3 -readonly`. Nothing here was copied from message text; the fixtures hold no paths, ids or text.

## Database and link

- One SQLite file for all sessions, `~/.local/share/opencode/opencode.db` (WAL mode: `-wal` and `-shm` files sit beside it, and `-readonly` reads them). opencode follows `XDG_DATA_HOME`; the mod reads the default place only, and reads n/a where opencode keeps the file elsewhere.
- Tables used: `session`, `message`, `part`. A `message` row is `(id, session_id, time_created, time_updated, data)`, `data` a JSON object; a `part` row is `(id, message_id, session_id, time_created, time_updated, data)`. An index on `message (session_id, time_created, id)` and one on `part (session_id)` keep the per-session queries fast (about 60 ms for a session of 740 messages).
- `session.directory` is the folder opencode was started in (exact path, no trailing slash); `session.parent_id` is set on a sub-agent's session; `session.time_archived` is set on an archived one; `session.time_updated` (epoch ms) follows the session's last message, about 20 ms behind it. The pane's session is the session of the pane's folder with no parent, not archived, with the greatest `time_updated`, taken as linked when it changed within the link window (D3). The session id stands for the file in the card builder (`path`).
- `session` also carries the totals `cost`, `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write` (running totals) and `model` (JSON). The provider sums the messages instead, so every figure comes from the same rows; the summed cost equals `session.cost` on the sessions checked.

## Message data

`data` of an assistant message (`role: "assistant"`):

| Field | Meaning |
| --- | --- |
| `modelID`, `providerID` | for example `claude-opus-5` and `github-copilot`; the model of a session is the model of its latest assistant message that is not a compaction summary |
| `variant` | the reasoning level chosen for the message (`low`, `medium`, `high`, ...); absent where the model has none. Shown as the thinking level |
| `parentID` | id of the user message that began the turn; one turn is many assistant messages (one per tool step), all with the same `parentID` |
| `time.created`, `time.completed` | epoch ms; `completed` is absent while the message is running |
| `cost` | USD the harness logged for this message; summed, no price table (D5) |
| `tokens.input`, `output`, `reasoning`, `cache.read`, `cache.write` | tokens of this message |
| `tokens.total` | equals `input + output + reasoning + cache.read + cache.write` on all 23,782 assistant messages that have it; absent on 112 (running, aborted or failed ones) |
| `error.name` | `ContextOverflowError`, `MessageAbortedError`, `APIError`, ...; present on a message that ended in error |
| `finish` | `tool-calls`, `stop`, `length`, `error`, ... |

A user message has `role: "user"`, `agent`, `model: { providerID, modelID }`, and a `summary` object of file diffs (not a compaction summary; see below). Time of a message is the `time_created` column.

## D8 (f): cache and compaction fields

**Cache: found.** Every assistant message carries `tokens.cache.read` and `tokens.cache.write` (all 23,894 of them, in 1.18.x). From them the provider computes the hit rate, `cache.read / (input + cache.read + cache.write)` summed over the session, and the hits and misses (a turn is an assistant message that sent a prompt, `input + cache.read + cache.write > 0`; a hit has `cache.read > 0`). A message of an older opencode without the counts is not counted; with none counted the figures read `n/a`. The prompt cache's lifetime is not logged, so `cacheLeftMs` is `n/a`.

**Compaction: found.** opencode records a compaction as two rows:

- a `part` row on a user message, `data = {"type":"compaction","auto":true|false,"overflow":true}`; `auto` is true when opencode started the compaction itself (8 of 13 seen), false for a manual one;
- an assistant message with `parentID` set to that user message, `summary: true`, `mode: "compaction"` and its own model; it holds the summary and its token use. It can end in an `error` (`ContextOverflowError` on 2 of the 13: the history was too large to compact; `MessageAbortedError` on 1) or without `time.completed`.

The autocompaction count is the number of `compaction` parts with `auto` true whose summary message finished (`time.completed` set) with no `error`. The query joins the part to its summary message on `parentID`. On the real database it gives 3, 2 and 0 for three sessions whose parts were read by hand. A database with no `part` table (a version before compaction, or damaged) leaves the count unknown: `n/a`, never 0. A session of a database that has the table and no compaction reads 0.

## Fields each figure uses

| Stat | Source |
| --- | --- |
| `model`, `thinkingLevel` | `modelID`, `variant` of the latest assistant message that is not a compaction summary |
| `durationMs` | first message's `time_created` to the last end: the greatest `time.completed` (a user message ends at its own time) |
| `sinceActivityMs` | `now` minus that last end |
| `totalTokens` | sum of `tokens.total` over assistant messages (compaction summaries included: they cost tokens); a message without it counts the sum of its five token counts when all five are logged |
| `costUsd`, `burnCostPerHour`, `burnTokensPerMin` | sum of `cost`; burn is over `durationMs` |
| `cacheHitRate`, `cacheHits`, `cacheMisses` | see D8 (f) above |
| `autocompactions` | see D8 (f) above |
| `contextTokens` | `input + cache.read + cache.write` of the latest turn that sent a prompt (same definition as omp's `promptTokens`) |
| `latencyMs` | `time.completed` of the latest completed assistant message minus `time_created` of the user message its `parentID` names |

## Not in the database: n/a

- `contextMax`, `contextPercent`, `headroomTokens`: the database holds no context window or compaction trigger. opencode's model catalogue (`~/.cache/opencode/models.json`) and its config are outside what this provider reads; they are not read, and the three figures read `n/a`.
- `cacheLeftMs`: no cache lifetime is logged.
- `premiumRequests`: no such count is logged.
