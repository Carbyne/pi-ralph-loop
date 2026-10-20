# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0

### Fixed

- `/ralph-resume` (and any follow-up fire) no longer errors during compaction. Previously,
  resuming while `Compacting context...` ran produced
  `Extension "<runtime>" error: Cannot submit a prompt while compaction is in progress`.
  The loop now tracks `session_before_compact` / `session_compact` / `session_compact_failed`,
  parks the pending follow-up, and drains it when compaction finishes (watchdog: the park
  releases after 60s even if an end-event is missed). A send that races compaction is caught,
  parked, and retried — never surfaced as an extension error.

### Changed

- `/ralph-config` now works while the loop is inactive. Edits apply to the same config the
  loop would resume with (in-memory loop → persisted saved loop → settings defaults) and are
  persisted, so you can tune prompt/flags of a paused loop before `/ralph-resume`. The loop is
  NOT started by config; notice says `config saved (loop not active — /ralph-resume will use it)`.

## 0.1.0

### Added

- `/ralph [prompt] [flags]` — start an autonomous follow-up loop that re-prompts the agent
  each time it fully settles
- `/ralph-config`, `/ralph-stop`, `/ralph-resume`, `/ralph-status`
- Iteration cap (`--max`), error budget (`--max-errors`) with refunded error turns, and
  configurable pre-prompt `--delay`
- Stall detector: self-stops after `--stall` consecutive follow-ups that make zero tool
  calls, notifies the operator, and runs an optional `--stall-cmd` template
- Optional completion marker to end a loop on an explicit signal
- Soft integration with `pi-bg-jobs` over the `pi.events` bus: pauses while jobs run, holds
  `--job-grace` when they drain, and fires a rate-limited `--job-wait` stuck-check with a
  customizable `--job-check` / `--job-check-file` template. Works standalone without it
- Duration parsing that accepts bare seconds or `1500ms` / `60s` / `10m` / `1h` units,
  failing loudly on garbage
- Transparent loop survival across `/reload`; restored paused after quit + resume
