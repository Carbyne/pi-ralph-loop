/**
 * ralph-loop — a simple "ralph loop" of follow-up prompts for pi.
 *
 * When active, every time the agent fully settles (no retries, no queued
 * follow-ups left) a custom follow-up user message is scheduled via
 * pi.sendUserMessage(..., { deliverAs: "followUp" }), keeping the agent
 * working on a task until a stop condition is met.
 *
 * bg-jobs integration (pi.events bus, events "bg-jobs:status" / "bg-jobs:status-request"):
 *   - On session start ralph subscribes to status events AND requests a fresh
 *     snapshot (events emitted before subscription — e.g. job revive during
 *     reload — would otherwise be missed).
 *   - While background jobs are running, NO follow-up is scheduled — the
 *     agent is just waiting; bg-jobs' own completion notification wakes it
 *     and this loop re-arms on the next agent_settled. When jobs drain, the
 *     loop holds for jobDoneGraceMs before firing itself (fallback for
 *     suppressed notices).
 *   - maxJobWaitMs (0 = wait forever): if jobs have been running longer than
 *     this, a "stuck-check" follow-up is fired (rate-limited to once per
 *     maxJobWaitMs window) so the agent verifies the jobs are not wedged.
 *
 * Lifecycle: /reload keeps an active loop running transparently; quit +
 * resume/new session restores it paused — resume manually with /ralph-resume.
 *
 * Commands: /ralph [prompt] [--max N] [--max-errors N] [--delay <dur>] [--job-wait <dur>] [--job-grace <dur>]
 *           [--job-check "<template, {summary} placeholder>" | --job-check-file <path>]
 *           /ralph-config [same flags] [new prompt]  — update the loop in place; also works while
 *           inactive (edits the config /ralph-resume will use; does not start the loop)
 *           /ralph-stop  /ralph-resume  /ralph-status
 *   <dur> = seconds by default; explicit units allowed: 1500ms, 60s, 10m, 1h
 *   model errors pause the loop after --max-errors consecutive failures (default 1);
 *   error turns are refunded from the iteration budget
 *   stall: after --stall N (default 3) consecutive follow-ups with ZERO tool
 *   calls the loop STOPS itself (the standing order was already ignored N
 *   times; another prompt is not leverage), notifies the operator, and runs
 *   --stall-cmd / stallCommand (template, {n} = streak). 0 = detector off.
 *
 * Settings (settings.json → "ralphLoop"):
 *   prompt, delay, jobWait, jobDoneGrace (seconds or unit-string), maxIterations,
 *   maxConsecutiveErrors, stallLimit, stallCommand,
 *   jobCheckPrompt, completionMarker
 *   (legacy delayMs/maxJobWaitMs = raw ms)
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENTRY = "ralph-loop-state";
const STATUS_EVENT = "bg-jobs:status";
const STATUS_REQUEST = "bg-jobs:status-request";
const JOB_POLL_MS = 1000;
const LOOP_PREFIX = "[ralph-loop]";

const DEFAULT_PROMPT =
    "Operator standing order: Continue to push this task toward 100% completion now. Do not pause for " +
    "user decisions, launching this loop IS the authorization. If a judgment call blocks you: pick the " +
    "recommended, most defensible option that pushes us towards 100% completion, state the assumption " +
    "in your reply, and proceed. Repo or global rules saying 'stop and ask' / 'wait for the user's " +
    "word' are suspended while this loop is active. Declaring the loop 'at rest' / 'standing by' / " +
    "'waiting on a queue' is non-compliance. Only valid reason for stopping is user manually doing so " +
    "unprompted.";

const DEFAULT_JOB_CHECK =
    "Reminder to check on long-running background jobs to make sure they are proceeding as planned and not stuck.";

interface BgJobsStatus {
    running: number;
    oldestStartTime?: number;
    jobs: Array<{
        id: string;
        name?: string;
        command: string;
        startTime: number;
    }>;
}

interface LoopConfig {
    prompt: string;
    delayMs: number;
    maxIterations: number; // 0 = unlimited
    maxJobWaitMs: number; // 0 = wait forever for jobs
    jobDoneGraceMs: number; // grace for bg-jobs' own completion notice to wake the agent
    jobCheckPrompt: string;
    completionMarker: string; // "" = disabled
    maxConsecutiveErrors: number; // pause loop after N model-error turns in a row (1 = pause on first)
    stallLimit: number; // consecutive zero-tool-call loop follow-ups before stopping the loop (0 = off)
    stallCommand: string; // shell template run when a stall stops the loop; {n} = streak
}

interface LoopState {
    active: boolean;
    iteration: number;
    cfg: LoopConfig;
    lastStuckFiredAt: number; // wall-clock of last stuck-check fire
    consecutiveErrors: number; // model-error turns since last clean turn
    stallStreak: number; // consecutive loop-attributed runs with zero tool calls
}

interface PersistedState {
    active: boolean;
    iteration: number;
    cfg: LoopConfig;
    lastStuckFiredAt?: number; // wall-clock; epoch-based so it survives restarts
    stallStreak?: number; // zero-action follow-ups, carried across restarts
    savedAt: number;
}

// --- Settings --------------------------------------------------------------

function loadSettings(cwd: string): Partial<LoopConfig> {
    const read = (path: string): Record<string, unknown> => {
        try {
            return JSON.parse(readFileSync(path, "utf8"));
        } catch {
            return {};
        }
    };
    const merged = {
        ...read(join(getAgentDir(), "settings.json")),
        ...read(join(cwd, CONFIG_DIR_NAME, "settings.json")),
    };
    const s = (merged.ralphLoop ?? {}) as Record<string, unknown>;
    const cfg: Partial<LoopConfig> = {};
    if (typeof s.prompt === "string") cfg.prompt = s.prompt;
    // delay / jobWait: number = seconds, or string with unit ("1500ms", "60s",
    // "10m", "1h"). Legacy *Ms keys (raw milliseconds) still supported.
    if (s.delay !== undefined) cfg.delayMs = parseDuration(s.delay);
    else if (typeof s.delayMs === "number" && s.delayMs >= 0) cfg.delayMs = s.delayMs;
    if (typeof s.maxIterations === "number" && s.maxIterations >= 0)
        cfg.maxIterations = s.maxIterations;
    if (s.jobWait !== undefined) cfg.maxJobWaitMs = parseDuration(s.jobWait);
    else if (typeof s.maxJobWaitMs === "number" && s.maxJobWaitMs >= 0)
        cfg.maxJobWaitMs = s.maxJobWaitMs;
    if (s.jobDoneGrace !== undefined) cfg.jobDoneGraceMs = parseDuration(s.jobDoneGrace);
    else if (typeof s.jobDoneGraceMs === "number" && s.jobDoneGraceMs >= 0)
        cfg.jobDoneGraceMs = s.jobDoneGraceMs;
    if (typeof s.jobCheckPrompt === "string") cfg.jobCheckPrompt = s.jobCheckPrompt;
    if (typeof s.completionMarker === "string") cfg.completionMarker = s.completionMarker;
    if (typeof s.maxConsecutiveErrors === "number" && s.maxConsecutiveErrors >= 1)
        cfg.maxConsecutiveErrors = Math.floor(s.maxConsecutiveErrors);
    if (typeof s.stallLimit === "number" && s.stallLimit >= 0) cfg.stallLimit = Math.floor(s.stallLimit);
    if (typeof s.stallCommand === "string") cfg.stallCommand = s.stallCommand;
    return cfg;
}

function defaultConfig(s: Partial<LoopConfig>): LoopConfig {
    return {
        prompt: s.prompt ?? DEFAULT_PROMPT,
        delayMs: s.delayMs ?? 1500,
        maxIterations: s.maxIterations ?? 0,
        maxJobWaitMs: s.maxJobWaitMs ?? 0,
        jobDoneGraceMs: s.jobDoneGraceMs ?? 1500,
        jobCheckPrompt: s.jobCheckPrompt ?? DEFAULT_JOB_CHECK,
        completionMarker: s.completionMarker ?? "",
        maxConsecutiveErrors: s.maxConsecutiveErrors ?? 1,
        stallLimit: s.stallLimit ?? 3,
        stallCommand: s.stallCommand ?? "",
    };
}

function formatAge(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Parse a duration to milliseconds. Plain numbers are SECONDS (5 -> 5000).
 * Strings may carry a unit: "1500ms", "60s", "10m", "1h" (default unit: s).
 * Throws on garbage so misconfiguration fails loudly.
 */
