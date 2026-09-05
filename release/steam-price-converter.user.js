// Tampermonkey обновляет скрипт сам, если знает, где лежит свежий: @updateURL и @downloadURL ниже всегда
// указывают на последний релиз, так что перекачивать вручную не нужно.
// ==UserScript==
// @name         Steam Price Converter (₽ / $)
// @namespace    https://github.com/grozovsky/steam-price-converter
// @version      1.1.0
// @description  Показывает цены магазина Steam в рублях и долларах рядом с оригиналом, независимо от региона аккаунта.
// @author       grozovsky
// @updateURL    https://github.com/grozovsky/steam-price-converter/releases/latest/download/steam-price-converter.user.js
// @downloadURL  https://github.com/grozovsky/steam-price-converter/releases/latest/download/steam-price-converter.user.js
// @match        https://store.steampowered.com/*
// @match        https://steamcommunity.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      open.er-api.com
// @connect      www.cbr-xml-daily.ru
// @connect      cdn.jsdelivr.net
// @connect      galaxylink.gg
// @connect      steam.galaxylink.gg
// ==/UserScript==

"use strict";
(() => {
  // core/providers/pricing.ts
  var MIN_TOPUP = 1;
  function methodById(r, id) {
    return r.methods.find((m) => m.id === id) ?? r.methods[0] ?? null;
  }
  function baseAtRate(amount, currency, r) {
    const rubPerUnit = currency === "RUB" ? 1 : r.rates[currency];
    if (!rubPerUnit) return null;
    return Math.ceil(amount * rubPerUnit - 1e-9);
  }
  function creditedAtRate(base, currency, r) {
    const rubPerUnit = currency === "RUB" ? 1 : r.rates[currency];
    if (!rubPerUnit) return null;
    return base / rubPerUnit;
  }
  function chargeWithPercent(base, fee) {
    return Math.round(base * (1 + fee / 100) * 100 + 1e-9) / 100;
  }
  function quote(need, currency, p, r, method) {
    if (!(need > 0)) return null;
    const raw = p.baseFor(need, currency, r);
    if (raw == null || raw > r.max) return null;
    const base = Math.max(raw, r.min, MIN_TOPUP);
    return {
      base,
      charge: p.charge(base, r, method),
      credited: p.credited(base, currency, r),
      lifted: raw < base
    };
  }

  // core/providers/galaxylink.ts
  var GALAXY_HOME = "https://galaxylink.gg/";
  var GALAXY_VALIDATE_URL = "https://steam.galaxylink.gg/api/validate_steam";
  var GALAXY_HARD_MIN = 50;
  var DEFAULT_FEES = { SBP: 2, BANK_CARD: 4 };
  var LABELS = { SBP: "СБП", BANK_CARD: "Банковская карта" };
  function parseGalaxyRates(text, fetchedAt) {
    const m = /STEAM_RATES\s*=\s*(\{[^}]*\})/.exec(text);
    if (!m) return null;
    let rates;
    try {
      const obj = JSON.parse(m[1]);
      rates = {};
      for (const [k, v] of Object.entries(obj)) if (typeof v === "number" && v > 0) rates[k.toUpperCase()] = v;
    } catch {
      return null;
    }
    if (!rates.RUB) rates.RUB = 1;
    if (Object.keys(rates).length < 2) return null;
    const fee = (id) => {
      const found = new RegExp(`${id}\\s*:\\s*(\\d+(?:\\.\\d+)?)`).exec(text);
      return found ? Number(found[1]) : DEFAULT_FEES[id];
    };
    const min = /MIN_AMOUNT\s*=\s*(\d+)/.exec(text);
    const max = /MAX_AMOUNT\s*=\s*(\d+)/.exec(text);
    return {
      rates,
      methods: Object.keys(DEFAULT_FEES).map((id) => ({ id, label: LABELS[id] ?? id, fee: fee(id) })),
      min: Math.max(min ? Number(min[1]) : GALAXY_HARD_MIN, GALAXY_HARD_MIN),
      max: max ? Number(max[1]) : 3e4,
      fetchedAt
    };
  }
  var galaxylink = {
    id: "galaxylink",
    name: "GalaxyLink",
    home: GALAXY_HOME,
    checkout: "deal",
    validatesLogin: true,
    parseRates: parseGalaxyRates,
    baseFor: baseAtRate,
    credited: creditedAtRate,
    charge: (base, r, method) => chargeWithPercent(base, methodById(r, method)?.fee ?? 0)
  };

  // core/providers/tbank.ts
  var TBANK_HOME = "https://www.tbank.ru/mybank/payments/payment-provider/id-steam-rk/";
  var TBANK_MIN = 30;
  var TBANK_MAX = 15e4;
  var TBANK_METHOD = "TBANK";
  var TBANK_RATE_ADJUST = 0.998;
  function isTbank(r) {
    return typeof r.usdSell === "number" && !!r.perUsd;
  }
  function usdFor(base, r) {
    return Math.floor(base / r.usdSell * 100 + 1e-9) / 100;
  }
  function parseTbankRates(text, fetchedAt) {
    const sell = /TBANK_USD_SELL\s*=\s*([\d.]+)/.exec(text);
    const per = /STEAM_PER_USD\s*=\s*(\{[^}]*\})/.exec(text);
    if (!sell || !per) return null;
    const published = Number(sell[1]);
    if (!(published > 0)) return null;
    const usdSell = published * TBANK_RATE_ADJUST;
    let perUsd;
    try {
      const obj = JSON.parse(per[1]);
      perUsd = {};
      for (const [k, v] of Object.entries(obj)) if (typeof v === "number" && v > 0) perUsd[k.toUpperCase()] = v;
    } catch {
      return null;
    }
    if (Object.keys(perUsd).length === 0) return null;
    const rates = {};
    for (const [code, units] of Object.entries(perUsd)) rates[code] = usdSell / units;
    const min = /TBANK_MIN\s*=\s*(\d+)/.exec(text);
    const max = /TBANK_MAX\s*=\s*(\d+)/.exec(text);
    return {
      rates,
      perUsd,
      usdSell,
      methods: [{ id: TBANK_METHOD, label: "Со счёта Т-Банка", fee: 0 }],
      min: Math.max(min ? Number(min[1]) : TBANK_MIN, TBANK_MIN),
      max: max ? Number(max[1]) : TBANK_MAX,
      fetchedAt
    };
  }
  var tbank = {
    id: "tbank",
    name: "Т-Банк",
    home: TBANK_HOME,
    checkout: "manual",
    // Their form takes the login without checking it; a wrong one is only caught after the money leaves.
    validatesLogin: false,
    parseRates: parseTbankRates,
    /**
     * Rubles to type into their form so `amount` of `currency` is covered. Both roundings go up: cents, because a
     * part-cent buys nothing, and then rubles, because their field takes whole ones. The 1e-9 allowances absorb
     * binary-float noise the way pricing.ts does — without them an exact hit like 146.227 ₸ asks for a cent too many.
     */
    baseFor(amount, currency, r) {
      if (!isTbank(r)) return null;
      const units = r.perUsd[currency];
      if (!units) return null;
      const cents = Math.ceil(amount / units * 100 - 1e-9);
      return Math.ceil(cents / 100 * r.usdSell - 1e-9);
    },
    /** What those rubles actually land on the wallet as, by the same path the money takes. */
    credited(base, currency, r) {
      if (!isTbank(r)) return null;
      const units = r.perUsd[currency];
      if (!units) return null;
      return usdFor(base, r) * units;
    },
    /** No fee on top: "Без комиссии" is true of the billing — the bank's margin lives inside its dollar rate. */
    charge: (base) => base
  };

  // core/providers/index.ts
  var PROVIDERS = [galaxylink, tbank];
  var DEFAULT_PROVIDER = galaxylink;
  function providerById(id) {
    return PROVIDERS.find((p) => p.id === id) ?? DEFAULT_PROVIDER;
  }

  // core/settings.ts
  var DEFAULT_SETTINGS = {
    // Rubles in every mode are the top-up price (provider rate plus the method's fee), so this is what a purchase costs.
    mode: "rub",
    source: "market",
    store_currency: "auto",
    provider: DEFAULT_PROVIDER.id,
    galaxy_method: "SBP",
    steam_login: "",
    // Steam's own browser window keeps the payment inside the client and shows the domain in its address bar.
    pay_target: "steam",
    auto_restart: "no"
  };
  var MODES = ["off", "rub", "usd", "both"];
  var SOURCES = ["market", "cbr"];
  var PAY_TARGETS = ["steam", "browser"];
  function normalizeSettings(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const rawMode = r.mode === "galaxy" ? "rub" : r.mode;
    const mode = MODES.includes(rawMode) ? rawMode : DEFAULT_SETTINGS.mode;
    const source = SOURCES.includes(r.source) ? r.source : DEFAULT_SETTINGS.source;
    const sc = typeof r.store_currency === "string" && /^(auto|[A-Z]{3})$/.test(r.store_currency) ? r.store_currency : DEFAULT_SETTINGS.store_currency;
    const gm = typeof r.galaxy_method === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(r.galaxy_method) ? r.galaxy_method : DEFAULT_SETTINGS.galaxy_method;
    const provider = providerById(typeof r.provider === "string" ? r.provider : void 0).id;
    const login = typeof r.steam_login === "string" && /^[A-Za-z0-9_\-.]{1,64}$/.test(r.steam_login) ? r.steam_login : "";
    const pt = PAY_TARGETS.includes(r.pay_target) ? r.pay_target : DEFAULT_SETTINGS.pay_target;
    const ar = r.auto_restart === "yes" ? "yes" : "no";
    return { mode, source, store_currency: sc, provider, galaxy_method: gm, steam_login: login, pay_target: pt, auto_restart: ar };
  }

  // core/currencies.ts
  var CURRENCIES = [
    { code: "KZT", id: 37, decimal: ",", detect: /₸/ },
    // Steam prints "руб." with either a Latin "p" or a Cyrillic "р" depending on the page.
    { code: "RUB", id: 5, decimal: ",", detect: /(?:₽|[pр]уб\.?)/ },
    { code: "UAH", id: 18, decimal: ",", detect: /₴/ },
    { code: "EUR", id: 3, decimal: ",", detect: /€/ },
    { code: "GBP", id: 2, decimal: ".", detect: /£/ },
    { code: "PLN", id: 6, decimal: ",", detect: /zł/ },
    { code: "BRL", id: 7, decimal: ",", detect: /R\$/ },
    { code: "CAD", id: 20, decimal: ".", detect: /CDN\$/ },
    { code: "AUD", id: 21, decimal: ".", detect: /A\$/ },
    { code: "NZD", id: 22, decimal: ".", detect: /NZ\$/ },
    { code: "SGD", id: 13, decimal: ".", detect: /S\$/ },
    { code: "HKD", id: 29, decimal: ".", detect: /HK\$/ },
    { code: "TWD", id: 30, decimal: "", detect: /NT\$/ },
    { code: "MXN", id: 19, decimal: ".", detect: /Mex\$/ },
    { code: "ARS", id: 34, decimal: ",", detect: /ARS\$/ },
    { code: "COP", id: 27, decimal: "", detect: /COL\$/ },
    { code: "CLP", id: 25, decimal: "", detect: /CLP\$/ },
    { code: "UYU", id: 41, decimal: ",", detect: /\$U/ },
    { code: "USD", id: 1, decimal: ".", detect: /\$/ },
    { code: "CHF", id: 4, decimal: ".", detect: /CHF/ },
    // JPY and CNY share "¥": resolved by the page's meta tag, or by the presence of ".00" (CNY) in the text.
    { code: "JPY", id: 8, decimal: "", detect: /¥/ },
    { code: "CNY", id: 23, decimal: ".", detect: /¥/ },
    { code: "INR", id: 24, decimal: ".", detect: /₹/ },
    { code: "KRW", id: 16, decimal: "", detect: /₩/ },
    { code: "VND", id: 15, decimal: "", detect: /₫/ },
    { code: "IDR", id: 10, decimal: "", detect: /Rp/ },
    { code: "MYR", id: 11, decimal: ".", detect: /RM/ },
    { code: "PHP", id: 12, decimal: ".", detect: /₱/ },
    { code: "THB", id: 14, decimal: ".", detect: /฿/ },
    { code: "TRY", id: 17, decimal: ",", detect: /(?:₺|\bTL\b)/ },
    { code: "NOK", id: 9, decimal: ",", detect: /\bkr\b/ },
    { code: "ZAR", id: 28, decimal: ".", detect: /\bR\s?(?=\d)/ },
    { code: "SAR", id: 31, decimal: ".", detect: /\bSR\b/ },
    { code: "AED", id: 32, decimal: ".", detect: /\bAED\b/ },
    { code: "ILS", id: 35, decimal: ".", detect: /₪/ },
    { code: "BYN", id: 36, decimal: ",", detect: /\bBr\b/ },
    { code: "KWD", id: 38, decimal: ".", detect: /\bKD\b/ },
    { code: "QAR", id: 39, decimal: ".", detect: /\bQR\b/ },
    { code: "CRC", id: 40, decimal: ",", detect: /₡/ },
    { code: "PEN", id: 26, decimal: ".", detect: /S\/\./ }
  ];
  var BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));
  function byCode(code) {
    return code ? BY_CODE.get(code.toUpperCase()) : void 0;
  }

  // core/parse.ts
  var SPACES = /[\s   ]+/g;
  var FREE = /^(?:free|бесплатно|kostenlos|gratis|gratuit|gratuito|無料|免费)\b/i;
  function stripCurrency(text, cur) {
    return text.replace(new RegExp(cur.detect.source, "g"), " ").replace(/\b[A-Z]{3}\b/g, " ");
  }
  function isPriceText(text, cur) {
    const t = text.replace(SPACES, " ").trim();
    if (!t || t.length > 32 || !/\d/.test(t)) return false;
    if (!cur.detect.test(t)) return false;
    const leftovers = stripCurrency(t, cur).replace(/[\d.,\s-]/g, "");
    return leftovers === "";
  }
  function parsePrice(text, cur) {
    const t = text.replace(SPACES, " ").trim();
    if (!t || FREE.test(t)) return null;
    if (!cur.detect.test(t)) return null;
    const rest = stripCurrency(t, cur);
    const negative = /^\s*-/.test(rest);
    const digits = rest.replace(/[^\d.,]/g, "");
    if (!/\d/.test(digits)) return null;
    let num;
    if (cur.decimal === "") {
      num = digits.replace(/[.,]/g, "");
    } else {
      const thousand = cur.decimal === "." ? "," : ".";
      const parts = digits.split(cur.decimal);
      if (parts.length > 2) return null;
      const intPart = parts[0].split(thousand).join("");
      const frac = parts[1] ?? "";
      if (frac.length > 3 || !/^\d*$/.test(intPart)) return null;
      num = frac ? `${intPart}.${frac}` : intPart;
    }
    const value = Number(num);
    if (!Number.isFinite(value)) return null;
    return negative ? -value : value;
  }

  // core/detect.ts
  function detectFromText(text) {
    for (const cur of CURRENCIES) {
      if (!isPriceText(text, cur)) continue;
      if (cur.code === "JPY" && /\.\d{2}\s*$/.test(text.trim())) {
        return byCode("CNY");
      }
      return cur;
    }
    return null;
  }
  var SKIP_TAGS = /* @__PURE__ */ new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SELECT", "OPTION", "NOSCRIPT", "TITLE", "SVG"]);
  function scanForCurrency(root, limit = 600) {
    const doc = root.ownerDocument ?? root;
    const walker = doc.createTreeWalker(
      root,
      4
      /* NodeFilter.SHOW_TEXT */
    );
    let seen = 0;
    let node;
    while (node = walker.nextNode()) {
      const text = node.nodeValue ?? "";
      if (!/\d/.test(text) || text.length > 32) continue;
      const parent = node.parentElement;
      if (!parent || SKIP_TAGS.has(parent.tagName.toUpperCase())) continue;
      const cur = detectFromText(text);
      if (cur) return cur;
      if (++seen >= limit) break;
    }
    return null;
  }
  function detectCurrency(override, doc) {
    if (override && override !== "auto") return byCode(override) ?? null;
    const meta = doc.querySelector('meta[itemprop="priceCurrency"][content]');
    const fromMeta = byCode(meta?.getAttribute("content"));
    if (fromMeta) return fromMeta;
    return doc.body ? scanForCurrency(doc.body) : null;
  }

  // core/rates.ts
  var SOURCE_URLS = {
    market: "https://open.er-api.com/v6/latest/USD",
    cbr: "https://www.cbr-xml-daily.ru/daily_json.js",
    fallback: "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json"
  };
  function sourceChain(preferred) {
    return preferred === "cbr" ? ["cbr", "market", "fallback"] : ["market", "fallback", "cbr"];
  }
  function normalizeRates(source, body, fetchedAt) {
    let j;
    try {
      j = JSON.parse(body);
    } catch {
      return null;
    }
    if (!j || typeof j !== "object") return null;
    if (source === "market") {
      if (j.result !== "success" || !j.rates || typeof j.rates.RUB !== "number") return null;
      return { base: "USD", rates: { ...j.rates, USD: 1 }, date: String(j.time_last_update_utc ?? ""), source, fetchedAt };
    }
    if (source === "cbr") {
      const v = j.Valute;
      if (!v?.USD?.Value) return null;
      const rubPerUsd = v.USD.Value / (v.USD.Nominal || 1);
      const rates2 = { USD: 1, RUB: rubPerUsd };
      for (const [code, entry] of Object.entries(v)) {
        if (!entry || typeof entry.Value !== "number") continue;
        const rubPerUnit = entry.Value / (entry.Nominal || 1);
        if (rubPerUnit > 0) rates2[code] = rubPerUsd / rubPerUnit;
      }
      return { base: "USD", rates: rates2, date: String(j.Date ?? ""), source, fetchedAt };
    }
    const m = j.usd;
    if (!m || typeof m !== "object" || typeof m.rub !== "number") return null;
    const rates = { USD: 1 };
    for (const [k, val] of Object.entries(m)) if (typeof val === "number") rates[k.toUpperCase()] = val;
    return { base: "USD", rates, date: String(j.date ?? ""), source, fetchedAt };
  }
  function convert(amount, from, to, rates) {
    if (from === to) return amount;
    const rf = rates.rates[from];
    const rt = rates.rates[to];
    if (!rf || !rt) return null;
    return amount / rf * rt;
  }

  // core/format.ts
  var THIN = " ";
  function group(intStr, sep) {
    return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  }
  function formatRub(v) {
    const n = Math.round(Math.abs(v));
    return `${v < 0 ? "-" : ""}${group(String(n), THIN)} ₽`;
  }
  function formatRubExact(v) {
    const a = Math.abs(v);
    const whole = Math.floor(a + 1e-9);
    const kopecks = Math.round((a - whole) * 100);
    const body = kopecks === 0 ? group(String(whole), THIN) : `${group(String(whole), THIN)},${String(kopecks).padStart(2, "0")}`;
    return `${v < 0 ? "-" : ""}${body} ₽`;
  }
  function formatUsd(v) {
    const a = Math.abs(v);
    let body;
    if (a >= 1e3) {
      body = group(String(Math.round(a)), ",");
    } else {
      const [i, f] = a.toFixed(2).split(".");
      body = `${i}.${f}`;
    }
    return `${v < 0 ? "-" : ""}$${body}`;
  }
  function formatConversion(amount, from, mode, rates, opts = {}) {
    if (mode === "off") return null;
    const wantRub = mode === "rub" || mode === "both" || mode === "galaxy";
    const wantUsd = mode === "usd" || mode === "both";
    const parts = [];
    if (wantRub && from !== "RUB") {
      const viaTopUp = opts.provider && opts.providerRates ? quote(amount, from, opts.provider, opts.providerRates, opts.method ?? "")?.charge ?? null : null;
      if (viaTopUp != null) parts.push(formatRubExact(viaTopUp));
      else {
        const v = rates ? convert(amount, from, "RUB", rates) : null;
        if (v != null) parts.push(formatRub(v));
      }
    }
    if (wantUsd && from !== "USD" && rates) {
      const v = convert(amount, from, "USD", rates);
      if (v != null) parts.push(formatUsd(v));
    }
    return parts.length ? `≈ ${parts.join(" / ")}` : null;
  }

  // core/dom.ts
  var CONV_CLASS = "spc-conv";
  var UI_CLASS = "spc-ui";
  var HOST_CLASS = "spc-host";
  var STRIKE_CLASS = "spc-strike";
  var STRIKE_VAR = "--spc-conv";
  var SEARCH_COL_VAR = "--spc-search-price";
  var SEARCH_COL_GAP = 10;
  function inOwnUi(el) {
    return !!el?.closest(`.${CONV_CLASS}, .${UI_CLASS}`);
  }
  function acceptable(node) {
    const parent = node.parentElement;
    if (!parent || SKIP_TAGS.has(parent.tagName.toUpperCase())) return false;
    if (parent.isContentEditable) return false;
    return !inOwnUi(parent);
  }
  function render(amount, from, ctx) {
    const t = formatConversion(amount, from, ctx.mode, ctx.rates, { provider: ctx.provider, providerRates: ctx.providerRates, method: ctx.method });
    return t ? ` ${t}` : "";
  }
  function hasStrikeBefore(el) {
    const win = el.ownerDocument.defaultView;
    if (!win || typeof win.getComputedStyle !== "function") return false;
    try {
      const cs = win.getComputedStyle(el, "::before");
      if (!cs || cs.content === "none" || cs.content === "normal" || cs.content === "") return false;
      if (cs.position !== "absolute") return false;
      return parseFloat(cs.borderBottomWidth) > 0 || parseFloat(cs.borderTopWidth) > 0;
    } catch {
      return false;
    }
  }
  function layoutStrikes(hosts) {
    const widths = [];
    for (const host of hosts) {
      if (!host.isConnected) continue;
      let span = null;
      for (const child of Array.from(host.children)) {
        if (child.classList.contains(CONV_CLASS)) {
          span = child;
          break;
        }
      }
      let w = 0;
      if (span) {
        const sr = span.getBoundingClientRect();
        if (sr.width > 0) w = Math.max(0, Math.ceil(host.getBoundingClientRect().right - sr.left));
      }
      widths.push([host, w]);
    }
    for (const [host, w] of widths) host.style.setProperty(STRIKE_VAR, `${w}px`);
  }
  function layoutSearchColumn(doc) {
    const grids = doc.querySelectorAll(".responsive_search_name_combined");
    if (!grids.length) return;
    let need = 0;
    grids.forEach((grid) => {
      const cell = grid.querySelector(".search_price_discount_combined");
      if (!cell) return;
      const right = cell.getBoundingClientRect().right;
      let left = right;
      cell.querySelectorAll("*").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.left < left) left = r.left;
      });
      if (right > left) need = Math.max(need, Math.ceil(right - left) + SEARCH_COL_GAP);
    });
    if (need > 0) doc.documentElement.style.setProperty(SEARCH_COL_VAR, `${need}px`);
  }
  function siblingConv(node) {
    const next = node.nextSibling;
    return next instanceof HTMLElement && next.classList.contains(CONV_CLASS) ? next : null;
  }
  function annotateTextNode(node, ctx, pending) {
    if (!acceptable(node)) return false;
    const raw = node.nodeValue ?? "";
    if (!/\d/.test(raw) || !isPriceText(raw, ctx.cur)) {
      siblingConv(node)?.remove();
      return false;
    }
    const amount = parsePrice(raw, ctx.cur);
    if (amount == null) {
      siblingConv(node)?.remove();
      return false;
    }
    const existing = siblingConv(node);
    if (existing) {
      if (existing.dataset.spcAmount !== String(amount)) {
        existing.dataset.spcAmount = String(amount);
        existing.dataset.spcCur = ctx.cur.code;
        existing.textContent = render(amount, ctx.cur.code, ctx);
        const host2 = node.parentElement;
        if (host2?.classList.contains(STRIKE_CLASS)) pending?.add(host2);
      }
      return true;
    }
    const span = node.ownerDocument.createElement("span");
    span.className = CONV_CLASS;
    span.dataset.spcAmount = String(amount);
    span.dataset.spcCur = ctx.cur.code;
    span.textContent = render(amount, ctx.cur.code, ctx);
    node.parentNode?.insertBefore(span, node.nextSibling);
    const host = node.parentElement;
    if (host) {
      host.classList.add(HOST_CLASS);
      if (hasStrikeBefore(host)) {
        host.classList.add(STRIKE_CLASS);
        pending?.add(host);
      }
    }
    return true;
  }
  function processTree(root, ctx) {
    if (root.nodeType === 3) {
      const pending2 = /* @__PURE__ */ new Set();
      const ok = annotateTextNode(root, ctx, pending2);
      layoutStrikes(pending2);
      layoutSearchColumn(root.ownerDocument);
      return ok ? 1 : 0;
    }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return 0;
    if (root instanceof Element && (SKIP_TAGS.has(root.tagName.toUpperCase()) || inOwnUi(root))) return 0;
    const doc = root.ownerDocument ?? root;
    const walker = doc.createTreeWalker(
      root,
      4
      /* SHOW_TEXT */
    );
    const nodes = [];
    let n;
    while (n = walker.nextNode()) {
      if (/\d/.test(n.nodeValue ?? "")) nodes.push(n);
    }
    let count = 0;
    const pending = /* @__PURE__ */ new Set();
    for (const t of nodes) if (annotateTextNode(t, ctx, pending)) count++;
    layoutStrikes(pending);
    layoutSearchColumn(doc);
    return count;
  }
  function rerenderAll(doc, ctx) {
    doc.querySelectorAll(`.${CONV_CLASS}`).forEach((span) => {
      const amount = Number(span.dataset.spcAmount);
      const from = span.dataset.spcCur ?? ctx.cur.code;
      if (!Number.isFinite(amount)) return;
      span.textContent = render(amount, from, ctx);
    });
    layoutStrikes(doc.querySelectorAll(`.${STRIKE_CLASS}`));
    layoutSearchColumn(doc);
  }
  function applyMode(doc, mode) {
    doc.documentElement.classList.toggle("spc-off", mode === "off");
  }
  function observe(doc, getCtx) {
    const queue = /* @__PURE__ */ new Set();
    let timer;
    const flush = () => {
      timer = void 0;
      const ctx = getCtx();
      const batch = [...queue];
      queue.clear();
      if (!ctx) return;
      const pending = /* @__PURE__ */ new Set();
      for (const node of batch) {
        if (!node.isConnected) continue;
        if (node.nodeType === 3) annotateTextNode(node, ctx, pending);
        else processTree(node, ctx);
      }
      layoutStrikes(pending);
      layoutSearchColumn(doc);
    };
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        const el = m.target instanceof Element ? m.target : m.target.parentElement;
        if (inOwnUi(el)) continue;
        if (m.type === "characterData") queue.add(m.target);
        else m.addedNodes.forEach((n) => queue.add(n));
      }
      if (queue.size && timer === void 0) timer = setTimeout(flush, 120);
    });
    mo.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
    return mo;
  }

  // core/purchase.ts
  var TOPUP_CLASS = "spc-topup";
  var NATIVE_COMPACT_CLASS = "spc-cart-compact";
  var CART_BTN_CLASS = "spc-topup-cart";
  function parseWallet(text) {
    if (!text) return null;
    const cur = detectFromText(text);
    if (!cur) return null;
    const amount = parsePrice(text, cur);
    if (amount == null || amount < 0) return null;
    return { amount, cur: cur.code };
  }
  var CART_HREF = /^javascript:\s*add(?:Bundle)?ToCart\s*\(/;
  var SKIP_BUTTON = /подар|gift|список желаемого|wishlist/i;
  function findPurchaseBlocks(doc, cur) {
    const out = [];
    for (const root of Array.from(doc.querySelectorAll(".game_area_purchase_game"))) {
      const action = root.querySelector(".game_purchase_action");
      if (!action) continue;
      const cart = Array.from(action.querySelectorAll(".btn_addtocart")).find((el) => {
        if (el.classList.contains("btn_packageinfo") || el.classList.contains("btn_addtoaccount")) return false;
        const a = el.querySelector("a");
        return !!a && CART_HREF.test(a.getAttribute("href") ?? "") && !SKIP_BUTTON.test(a.textContent ?? "");
      });
      if (!cart) continue;
      const bar = cart.closest(".game_purchase_action_bg") ?? action;
      const price = readPrice(bar, cur) ?? readPrice(action, cur);
      if (price == null || price <= 0) continue;
      out.push({ root, cart, price });
    }
    return out;
  }
  function ownText(el) {
    let s = "";
    for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) s += n.nodeValue ?? "";
    return s;
  }
  function priceCandidates(el) {
    const out = [ownText(el)];
    for (const child of Array.from(el.children)) {
      if (child.classList.contains(CONV_CLASS) || child.classList.contains("your_price_label")) continue;
      out.push(ownText(child));
    }
    return out;
  }
  function readPrice(scope, cur) {
    for (const printed of Array.from(scope.querySelectorAll(".discount_final_price, .game_purchase_price"))) {
      for (const text of priceCandidates(printed)) {
        const v = parsePrice(text, cur);
        if (v != null && v > 0) return v;
      }
    }
    const raw = scope.querySelector("[data-price-final]")?.getAttribute("data-price-final");
    if (raw && /^\d+$/.test(raw)) return Number(raw) / 100;
    return null;
  }
  function isCartPage(doc) {
    return /(^|\/)cart\/?$/.test(doc.location?.pathname ?? "");
  }
  function findCartTarget(doc, cur) {
    if (!isCartPage(doc)) return null;
    for (const button of Array.from(doc.querySelectorAll("button"))) {
      if (button.classList.contains(TOPUP_CLASS)) continue;
      if (button.getBoundingClientRect().width <= 0) continue;
      const box = button.parentElement;
      if (!box) continue;
      let price = null;
      let seen = 0;
      for (const el of Array.from(box.querySelectorAll("*"))) {
        const v = parsePrice(ownText(el), cur);
        if (v != null && v > 0) {
          price = v;
          seen++;
        }
      }
      if (seen === 1 && price != null) return { native: button, price };
    }
    return null;
  }
  function ourButton(target) {
    const sib = target.before ? target.native.previousElementSibling : target.native.nextElementSibling;
    return sib instanceof HTMLElement && sib.classList.contains(TOPUP_CLASS) ? sib : null;
  }
  function uncompact(cart) {
    cart.classList.remove(NATIVE_COMPACT_CLASS);
    cart.querySelector("a")?.removeAttribute("title");
  }
  function applyTopupButtons(doc, opts) {
    const targets = [];
    if (opts.enabled !== false) {
      for (const block of findPurchaseBlocks(doc, opts.cur)) {
        targets.push({ native: block.cart, price: block.price, before: false, compact: true, what: "" });
      }
      const cart = findCartTarget(doc, opts.cur);
      if (cart) targets.push({ native: cart.native, price: cart.price, before: true, compact: false, what: `В корзине на ${formatAmount(cart.price, opts.cur)}.` });
    }
    const ours = /* @__PURE__ */ new Set();
    const compacted = /* @__PURE__ */ new Set();
    let shown = 0;
    for (const target of targets) {
      const missing = opts.wallet ? target.price - opts.wallet.amount : 0;
      const priced = opts.wallet && opts.providerRates ? quote(missing, opts.cur.code, opts.provider, opts.providerRates, opts.method) : null;
      if (!priced) continue;
      shown++;
      const { base, charge } = priced;
      const label = `Пополнить ${formatRubExact(charge)}`;
      const head = `${target.what} На кошельке ${formatAmount(opts.wallet.amount, opts.cur)}, не хватает ${formatAmount(missing, opts.cur)}.`.trim();
      const title = opts.prefills === false ? `${head} Откроет ${opts.provider.name}: введите ${formatRubExact(base)} в поле суммы, спишется ${formatRubExact(charge)}.` : `${head} Откроет пополнение ${opts.provider.name}: ${formatRubExact(base)} на кошелёк, спишется ${formatRubExact(charge)}.`;
      let btn = ourButton(target);
      if (!btn) {
        btn = target.compact ? buildButton(doc, target.native) : buildCartButton(doc, target.native);
        target.native.insertAdjacentElement(target.before ? "beforebegin" : "afterend", btn);
        const self = btn;
        self.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const current = Number(self.dataset.spcNeed);
          if (Number.isFinite(current) && current > 0) opts.onTopup(current);
        });
      }
      ours.add(btn);
      if (target.compact && !target.native.classList.contains(NATIVE_COMPACT_CLASS)) {
        target.native.classList.add(NATIVE_COMPACT_CLASS);
        const nativeA = target.native.querySelector("a");
        if (nativeA && !nativeA.title) nativeA.title = (nativeA.textContent ?? "").trim() || "В корзину";
      }
      if (target.compact) compacted.add(target.native);
      if (btn.dataset.spcNeed !== String(missing) || btn.title !== title) {
        btn.dataset.spcNeed = String(missing);
        const span = btn.querySelector("span");
        if (span) span.textContent = label;
        const a = btn.querySelector("a");
        (a ?? btn).title = title;
        if (a) btn.title = "";
      }
    }
    for (const cart of Array.from(doc.querySelectorAll(`.${NATIVE_COMPACT_CLASS}`))) {
      if (!compacted.has(cart)) uncompact(cart);
    }
    for (const own of Array.from(doc.querySelectorAll(`.${TOPUP_CLASS}`))) {
      if (!ours.has(own)) own.remove();
    }
    return shown;
  }
  function buildCartButton(doc, native) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = `${native.className} ${TOPUP_CLASS} ${CART_BTN_CLASS}`;
    btn.appendChild(doc.createElement("span"));
    return btn;
  }
  function buildButton(doc, cart) {
    const wrap = doc.createElement("div");
    wrap.className = TOPUP_CLASS;
    wrap.style.position = "relative";
    const a = doc.createElement("a");
    const nativeA = cart.querySelector("a");
    a.className = nativeA?.className || "btn_green_steamui btn_medium";
    a.setAttribute("role", "button");
    const panel = nativeA?.getAttribute("data-panel");
    if (panel) a.setAttribute("data-panel", panel);
    a.href = "#";
    const span = doc.createElement("span");
    a.appendChild(span);
    wrap.appendChild(a);
    return wrap;
  }
  function formatAmount(v, cur) {
    const whole = Number.isInteger(v) ? String(v) : v.toFixed(2).replace(".", ",");
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return `${grouped} ${cur.code === "KZT" ? "₸" : cur.code === "RUB" ? "₽" : cur.code === "USD" ? "$" : cur.code}`;
  }

  // core/header.ts
  var MODE_LABELS = {
    rub: "₽",
    both: "₽ + $",
    usd: "$",
    off: "Как есть",
    galaxy: "₽"
    // legacy value from older settings; behaves like 'rub'
  };
  var STYLE_ID = "spc-style";
  function injectStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.${CONV_CLASS}{font-size:.85em;opacity:.78;margin-left:.35em;white-space:nowrap;font-weight:normal;letter-spacing:0}
