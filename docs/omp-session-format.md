# omp session format

What the omp provider reads, and the answers to the open facts D8 (a) to (d) of the spec.

Sources checked on 2026-11-15: the 171 session files in `~/.omp/agent/sessions` (18,275 entries, omp 18.13 to 18.20), `~/.omp/agent/models.db`, `omp config list`, and the strings of the omp 18.20.2 binary (`/opt/homebrew/Cellar/omp/18.20.2/bin/omp`), where a fact is not in a session file. Each finding says which source it comes from. Nothing here was copied from message text; the fixtures hold no paths or text.

## File layout

- A session is one JSON-lines file: `~/.omp/agent/sessions/<folder>/<ISO time with - for : and .>_<uuid>.jsonl`. A directory of the same name beside the file holds sub-agent and blob data; ignore it.
- `<folder>` is the session's cwd with `/` turned into `-`. A cwd under the home folder drops the home prefix (`/Users/me/projects/x` is `-projects-x`). A cwd outside home keeps its real path with a `-` on each end (`/tmp`, really `/private/tmp`, is `--private-tmp--`). The first entry of the file holds the exact cwd.
- Entry types seen, with counts: `message` 10995, `custom` 6001 (tool_execution_start, system-prompt-digest, date-cwd-reminder, session_exit, todo_hud_state), `custom_message` 210, `model_change` 186, `thinking_level_change` 171, `title` 170, `session` 170, `model_usage` 125, `session_init` 81, `title_change` 91, `call` 32, `service_tier_change` 22, `ttsr_injection` 11, `mode_change` 3, `change` 2, `reset_boundary` 1. `call` and `change` lines have no `id`; `title` is the first line of a file.
- `message` entries have `message.role` of `assistant`, `user`, `toolResult`, `bashExecution`, `developer` or `fileMention`.

## Fields each figure uses

An assistant message: `message.role == "assistant"`, with

| Field | Meaning |
| --- | --- |
| `message.provider`, `message.model` | for example `github-copilot` and `claude-sonnet-5.5-1m`; the model of a session is the model of the latest assistant message |
| `message.timestamp` | epoch ms when the turn started; the entry's own `timestamp` is ISO |
| `message.completedAt`, `message.duration`, `message.ttft` | epoch ms, ms, ms; on a few messages absent |
| `message.stopReason` | `toolUse`, `stop`, `aborted`, `error` |
| `message.usage.input`, `output`, `cacheRead`, `cacheWrite` | tokens of this turn |
| `message.usage.totalTokens` | equals `input + output + cacheRead + cacheWrite` (checked on all 4,826 assistant messages) |
| `message.usage.cost.total` | cost the harness logged for this turn, USD; `cost.cacheRead` is 0 on `github-copilot` even when `cacheRead` tokens are many |
| `message.usage.premiumRequests` | present on most, absent on some (aborted or errored turns) |
| `message.usage.cttl` | see D8 (d) |
| `message.contextSnapshot.promptTokens` | tokens in the prompt of this turn, equal to `input + cacheRead + cacheWrite` on all 4,798 messages that carry it; this is the current context usage. Absent on 28 messages (aborted or errored turns) |
| `message.contextSnapshot.compactionEpoch` | see D8 (a) |

Aborted and errored assistant messages can have no `contextSnapshot`, no `cttl` and no `premiumRequests`; a figure that needs one of them reads `n/a` for that message. `thinking_level_change` entries carry `thinkingLevel` (`medium` in the files seen) and `model_change` entries carry `model` as `provider/model`. The first user message that starts a turn has `role: "user"` and an epoch-ms `message.timestamp`. A `model_usage` entry (title generation and other side calls) carries a `usage` object of the same shape and is not an assistant message of the session.

## D8 (a): where autocompactions are recorded

Found in code, not in a real file. omp writes a session entry `{"type":"compaction","summary","shortSummary","firstKeptEntryId","tokensBefore","tokensAfter","method","fromExtension",...}` through `appendCompaction` (omp 18.20.2). None of the 171 local files holds one, and none holds a `compactionSummary` message role, so the shape is not seen in a real file.

- The count is the number of `type: "compaction"` entries in the file. The entry has no `auto` flag; `method` names the strategy (`remote`, `snapcompact`, `handoff`, `shake`, `soft`), and a manual `/compact` writes the same entry. The mod cannot tell automatic from manual compactions, so the figure is the number of compactions and is labelled as such.
- `message.contextSnapshot.compactionEpoch` is 0 in all 4,798 messages that carry it, so it is consistent with "no compaction yet" but is not a count to rely on.
- The count needs the whole file, not the tail. Where the file is larger than the tail window, the provider can count only the compactions in the tail and so reads `n/a` for the count, never 0 (D4).
- Fixture `compacted.jsonl` (Task 1.4) must be written by hand from the shape above, since no real file has one.