function parseDuration(v: unknown): number {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v * 1000);
    if (typeof v === "string") {
        const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
        if (m) {
            const n = Number(m[1]);
            const mul = ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const)[
                (m[2] ?? "s").toLowerCase() as "ms" | "s" | "m" | "h"
            ];
            return Math.floor(n * mul);
        }
    }
    throw new Error(
        `ralph-loop: invalid duration ${JSON.stringify(v)} (use seconds or a unit, e.g. 5, 60s, 1500ms, 10m, 1h)`
    );
}

/** Human-readable ms for user-facing messages. */
function fmtDur(ms: number): string {
    return ms < 1000 ? `${ms}ms` : formatAge(ms);
}

// --- flag autocomplete ------------------------------------------------------

const FLAG_SPECS: Array<{ flag: string; hint: string }> = [
    { flag: "--max", hint: "N — stop after N iterations (0 = unlimited)" },
    { flag: "--max-errors", hint: "N — pause after N consecutive model errors" },
    { flag: "--delay", hint: "<dur> — wait after settle (5, 500ms, 2m, 1h)" },
    { flag: "--job-wait", hint: "<dur> — stuck-job check threshold (0 = wait forever)" },
    { flag: "--job-grace", hint: "<dur> — hold after bg jobs drain" },
    { flag: "--stall", hint: "N — zero-action follow-ups before auto-stop (0 = off)" },
    { flag: "--stall-cmd", hint: "<template> — shell command on stall ({n})" },
    { flag: "--job-check", hint: "<text> — stuck-check template ({summary})" },
    { flag: "--job-check-file", hint: "<path> — stuck-check template from file" },
];