html.spc-off .${CONV_CLASS}{display:none}
/* A price never breaks mid-number: in Steam's narrow slots "3 773,00₸" was splitting across two lines. */
html:not(.spc-off) .${HOST_CLASS}{white-space:nowrap}
/* Search rows are a grid. Its price column is a percentage of the row, and the price block is glued to that
   column's right edge and spills leftwards, so our suffix pushed it over the release date and the review icon.
   Widening that column moves the date and the icon left instead; the price itself does not move. The width is
   one number for the whole list, measured by layoutSearchColumn — sizing each row to its own content would step
   the dates down the page. Until the first measurement the column keeps Steam's own 25%.
   Below 751px Steam switches to its own two-column layout, which has no room to give and needs no help. */
@media screen and (min-width:751px){
html:not(.spc-off) .responsive_search_name_combined{grid-template-columns:minmax(0,1fr) auto 30px var(${SEARCH_COL_VAR},25%)}
}
/* Hover pop-ups sit the price next to the capsule thumbnail and cap it at half the width; with our suffix the
   number wrapped and the block hung out of the card. The price keeps its natural width now, its neighbour gives
   up the difference. Steam's class names here are hashed per build, so the price widget is found through :has(). */
html:not(.spc-off) :has(>.StoreSalePriceWidgetContainer){max-width:none!important;flex-shrink:0}
html:not(.spc-off) :has(+ *>.StoreSalePriceWidgetContainer){min-width:0;flex-shrink:1}
/* The "Новинка" badge standing in front of the discount is what made the price row overflow in the first place:
   badge + discount + two prices never fit a capsule. It leaves the row and becomes a ribbon pinned to the bottom
   right of the artwork just above the price — Steam's own blue, a pennant notch on the left, a shadow so it reads
   over any cover. Higher than the artwork is out of reach: the price bar declares container-type, which makes it
   the containing block for anything absolute inside it.
   The badge has no class of its own that survives a Steam build, so it is found by shape: it is the first of the
   three children of a discounted widget (badge, discount, prices), or of the two of an undiscounted one. */