## D8 (b): where the maximum context window comes from

Not in the session files; found in omp's model catalogue. `~/.omp/agent/models.db`, table `model_cache`, column `models` (a JSON array) holds one object per model with `id`, `provider` and `contextWindow`. For `github-copilot` it lists `claude-sonnet-5.5-1m`, `claude-opus-5.5-1m` and `claude-haiku-5.5-1m` at `1000000`, and `claude-sonnet-5.5`, `claude-opus-5.5` at `328000`, `claude-haiku-5.5` at `228000`.

- Look up by `message.provider` and `message.model` of the latest assistant message.
- The table holds several rows per provider (`provider_id` is `<provider>:models-v2:<hash>` and `materialization_policy` names the omp version). Use the row with the greatest `updated_at` among the rows whose `provider_id` starts with `<provider>:`. An older row can disagree: the `29dw...` row, last updated by omp 18.13.2, lists `claude-sonnet-5.5` at `1000000`.
- Read the database read-only. If the file, the row or the model is missing, the maximum window, the percentage and the headroom read `n/a` (D8).

## D8 (c): where the autocompaction trigger point comes from

Not in the session files; it is computed by omp from its settings and the model's window (omp 18.20.2 strings, function `Hx`: compact when the context tokens exceed the trigger).

- Settings: `compaction.thresholdTokens` (a token count) and `compaction.thresholdPercent` (a percentage of the window), and `compaction.reserveTokens`. `omp config get` shows `compaction.thresholdTokens` and `compaction.thresholdPercent` as `-1` and `compaction.reserveTokens` as not set; `~/.omp/agent/config.yml` holds no compaction key.
- With a positive `thresholdTokens` the trigger is that count (capped under the window). With a positive `thresholdPercent` it is `floor(window * percent / 100)`. With both at `-1` (the default here) it is `window - reserve`, where the reserve is derived inside omp from the window and `reserveTokens` (a 15% of the window rule and a 16,384 default were visible in the code). That formula is internal and can change between omp versions.
- Decision for Task 1.4: the trigger point is known only when `config.yml` sets `compaction.thresholdTokens` or `compaction.thresholdPercent` explicitly; with the default settings it is **not found** and the headroom reads `n/a`. The mod does not copy omp's internal reserve formula, since a wrong copy would be an invented figure (D4).

## D8 (d): meaning of `usage.cttl`

Found in real files, and it differs from the spec's guess. `cttl` is an object `{"ephemeral5m": N}`, present on 4,804 of 4,826 assistant messages (never `null` when present, never another key). `N` is equal to that message's `usage.cacheWrite` on all 4,804.

- The key names the cache lifetime class of the tokens written in the turn (`ephemeral5m`, a 5-minute prompt cache); the value is how many tokens were written under that class, not a duration.
- So the lifetime is read from the key: `ephemeral5m` is 5 minutes. A `cttl` with no key the provider knows, or no `cttl`, gives `n/a` for the countdown. No other key (such as a 1-hour class) appears in the files seen.
- The cache goes cold at `message.completedAt + 5 min` (fall back to `message.timestamp` plus `duration`; if neither is there, `n/a`). The countdown uses the last assistant turn with a `cttl`.
- A turn with `cacheWrite` 0 has no `cttl`, and every turn with `cttl` has `cacheWrite` above 0 (all 22 messages without `cttl` have `cacheWrite` 0): a cache written earlier is still warm, but the figure counts from the last turn that has one, and the mod does not guess beyond it.

## The stats shape

The stats object a provider returns is defined once, in the header comment of `src/providers/index.js`, with the `STAT_FIELDS` list. Every figure is a value or the string `n/a`; `readStats` returns every field and fills the ones a provider left out with `n/a`. `harness` is the name asked for and is never `n/a`.

## Fixtures

`test/fixtures/omp/basic.jsonl` is the header entries (`title`, `session`, `model_change`, `thinking_level_change`) and the first 12 messages of one real session, with the cwd, title, message text, thinking text, tool arguments and results, response ids and credential ids removed. Numbers, timestamps, model names, stop reasons and usage are the original ones. `no-usage.jsonl` is the first 9 lines of `basic.jsonl` with `usage` and `contextSnapshot` deleted from every assistant message.