/**
 * pi replaces the ENTIRE argument string with the chosen item.value, so
 * values are (already-typed args) + completed flag + trailing space.
 * Suggestions appear when typing a new flag ("--…") or on an empty arg line.
 */
function flagCompletions(args: string): AutocompleteItem[] | null {
    const lastSpace = args.lastIndexOf(" ");
    const head = lastSpace === -1 ? "" : args.slice(0, lastSpace + 1);
    const trailing = lastSpace === -1 ? args : args.slice(lastSpace + 1);
    if (trailing !== "" && !trailing.startsWith("-")) return null; // mid-word: user text/value
    if (trailing === "" && args.trim() !== "" && !args.trimEnd().endsWith("-")) {
        // Ends with space: only offer the flag list when the previous token
        // was itself a flag position (keeps prompt typing unintercepted).
        const lastTok = args.trimEnd().split(/\s+/).pop() ?? "";
        if (!lastTok.startsWith("-")) return null;
    }
    const items: AutocompleteItem[] = FLAG_SPECS.filter((f) => f.flag.startsWith(trailing)).map((f) => ({
        value: head + f.flag + " ",
        label: f.flag,
        description: f.hint,
    }));
    return items.length ? items : null;
}

// --- Extension -------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
    let settings: Partial<LoopConfig> = {};
    let state: LoopState = {
        active: false,
        iteration: 0,
        cfg: defaultConfig({}),
        lastStuckFiredAt: 0,
        consecutiveErrors: 0,
        stallStreak: 0,
    };
    let bgStatus: BgJobsStatus = { running: 0, jobs: [] };
    let timer: NodeJS.Timeout | undefined;
    let lastCtx: ExtensionContext | undefined;
    let subActive = true; // guards stale event listeners after session switch
    let savedLoop: PersistedState | undefined;
    // Tool calls observed in the current loop-attributed run (stall detector).
    let toolCallsSinceFire = 0;
    // True from a loop-fired prompt until user/rpc input arrives; error turns
    // are only attributed to the loop while set (auto-retries keep it true).
    let attributedToLoop = false;
    // True between session_before_compact and session_compact/_failed. While
    // set, pi.sendUserMessage throws ("Cannot submit a prompt while compaction
    // is in progress"), so fires are parked in pendingFire and drained when
    // compaction finishes instead of erroring the extension.
    let compacting = false;
    let compactWatchdog: NodeJS.Timeout | undefined;
    let pendingFire: { text: string; label: string } | undefined;

    const clearTimer = () => {
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
    };

    function setStatus(extra?: string): void {
        if (!lastCtx?.hasUI) return;
        try {
            if (!state.active) {
                lastCtx.ui.setStatus("ralph-loop", undefined);
                return;
            }
            const max = state.cfg.maxIterations > 0 ? `/${state.cfg.maxIterations}` : "";
            let text = `\u{1F504} ralph ${state.iteration}${max}`;
            if (extra) text += ` — ${extra}`;
            lastCtx.ui.setStatus("ralph-loop", text);
        } catch {
            /* stale ctx */
        }
    }

    function persist(): void {
        try {
            pi.appendEntry(ENTRY, {
                active: state.active,
                iteration: state.iteration,
                cfg: state.cfg,
                lastStuckFiredAt: state.lastStuckFiredAt,
                stallStreak: state.stallStreak,
                savedAt: Date.now(),
            } satisfies PersistedState);
        } catch {
            /* non-session contexts */
        }
    }

    function stop(reason: string): void {
        clearTimer();
        state.active = false;
        pendingFire = undefined;
        setStatus();
        persist();
        if (lastCtx?.hasUI) lastCtx.ui.notify(`Ralph loop stopped: ${reason}`, "info");
    }

    // Parked follow-up, fired once compaction ends (or by the watchdog if an
    // end event is missed). No-op while still compacting or inactive.
    function drainPendingFire(): void {
        if (!state.active || !pendingFire || compacting) return;
        const p = pendingFire;
        pendingFire = undefined;
        timer = setTimeout(() => {
            if (state.active && !compacting) fire(p.text, p.label);
        }, 300);
        timer.unref();
    }

    function noteCompactionStart(): void {
        compacting = true;
        if (compactWatchdog) clearTimeout(compactWatchdog);
        // Safety net: if the end event is missed (fork/switch/reload races),
        // unblock after 60s rather than park the loop forever.
        compactWatchdog = setTimeout(() => {
            compacting = false;
            compactWatchdog = undefined;
            drainPendingFire();
        }, 60_000);
        compactWatchdog.unref();
    }

    function noteCompactionEnd(): void {
        compacting = false;
        if (compactWatchdog) {
            clearTimeout(compactWatchdog);
            compactWatchdog = undefined;
        }
        drainPendingFire();
    }

    // Fire one follow-up prompt. Returns true if the message was queued.
    function fire(text: string, label = "follow-up"): boolean {
        // Compaction in progress: pi refuses prompt submission right now.
        // Park it — the compact-end handler drains it. No extension error.
        if (compacting) {
            pendingFire = { text, label };
            return false;
        }
        // A turn is already running or input is queued — agent_settled will
        // re-arm the loop, so don't add another prompt.
        if (lastCtx && (!lastCtx.isIdle() || lastCtx.hasPendingMessages())) return false;

        state.iteration++;
        if (state.cfg.maxIterations > 0 && state.iteration > state.cfg.maxIterations) {
            stop(`max iterations (${state.cfg.maxIterations}) reached`);
            return false;
        }
        persist();
        const max = state.cfg.maxIterations > 0 ? `/${state.cfg.maxIterations}` : "";
        const message = `${LOOP_PREFIX} ${label} ${state.iteration}${max}\n\n${text}`;
        try {
            pi.sendUserMessage(message, { deliverAs: "followUp" });
            attributedToLoop = true;
            toolCallsSinceFire = 0;
            setStatus();
            return true;
        } catch (err) {
            state.iteration--;
            const msg = String(err);
            // Race: compaction started between the idle check and the send.
            // Enter compacting mode and park the follow-up; do not surface
            // an extension error (pi recovers on compaction end).
            if (/compact/i.test(msg)) {
                noteCompactionStart();
                pendingFire = { text, label };
                if (lastCtx?.hasUI)
                    lastCtx.ui.notify("Ralph loop: compaction in progress — follow-up deferred until it finishes.", "info");
                return false;
            }
            if (lastCtx?.hasUI)
                lastCtx.ui.notify(`ralph-loop failed to send follow-up: ${msg}`, "error");
            return false;
        }
    }

    // The standing order has already been repeated stallStreak times with no
    // observable work. A further prompt is not leverage — stop, page the
    // operator, run the stall command. Returns false when the loop stopped.
    function checkStall(): boolean {
        const { stallLimit } = state.cfg;
        if (stallLimit <= 0 || state.stallStreak < stallLimit) return true;
        runStallCommand(state.stallStreak);
        stop(`stalled: ${state.stallStreak} consecutive follow-ups with zero tool calls — the standing order was ignored ${state.stallStreak}x`);
        return false;
    }

    function runStallCommand(n: number): void {
        const tpl = state.cfg.stallCommand;
        if (!tpl || typeof pi.exec !== "function") return;
        const cmd = tpl.split("{n}").join(String(n));
        try {
            void Promise.resolve(pi.exec("sh", ["-c", cmd], { timeout: 15000 })).catch(() => {
                /* best-effort notification */
            });
        } catch {
            /* best-effort notification */
        }
    }

    // Called when the agent has fully settled while the loop is active.
    function schedule(): void {
        if (!state.active) return;
        clearTimer();
        // Set while this schedule chain is waiting on bg jobs. When they
        // drain, bg-jobs' own completion notice (coalesced ~400ms after the
        // status snapshot says running=0) should wake the agent — firing our
        // prompt immediately would beat it and get the notice steered mid-run.
        let wasWaitingOnJobs = false;

        const tick = () => {
            if (!state.active) return;

            if (bgStatus.running > 0) {
                wasWaitingOnJobs = true;
                setStatus(`waiting on ${bgStatus.running} bg job(s)`);
                const { maxJobWaitMs, jobCheckPrompt } = state.cfg;
                if (maxJobWaitMs > 0 && bgStatus.oldestStartTime) {
                    const age = Date.now() - bgStatus.oldestStartTime;
                    if (
                        age >= maxJobWaitMs &&
                        Date.now() - state.lastStuckFiredAt >= maxJobWaitMs
                    ) {
                        state.lastStuckFiredAt = Date.now();
                        const summary = bgStatus.jobs
                            .map(
                                (j) =>
                                    `- ${j.id}${j.name ? ` "${j.name}"` : ""}: ${j.command.slice(0, 120)} (running ${formatAge(Date.now() - j.startTime)})`
                            )
                            .join("\n");
                        // Templates without {summary} still get the job list,
                        // appended — a check prompt must say which jobs.
                        const body = jobCheckPrompt.includes("{summary}")
                            ? jobCheckPrompt.replace("{summary}", summary)
                            : `${jobCheckPrompt}\n\n${summary}`;
                        const stuck = `⏳ Ralph loop stuck-job check — jobs over the ${formatAge(maxJobWaitMs)} limit.\n\n${body}`;
                        fire(stuck, "stuck-job check");
                    }
                }
                timer = setTimeout(tick, JOB_POLL_MS);
                timer.unref();
                return;
            }

            // Jobs drained. Two cases:
            //  - We were waiting: give bg-jobs' completion notice a grace
            //    window to wake the agent itself. If it did (agent busy), do
            //    nothing — the next agent_settled re-arms us with the job
            //    output already seen. Only if still idle (notice suppressed,
            //    e.g. consumed by attach/output) do we fire.
            //  - We never waited: fire the normal follow-up.
            if (wasWaitingOnJobs && state.cfg.jobDoneGraceMs > 0) {
                const grace = state.cfg.jobDoneGraceMs;
                setStatus(`bg jobs done, holding ${fmtDur(grace)} for job notice`);
                timer = setTimeout(() => {
                    if (!state.active) return;
                    if (lastCtx && !lastCtx.isIdle()) return; // notice woke it
                    fire(state.cfg.prompt, "follow-up");
                }, grace);
                timer.unref();
                return;
            }

            setStatus();
            fire(state.cfg.prompt, state.iteration === 0 ? "kickoff" : "follow-up");
        };

        // Arm after the delay. Also used by /ralph start: the first prompt
        // waits for the agent to settle (and the delay) before firing.

        // If we never even started waiting, just fire after the delay.
        timer = setTimeout(tick, state.cfg.delayMs);
        timer.unref();
    }

    function pause(reason: string, level: "warning" | "error" = "warning"): void {
        clearTimer();
        state.active = false;
        pendingFire = undefined;
        setStatus();
        persist();
        if (lastCtx?.hasUI)
            lastCtx.ui.notify(
                `Ralph loop paused (${reason}). Resume with /ralph-resume`,
                level
            );
    }

    // Inspect the finalized messages of a run: handle interrupts and model
    // errors, and the optional completion marker.
    function inspectLastRun(messages: unknown[]): void {
        if (!state.active) return;
        const lastAssistant = [...messages]
            .reverse()
            .find((m) => (m as { role?: string })?.role === "assistant") as
            | { stopReason?: string; content?: unknown; errorMessage?: string }
            | undefined;
        if (!lastAssistant) return;
        const reason = lastAssistant.stopReason;

        if (reason !== "error") state.consecutiveErrors = 0;

        if (reason === "aborted" || reason === "cancelled") {
            pause("agent was interrupted");
            return;
        }

        if (reason === "error") {
            // A user-initiated turn failing says nothing about the loop's
            // budget — leave it alone; the outage counter still matters if we
            // last fired.
            if (!attributedToLoop) return;
            state.consecutiveErrors++;
            // The failed turn did no work: refund its iteration so an outage
            // does not silently eat maxIterations.
            if (state.iteration > 0) state.iteration--;
            const detail = (lastAssistant.errorMessage || "").split("\n")[0] ?? "";
            if (state.consecutiveErrors >= state.cfg.maxConsecutiveErrors) {
                pause(
                    `model error${detail ? `: ${detail.slice(0, 160)}` : ""}`,
                    "error"
                );
            } else if (lastCtx?.hasUI) {
                lastCtx.ui.notify(
                    `ralph-loop: model error (${state.consecutiveErrors}/${state.cfg.maxConsecutiveErrors} tolerated)${detail ? `: ${detail.slice(0, 120)}` : ""} — retrying`,
                    "warning"
                );
            }
            return;
        }

        if (state.cfg.completionMarker) {
            const text = Array.isArray(lastAssistant.content)
                ? (lastAssistant.content as Array<{ type?: string; text?: string }>)
                      .filter((c) => c.type === "text")
                      .map((c) => c.text ?? "")
                      .join("\n")
                : "";
            if (text.includes(state.cfg.completionMarker)) {
                stop(`completion marker "${state.cfg.completionMarker}" seen`);
            }
        }
    }

    // --- events --------------------------------------------------------------

    pi.on("session_start", async (event, ctx) => {
        subActive = true;
        lastCtx = ctx;
        settings = loadSettings(ctx.cwd);
        clearTimer();
        compacting = false;
        pendingFire = undefined;
        if (compactWatchdog) {
            clearTimeout(compactWatchdog);
            compactWatchdog = undefined;
        }
        bgStatus = { running: 0, jobs: [] };
        state = { active: false, iteration: 0, cfg: defaultConfig(settings), lastStuckFiredAt: 0, consecutiveErrors: 0, stallStreak: 0 };

        // Restore the most recent persisted loop.
        savedLoop = undefined;
        for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "custom" && (entry as { customType?: string }).customType === ENTRY) {
                savedLoop = (entry as { data?: PersistedState }).data;
            }
        }

        // Subscribe to live bg-job status, then ask bg-jobs for the current
        // snapshot: after a reload/revive we may have missed change events
        // emitted before this subscription existed.
        try {
            pi.events.on(STATUS_EVENT, (s: BgJobsStatus) => {
                if (subActive) bgStatus = s;
            });
            pi.events.emit(STATUS_REQUEST, undefined);
        } catch {
            /* event bus unavailable */
        }

        const reason = (event as { reason?: string })?.reason;
        if (reason === "reload" && savedLoop?.active) {
            // /reload: keep the loop running transparently — reload is not a
            // user stop. (quit/resume/new/fork stay manual on purpose.)
            state = {
                active: true,
                iteration: savedLoop.iteration,
                cfg: { ...defaultConfig(settings), ...savedLoop.cfg },
                // Carry the stuck-check cooldown across reload so we don't
                // re-nag a job the loop already reported (wall-clock values).
                lastStuckFiredAt: savedLoop.lastStuckFiredAt ?? 0,
                consecutiveErrors: 0,
                stallStreak: savedLoop.stallStreak ?? 0,
            };
            setStatus();
            ctx.ui.notify(
                `Ralph loop restored after reload (iteration ${state.iteration}).`,
                "info"
            );
            // Re-enter normal scheduling: honors bg jobs + delay, exactly
            // like an agent_settled would.
            schedule();
            return;
        }

        if (savedLoop?.active) {
            ctx.ui.notify(
                `Ralph loop was active when this session last stopped (iteration ${savedLoop.iteration}). Resume with /ralph-resume`,
                "info"
            );
        }
    });

    pi.on("session_shutdown", async () => {
        subActive = false;
        clearTimer();
    });

    pi.on("agent_start", async (_event, ctx) => {
        lastCtx = ctx;
    });

    pi.on("agent_end", async (event, ctx) => {
        lastCtx = ctx;
        inspectLastRun(event.messages as unknown[]);
    });

    pi.on("agent_settled", async (_event, ctx) => {
        lastCtx = ctx;
        if (state.active && attributedToLoop) {
            if (toolCallsSinceFire === 0) state.stallStreak++;
            else state.stallStreak = 0;
            if (!checkStall()) return;
        }
        schedule();
    });

    // Count tool activity for the stall detector (loop-attributed runs only).
    pi.on("tool_call", async (event) => {
        if (state.active && attributedToLoop) toolCallsSinceFire++;
        void event;
        return undefined;
    });

    // Compaction lifecycle: gate follow-up submission. pi rejects
    // sendUserMessage while compaction runs; instead of erroring we park the
    // fire and drain it from session_compact / session_compact_failed.
    pi.on("session_before_compact", async () => {
        noteCompactionStart();
        return undefined;
    });

    pi.on("session_compact", async () => {
        noteCompactionEnd();
    });

    pi.on("session_compact_failed", async () => {
        noteCompactionEnd();
    });

    // User typed something while we were waiting — let their turn run; the
    // loop re-arms at the next agent_settled. Prevents racing the user.
    pi.on("input", async (event) => {
        if (event.source !== "extension") attributedToLoop = false;
        if (state.active && event.source === "interactive") clearTimer();
        return undefined;
    });

    // --- commands ------------------------------------------------------------

    function parseArgs(args: string, base: LoopConfig): { cfg: LoopConfig; prompt: string } {
        const cfg = { ...base };
        // Split into tokens honoring "double" and 'single' quotes (\" and \' escapes
        // inside quotes are unwrapped).
        const tokens: string[] = [];
        const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(args))) {
            const raw = m[1] ?? m[2] ?? m[3] ?? "";
            tokens.push(m[1] !== undefined || m[2] !== undefined ? raw.replace(/\\(["'\\])/g, "$1") : raw);
        }

        let i = -1;
        const needValue = (flag: string): string => {
            const v = tokens[++i];
            if (v === undefined || v.startsWith("--")) {
                throw new Error(`ralph-loop: ${flag} requires a value`);
            }
            return v;
        };

        const rest: string[] = [];
        while (++i < tokens.length) {
            const t = tokens[i];
            if (t === "--max") cfg.maxIterations = requireInt(needValue(t), t);
            else if (t === "--max-errors") cfg.maxConsecutiveErrors = Math.max(1, requireInt(needValue(t), t));
            else if (t === "--delay") cfg.delayMs = parseDuration(needValue(t));
            else if (t === "--job-wait") cfg.maxJobWaitMs = parseDuration(needValue(t));
            else if (t === "--job-grace") cfg.jobDoneGraceMs = parseDuration(needValue(t));
            else if (t === "--stall") cfg.stallLimit = requireInt(needValue(t), t);
            else if (t === "--stall-cmd") cfg.stallCommand = needValue(t);
            else if (t === "--job-check") cfg.jobCheckPrompt = needValue(t);
            else if (t === "--job-check-file") {
                const p = needValue(t);
                try {
                    cfg.jobCheckPrompt = readFileSync(p, "utf8");
                } catch (err) {
                    throw new Error(`ralph-loop: cannot read --job-check-file ${p}: ${String(err)}`);
                }
            }
            else rest.push(t);
        }
        return { cfg, prompt: rest.join(" ").trim() };
    }

    function requireInt(v: string, flag: string): number {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) throw new Error(`ralph-loop: ${flag} expects a non-negative number, got ${v}`);
        return Math.floor(n);
    }


    function startLoop(cfg: LoopConfig, ctx: ExtensionContext): void {
        clearTimer();
        state = { active: true, iteration: 0, cfg, lastStuckFiredAt: 0, consecutiveErrors: 0, stallStreak: 0 };
        persist();
        setStatus();
        const max = cfg.maxIterations > 0 ? `, max ${cfg.maxIterations} iterations` : ", unlimited";
        const jobWait = cfg.maxJobWaitMs > 0 ? `, stuck-job check after ${fmtDur(cfg.maxJobWaitMs)}` : "";
        ctx.ui.notify(
            `Ralph loop started: delay ${fmtDur(cfg.delayMs)}${max}${jobWait}. Stop with /ralph-stop.`,
            "info"
        );
        // Don't fire immediately — wait for the agent to settle (fires on the
        // next agent_settled if a turn is running; after delayMs if idle).
        schedule();
    }

    pi.registerCommand("ralph", {
        description:
            "Start ralph follow-up loop: /ralph [prompt] [--max N] [--max-errors N] [--delay <dur>] [--job-wait <dur>] [--job-grace <dur>] [--stall N] [--stall-cmd <template>] [--job-check <text> | --job-check-file <path>]",
        getArgumentCompletions: flagCompletions,
        handler: async (args, ctx) => {
            lastCtx = ctx;
            const base = defaultConfig(settings);
            let parsed: { cfg: LoopConfig; prompt: string };
            try {
                parsed = parseArgs(args ?? "", base);
            } catch (err) {
                ctx.ui.notify(String(err), "error");
                return;
            }
            const { cfg, prompt } = parsed;
            if (prompt) cfg.prompt = prompt;
            if (!cfg.prompt) {
                const entered = await ctx.ui.input("Ralph loop prompt", "");
                if (!entered) {
                    ctx.ui.notify("ralph-loop: no prompt, not starting", "warning");
                    return;
                }
                cfg.prompt = entered;
            }
            startLoop(cfg, ctx);
        },
    });

    pi.registerCommand("ralph-stop", {
        description: "Stop the ralph follow-up loop",
        handler: async (_args, ctx) => {
            lastCtx = ctx;
            if (!state.active) {
                ctx.ui.notify("ralph-loop: no active loop", "info");
                return;
            }
            stop("user request");
        },
    });

    pi.registerCommand("ralph-resume", {
        description: "Resume a paused/stopped ralph loop (keeps iteration count)",
        handler: async (_args, ctx) => {
            lastCtx = ctx;
            if (state.active) {
                ctx.ui.notify("ralph-loop: loop is already active", "info");
                return;
            }
            // Prefer this session's in-memory loop; fall back to the loop
            // persisted in the session log; finally settings defaults.
            const hasInMemory = state.iteration > 0 || state.active;
            const cfg: LoopConfig = hasInMemory
                ? state.cfg
                : savedLoop
                    ? { ...savedLoop.cfg }
                    : defaultConfig(settings);
            const iteration = hasInMemory
                ? state.iteration
                : savedLoop?.iteration ?? 0;
            const lastStuckFiredAt = hasInMemory
                ? state.lastStuckFiredAt
                : savedLoop?.lastStuckFiredAt ?? 0;
            // Operator explicitly resuming = a fresh stall budget.
            const stallStreak = 0;
            state = { active: true, iteration, cfg, lastStuckFiredAt, consecutiveErrors: 0, stallStreak };
            persist();
            setStatus();
            ctx.ui.notify(`Ralph loop resumed at iteration ${iteration}.`, "info");
            // Same path as any settle: honor bg jobs (wait / stuck-check) and
            // the delay before firing — never jump the queue.
            schedule();
        },
    });

    pi.registerCommand("ralph-config", {
        description:
            "Update the ralph loop in place (active, or paused — edits apply on /ralph-resume): /ralph-config [--max N] [--max-errors N] [--delay <dur>] [--job-wait <dur>] [--job-grace <dur>] [--stall N] [--stall-cmd <template>] [--job-check <text> | --job-check-file <path>] [new prompt]",
        getArgumentCompletions: flagCompletions,
        handler: async (args, ctx) => {
            lastCtx = ctx;
            // Works with the loop active OR inactive: when inactive, edits are
            // applied to the same config source /ralph-resume would pick up
            // (in-memory loop config, else the persisted saved loop, else
            // settings defaults), so you can tune a paused loop before
            // resuming it. The loop is NOT started — use /ralph or
            // /ralph-resume for that.
            const wasActive = state.active;
            if (!wasActive && state.iteration === 0 && savedLoop) {
                // Align in-memory state with what /ralph-resume would use.
                state.cfg = { ...savedLoop.cfg };
                state.stallStreak = savedLoop.stallStreak ?? 0;
                state.lastStuckFiredAt = savedLoop.lastStuckFiredAt ?? 0;
            }
            let parsed: { cfg: LoopConfig; prompt: string };
            try {
                // Base on the LIVE cfg so unspecified settings are preserved.
                parsed = parseArgs(args ?? "", state.cfg);
            } catch (err) {
                ctx.ui.notify(String(err), "error");
                return;
            }
            state.cfg = parsed.cfg;
            if (parsed.prompt) state.cfg.prompt = parsed.prompt;
            if (!wasActive) {
                // Materialize/refresh the persisted loop so /ralph-resume (in
                // this session) and reload-restore pick the edited config up.
                savedLoop = {
                    active: false,
                    iteration: state.iteration,
                    cfg: state.cfg,
                    lastStuckFiredAt: state.lastStuckFiredAt,
                    stallStreak: state.stallStreak,
                    savedAt: Date.now(),
                };
            }
            persist();
            setStatus();
            ctx.ui.notify(
                (wasActive ? "Ralph loop updated: " : "Ralph loop config saved (loop not active — /ralph-resume will use it): ") +
                    `delay ${fmtDur(state.cfg.delayMs)}, max ${state.cfg.maxIterations || "unlimited"}, ` +
                    `job-wait ${state.cfg.maxJobWaitMs ? fmtDur(state.cfg.maxJobWaitMs) : "forever"}, ` +
                    `job-grace ${fmtDur(state.cfg.jobDoneGraceMs)}, max-errors ${state.cfg.maxConsecutiveErrors}` +
                    (parsed.prompt ? " \u2014 prompt replaced" : ""),
                "info"
            );
        },
    });

    pi.registerCommand("ralph-status", {
        description: "Show complete ralph loop status (all settings, full text)",
        handler: async (_args, ctx) => {
            lastCtx = ctx;
            const c = state.cfg;
            const stuckAge = state.lastStuckFiredAt
                ? `${fmtDur(Date.now() - state.lastStuckFiredAt)} ago`
                : "never";
            const lines = [
                `Ralph loop: ${state.active ? "ACTIVE" : "inactive/paused"}`,
                `  iteration: ${state.iteration}${c.maxIterations > 0 ? ` / max ${c.maxIterations}` : " (no max)"}`,
                `  delay: ${fmtDur(c.delayMs)}`,
                `  job-wait: ${c.maxJobWaitMs > 0 ? fmtDur(c.maxJobWaitMs) : "forever"} · job-grace: ${fmtDur(c.jobDoneGraceMs)}`,
                `  stall: ${state.stallStreak} zero-action follow-up(s) so far, stops at ${c.stallLimit || "off"}`,
                `  stall-cmd: ${c.stallCommand || "(none)"}`,
                `  errors: ${state.consecutiveErrors}/${c.maxConsecutiveErrors} consecutive · last stuck-check: ${stuckAge}`,
                `  completion marker: ${c.completionMarker ? `"${c.completionMarker}"` : "(off)"}`,
                `  bg jobs running: ${bgStatus.running}`,
                `  prompt:`,
                `    ${c.prompt}`,
                `  job-check template:`,
                `    ${c.jobCheckPrompt}`,
            ];
            ctx.ui.notify(lines.join("\n"), "info");
        },
    });
}
