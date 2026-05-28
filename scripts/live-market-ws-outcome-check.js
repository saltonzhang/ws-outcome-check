#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const DEFAULT_LIST_URL = "https://xp-match-pc-test1.helix.city/en/sports-live";
const DEFAULT_ODDS_SELECTOR = 'button[class*="betBtn"]';
const MARKET_CMDS = new Set([10020]);

function parseArgs(argv) {
  const args = {
    url: DEFAULT_LIST_URL,
    matchId: "",
    matchUrl: "",
    apiBase: "",
    matchApiUrl: "",
    thresholdSeconds: 300,
    watchSeconds: 900,
    intervalSeconds: 3,
    headed: false,
    expandMarkets: true,
    scanTabs: true,
    untilMatchEnd: false,
    excludeMatchIds: new Set(),
    output: "",
    oddsSelector: DEFAULT_ODDS_SELECTOR,
    larkWebhook: process.env.LARK_WEBHOOK_URL || "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const read = () => argv[++index];
    if (token === "--url") args.url = read();
    else if (token === "--match-id") args.matchId = read();
    else if (token === "--match-url") args.matchUrl = read();
    else if (token === "--api-base") args.apiBase = read();
    else if (token === "--match-api-url") args.matchApiUrl = read();
    else if (token === "--threshold-seconds") args.thresholdSeconds = Number(read());
    else if (token === "--threshold-minutes") args.thresholdSeconds = Number(read()) * 60;
    else if (token === "--watch-seconds") args.watchSeconds = Number(read());
    else if (token === "--watch-minutes") args.watchSeconds = Number(read()) * 60;
    else if (token === "--interval-seconds") args.intervalSeconds = Number(read());
    else if (token === "--output") args.output = read();
    else if (token === "--odds-selector") args.oddsSelector = read();
    else if (token === "--lark-webhook") args.larkWebhook = read();
    else if (token === "--headed") args.headed = true;
    else if (token === "--no-expand") args.expandMarkets = false;
    else if (token === "--no-scan-tabs") args.scanTabs = false;
    else if (token === "--until-match-end") args.untilMatchEnd = true;
    else if (token === "--exclude-match-ids") {
      args.excludeMatchIds = new Set(
        String(read() || "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      );
    }
    else if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  for (const [name, value] of [
    ["threshold", args.thresholdSeconds],
    ["watch", args.watchSeconds],
    ["interval", args.intervalSeconds],
  ]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} seconds must be positive`);
  }
  return args;
}

function printHelp() {
  console.log(`
Usage:
  node scripts/live-market-ws-outcome-check.js --match-id <id> [options]

What it checks:
  - Fetches /v1/match/:id once for the initial full market structure.
  - Opens the real detail page and listens to its WebSocket messages.
  - Updates each outcome's last_update from WS odds_change messages.
  - Every few seconds, checks whether stale outcomes are still visible in DOM.

Options:
  --url <url>                  Live list URL, used to derive detail/API URLs.
  --match-id <id>              Match id, e.g. 18926411.
  --match-url <url>            Full match detail URL.
  --api-base <url>             Service API base, e.g. https://xp-service-test1-api.helix.city.
  --match-api-url <url>        Full /v1/match/:id API URL.
  --threshold-seconds <n>      Stale threshold. Default 300.
  --threshold-minutes <n>      Stale threshold in minutes.
  --watch-seconds <n>          Total watch time. Default 900.
  --watch-minutes <n>          Total watch time in minutes.
  --interval-seconds <n>       DOM check interval. Default 3.
  --headed                     Run visible Chromium.
  --no-expand                  Do not expand collapsed market groups.
  --no-scan-tabs               Only scan the currently selected market tab.
  --until-match-end            Stop this run when WS says match_status is 100.
  --exclude-match-ids <ids>    Comma separated match ids to skip when auto-picking.
  --output <file>              JSON report path.
  --lark-webhook <url>         Lark bot webhook. Can also use LARK_WEBHOOK_URL env.
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function token(value) {
  return clean(value).toLowerCase();
}

function matchIdFromUrl(value) {
  try {
    return new URL(value).pathname.match(/\/matches\/([^/?#]+)/)?.[1] || "";
  } catch (_) {
    return "";
  }
}

function detailUrlForMatch(listUrl, matchId) {
  const url = new URL(listUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const locale = parts[0] || "en";
  url.pathname = `/${locale}/matches/${matchId}`;
  url.search = "";
  return url.toString();
}

function deriveApiUrl(args, matchId, detailUrl) {
  if (args.matchApiUrl) return args.matchApiUrl;
  if (args.apiBase) return `${args.apiBase.replace(/\/$/, "")}/v1/match/${matchId}`;
  const source = detailUrl || args.matchUrl || args.url;
  try {
    const parsed = new URL(source);
    const found = parsed.hostname.match(/^xp-match-pc-(.+)\.helix\.city$/);
    if (found) return `${parsed.protocol}//xp-service-${found[1]}-api.helix.city/v1/match/${matchId}`;
  } catch (_) {}
  return "";
}

function frameToBuffer(frame) {
  const payload = frame && typeof frame === "object" && "payload" in frame ? frame.payload : frame;
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  if (ArrayBuffer.isView(payload)) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (typeof payload === "string") return Buffer.from(payload);
  return Buffer.from(String(payload ?? ""));
}

function parseWsFrame(frame) {
  const buffer = frameToBuffer(frame);
  const parsed = { cmd: null, timestamp: "", text: "", json: null, bytes: buffer.length };
  if (buffer.length >= 12) {
    parsed.cmd = buffer.readUInt32LE(0);
    parsed.timestamp = buffer.readBigUInt64LE(4).toString();
    parsed.text = buffer.subarray(12).toString("utf8");
  } else {
    parsed.text = buffer.toString("utf8");
  }
  try {
    parsed.json = parsed.text ? JSON.parse(parsed.text) : null;
  } catch (_) {}
  return parsed;
}

function jsonHasMatchId(value, matchId, depth = 0) {
  if (!matchId || value == null || depth > 8) return false;
  if (typeof value !== "object") {
    const text = String(value);
    return text === matchId || text === `sr:match:${matchId}` || text.endsWith(`:${matchId}`);
  }
  if (Array.isArray(value)) return value.some((item) => jsonHasMatchId(item, matchId, depth + 1));
  return Object.entries(value).some(([key, item]) => {
    if (/event|match|fixture|sport_event|id/i.test(key) && jsonHasMatchId(item, matchId, depth + 1)) return true;
    return jsonHasMatchId(item, matchId, depth + 1);
  });
}

function findFirstValueByKey(value, keys, depth = 0) {
  if (value == null || depth > 8 || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstValueByKey(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key)) return item;
    const found = findFirstValueByKey(item, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function isMatchEndMessage(json) {
  const matchStatus = findFirstValueByKey(json, new Set(["match_status", "matchStatus"]));
  return String(matchStatus || "") === "100";
}

function outcomeKey(marketId, specifiers, outcomeId, outcomeName) {
  return [marketId ?? "", specifiers ?? "", outcomeId || outcomeName || ""].join("|");
}

function flattenApiSnapshot(json) {
  const markets = Array.isArray(json?.data?.markets) ? json.data.markets : [];
  const outcomes = [];
  for (const market of markets) {
    for (const line of market.lines || []) {
      const columns = Array.isArray(market.col) ? market.col.map(normalizeOutcomeName) : [];
      for (const outcome of line.outcomes || []) {
        outcomes.push({
          key: outcomeKey(market.id, line.specifiers || line.row || "", outcome.id, outcome.name),
          source: "api",
          eventId: String(json.data?.event_id || ""),
          marketId: String(market.id ?? ""),
          marketName: clean(market.name),
          columns,
          lineId: line.id ?? "",
          specifiers: String(line.specifiers || line.row || ""),
          row: String(line.row || line.specifiers || ""),
          line: String(outcome.line || line.specifiers || line.row || ""),
          outcomeId: String(outcome.id ?? ""),
          outcomeName: normalizeOutcomeName(outcome.name),
          outcomeAlias: clean(outcome.name_alias),
          odds: outcome.odds,
          active: outcome.active,
          lastUpdate: Number(outcome.last_update || line.timestamp || 0),
          receivedAt: new Date().toISOString(),
        });
      }
    }
  }
  return {
    raw: {
      code: json.code,
      message: json.message,
      eventId: json.data?.event_id,
      marketCount: markets.length,
      timestamp: json.data?.timestamp,
      currTime: json.data?.curr_time,
    },
    outcomes,
  };
}

function flattenWsUpdate(json, existingMap) {
  const outcomes = [];
  for (const market of json?.markets || []) {
    for (const line of market.lines || []) {
      for (const outcome of line.outcomes || []) {
        const key = outcomeKey(market.id, line.specifiers || "", outcome.id, outcome.name);
        const existing = existingMap.get(key) || {};
        outcomes.push({
          ...existing,
          key,
          source: existing.source ? `${existing.source}+ws` : "ws",
          eventId: String(json.event_id || ""),
          marketId: String(market.id ?? existing.marketId ?? ""),
          specifiers: String(line.specifiers || existing.specifiers || ""),
          row: String(existing.row || line.specifiers || ""),
          line: String(outcome.line || line.specifiers || existing.line || ""),
          outcomeId: String(outcome.id ?? existing.outcomeId ?? ""),
          outcomeName: normalizeOutcomeName(outcome.name || existing.outcomeName),
          odds: outcome.odds ?? existing.odds,
          active: outcome.active ?? existing.active,
          lastUpdate: Number(outcome.last_update || outcome.lastUpdate || existing.lastUpdate || 0),
          receivedAt: new Date().toISOString(),
        });
      }
    }
  }
  return outcomes;
}

function normalizeOutcomeName(value) {
  const text = token(value);
  if (["over", "mais"].includes(text)) return "Over";
  if (["under", "menos"].includes(text)) return "Under";
  if (["odd", "impar", "ímpar"].includes(text)) return "Odd";
  if (["even", "par"].includes(text)) return "Even";
  if (["yes", "sim"].includes(text)) return "Yes";
  if (["no", "não", "nao"].includes(text)) return "No";
  if (["1", "x", "2", "1x", "x2", "12"].includes(text)) return clean(value);
  return clean(value);
}

function upsertOutcome(map, outcome) {
  const prev = map.get(outcome.key) || {};
  map.set(outcome.key, { ...prev, ...outcome });
}

async function fetchApiSnapshot(apiUrl) {
  if (!apiUrl) throw new Error("No match API URL can be derived");
  const response = await fetch(apiUrl, {
    headers: {
      accept: "application/json,text/plain,*/*",
      "user-agent": "Mozilla/5.0 live-market-ws-outcome-check",
    },
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`Match API ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return flattenApiSnapshot(json);
}

async function autoScrollPage(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let same = 0;
      const timer = setInterval(() => {
        const before = window.scrollY;
        window.scrollBy(0, Math.max(window.innerHeight * 0.8, 500));
        same = window.scrollY === before ? same + 1 : 0;
        if (same >= 2) {
          clearInterval(timer);
          resolve();
        }
      }, 120);
    });
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

async function expandAllMarkets(page, oddsSelector) {
  const beforeOdds = await page.locator(oddsSelector).count().catch(() => 0);
  const labels = [];
  let clicked = 0;
  for (let pass = 0; pass < 6; pass += 1) {
    await autoScrollPage(page);
    const result = await page.evaluate(() => {
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const buttons = [...document.querySelectorAll('button[aria-expanded="false"]')]
        .filter(visible)
        .filter((button) => cleanText(button.innerText).length > 0);
      for (const button of buttons) {
        button.scrollIntoView({ block: "center", inline: "nearest" });
        button.click();
      }
      return { count: buttons.length, labels: buttons.map((button) => cleanText(button.innerText).slice(0, 120)) };
    });
    clicked += result.count;
    labels.push(...result.labels);
    if (result.count === 0) break;
    await page.waitForTimeout(1000);
  }
  await autoScrollPage(page);
  return {
    enabled: true,
    clicked,
    beforeOdds,
    afterOdds: await page.locator(oddsSelector).count().catch(() => 0),
    remainingCollapsed: await page.locator('button[aria-expanded="false"]').count().catch(() => 0),
    labels,
  };
}

async function findMatchWithMarkets(page, oddsSelector, excludeMatchIds = new Set()) {
  await page.waitForLoadState("domcontentloaded");
  const deadline = Date.now() + 25000;
  const excluded = [...excludeMatchIds];
  while (Date.now() < deadline) {
    const candidate = await page.evaluate(({ selector, excludedIds }) => {
      const excludedSet = new Set(excludedIds);
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
      for (const anchor of document.querySelectorAll('a[href*="/matches/"]')) {
        const href = new URL(anchor.getAttribute("href"), location.href).toString();
        const matchId = href.match(/\/matches\/([^/?#]+)/)?.[1] || "";
        if (matchId && excludedSet.has(matchId)) continue;
        let node = anchor;
        for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
          const odds = [...node.querySelectorAll(selector)].filter(visible);
          if (odds.length > 0) {
            return {
              href,
              linkText: cleanText(anchor.innerText),
              oddsCount: odds.length,
            };
          }
        }
      }
      return null;
    }, { selector: oddsSelector, excludedIds: excluded });
    if (candidate) return candidate;
    await page.waitForTimeout(1000);
  }
  throw new Error("No live match with visible markets was found");
}

async function snapshotVisibleOutcomes(page, oddsSelector) {
  return page.evaluate((selector) => {
    const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const normalize = (value) => {
      const text = cleanText(value).toLowerCase();
      if (text === "over" || text === "mais") return "Over";
      if (text === "under" || text === "menos") return "Under";
      if (text === "odd" || text === "impar" || text === "ímpar") return "Odd";
      if (text === "even" || text === "par") return "Even";
      if (text === "yes" || text === "sim") return "Yes";
      if (text === "no" || text === "não" || text === "nao") return "No";
      return cleanText(value);
    };
    const parseOdd = (text) => {
      const value = cleanText(text);
      const match = value.match(/^(?:(.+?)\s+)?(\d+(?:\.\d+)?)$/);
      if (!match) {
        const lastNumber = value.match(/(\d+(?:\.\d+)?)(?!.*\d)/);
        return { outcomeName: "", odds: lastNumber ? Number(lastNumber[1]) : null };
      }
      return { outcomeName: normalize(match[1] || ""), odds: Number(match[2]) };
    };
    const inferColumns = (scopeText, count) => {
      const upper = cleanText(scopeText).toUpperCase();
      if (/\b(OVER|MAIS)\b/.test(upper) && /\b(UNDER|MENOS)\b/.test(upper)) return ["Over", "Under"];
      if (/\bODD\b/.test(upper) && /\bEVEN\b/.test(upper)) return ["Odd", "Even"];
      if (/\bYES\b/.test(upper) && /\bNO\b/.test(upper)) return ["Yes", "No"];
      if (count === 3 && /\b1\b/.test(upper) && /\bX\b/.test(upper) && /\b2\b/.test(upper)) return ["1", "X", "2"];
      if (count === 2 && /\b1\b/.test(upper) && /\b2\b/.test(upper)) return ["1", "2"];
      return [];
    };

    const buttons = [...document.querySelectorAll(selector)]
      .filter(visible)
      .filter((button) => button.getAttribute("data-outcome-id") || /\d+(?:\.\d+)?/.test(cleanText(button.innerText)));

    return buttons.map((button, index) => {
      let rowRoot = button.parentElement || button;
      for (let depth = 0; rowRoot && depth < 6; depth += 1) {
        const count = rowRoot.querySelectorAll(selector).length;
        if (count >= 1 && count <= 4) break;
        rowRoot = rowRoot.parentElement;
      }
      if (!rowRoot) rowRoot = button.parentElement || button;

      let marketHeader = null;
      let marketScope = rowRoot;
      for (let scope = rowRoot, depth = 0; scope && depth < 8; depth += 1, scope = scope.parentElement) {
        marketHeader = [...scope.querySelectorAll('button[aria-expanded="true"], button[aria-expanded="false"]')]
          .filter((item) => !String(item.className).includes("betBtn"))
          .find((item) => cleanText(item.innerText).length > 0);
        if (marketHeader) {
          marketScope = scope;
          break;
        }
      }

      const rowButtons = [...rowRoot.querySelectorAll(selector)].filter(visible);
      const columnIndex = Math.max(0, rowButtons.indexOf(button));
      const rowText = cleanText(rowRoot.innerText);
      const marketText = cleanText(marketScope.innerText);
      const parsed = parseOdd(button.innerText);
      const columns = inferColumns(marketText, rowButtons.length);
      const rowLine = (rowText.match(/\d+:\d+|\d+(?:\.\d+)?(?:\s*\([^)]+\))?/) || [""])[0];
      const inferredOutcomeName = parsed.outcomeName || columns[columnIndex] || "";

      return {
        index,
        dataEventId: button.getAttribute("data-event-id") || "",
        dataMarketId: button.getAttribute("data-market-id") || "",
        dataOutcomeId: button.getAttribute("data-outcome-id") || "",
        dataOutcomeName: normalize(button.getAttribute("data-outcome-name") || ""),
        dataSpecifiers: cleanText(button.getAttribute("data-specifiers") || ""),
        dataLastUpdate: Number(button.getAttribute("data-last-update") || 0),
        marketName: cleanText(marketHeader?.innerText).slice(0, 160),
        rowText: rowText.slice(0, 500),
        marketText: marketText.slice(0, 1000),
        rowLine,
        oddText: cleanText(button.innerText).slice(0, 120),
        odds: parsed.odds,
        parsedOutcomeName: parsed.outcomeName,
        inferredOutcomeName,
        columnIndex,
        columns,
      };
    });
  }, oddsSelector);
}

async function getMarketTabs(page) {
  return page.evaluate(() => {
    const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const ignored = new Set(["Sign In", "FAQ", "Contact Us", "Deposit & Withdrawal"]);
    return [...document.querySelectorAll("button")]
      .filter(visible)
      .filter((button) => String(button.className).includes("filter-item"))
      .map((button) => cleanText(button.innerText))
      .filter((label) => label && !ignored.has(label));
  });
}

async function clickMarketTab(page, label) {
  return page.evaluate((target) => {
    const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const button = [...document.querySelectorAll("button")]
      .filter(visible)
      .find((item) => String(item.className).includes("filter-item") && cleanText(item.innerText) === target);
    if (!button) return false;
    button.scrollIntoView({ block: "center", inline: "center" });
    button.click();
    return true;
  }, label);
}

function visibleKey(item) {
  if (item.dataOutcomeId) {
    return [
      item.dataEventId || "",
      item.dataMarketId || "",
      item.dataSpecifiers || "",
      item.dataOutcomeId || "",
    ].join("|");
  }
  return [
    item.marketName || "",
    item.rowLine || item.rowText || "",
    item.inferredOutcomeName || item.parsedOutcomeName || "",
    item.oddText || "",
  ].join("|");
}

async function snapshotVisibleOutcomesAcrossTabs(page, args) {
  if (!args.scanTabs) {
    return {
      visible: await snapshotVisibleOutcomes(page, args.oddsSelector),
      tabs: [{ label: "current", visible: 0 }],
    };
  }

  const labels = await getMarketTabs(page);
  if (labels.length === 0) {
    return {
      visible: await snapshotVisibleOutcomes(page, args.oddsSelector),
      tabs: [{ label: "current", visible: 0 }],
    };
  }

  const seen = new Set();
  const merged = [];
  const tabStats = [];
  for (const label of labels) {
    const clicked = await clickMarketTab(page, label);
    if (!clicked) continue;
    await page.waitForTimeout(700);
    if (args.expandMarkets) await expandAllMarkets(page, args.oddsSelector);
    const items = await snapshotVisibleOutcomes(page, args.oddsSelector);
    tabStats.push({ label, visible: items.length });
    for (const item of items) {
      const key = visibleKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...item, tab: label });
    }
  }

  const preferredTab = labels.includes("All") ? "All" : labels[0];
  if (preferredTab) {
    await clickMarketTab(page, preferredTab).catch(() => {});
    await page.waitForTimeout(300);
  }
  return { visible: merged, tabs: tabStats };
}

function numbersClose(left, right) {
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.0025);
}

function lineMatches(outcome, dom) {
  const candidates = [outcome.row, outcome.specifiers, outcome.line].filter(Boolean).map(token);
  if (candidates.length === 0) return true;
  const visibleLine = token(dom.rowLine);
  if (!visibleLine) return false;
  return candidates.some((item) => item === visibleLine);
}

function outcomeMatches(outcome, dom) {
  const expected = normalizeOutcomeName(outcome.outcomeName);
  const actual = normalizeOutcomeName(dom.inferredOutcomeName || dom.parsedOutcomeName);
  if (!expected) return true;
  return actual === expected;
}

function marketMatches(outcome, dom) {
  if (!outcome.marketName || !dom.marketName) return false;
  const expected = token(outcome.marketName);
  const actual = token(dom.marketName);
  return actual === expected;
}

function directIdentifierMatches(outcome, dom) {
  if (!dom.dataMarketId || !dom.dataOutcomeId) return false;
  if (String(outcome.marketId || "") !== String(dom.dataMarketId)) return false;
  if (String(outcome.outcomeId || "") !== String(dom.dataOutcomeId)) return false;
  if (dom.dataEventId && outcome.eventId && String(outcome.eventId) !== String(dom.dataEventId)) return false;

  const expectedSpecifiers = String(outcome.specifiers || "");
  const actualSpecifiers = String(dom.dataSpecifiers || "");
  if (expectedSpecifiers || actualSpecifiers) return expectedSpecifiers === actualSpecifiers;
  return true;
}

function scoreMatch(outcome, dom) {
  if (Number(outcome.active) !== 1) return 0;
  if (directIdentifierMatches(outcome, dom)) return 220;
  if (!numbersClose(outcome.odds, dom.odds)) return 0;
  if (!marketMatches(outcome, dom)) return 0;
  if (!lineMatches(outcome, dom)) return 0;
  if (!outcomeMatches(outcome, dom)) return 0;
  let score = 145;
  if (outcome.outcomeId) score += 10;
  return score;
}

function findStaleVisibleOutcomes(outcomes, domOutcomes, thresholdSeconds, now = Date.now()) {
  const matches = [];
  for (const outcome of outcomes) {
    if (Number(outcome.active) !== 1 || !outcome.lastUpdate) continue;
    const ageSeconds = Math.floor((now - Number(outcome.lastUpdate)) / 1000);
    if (ageSeconds < thresholdSeconds) continue;

    let best = null;
    for (const dom of domOutcomes) {
      const score = scoreMatch(outcome, dom);
      if (score >= 110 && (!best || score > best.score)) best = { score, dom };
    }
    if (best) {
      matches.push({
        detectedAt: new Date(now).toISOString(),
        ageSeconds,
        confidence: best.score >= 140 ? "high" : "medium",
        score: best.score,
        outcome,
        visible: best.dom,
      });
    }
  }
  return matches.sort((a, b) => b.ageSeconds - a.ageSeconds || b.score - a.score);
}

function formatDate(value) {
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function formatViolationAlert(report, violation) {
  const outcome = violation?.outcome || {};
  const visible = violation?.visible || {};
  return [
    "[WS盘口过期仍显示告警]",
    `比赛: ${report.matchId}`,
    `阈值: ${report.thresholdSeconds}s`,
    `盘口: ${outcome.marketName || ""}`,
    `Market ID: ${outcome.marketId || ""}`,
    `Line: ${outcome.specifiers || ""}`,
    `Outcome: ${outcome.outcomeName || ""}`,
    `Outcome ID: ${outcome.outcomeId || ""}`,
    `Odds: ${outcome.odds ?? ""}`,
    `last_update: ${formatDate(outcome.lastUpdate)}`,
    `已过期: ${violation?.ageSeconds ?? ""}s`,
    `前端按钮ID: ${[visible.dataMarketId, visible.dataSpecifiers, visible.dataOutcomeId].filter(Boolean).join(" / ")}`,
    `前端显示: ${visible.marketName || ""} ${visible.rowLine || ""} ${visible.inferredOutcomeName || ""} ${visible.oddText || ""}`.trim(),
    `详情页: ${report.detailUrl}`,
    `证据截图: ${report.violationScreenshot || ""}`,
    `JSON报告: ${report.jsonReport || ""}`,
    `MD报告: ${report.markdownReport || ""}`,
  ].join("\n");
}

async function sendLarkText(webhook, text) {
  if (!webhook) return false;
  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        msg_type: "text",
        content: { text },
      }),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
    console.log(`lark alert sent status=${response.status}`);
    return true;
  } catch (error) {
    console.error(`lark alert failed: ${error.message}`);
    return false;
  }
}

function markdownTable(rows, columns) {
  const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${columns.map((column) => cell(column.label)).join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${columns.map((column) => cell(row[column.key])).join(" | ")} |`),
  ].join("\n");
}

function buildMarkdown(report) {
  const first = report.staleVisibleOutcomes[0] || {};
  const rows = report.staleVisibleOutcomes.slice(0, 30).map((item) => ({
    confidence: item.confidence,
    score: item.score,
    ageSeconds: item.ageSeconds,
    marketId: item.outcome.marketId,
    marketName: item.outcome.marketName,
    specifiers: item.outcome.specifiers,
    outcomeId: item.outcome.outcomeId,
    outcomeName: item.outcome.outcomeName,
    wsOdds: item.outcome.odds,
    lastUpdate: formatDate(item.outcome.lastUpdate),
    visibleMarket: item.visible.marketName,
    visibleLine: item.visible.rowLine,
    visibleOutcome: item.visible.inferredOutcomeName,
    visibleOdd: item.visible.oddText,
    visibleIds: [item.visible.dataMarketId, item.visible.dataSpecifiers, item.visible.dataOutcomeId].filter(Boolean).join(" / "),
    domLastUpdate: formatDate(item.visible.dataLastUpdate),
  }));

  return [
    "# WS Outcome Stale Visible Evidence",
    "",
    `- Result: ${report.result}`,
    `- Match ID: ${report.matchId}`,
    `- Detail URL: ${report.detailUrl}`,
    `- Match API URL: ${report.matchApiUrl}`,
    `- Threshold: ${report.thresholdSeconds}s`,
    `- End Reason: ${report.endReason || ""}`,
    `- Match Ended: ${report.matchEnded ? "yes" : "no"}`,
    `- Match End At: ${report.matchEndAt || ""}`,
    `- First Violation Time: ${first.detectedAt || ""}`,
    `- First Violation Age: ${first.ageSeconds ?? ""}s`,
    `- WS URLs: ${report.websocketUrls.join(", ")}`,
    `- WS Messages For Match: ${report.wsMessagesForMatch}`,
    `- WS Market Messages: ${report.wsMarketMessages}`,
    `- API Initial Outcomes: ${report.apiInitialOutcomes}`,
    `- Tracked Outcomes: ${report.trackedOutcomes}`,
    `- Visible Outcome Buttons At End: ${report.lastVisibleCount}`,
    `- Scan Tabs: ${report.scanTabs}`,
    `- Violation Screenshot: ${report.violationScreenshot || ""}`,
    `- Final Screenshot: ${report.finalScreenshot || ""}`,
    `- JSON Report: ${report.jsonReport}`,
    "",
    "## Stale Visible Outcomes",
    "",
    rows.length
      ? markdownTable(rows, [
          { key: "confidence", label: "Confidence" },
          { key: "score", label: "Score" },
          { key: "ageSeconds", label: "Age Seconds" },
          { key: "marketId", label: "Market ID" },
          { key: "marketName", label: "Market" },
          { key: "specifiers", label: "Line" },
          { key: "outcomeId", label: "Outcome ID" },
          { key: "outcomeName", label: "Outcome" },
          { key: "wsOdds", label: "WS Odds" },
          { key: "lastUpdate", label: "last_update" },
          { key: "visibleMarket", label: "Visible Market" },
          { key: "visibleLine", label: "Visible Line" },
          { key: "visibleOutcome", label: "Visible Outcome" },
          { key: "visibleOdd", label: "Visible Odd" },
          { key: "visibleIds", label: "Visible IDs" },
          { key: "domLastUpdate", label: "DOM last_update" },
        ])
      : "_No stale visible outcomes captured._",
    "",
    "## Snapshots",
    "",
    markdownTable(report.snapshots.slice(-20), [
      { key: "at", label: "At" },
      { key: "visible", label: "Visible" },
      { key: "tabsText", label: "Tabs" },
      { key: "tracked", label: "Tracked" },
      { key: "violations", label: "Violations" },
      { key: "wsMessages", label: "WS Messages" },
    ]),
    "",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const output =
    args.output ||
    path.join(process.cwd(), "reports", `live-market-ws-outcome-check-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });

  let matchId = args.matchId || matchIdFromUrl(args.matchUrl);
  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
  const page = await context.newPage();
  const outcomeMap = new Map();

  const report = {
    result: "unknown",
    startedAt: new Date(startedAt).toISOString(),
    matchId,
    detailUrl: "",
    matchApiUrl: "",
    thresholdSeconds: args.thresholdSeconds,
    untilMatchEnd: args.untilMatchEnd,
    matchEnded: false,
    matchEndAt: "",
    endReason: "",
    websocketUrls: [],
    wsMessagesForMatch: 0,
    wsMarketMessages: 0,
    apiInitialOutcomes: 0,
    trackedOutcomes: 0,
    lastVisibleCount: 0,
    expand: null,
    scanTabs: args.scanTabs,
    snapshots: [],
    staleVisibleOutcomes: [],
    violationScreenshot: "",
    finalScreenshot: "",
    jsonReport: output,
    markdownReport: output.replace(/\.json$/i, ".md"),
    larkAlertSent: false,
    notes: [],
  };

  const seenViolationKeys = new Set();
  let captured = false;
  let matchEnded = false;

  page.on("websocket", (socket) => {
    report.websocketUrls.push(socket.url());
    socket.on("framereceived", (frame) => {
      const parsed = parseWsFrame(frame);
      if (!jsonHasMatchId(parsed.json, matchId) && !parsed.text.includes(matchId)) return;
      report.wsMessagesForMatch += 1;
      if (isMatchEndMessage(parsed.json)) {
        matchEnded = true;
        report.matchEnded = true;
        report.matchEndAt = new Date().toISOString();
        console.log(`match ended by ws match_status=100 at ${report.matchEndAt}`);
      }
      if (!MARKET_CMDS.has(parsed.cmd)) return;
      report.wsMarketMessages += 1;
      for (const outcome of flattenWsUpdate(parsed.json, outcomeMap)) upsertOutcome(outcomeMap, outcome);
      report.trackedOutcomes = outcomeMap.size;
    });
  });

  try {
    if (args.matchUrl) {
      report.detailUrl = args.matchUrl;
      console.log(`打开指定比赛详情: ${args.matchUrl}`);
      await page.goto(args.matchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    } else if (matchId) {
      report.detailUrl = detailUrlForMatch(args.url, matchId);
      console.log(`打开指定比赛详情: ${report.detailUrl}`);
      await page.goto(report.detailUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    } else {
      console.log(`打开直播列表: ${args.url}`);
      await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 60000 });
      const candidate = await findMatchWithMarkets(page, args.oddsSelector, args.excludeMatchIds);
      matchId = matchIdFromUrl(candidate.href);
      report.matchId = matchId;
      report.detailUrl = candidate.href;
      console.log(`选中有盘口比赛: ${matchId} ${candidate.linkText}`);
      await page.goto(candidate.href, { waitUntil: "domcontentloaded", timeout: 60000 });
    }

    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
    if (!matchId) matchId = matchIdFromUrl(page.url());
    report.matchId = matchId;
    report.detailUrl = page.url();
    report.matchApiUrl = deriveApiUrl(args, matchId, report.detailUrl);

    const api = await fetchApiSnapshot(report.matchApiUrl);
    report.apiInitialOutcomes = api.outcomes.length;
    for (const outcome of api.outcomes) upsertOutcome(outcomeMap, outcome);
    report.trackedOutcomes = outcomeMap.size;
    console.log(`接口初始快照: ${report.matchApiUrl} outcomes=${api.outcomes.length}`);

    if (args.expandMarkets) {
      report.expand = await expandAllMarkets(page, args.oddsSelector);
      console.log(`已展开盘口分组: clicked=${report.expand.clicked} odds ${report.expand.beforeOdds}->${report.expand.afterOdds}`);
    } else {
      report.expand = { enabled: false };
    }

    console.log(
      `开始监控 ${args.watchSeconds}s threshold=${args.thresholdSeconds}s scanTabs=${args.scanTabs} untilMatchEnd=${args.untilMatchEnd}`,
    );
    const deadline = Date.now() + args.watchSeconds * 1000;
    while (Date.now() < deadline && !(args.untilMatchEnd && matchEnded)) {
      await sleep(args.intervalSeconds * 1000);
      const scan = await snapshotVisibleOutcomesAcrossTabs(page, args);
      const visible = scan.visible;
      const stale = findStaleVisibleOutcomes([...outcomeMap.values()], visible, args.thresholdSeconds);
      report.lastVisibleCount = visible.length;

      for (const item of stale) {
        const key = `${item.outcome.key}|${item.visible.index}|${item.visible.oddText}`;
        if (seenViolationKeys.has(key)) continue;
        seenViolationKeys.add(key);
        report.staleVisibleOutcomes.push(item);
      }

      report.snapshots.push({
        at: new Date().toISOString(),
        visible: visible.length,
        tabs: scan.tabs,
        tabsText: scan.tabs.map((item) => `${item.label}:${item.visible}`).join(", "),
        tracked: outcomeMap.size,
        violations: stale.length,
        wsMessages: report.wsMessagesForMatch,
      });
      console.log(
        `snapshot visible=${visible.length} tabs=[${scan.tabs
          .map((item) => `${item.label}:${item.visible}`)
          .join(",")}] tracked=${outcomeMap.size} violations=${stale.length} ws(match)=${report.wsMessagesForMatch}`,
      );

      if (stale.length > 0 && !captured) {
        captured = true;
        report.violationScreenshot = output.replace(/\.json$/i, "-violation.png");
        await page.screenshot({ path: report.violationScreenshot, fullPage: true }).catch(() => {});
        console.log(`violation evidence screenshot=${report.violationScreenshot}`);
        report.larkAlertSent = await sendLarkText(args.larkWebhook, formatViolationAlert(report, stale[0]));
      }
    }

    report.endReason = args.untilMatchEnd && matchEnded ? "match_end" : "watch_timeout";
    report.result = report.staleVisibleOutcomes.length > 0 ? "failed" : "passed";
    if (report.endReason === "match_end") report.notes.push("Stopped because WS reported match_status=100.");
    if (report.endReason === "watch_timeout") report.notes.push("Stopped because watch time reached the configured maximum.");
    if (report.result === "failed") report.notes.push("WS outcome last_update exceeded threshold while a matching DOM button remained visible.");
    report.finalScreenshot = output.replace(/\.json$/i, ".png");
    await page.screenshot({ path: report.finalScreenshot, fullPage: true }).catch(() => {});
  } finally {
    report.finishedAt = new Date().toISOString();
    report.durationSeconds = Math.floor((Date.now() - startedAt) / 1000);
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    fs.writeFileSync(report.markdownReport, buildMarkdown(report));
    await browser.close();
    console.log(`报告: ${output}`);
    console.log(`证据: ${report.markdownReport}`);
    console.log(`结果: ${report.result}`);
  }

  if (report.result === "failed") process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
