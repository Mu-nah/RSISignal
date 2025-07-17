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

  const i5 = df5.length - 1;
  const i1h = df1h.length - 1;
  const c5 = df5[i5];
  const c1h = df1h[i1h];
  const r5 = rsi5[i5], r1h = rsi1h[i1h];
  const now = new Date().toISOString();

  const rsiValid = (r5 < RSI_LO && r1h < RSI_LO) || (r5 > RSI_HI && r1h > RSI_HI);
  if (!rsiValid) return { symbol: sym, time: now, direction: "wait", reason: "weak rsi" };

  const trendBuy =
    c5.close > bb5.mid[i5] && c5.high < bb5.up[i5] &&
    c1h.close > c1h.open && c1h.high < bb1h.up[i1h] && c1h.low > bb1h.lo[i1h];

  const trendSell =
    c5.close < bb5.mid[i5] && c5.low > bb5.lo[i5] &&
    c1h.close < c1h.open && c1h.high < bb1h.up[i1h] && c1h.low > bb1h.lo[i1h];

  const reversalBuy =
    c1h.close > c1h.open &&
    c5.close > c5.open &&
    c5.close < bb5.mid[i5] &&
    c5.low < bb5.lo[i5] &&
    c5.high < bb5.mid[i5];

  const reversalSell =
    c1h.close < c1h.open &&
    c5.close < c5.open &&
    c5.close > bb5.mid[i5] &&
    c5.high > bb5.up[i5] &&
    c5.low > bb5.mid[i5];

  let direction = "wait", tp = null, sl = null, strategy = null, entry = null;

  if (trendBuy) {
    direction = "buy"; entry = c5.close; tp = bb5.up[i5]; sl = c1h.open; strategy = "trend";
    if (c5.high >= tp || c5.low <= sl)
      return { symbol: sym, time: now, direction: "wait", reason: "already triggered" };
  } else if (trendSell) {
    direction = "sell"; entry = c5.close; tp = bb5.lo[i5]; sl = c1h.open; strategy = "trend";
    if (c5.low <= tp || c5.high >= sl)
      return { symbol: sym, time: now, direction: "wait", reason: "already triggered" };
  } else if (reversalBuy) {
    direction = "buy"; entry = c5.close; tp = bb5.mid[i5]; sl = c5.low; strategy = "reversal";
    if (c5.high >= tp || c5.low <= sl)
      return { symbol: sym, time: now, direction: "wait", reason: "already triggered" };
  } else if (reversalSell) {
    direction = "sell"; entry = c5.close; tp = bb5.mid[i5]; sl = c5.high; strategy = "reversal";
    if (c5.low <= tp || c5.high >= sl)
      return { symbol: sym, time: now, direction: "wait", reason: "already triggered" };
  }

  return { symbol: sym, time: c5.time.toISOString(), direction, entry, tp, sl, strategy };
}
