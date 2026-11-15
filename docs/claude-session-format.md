# Claude Code session format

What the Claude Code provider (`src/providers/claude.js`, `src/providers/claude-sources.js`) reads, and which figures of the stats shape the files cannot give.

Sources checked on 2026-11-15: the 44 session files in `~/.claude/projects` (Claude Code 2.1.260 to 2.1.310; entrypoints `cli`, `sdk-cli` and `claude-desktop-3p`), and in detail the 2,209-line file of one 16-hour session. Each finding says which source it comes from. Nothing here was copied from message text; the fixtures hold no paths or text.

## File layout

- A session is one JSON-lines file: `~/.claude/projects/<folder>/<session uuid>.jsonl`. A directory of the session's uuid beside the file holds sub-agent data (`subagents/`) and a `custom-title.json`; ignore it. Sub-agent turns are not in the main file.
- `<folder>` is the session's working folder with every character that is not a letter or a digit turned into `-` (`/Users/me/.claude` is `-Users-me--claude`). Seen on the folders here: `/` and `.` become `-`, and `-` stays. Another character (a space, an underscore) is not in any folder here, so turning it into `-` is [INFERENCE] from Claude Code's own rule; if it is wrong, that folder has no linked session and its card reads n/a. A name beyond about 200 characters is cut and given a hash by Claude Code; the mod does not reproduce it, so such a folder reads n/a too.
- Entry types seen in the big file, with counts: `assistant` 649, `attachment` 498, `user` 446, `system` 88, `last-prompt` 86, `permission-mode` 85, `mode` 85, `atis-latch` 85, `ai-title` 83, `file-history-snapshot` 79, `queue-operation` 14, `file-history-delta` 8, `cost-state` 3. Only `user`, `assistant`, `system` and `cost-state` carry figures. There is no header entry: a file starts with whatever came first, so the whole file is told from a tail by its size, not by a first line.
- `user` and `assistant` entries carry an ISO `timestamp` and a `message` (`role`, `content`). A `user` entry whose `message.content` is a list of `tool_result` parts continues a turn; a string, or a list of other parts, begins one (`isMeta: true` entries are Claude Code's own notes, not prompts).

## Fields each figure uses

An assistant entry has `message.id`, `message.model`, `message.stop_reason` and `message.usage`:

| Field | Meaning |
| --- | --- |
| `message.model` | for example `claude-opus-4-6`; the model of a session is the model of the latest assistant entry. `<synthetic>` marks a placeholder Claude Code writes for an API error or an interruption (3 in the big file): all its usage is 0, and it is not a turn |
| `message.usage.input_tokens`, `output_tokens` | tokens of this response (`input_tokens` is only the part of the prompt not read from or written to the cache, so 1 to 3 on most) |
| `message.usage.cache_read_input_tokens`, `cache_creation_input_tokens` | tokens read from and written to the prompt cache |
| `message.usage.cache_creation` | the written tokens split by lifetime class: `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`; they add up to `cache_creation_input_tokens` (the 1-hour class is rare: 42,404 tokens in one place here) |
| `message.usage.output_tokens_details.thinking_tokens` | part of `output_tokens`; not used |

**One response is several entries.** Claude Code writes an API response as one entry per content block (`thinking`, `text`, `tool_use`), and every one of them has the same `message.id` and, in the big file, the same `usage` (the 649 assistant entries are 346 responses; checked: no `message.id` has two different usage objects). Summing the entries would count a response up to six times, so the provider keeps one record per `message.id`, the last entry, and dates the response by that last entry's `timestamp`. An entry with no `message.id` is a response of its own.

A tool result is a `user` entry too, so a prompt is told from it by its content, not by its `type`.

## Figures

| Figure | Source in the files |
| --- | --- |
| model | `message.model` of the latest non-synthetic assistant entry |
| durationMs | first to last `user` or `assistant` entry, by `timestamp` |
| totalTokens | per response `input + output + cache_read + cache_creation`, summed; a response lacking one of the four has no total |
| contextTokens | latest response's `input + cache_read + cache_creation` (its prompt) |
| cacheHitRate, cacheHits, cacheMisses | D6 over `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`; a hit is a response with a cache read above 0 |
| cacheLeftMs | latest response's `cache_creation` class (5 minutes or 1 hour, the larger when both were written) from the response's last entry; 0 once past. Unknown (n/a) when that response wrote nothing to the cache or has no split: a read refreshes the entry, but the files do not say for how long |
| costUsd | the `totalCostUSD` of the last `cost-state` entry (below) |
| burnTokensPerMin | totalTokens over durationMs, from what was read |
| sinceActivityMs | now minus the last `user` or `assistant` entry |
| latencyMs | last assistant entry minus the prompt that began its turn |
| autocompactions | `system` entries with `subtype: "compact_boundary"` and `compactMetadata.trigger: "auto"`, over the whole file (below) |

**Cost.** Claude Code logs no cost on a response. It does write a `cost-state` entry (39 of the 44 files have one, at the end of the file, 1 to 3 times): `totalCostUSD`, plus `totalDuration`, `startTime`, `totalLinesAdded` and `modelUsage` with tokens and `costUSD` by model. That total is the session's cost as Claude Code itself counted it, sub-agents and side calls included (the big file: 39.33 USD; its `totalDuration` of 57,677,524 ms agrees with the 57,664,215 ms the provider reads as the duration). It is written when a session is saved, not per turn, so a live session has none, or the one from before it was resumed. A response after the last `cost-state` is not in it, so then the figure is n/a instead of a stale lower one (D4, D5; no price table). There is no cost per hour: it would divide a total logged at save time by a duration read here.

**Autocompactions.** A compaction writes a `system` entry `compact_boundary` with `compactMetadata` (`trigger`, `preTokens`, `postTokens`, ...). The one in the files here has `trigger: "manual"`; no automatic one is in any local file, so `trigger: "auto"` as the name of the automatic kind is [INFERENCE], and so is that no other trigger is automatic. A `compact_boundary` whose trigger is neither `manual` nor `auto` (or has none) might be an automatic one under a name this reader does not know, so the count reads n/a then instead of a number that may be too low (D4). The count needs the whole file: it is read from the accumulator over the whole file, as for omp (below), and the fixtures of the tests are written by hand from the shape above.

## n/a by design

The session files hold nothing for these, so they read n/a (D4), for every Claude Code session:

- `contextMax`, `contextPercent`, `headroomTokens`: no model window is in a session file (the `[1m]` in a `cost-state` model name is a hint of a 1M variant, not a window), and no autocompaction trigger is either.
- `thinkingLevel`: the file has an `effort` field on assistant entries (`max`, `high`) and a `mode`/`permission-mode` entry; neither is a thinking level in the sense of the stats shape, so it is not mapped.
- `premiumRequests`: Claude Code has no such count.
- `burnCostPerHour`: see Cost.

As for omp, a file larger than the tail window is folded once in blocks and then by the bytes appended (`fold` in `src/providers/claude.js`, driven by `src/refresh.js`), so totals, duration, cache figures, the token burn and the latency of the last turn are over the whole session (D7, amended). A response written as several blocks (same `message.id`) counts once also when its blocks lie in different blocks of the scan: the accumulator keeps what each id added, to replace it. The latency of the last turn skips a `<synthetic>` reply, as the model and the cache figures do, and the accumulator keeps the timestamp of the latest prompt, so a prompt before the tail window still gives it.

## Fixtures

`test/fixtures/claude/basic.jsonl` is five responses of the big file with their usage, timestamps, model and block structure as logged, and the prompts and tool results of the turns they belong to; ids are `msg_01` to `msg_05`, `u01`, `a01`, ... and `s1`, and the text, tool inputs, paths and branch names are placeholders. Its `cost-state` line is written by hand (total 1.25), since the real totals describe whole sessions. `no-usage.jsonl` is the first six lines of `basic.jsonl` with `usage` removed from every assistant entry.
