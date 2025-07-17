const express = require("express");
const axios = require("axios");
const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_KEYS = process.env.API_KEYS?.split(",") || [];
const SYMBOLS = ["XAU/USD", "BTC/USD"];
const RSI_LO = 45, RSI_HI = 55;

const lastSignal = {}; // Track previous signals
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Telegram Notification ──
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" });
  } catch {}
}

// ── Fetch Candle Data ──
async function fetchTD(symbol, interval, rows = 100) {
  for (const key of API_KEYS) {
    const params = {
      symbol,
      interval,
      outputsize: rows,
      apikey: key,
      format: "JSON",
      dp: 5,
    };
    try {
      const res = await axios.get("https://api.twelvedata.com/time_series", { params });
      if (res.data && res.data.values) {
        return res.data.values.map(row => ({
          time: new Date(row.datetime),
          open: +row.open,
          high: +row.high,
          low: +row.low,
          close: +row.close,
        })).reverse();
      }
    } catch {}
  }
  return null;
}

// ── RSI ──
function rsi(closes, len = 14) {
  const rsis = Array(closes.length).fill(null);
  let gain = 0, loss = 0;

  for (let i = 1; i <= len; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }

  gain /= len;
  loss /= len;
  rsis[len] = 100 - (100 / (1 + gain / loss));

  for (let i = len + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      gain = (gain * (len - 1) + diff) / len;
      loss = (loss * (len - 1)) / len;
    } else {
      gain = (gain * (len - 1)) / len;
      loss = (loss * (len - 1) - diff) / len;
    }
    rsis[i] = 100 - (100 / (1 + gain / loss));
  }
  return rsis;
}

// ── Bollinger Bands ──
function bollinger(closes, w = 20, d = 2) {
  const mid = [], up = [], lo = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < w - 1) {
      mid.push(null); up.push(null); lo.push(null);
      continue;
    }
    const slice = closes.slice(i - w + 1, i + 1);
    const avg = slice.reduce((a, b) => a + b) / w;
    const std = Math.sqrt(slice.reduce((a, b) => a + (b - avg) ** 2, 0) / w);
    mid.push(avg);
    up.push(avg + d * std);
    lo.push(avg - d * std);
  }
  return { mid, up, lo };
}

// ── Signal Strategy ──
async function getSignal(sym) {
  const df5 = await fetchTD(sym, "5min");
  const df1h = await fetchTD(sym, "1h");
  if (!df5 || !df1h) return { symbol: sym, direction: "wait", reason: "no data" };

  const closes5 = df5.map(c => c.close);
  const closes1h = df1h.map(c => c.close);
  const bb5 = bollinger(closes5);
  const bb1h = bollinger(closes1h);
  const rsi5 = rsi(closes5);
  const rsi1h = rsi(closes1h);

  const i5 = df5.length - 1;
  const i1h = df1h.length - 1;
  const c5 = df5[i5];
  const c1h = df1h[i1h];
  const r5 = rsi5[i5], r1h = rsi1h[i1h];
  const now = new Date().toISOString();

  const upperBuffer = 0.10; // 100 pips = 0.10 for XAU/USD
  const lowerBuffer = 0.10;

  const rsiStrong = (r5 < RSI_LO && r1h < RSI_LO) || (r5 > RSI_HI && r1h > RSI_HI);
  if (!rsiStrong) return { symbol: sym, time: now, direction: "wait", reason: "weak rsi" };

  const trendBuy =
    c5.close > bb5.mid[i5] &&
    c5.high < bb5.up[i5] - upperBuffer &&
    c1h.close > c1h.open &&
    c1h.high < bb1h.up[i1h] && c1h.low > bb1h.lo[i1h];

  const trendSell =
    c5.close < bb5.mid[i5] &&
    c5.low > bb5.lo[i5] + lowerBuffer &&
    c1h.close < c1h.open &&
    c1h.high < bb1h.up[i1h] && c1h.low > bb1h.lo[i1h];

  const reversalBuy =
    c5.close > c5.open &&
    c5.close < bb5.mid[i5] &&
    c5.low < bb5.lo[i5] &&
    c5.high < bb5.mid[i5] &&
    c1h.close > c1h.open &&
    c1h.high < bb1h.up[i1h] && c1h.low > bb1h.lo[i1h];

  const reversalSell =
    c5.close < c5.open &&
    c5.close > bb5.mid[i5] &&
    c5.high > bb5.up[i5] &&
    c5.low > bb5.mid[i5] &&
    c1h.close < c1h.open &&
    c1h.high < bb1h.up[i1h] && c1h.low > bb1h.lo[i1h];

  let direction = "wait", strategy = null, entry = null, tp = null, sl = null;

  if (trendBuy) {
    direction = "buy"; strategy = "trend"; entry = c5.close; tp = bb5.up[i5]; sl = c1h.open;
  } else if (trendSell) {
    direction = "sell"; strategy = "trend"; entry = c5.close; tp = bb5.lo[i5]; sl = c1h.open;
  } else if (reversalBuy) {
    direction = "buy"; strategy = "reversal"; entry = c5.close; tp = bb5.mid[i5]; sl = c5.low;
  } else if (reversalSell) {
    direction = "sell"; strategy = "reversal"; entry = c5.close; tp = bb5.mid[i5]; sl = c5.high;
  }

  return { symbol: sym, time: c5.time.toISOString(), direction, entry, tp, sl, strategy };
}

// ── Signal Loop ──
async function loopSignals() {
  while (true) {
    for (const sym of SYMBOLS) {
      try {
        const sig = await getSignal(sym);
        const prev = lastSignal[sym];

        const isSame = prev && prev.direction === sig.direction && prev.time === sig.time;
        if (sig.direction === "wait" || isSame) continue;

        lastSignal[sym] = { direction: sig.direction, time: sig.time };

        const watTime = new Date(sig.time).toLocaleString("en-NG", {
          timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", hour12: true,
        });

        const dirIcon = sig.direction === "buy" ? "🟩" : "🟥";
        let msg = `📢 *${sig.symbol}* Signal (${sig.strategy?.toUpperCase()})\n`;
        msg += `${dirIcon} Direction: *${sig.direction.toUpperCase()}*\n`;
        msg += `💰 Entry: $${(sig.entry || 0).toFixed(2)}\n🎯 TP: $${(sig.tp || 0).toFixed(2)}\n🛑 SL: $${(sig.sl || 0).toFixed(2)}\n`;
        msg += `🕒 ${watTime} (WAT)`;

        await sendTelegram(msg);
      } catch (err) {
        console.error("Signal error:", err);
      }
    }
    await sleep(240000); // 4 minutes
  }
}

// ── Start Server ──
app.get("/", (_, res) => res.send("✅ Signal bot running"));
app.listen(PORT, () => loopSignals());