html:not(.spc-off) .StoreSalePriceWidgetContainer.Discounted>:first-child:nth-last-child(3),
html:not(.spc-off) .StoreSalePriceWidgetContainer:not(.Discounted)>:first-child:nth-last-child(2){position:absolute;right:0;bottom:calc(100% + 7px);z-index:2;min-width:0;padding:3px 10px 3px 16px;font-size:11px;line-height:13px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#fff;background:linear-gradient(135deg,#43b6ff 0%,#1a76c4 55%,#0d5a9c 100%);box-shadow:0 2px 7px rgba(0,0,0,.6);clip-path:polygon(9px 0,100% 0,100% 100%,9px 100%,0 50%);white-space:nowrap;pointer-events:none}
/* Safety net for any capsule still too narrow for its price: the overflow goes left, over the artwork, instead of
   cutting the price off at the right edge. Measured to change nothing on capsules that already fit. */
html:not(.spc-off) .CapsuleBottomBar{justify-content:flex-end}
/* Cart panel: same shape as Steam's checkout button (its classes are copied onto ours), Steam's green over it. */
.${CART_BTN_CLASS}{background:linear-gradient(to right,#75b022 5%,#588a1b 95%)!important;color:#d2efa9!important;border:none!important;width:100%;margin-bottom:8px}
.${CART_BTN_CLASS}:hover{background:linear-gradient(to right,#8ed629 5%,#6aa621 95%)!important;color:#fff!important}
html:not(.spc-off) .${STRIKE_CLASS}::before{transform:none!important;right:var(${STRIKE_VAR},0px)!important}
/* Both wrappers sit in Steam's black bar, which aligns its children on a text baseline: a wrapper that keeps its
   own 12px strut ends up 36px tall instead of 32 and pushes the whole row down by 2px. Zeroing the strut makes
   every child exactly as tall as its button. */
.game_purchase_action_bg>.${NATIVE_COMPACT_CLASS},.game_purchase_action_bg>.${TOPUP_CLASS}{font-size:0!important;line-height:0!important}
/* Native cart button shrunk to an icon: the text is kept in the DOM (font-size 0, the 30px line box still sets the
   height), the icon is painted over it. Colours follow Steam's green button: #d2efa9 text, white on hover. */
.${NATIVE_COMPACT_CLASS} a>span{position:relative;font-size:0!important;padding:0 9px!important;width:20px;overflow:hidden}
.${NATIVE_COMPACT_CLASS} a>span::before{content:'';position:absolute;left:50%;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23d2efa9' d='M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49A1 1 0 0 0 20 4H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z'/%3E%3C/svg%3E") center/contain no-repeat}
.${NATIVE_COMPACT_CLASS} a:hover>span::before{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23ffffff' d='M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49A1 1 0 0 0 20 4H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z'/%3E%3C/svg%3E")}
.${UI_CLASS}{display:inline-flex;align-items:center;height:25px;margin-right:6px;vertical-align:top}
.${UI_CLASS} select{background:#3d4450;color:#c6d4df;border:1px solid #1b2838;border-radius:3px;font-size:12px;line-height:18px;padding:1px 4px;cursor:pointer;outline:none}
.${UI_CLASS} select:hover{background:#4c5866;color:#fff}
`;
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  function mountHeader(doc, mode, onChange) {
    const host = doc.getElementById("global_actions");
    if (!host || host.querySelector(`.${UI_CLASS}`)) return null;
    const wrap = doc.createElement("div");
    wrap.className = UI_CLASS;
    const select = doc.createElement("select");
    select.title = "Показывать цены (Steam Price Converter)";
    for (const value of MODES) {
      const label = MODE_LABELS[value];
      const opt = doc.createElement("option");
      opt.value = value;
      opt.textContent = label;
      if (value === mode) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => onChange(select.value));
    wrap.appendChild(select);
    host.insertBefore(wrap, host.firstChild);
    return select;
  }

  // core/update.ts
  var RELEASE_REPO = "grozovsky/steam-price-converter";
  var RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
  var RELEASE_ASSET_PREFIX = `https://github.com/${RELEASE_REPO}/releases/download/`;

  // core/index.ts
  function domReady(doc) {
    if (doc.readyState !== "loading") return Promise.resolve();
    return new Promise((resolve) => doc.addEventListener("DOMContentLoaded", () => resolve(), { once: true }));
  }
  async function loadRates(adapter2, preferred) {
    for (const source of sourceChain(preferred)) {
      try {
        const raw = await adapter2.fetchRates(source, false);
        if (!raw) continue;
        const rates = normalizeRates(source, raw.body, raw.fetchedAt);
        if (rates) return rates;
      } catch (err) {
        adapter2.log?.warn("[spc] rates source failed", source, err);
      }
    }
    return null;
  }
  async function loadProviderRates(adapter2, provider, force = false) {
    try {
      const raw = await adapter2.fetchProviderRates(provider.id, force);
      return raw ? provider.parseRates(raw.body, raw.fetchedAt) : null;
    } catch (err) {
      adapter2.log?.warn(`[spc] ${provider.id} rates failed`, err);
      return null;
    }
  }
  var WALLET_POLL_MS = 4e3;
  var SETTINGS_POLL_MS = 5e3;
  async function readWallet(adapter2, doc) {
    let text = null;
    try {
      text = await adapter2.getWallet?.() ?? null;
    } catch (err) {
      adapter2.log?.warn("[spc] wallet read failed", err);
    }
    if (!text) {
      const el = doc.getElementById("header_wallet_balance");
      if (el) text = ownText(el);
    }
    return parseWallet(text);
  }
  function watchPurchase(adapter2, doc, getCtx) {
    if (!adapter2.openTopup) return null;
    if (!isCartPage(doc) && findPurchaseBlocks(doc, getCtx().cur).length === 0) return null;
    const log = adapter2.log ?? console;
    let lastKey = "";
    let inFlight = false;
    const tick = async () => {
      if (inFlight || doc.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const ctx = getCtx();
        if (!ctx) return;
        const wallet = await readWallet(adapter2, doc);
        const shown = applyTopupButtons(doc, {
          cur: ctx.cur,
          wallet,
          provider: ctx.provider,
          providerRates: ctx.providerRates,
          method: ctx.method,
          enabled: ctx.mode !== "off",
          prefills: adapter2.topupPrefills !== false,
          onTopup: (need) => {
            log.info(`[spc] top-up requested to cover ${need} ${ctx.cur.code} (${ctx.provider.id}/${ctx.method})`);
            Promise.resolve(adapter2.openTopup(need, ctx.method)).catch((err) => log.warn("[spc] top-up open failed", err));
          }
        });
        const key = `${wallet?.amount ?? "-"}|${wallet?.cur ?? "-"}|${ctx.method}|${ctx.mode}|${shown}`;
        if (key !== lastKey) {
          lastKey = key;
          log.info(`[spc] wallet ${wallet ? `${wallet.amount} ${wallet.cur}` : "unknown"}, top-up buttons: ${shown}`);
        }
      } catch (err) {
        log.warn("[spc] purchase buttons failed", err);
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = setInterval(tick, WALLET_POLL_MS);
    doc.addEventListener("visibilitychange", () => {
      if (doc.visibilityState === "visible") void tick();
    });
    doc.defaultView?.addEventListener("pagehide", () => clearInterval(timer));
    return () => void tick();
  }
  async function run(adapter2, doc = document) {
    const log = adapter2.log ?? console;
    await domReady(doc);
    if (!doc.body) return;
    const settings = normalizeSettings(await adapter2.getSettings().catch(() => null));
    injectStyle(doc);
    applyMode(doc, settings.mode);
    let ctx = null;
    let refreshPurchase = null;
    let source = settings.source;
    let applied = `${settings.provider}|${settings.galaxy_method}|${settings.source}|${settings.mode}`;
    const onMode = async (mode) => {
      applyMode(doc, mode);
      if (ctx) {
        ctx.mode = mode;
        if (mode === "galaxy" && !ctx.providerRates) ctx.providerRates = await loadProviderRates(adapter2, ctx.provider);
        rerenderAll(doc, ctx);
        refreshPurchase?.();
      }
      applied = `${ctx?.provider.id ?? settings.provider}|${ctx?.method ?? settings.galaxy_method}|${source}|${mode}`;
      await adapter2.setSettings({ mode }).catch((e) => log.warn("[spc] save failed", e));
    };
    const modeSelect = mountHeader(doc, settings.mode, onMode);
    const cur = detectCurrency(settings.store_currency, doc);
    if (!cur) {
      log.info("[spc] no store currency detected on", doc.location?.href);
      return;
    }
    const provider = providerById(settings.provider);
    const [rates, providerRates] = await Promise.all([loadRates(adapter2, settings.source), loadProviderRates(adapter2, provider)]);
    if (!rates && !providerRates) {
      log.warn("[spc] exchange rates unavailable");
      return;
    }
    ctx = { cur, rates, mode: settings.mode, provider, providerRates, method: settings.galaxy_method };
    const n = processTree(doc.body, ctx);
    log.info(`[spc] ${cur.code} → ${settings.mode}, ${n} prices, rates ${rates?.source ?? "-"} ${rates?.date ?? ""}, ${provider.id} ${providerRates ? "ok" : "-"}`);
    observe(doc, () => ctx);
    refreshPurchase = watchPurchase(adapter2, doc, () => ctx);
    const pollSettings = async () => {
      if (!ctx || doc.visibilityState === "hidden") return;
      let next;
      try {
        next = normalizeSettings(await adapter2.getSettings());
      } catch (err) {
        log.warn("[spc] settings re-read failed", err);
        return;
      }
      const key = `${next.provider}|${next.galaxy_method}|${next.source}|${next.mode}`;
      if (key === applied) return;
      applied = key;
      if (next.provider !== ctx.provider.id) {
        ctx.provider = providerById(next.provider);
        ctx.providerRates = await loadProviderRates(adapter2, ctx.provider);
      }
      if (next.source !== source) {
        source = next.source;
        ctx.rates = await loadRates(adapter2, source) ?? ctx.rates;
      }
      ctx.method = next.galaxy_method;
      if (next.mode !== ctx.mode) {
        ctx.mode = next.mode;
        applyMode(doc, next.mode);
        if (modeSelect) modeSelect.value = next.mode;
      }
      rerenderAll(doc, ctx);
      refreshPurchase?.();
      log.info(`[spc] settings changed → ${ctx.provider.id}/${ctx.method}, mode ${ctx.mode}, rates ${source}`);
    };
    const settingsTimer = setInterval(pollSettings, SETTINGS_POLL_MS);
    doc.defaultView?.addEventListener("pagehide", () => clearInterval(settingsTimer));
  }

  // userscript/entry.ts
  var SETTINGS_KEY = "spc.settings";
  var RATES_TTL_MS = 12 * 60 * 60 * 1e3;
  var GALAXY_TTL_MS = 60 * 60 * 1e3;
  var hasGmStore = typeof GM_getValue === "function" && typeof GM_setValue === "function";
  function read(key) {
    try {
      if (hasGmStore) {
        const v2 = GM_getValue(key, null);
        return typeof v2 === "string" ? JSON.parse(v2) : v2 ?? null;
      }
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  }
  function write(key, value) {
    try {
      if (hasGmStore) GM_setValue(key, JSON.stringify(value));
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {
    }
  }
  function request(url, method = "GET", data) {
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method,
          url,
          data,
          timeout: 1e4,
          headers: data ? { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } : { Accept: "*/*" },
          onload: (r) => resolve({ status: r.status, text: r.responseText }),
          onerror: () => reject(new Error("network error")),
          ontimeout: () => reject(new Error("timeout"))
        });
      });
    }
    return fetch(url, { method, body: data, cache: "no-store" }).then(async (res) => ({ status: res.status, text: await res.text() }));
  }
  async function cachedText(key, url, ttl, force) {
    const cached = read(key);
    if (cached && !force && Date.now() - cached.fetchedAt < ttl) return cached;
    try {
      const r = await request(url);
      if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
      const entry = { body: r.text, fetchedAt: Date.now() };
      write(key, entry);
      return entry;
    } catch (err) {
      console.warn("[spc] fetch failed", url, err);
      return cached;
    }
  }
  var adapter = {
    async getSettings() {
      return read(SETTINGS_KEY);
    },
    async setSettings(patch) {
      write(SETTINGS_KEY, { ...read(SETTINGS_KEY) ?? {}, ...patch });
    },
    fetchRates(source, force) {
      return cachedText(`spc.rates.${source}`, SOURCE_URLS[source], RATES_TTL_MS, force);
    },
    // The browser has no backend, so a provider's rates are fetched straight from its home page. A second provider
    // needs its rate URL here (providerById(...).home is only the site itself).
    fetchProviderRates(providerId, force) {
      return cachedText(`spc.provider.${providerId}`, providerById(providerId).home, GALAXY_TTL_MS, force);
    },
    async validateSteamLogin(_providerId, login) {
      try {
        const r = await request(GALAXY_VALIDATE_URL, "POST", `nickname=${encodeURIComponent(login)}`);
        const j = JSON.parse(r.text);
        return typeof j?.success === "boolean" ? j.success : null;
      } catch {
        return null;
      }
    },
    // The browser page has the balance in its own header (core reads #header_wallet_balance), and there is no dialog
    // here: the provider's own site opens in a new tab and the user types the amount themselves — which is why
    // topupPrefills is false, so the button's tooltip spells out the number their form expects.
    openTopup() {
      window.open(GALAXY_HOME, "_blank", "noopener");
    },
    topupPrefills: false,
    log: console
  };
  run(adapter).catch((err) => console.error("[spc]", err));
})();
