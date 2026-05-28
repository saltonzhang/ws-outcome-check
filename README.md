# WS Outcome Check

Monitor live match WebSocket outcome updates and detect odds/outcomes that are still visible on the frontend after their `last_update` is older than the configured threshold.

When the frontend exposes button identifiers such as `data-event-id`, `data-market-id`, `data-outcome-id`, `data-outcome-name`, `data-specifiers`, and `data-last-update`, the checker uses them for direct WS-to-DOM matching. If those attributes are missing, it falls back to text/odds matching.

## Install

```bash
npm install
npx playwright install chromium
```

## Run One Match By ID

```bash
node scripts/live-market-ws-outcome-check.js \
  --match-id 18952785 \
  --threshold-minutes 5 \
  --watch-minutes 15
```

## Auto Pick One Live Match

```bash
node scripts/live-market-ws-outcome-check.js \
  --url https://xp-match-pc-test1.helix.city/en/sports-live \
  --threshold-minutes 5 \
  --watch-minutes 15
```

## Run Until Match End

The checker stops early when a matched WebSocket message contains `match_status=100`.

```bash
node scripts/live-market-ws-outcome-check.js \
  --url https://xp-match-pc-test1.helix.city/en/sports-live \
  --threshold-minutes 5 \
  --watch-minutes 360 \
  --until-match-end
```

## Continuous Daemon

This mode automatically picks a live match with markets, monitors it until `match_status=100` or max watch time, then switches to another match. Recently monitored match ids are skipped for a while so a finished match that remains on the list is not immediately picked again.

```bash
node scripts/live-market-ws-outcome-daemon.js \
  --url https://xp-match-pc-test1.helix.city/en/sports-live \
  --threshold-minutes 5 \
  --max-watch-minutes 360 \
  --cooldown-seconds 15
```

With Lark alert:

```bash
export LARK_WEBHOOK_URL='https://open.larksuite.com/open-apis/bot/v2/hook/xxxx'

node scripts/live-market-ws-outcome-daemon.js \
  --url https://xp-match-pc-test1.helix.city/en/sports-live \
  --threshold-minutes 5 \
  --max-watch-minutes 360 \
  --cooldown-seconds 15
```

Background run:

```bash
export LARK_WEBHOOK_URL='https://open.larksuite.com/open-apis/bot/v2/hook/xxxx'

nohup node scripts/live-market-ws-outcome-daemon.js \
  --url https://xp-match-pc-test1.helix.city/en/sports-live \
  --threshold-minutes 5 \
  --max-watch-minutes 360 \
  --cooldown-seconds 15 \
  > reports/live-market-ws-outcome-daemon.log 2>&1 &
```

## Useful Options

- `--threshold-seconds <n>` / `--threshold-minutes <n>`: stale threshold.
- `--watch-seconds <n>` / `--watch-minutes <n>`: max runtime for a single check.
- `--max-watch-seconds <n>` / `--max-watch-minutes <n>`: daemon per-match safety limit.
- `--interval-seconds <n>`: DOM scan interval.
- `--headed`: run visible Chromium.
- `--no-expand`: do not expand collapsed market groups.
- `--no-scan-tabs`: only scan the current market tab.
- `--lark-webhook <url>`: send a Lark text alert when the first violation appears. `LARK_WEBHOOK_URL` env is also supported.
- `--output <file>`: JSON report path for single check.
- `--output-dir <dir>`: report directory for daemon.

Reports are written under `reports/` by default and include JSON, Markdown, final screenshots, and violation screenshots when a stale visible outcome is detected.
