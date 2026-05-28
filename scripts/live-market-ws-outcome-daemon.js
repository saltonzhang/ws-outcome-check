#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_LIST_URL = "https://xp-match-pc-test1.helix.city/en/sports-live";

function parseArgs(argv) {
  const args = {
    url: DEFAULT_LIST_URL,
    thresholdSeconds: 300,
    maxWatchSeconds: 21600,
    intervalSeconds: 3,
    cooldownSeconds: 15,
    excludeWindowSeconds: 3600,
    outputDir: path.join(process.cwd(), "reports"),
    headed: false,
    expandMarkets: true,
    scanTabs: true,
    once: false,
    larkWebhook: process.env.LARK_WEBHOOK_URL || "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const read = () => argv[++index];
    if (token === "--url") args.url = read();
    else if (token === "--threshold-seconds") args.thresholdSeconds = Number(read());
    else if (token === "--threshold-minutes") args.thresholdSeconds = Number(read()) * 60;
    else if (token === "--max-watch-seconds") args.maxWatchSeconds = Number(read());
    else if (token === "--max-watch-minutes") args.maxWatchSeconds = Number(read()) * 60;
    else if (token === "--interval-seconds") args.intervalSeconds = Number(read());
    else if (token === "--cooldown-seconds") args.cooldownSeconds = Number(read());
    else if (token === "--exclude-window-minutes") args.excludeWindowSeconds = Number(read()) * 60;
    else if (token === "--output-dir") args.outputDir = read();
    else if (token === "--headed") args.headed = true;
    else if (token === "--no-expand") args.expandMarkets = false;
    else if (token === "--no-scan-tabs") args.scanTabs = false;
    else if (token === "--lark-webhook") args.larkWebhook = read();
    else if (token === "--once") args.once = true;
    else if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  for (const [name, value] of [
    ["threshold", args.thresholdSeconds],
    ["max watch", args.maxWatchSeconds],
    ["interval", args.intervalSeconds],
    ["cooldown", args.cooldownSeconds],
    ["exclude window", args.excludeWindowSeconds],
  ]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} seconds must be positive`);
  }
  return args;
}

function printHelp() {
  console.log(`
Usage:
  node scripts/live-market-ws-outcome-daemon.js [options]

What it does:
  - Repeatedly opens the live list URL and lets live-market-ws-outcome-check.js pick a match with markets.
  - Monitors that match until WS reports match_status=100 or max watch time is reached.
  - Writes one JSON/Markdown/screenshot evidence bundle per match.
  - Skips recently monitored match ids so a finished match that remains on the list is not picked again immediately.

Options:
  --url <url>                    Live list URL. Default test1 sports-live.
  --threshold-seconds <n>        Stale threshold. Default 300.
  --threshold-minutes <n>        Stale threshold in minutes.
  --max-watch-seconds <n>        Safety limit for one match. Default 21600.
  --max-watch-minutes <n>        Safety limit for one match in minutes.
  --interval-seconds <n>         DOM check interval. Default 3.
  --cooldown-seconds <n>         Wait between matches/retries. Default 15.
  --exclude-window-minutes <n>   How long to skip a recently monitored match. Default 60.
  --output-dir <dir>             Report directory. Default ./reports.
  --headed                       Run visible Chromium.
  --no-expand                    Do not expand collapsed market groups.
  --no-scan-tabs                 Only scan the current market tab.
  --lark-webhook <url>           Lark bot webhook. Can also use LARK_WEBHOOK_URL env.
  --once                         Run one match and exit.
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function pruneExcludes(excluded, windowSeconds) {
  const cutoff = Date.now() - windowSeconds * 1000;
  for (const [matchId, addedAt] of excluded) {
    if (addedAt < cutoff) excluded.delete(matchId);
  }
}

function readReport(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

function runChild(checkScript, childArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [checkScript, ...childArgs], {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    });
    child.on("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
    child.on("error", (error) => {
      console.error(`[daemon] failed to start child: ${error.message}`);
      resolve({ code: 1, signal: "" });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.outputDir, { recursive: true });

  const checkScript = path.join(__dirname, "live-market-ws-outcome-check.js");
  const excluded = new Map();
  let runNumber = 0;

  console.log(
    `[daemon] start url=${args.url} threshold=${args.thresholdSeconds}s maxWatch=${args.maxWatchSeconds}s cooldown=${args.cooldownSeconds}s`,
  );

  while (true) {
    runNumber += 1;
    pruneExcludes(excluded, args.excludeWindowSeconds);

    const output = path.join(args.outputDir, `live-market-ws-outcome-check-daemon-${timestamp()}.json`);
    const childArgs = [
      "--url",
      args.url,
      "--threshold-seconds",
      String(args.thresholdSeconds),
      "--watch-seconds",
      String(args.maxWatchSeconds),
      "--interval-seconds",
      String(args.intervalSeconds),
      "--until-match-end",
      "--output",
      output,
    ];

    const excludeIds = [...excluded.keys()];
    if (excludeIds.length > 0) childArgs.push("--exclude-match-ids", excludeIds.join(","));
    if (args.larkWebhook) childArgs.push("--lark-webhook", args.larkWebhook);
    if (args.headed) childArgs.push("--headed");
    if (!args.expandMarkets) childArgs.push("--no-expand");
    if (!args.scanTabs) childArgs.push("--no-scan-tabs");

    console.log(`[daemon] run #${runNumber} output=${output}`);
    if (excludeIds.length > 0) console.log(`[daemon] skip recent match ids=${excludeIds.join(",")}`);

    const result = await runChild(checkScript, childArgs);
    const report = readReport(output);
    if (report?.matchId) excluded.set(String(report.matchId), Date.now());

    if (report) {
      console.log(
        `[daemon] run #${runNumber} done code=${result.code} result=${report.result} match=${report.matchId || ""} end=${report.endReason || ""} violations=${report.staleVisibleOutcomes?.length || 0}`,
      );
    } else {
      console.log(`[daemon] run #${runNumber} done code=${result.code} signal=${result.signal || ""} report=missing`);
    }

    if (args.once) process.exit(result.code || 0);
    await sleep(args.cooldownSeconds * 1000);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
