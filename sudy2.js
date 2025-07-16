const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

const SYMBOLS = ["BTC/USD"];
const RSI_LO = 45;
const RSI_HI = 55;

const API_KEYS = process.env.TD_API_KEYS.split(",").map(k => k.trim()).filter(k => k.length > 20);
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const lastSignal = {}; // { "BTC/USD": { direction, time } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Telegram Notification ──
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown"
    });
  } catch (e) {}
}

// ── Twelve Data Fetch ──
async function fetchTD(symbol, interval, rows = 100) {
  for (const key of API_KEYS) {
    try {
      const { data } = await axios.get("https://api.twelvedata.com/time_series", {
        params: { symbol, interval, outputsize: rows, apikey: key, format: "JSON" },
        timeout: 8000
      });
      if (data.values) {
        return data.values.map(c => ({
          time: new Date(c.datetime),
          open: +c.open,
          high: +c.high,
          low: +c.low,
          close: +c.close
        })).reverse();
      }
    } catch (err) {}
  }
  return null;
}

// ── RSI Calculation ──
function rsi(closes, len = 14) {
  const rsis = Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (i <= len) {
      if (diff > 0) gain += diff;
      else loss -= diff;
      if (i === len) {
        gain /= len; loss /= len;
        rsis[i] = 100 - 100 / (1 + gain / (loss || 1e-9));
      }
    } else {
      gain = (gain * (len - 1) + Math.max(0, diff)) / len;
      loss = (loss * (len - 1) + Math.max(0, -diff)) / len;
      rsis[i] = 100 - 100 / (1 + gain / (loss || 1e-9));
    }
  }
  return rsis;
}

// ── Bollinger Band ──
function bollinger(closes, w = 20, d = 2) {
  const mid = Array(closes.length).fill(null);
  const up = Array(closes.length).fill(null);
  const lo = Array(closes.length).fill(null);
  for (let i = w; i < closes.length; i++) {
    const slice = closes.slice(i - w, i);
    const avg = slice.reduce((a, b) => a + b, 0) / w;
    const sd = Math.sqrt(slice.reduce((a, b) => a + (b - avg) ** 2, 0) / w);
    mid[i] = avg;
    up[i] = avg + d * sd;
    lo[i] = avg - d * sd;
  }
  return { mid, up, lo };
}

// ── MACD (12,26,9) ──
function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ema = (data, length) => {
    const alpha = 2 / (length + 1);
    let emaArr = [];
    let prev = data.slice(0, length).reduce((a, b) => a + b, 0) / length;
    for (let i = 0; i < data.length; i++) {
      prev = i < length ? prev : alpha * data[i] + (1 - alpha) * prev;
      emaArr.push(i < length - 1 ? null : prev);
    }
    return emaArr;
  };

  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = emaFast.map((val, i) =>
    val != null && emaSlow[i] != null ? val - emaSlow[i] : null
  );
  const signalLine = ema(macdLine.filter(v => v != null), signal);
  const fullSignal = Array(macdLine.length).fill(null);
  let j = 0;
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] != null) {
      fullSignal[i] = signalLine[j++] ?? null;
    }
  }
  return { macd: macdLine, signal: fullSignal };
}

// ── Strategy Engine ──
async function getSignal(sym) {
  const df5 = await fetchTD(sym, "5min");
  const df1h = await fetchTD(sym, "1h");
  if (!df5 || !df1h) return { symbol: sym, direction: "wait", reason: "no data" };

  const closes5 = df5.map(c => c.close);
  const closes1h = df1h.map(c => c.close);
  const rsi5 = rsi(closes5);
  const rsi1h = rsi(closes1h);
  const bb5 = bollinger(closes5);
  const bb1h = bollinger(closes1h);
  const { macd: macdLine, signal: macdSignal } = macd(closes1h);

  const i5 = df5.length - 1;
  const i1h = df1h.length - 1;
  const c5 = df5[i5];
  const c1h = df1h[i1h];
  const r5 = rsi5[i5], r1h = rsi1h[i1h];
  const macdVal = macdLine[i1h], signalVal = macdSignal[i1h];
  const now = new Date().toISOString();

  const rsiValid = (r5 < RSI_LO && r1h < RSI_LO) || (r5 > RSI_HI && r1h > RSI_HI);
  if (!rsiValid) return { symbol: sym, time: now, direction: "wait", reason: "weak rsi" };
  if (macdVal == null || signalVal == null) return { symbol: sym, time: now, direction: "wait", reason: "macd loading" };

  const trendBuy =
    c5.close > bb5.mid[i5] && c5.high < bb5.up[i5] &&
    c1h.close > c1h.open && c1h.high < bb1h.up[i1h] && c1h.low > bb1h.lo[i1h] &&
    macdVal > signalVal;

  const trendSell =
    c5.close < bb5.mid[i5] && c5.low > bb5.lo[i5] &&
    c1h.close < c1h.open && c1h.high < bb1h.up[i1h] && c1h.low > bb1h.lo[i1h] &&
    macdVal < signalVal;

  let direction = "wait", tp = null, sl = null, strategy = null, entry = null;

  if (trendBuy) {
    direction = "buy"; entry = c5.close; tp = bb5.up[i5]; sl = c1h.open; strategy = "trend";
    if (c5.high >= tp || c5.low <= sl)
      return { symbol: sym, time: now, direction: "wait", reason: "already triggered" };
  } else if (trendSell) {
    direction = "sell"; entry = c5.close; tp = bb5.lo[i5]; sl = c1h.open; strategy = "trend";
    if (c5.low <= tp || c5.high >= sl)
      return { symbol: sym, time: now, direction: "wait", reason: "already triggered" };
  }

  return { symbol: sym, time: c5.time.toISOString(), direction, entry, tp, sl, strategy };
}

// ── Background Signal Loop ──
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
          timeZone: "Africa/Lagos",
          weekday: "short", day: "2-digit", month: "short", year: "numeric",
          hour: "2-digit", minute: "2-digit", hour12: true
        });

        const dirIcon = sig.direction === "buy" ? "🟩" : "🟥";
        let msg = `📢 *${sig.symbol}* Signal (${sig.strategy?.toUpperCase()})\n`;
        msg += `${dirIcon} Direction: *${sig.direction.toUpperCase()}*`;
        msg += `\n💰 Entry: $${(sig.entry || 0).toFixed(2)}`;
        msg += `\n🎯 TP: $${(sig.tp || 0).toFixed(2)}\n🛑 SL: $${(sig.sl || 0).toFixed(2)}`;
        msg += `\n🕒 ${watTime} (WAT)`;

        await sendTelegram(msg);
      } catch (err) {
        console.error("Loop error:", err);
      }
    }
    await sleep(240000); // every 4 minutes
  }
}

// ── Express API ──
app.get("/", (_, res) => res.send("✅ BTC Signal bot running"));
app.listen(PORT, () => loopSignals());
