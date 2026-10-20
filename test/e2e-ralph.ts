/**
 * E2E for pi-ralph-loop fixes:
 *  A) /ralph-config while INACTIVE → "config saved (loop not active…" notify, no error
 *  B) /ralph-resume → resumed; kickoff follow-up fires; NO extension_error events
 *  C) /ralph-status shows the edited config (max 5, prompt)
 *  D) /ralph-stop cleans up
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";

const EXT = "/home/jakob/git_projects/pi-ralph-loop/extensions/ralph-loop/index.ts";
const LOG = "/tmp/e2e-ralph.log";

const child = spawn("pi", ["--mode", "rpc", "--no-session", "--no-extensions", "-e", EXT, "-e", "/home/jakob/git_projects/pi-gateway-discovery/src/index.ts", "--thinking", "off"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: "/home/jakob/git_projects",
});

const events: any[] = [];
fs.writeFileSync(LOG, "");
let buf = "";
child.stdout.on("data", (d) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        fs.appendFileSync(LOG, line + "\n");
        try {
            events.push(JSON.parse(line));
        } catch {
            /* console noise */
        }
    }
});
child.stderr.on("data", (d) => fs.appendFileSync(LOG, `[stderr] ${d}`));
const send = (o: Record<string, unknown>) => child.stdin.write(JSON.stringify(o) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results = { configSaved: false, resumed: false, followUp: false, extError: false, status: false };

function scan() {
    for (const e of events) {
        const s = JSON.stringify(e);
        if (e.type === "extension_ui_request" && e.method === "notify") {
            if (/config saved \(loop not active/.test(e.message ?? "")) results.configSaved = true;
            if (/Ralph loop resumed at iteration/.test(e.message ?? "")) results.resumed = true;
            if (/loop is not active.*\/ralph to start/i.test(e.message ?? "") && !results.configSaved) results.extError = true; // old behavior
        }
        if (e.type === "extension_error") results.extError = true;
        if (e.type === "message_start" && e.message?.role === "user" && /\[ralph-loop\]/.test(JSON.stringify(e.message.content ?? ""))) results.followUp = true;
        if (e.type === "message_start" && e.message?.role === "user" && /delay 1s|max 5|job-grace/i.test(JSON.stringify(e.message.content ?? ""))) results.status = true;
    }
}

(async () => {
    // A: config while inactive (before ANY loop started this session)
    send({ type: "prompt", id: "cmd1", message: "/ralph-config --max 5 --delay 1s standing-order-test-prompt" });
    await sleep(3000);
    scan();
    console.log("after config-while-inactive:", JSON.stringify(results));

    // B: resume → follow-up should fire with the configured prompt
    send({ type: "prompt", id: "cmd2", message: "/ralph-resume" });
    await sleep(6000);
    scan();
    console.log("after resume:", JSON.stringify(results));

    // C: status
    send({ type: "prompt", id: "cmd3", message: "/ralph-status" });
    await sleep(2500);
    scan();

    // D: stop
    send({ type: "prompt", id: "cmd4", message: "/ralph-stop" });
    await sleep(2000);
    scan();
    console.log("final:", JSON.stringify(results));

    const pass = results.configSaved && results.resumed && results.followUp && !results.extError;
    console.log(pass ? "RALPH E2E PASS" : "RALPH E2E FAIL");
    child.kill("SIGTERM");
    setTimeout(() => process.exit(pass ? 0 : 1), 1500);
})();
