const axios = require("axios");
require("dotenv").config();

const SYMBOLS = ["BTC/USD", "XAU/USD"];
const RSI_LO = 48;
const RSI_HI = 52;
const API_KEYS = process.env.TD_API_KEYS.split(",").map(k => k.trim()).filter(k => k.length > 20);
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lastSignal = {}; // stores last signal direction per symbol

// ── Telegram Alert ──────────────────────────────
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown"
    });
  } catch (e) {
    console.error("Telegram Error:", e.message);
  }
}

// ── Fetch Candle Data ───────────────────────────
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

// ── RSI Calculation ─────────────────────────────
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

// ── Bollinger Bands ─────────────────────────────
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

// ── Generate Signal for 1 Symbol ────────────────
async function getSignal(sym) {
  const df15 = await fetchTD(sym, "15min");
  const df1h = await fetchTD(sym, "1h");
  if (!df15 || !df1h) return { symbol: sym, direction: "wait", reason: "no data" };

  const closes15 = df15.map(c => c.close);
  const closes1h = df1h.map(c => c.close);
  const rsi15 = rsi(closes15);
  const rsi1h = rsi(closes1h);
  const bb15 = bollinger(closes15);
  const bb1h = bollinger(closes1h);

  const i15 = df15.length - 1;
  const i1h = df1h.length - 1;
  const c15 = df15[i15];
  const c1h = df1h[i1h];
  const r15 = rsi15[i15], r1h = rsi1h[i1h];
  const now = new Date().toISOString();

  if (
    r15 == null || r1h == null ||
    (r15 >= RSI_LO && r15 <= RSI_HI) ||
    (r1h >= RSI_LO && r1h <= RSI_HI)
  )
    return { symbol: sym, time: now, direction: "wait", reason: "RSI neutral" };

  const trendBuy =
    c15.close > bb15.mid[i15] && c15.high < bb15.up[i15] &&
    c1h.close > c1h.open && c1h.high < bb1h.up[i1h] && c1h.low > bb1h.lo[i1h];

  const trendSell =
    c15.close < bb15.mid[i15] && c15.low > bb15.lo[i15] &&
    c1h.close < c1h.open && c1h.high < bb1h.up[i1h] && c1h.low > bb1h.lo[i1h];

  const reversalSell =
    c15.close > bb15.mid[i15] && c15.low > bb15.mid[i15] &&
    c15.high < bb15.up[i15] && c15.close < c15.open &&
    c1h.close < c1h.open;

  const reversalBuy =
    c15.close < bb15.mid[i15] && c15.high < bb15.mid[i15] &&
    c15.low > bb15.lo[i15] && c15.close > c15.open &&
    c1h.close > c1h.open;

  let direction = "wait", tp = null, sl = null, strategy = null, entry = null;

  if (trendBuy) {
    direction = "buy"; entry = c15.close; tp = bb15.up[i15]; sl = c1h.open; strategy = "trend";
  } else if (trendSell) {
    direction = "sell"; entry = c15.close; tp = bb15.lo[i15]; sl = c1h.open; strategy = "trend";
  } else if (reversalSell) {
    direction = "sell"; entry = c15.close; tp = bb15.mid[i15]; sl = c1h.open; strategy = "reversal";
  } else if (reversalBuy) {
    direction = "buy"; entry = c15.close; tp = bb15.mid[i15]; sl = c1h.open; strategy = "reversal";
  }

  return { symbol: sym, time: now, direction, entry, tp, sl, strategy };
}

// ── Main Loop ───────────────────────────────────
(async () => {
  while (true) {
    for (const sym of SYMBOLS) {
      try {
        const sig = await getSignal(sym);
        const prev = lastSignal[sym];
        lastSignal[sym] = sig.direction;

        if (sig.direction !== prev) {
          const watTime = new Date(sig.time).toLocaleString("en-NG", {
            timeZone: "Africa/Lagos",
            weekday: "short",
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true
          });

          let msg = `📢 *${sig.symbol}* Signal`;

          if (sig.direction === "wait") {
            msg += `\n🕒 *${watTime} (WAT)*`;
            msg += `\n⚠️ Direction changed to *WAIT*`;
          } else {
            const dirIcon = sig.direction === "buy" ? "🟩" : "🟥";
            msg += ` (${sig.strategy?.toUpperCase() || "UNKNOWN"})\n`;
            msg += `${dirIcon} Direction: *${sig.direction.toUpperCase()}*`;
            msg += `\n💰 Entry: $${(sig.entry || 0).toFixed(2)}`;
            msg += `\n🎯 TP: $${(sig.tp || 0).toFixed(2)}\n🛑 SL: $${(sig.sl || 0).toFixed(2)}`;
            msg += `\n🕒 ${watTime} (WAT)`;
          }

          console.log(`[Alert] ${sig.symbol}: ${sig.direction}`);
          await sendTelegram(msg);
        } else {
          console.log(`[No Change] ${sym}: ${sig.direction}`);
        }
      } catch (err) {
        console.error(`[Error] ${sym}:`, err.message);
      }
    }

    await sleep(240000); // every 4 minutes
  }
})();
