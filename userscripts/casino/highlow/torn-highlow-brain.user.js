// ==UserScript==
// @name         Torn High-Low Brain (Bloodawn)
// @namespace    https://github.com/Blood-Dawn/TornCity
// @version      4.1.0
// @description  High-Low helper using tracked deck + EV recursion (High/Low/Cash 50%). Tie modeled as PUSH by default. Strict auto-shuffle detection + draggable overlay + hide-worst/highlight-best.
// @author       Bloodawn
// @match        https://www.torn.com/page.php?sid=highlow*
// @grant        none
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/566026/Torn%20High-Low%20Brain%20%28Bloodawn%29.user.js
// @updateURL https://update.greasyfork.org/scripts/566026/Torn%20High-Low%20Brain%20%28Bloodawn%29.meta.js
// ==/UserScript==

/**
 * (Bloodawn)
 * File: torn-highlow-brain.user.js
 * Purpose: High-Low helper with robust DOM detection, strict shuffle handling, tie-as-push EV model, and draggable overlay.
 */

(function () {
  "use strict";

  /********************
   * Config / storage
   ********************/
  const LS_SETTINGS = "bloodawn_hl_settings_v41";
  const LS_STATE = "bloodawn_hl_state_v41";

  const CARD_VALUES = { "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10, "J": 11, "Q": 12, "K": 13, "A": 14 };
  const VALUE_TO_RANK = Object.fromEntries(Object.entries(CARD_VALUES).map(([k, v]) => [v, k]));

  const DEFAULTS = {
    overlayEnabled: true,
    hideWorstEnabled: true,         // ON => hide worse button; OFF => highlight best
    mode: "profit",                 // profit | merit
    overlayScale: 1.0,
    overlayPos: { left: null, top: null, right: 12, bottom: 12 },

    // Tie handling (logs show tie continues -> default PUSH)
    tieMode: "push",                // push | loss

    // Profit / EV settings
    evDepth: 2,                     // 1..4 recommended
    cashoutEnabled: true,           // allow recommending cash 50% in profit mode
    riskConfidenceCutoff: 0.20,     // used only for warnings/visuals

    // Shuffle / cap
    autoShuffleEnabled: true,
    autoCapEnabled: true,
    capCards: 32,                   // safety cap based on 16 rounds ~ 32 seen
  };

  const settings = loadSettings();
  const state = loadState();

  // Carryover: player reveal becomes next dealer in Torn sometimes
  let pendingCarryoverValue = null;

  // last model rendered
  let lastModel = null;

  /********************
   * DOM helpers
   ********************/
  function $(sel, root = document) { return root.querySelector(sel); }
  function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

  function getCardValueFromText(txt) {
    if (!txt) return null;
    const t = String(txt).trim().toUpperCase();
    return CARD_VALUES[t] ?? null;
  }

  function getCardTextFromCardEl(cardEl) {
    if (!cardEl) return "";
    const rating = cardEl.querySelector("span.rating");
    if (rating && rating.textContent) {
      const t = rating.textContent.trim();
      if (t) return t;
    }
    // fallback: find leaf nodes that look like ranks
    const leaves = $all("*", cardEl).filter(n => n.childElementCount === 0 && n.textContent);
    for (const n of leaves) {
      const t = n.textContent.trim().toUpperCase();
      if (t in CARD_VALUES) return t;
    }
    return "";
  }

  function findHighLowButtons(container) {
    const actions = $(".actions-wrap", container) || container;
    let low = $(".action-btn-wrap.low", actions) || $(".action-btn-wrap.lower", actions);
    let high = $(".action-btn-wrap.high", actions) || $(".action-btn-wrap.higher", actions);

    if (!low || !high) {
      const wraps = $all(".action-btn-wrap", actions);
      for (const w of wraps) {
        const t = (w.textContent || "").trim().toLowerCase();
        if (!low && (t === "low" || t.includes("lower"))) low = w;
        if (!high && (t === "high" || t.includes("higher"))) high = w;
      }
    }

    if (!low || !high) {
      const clicks = $all("button,a", actions);
      for (const b of clicks) {
        const t = (b.textContent || "").trim().toLowerCase();
        if (!low && (t === "low" || t.includes("lower"))) low = b;
        if (!high && (t === "high" || t.includes("higher"))) high = b;
      }
    }

    return { low, high };
  }

  function getClickable(node) {
    if (!node) return null;
    const tag = (node.tagName || "").toLowerCase();
    if (tag === "button" || tag === "a") return node;
    return node.querySelector?.("button,a") || null;
  }

  function findStartButton(container) {
    return $(".action-btn-wrap.startGame", container) || $(".startGame", container);
  }

  function isVisible(el) {
    return !!(el && el.offsetParent !== null);
  }

  function findCashoutButton(container) {
    // best-effort: locate visible element containing cash + half/50
    const nodes = $all("button,a,div,span", container);
    for (const n of nodes) {
      if (!isVisible(n)) continue;
      const t = (n.textContent || "").trim().toLowerCase();
      if (!t) continue;
      if (t.includes("cash") && (t.includes("half") || t.includes("50") || t.includes("take"))) {
        return n;
      }
    }
    return null;
  }

  function parsePercentFromDom(container) {
    // find something like "25%" and return 0.25
    const nodes = $all("*", container).filter(n => n.childElementCount === 0 && n.textContent);
    for (const n of nodes) {
      const t = (n.textContent || "").trim();
      const m = t.match(/(-?\d+(\.\d+)?)\s*%/);
      if (!m) continue;
      const v = Number(m[1]);
      if (!Number.isFinite(v)) continue;
      const dec = (Math.abs(v) > 1) ? (v / 100) : v;
      if (dec > 0 && dec < 1) return dec;
    }
    return null;
  }

  /********************
   * Deck tracking (52-card counts; safety reset at cap)
   ********************/
  function freshCounts() {
    const c = new Uint8Array(15);
    for (let v = 2; v <= 14; v++) c[v] = 4;
    return c;
  }

  function saveState() {
    try {
      localStorage.setItem(LS_STATE, JSON.stringify({
        counts: Array.from(state.counts || []),
        cardsSeen: state.cardsSeen || 0,
        deckKnown: !!state.deckKnown,
        lastDealer: state.lastDealer ?? null,
        lastPlayer: state.lastPlayer ?? null,
      }));
    } catch {}
  }

  function resetDeck(reason) {
    state.counts = freshCounts();
    state.cardsSeen = 0;
    state.deckKnown = true;
    state.lastDealer = null;
    state.lastPlayer = null;
    pendingCarryoverValue = null;
    saveState();
    toast(`Reset: ${reason}`);
  }

  function consumeCard(v) {
    if (v == null) return false;
    if (!state.counts || state.counts.length !== 15) state.counts = freshCounts();

    if ((state.counts[v] || 0) <= 0) {
      state.deckKnown = false;
      saveState();
      toast(`Desync on ${VALUE_TO_RANK[v]}. Hit Reset.`);
      return false;
    }
    state.counts[v]--;
    state.cardsSeen++;
    saveState();
    return true;
  }

  function countsRelativeTo(dealerValue) {
    const c = state.counts;
    let lower = 0, higher = 0, equal = 0, total = 0;
    for (let v = 2; v <= 14; v++) {
      const n = c[v] || 0;
      total += n;
      if (v < dealerValue) lower += n;
      else if (v > dealerValue) higher += n;
      else equal += n;
    }
    return { lower, higher, equal, total };
  }

  /********************
   * EV engine (depth-limited, tie-as-push default)
   ********************/
  function conf(pHigh, pLow) { return Math.abs(pHigh - pLow); }

  function bestImmediatePick(pHigh, pLow) {
    if (pHigh > pLow) return "HIGH";
    if (pLow > pHigh) return "LOW";
    return "TIE";
  }

  function makeKey(counts, dealer, depth, mod, tieMode) {
    // small depth => small memo; string key is fine
    return `${dealer}|${depth}|${mod}|${tieMode}|${Array.from(counts).slice(2).join("")}`;
  }

  function bestEV(counts, dealer, depth, mod, tieMode, memo) {
    // value returned: expected fraction of current pot after following optimal policy,
    // assuming cashout=0.5 is always available (profit mode).
    if (depth <= 0) return 0.5;

    const key = makeKey(counts, dealer, depth, mod, tieMode);
    const cached = memo.get(key);
    if (cached != null) return cached;

    let total = 0;
    for (let v = 2; v <= 14; v++) total += counts[v] || 0;
    if (total <= 0) return 0.5;

    const mul = 1 + mod;

    const evContinue = (chooseHigh) => {
      let ev = 0;
      for (let v = 2; v <= 14; v++) {
        const n = counts[v] || 0;
        if (!n) continue;
        const p = n / total;

        const isWin = chooseHigh ? (v > dealer) : (v < dealer);
        const isTie = (v === dealer);

        if (isWin) {
          counts[v]--;
          const fut = bestEV(counts, v, depth - 1, mod, tieMode, memo);
          counts[v]++;
          ev += p * mul * fut;
        } else if (isTie) {
          if (tieMode === "push") {
            counts[v]--;
            const fut = bestEV(counts, v, depth - 1, mod, tieMode, memo);
            counts[v]++;
            ev += p * fut; // no mul on tie
          } else {
            // tie treated as loss
            ev += 0;
          }
        } else {
          ev += 0; // loss
        }
      }
      return ev;
    };

    const evHigh = evContinue(true);
    const evLow = evContinue(false);

    const best = Math.max(0.5, evHigh, evLow);
    memo.set(key, best);
    return best;
  }

  function recommend(dealerValue, mod, mode) {
    const rel = countsRelativeTo(dealerValue);
    if (rel.total <= 0) {
      const rec = (dealerValue <= 8) ? "HIGH" : "LOW";
      return { rec, used: "fallback", rel, pHigh: 0, pLow: 0, pTie: 0, conf: 0, ev: null };
    }

    const pHigh = rel.higher / rel.total;
    const pLow = rel.lower / rel.total;
    const pTie = rel.equal / rel.total;
    const c = conf(pHigh, pLow);

    // Merit mode: maximize chance-to-win this click
    if (mode === "merit") {
      let rec = bestImmediatePick(pHigh, pLow);
      if (rec === "TIE") rec = (dealerValue <= 8) ? "HIGH" : "LOW";
      return { rec, used: "max-pWin", rel, pHigh, pLow, pTie, conf: c, ev: null };
    }

    // Profit mode: EV (High/Low/Cash)
    const effectiveMod = (Number.isFinite(mod) && mod > 0 && mod < 1) ? mod : 0.25;
    const memo = new Map();

    // compute EV if choose High/Low *now* (depth includes this decision)
    const depth = Math.max(1, Math.min(4, settings.evDepth | 0));
    const countsCopy = state.counts; // we mutate+revert inside bestEV safely

    // EV after choosing HIGH/LOW now is just "continue EV with that choice"
    // implemented by temporarily forcing first decision: we do a one-step roll ourselves, then recurse bestEV.
    const evFirst = (chooseHigh) => {
      let total = 0;
      for (let v = 2; v <= 14; v++) total += countsCopy[v] || 0;
      if (total <= 0) return 0.5;

      const mul = 1 + effectiveMod;
      let ev = 0;

      for (let v = 2; v <= 14; v++) {
        const n = countsCopy[v] || 0;
        if (!n) continue;
        const p = n / total;

        const isWin = chooseHigh ? (v > dealerValue) : (v < dealerValue);
        const isTie = (v === dealerValue);

        if (isWin) {
          countsCopy[v]--;
          const fut = bestEV(countsCopy, v, depth - 1, effectiveMod, settings.tieMode, memo);
          countsCopy[v]++;
          ev += p * mul * fut;
        } else if (isTie) {
          if (settings.tieMode === "push") {
            countsCopy[v]--;
            const fut = bestEV(countsCopy, v, depth - 1, effectiveMod, settings.tieMode, memo);
            countsCopy[v]++;
            ev += p * fut;
          } else {
            ev += 0;
          }
        } else {
          ev += 0;
        }
      }
      return ev;
    };

    const evHigh = evFirst(true);
    const evLow = evFirst(false);
    const evCash = settings.cashoutEnabled ? 0.5 : -1;

    let rec = "HIGH";
    let used = `EV-depth${depth}`;
    let best = evHigh;

    if (evLow > best) { best = evLow; rec = "LOW"; }
    if (evCash >= 0 && evCash > best) { best = evCash; rec = "CASH"; }

    return { rec, used, rel, pHigh, pLow, pTie, conf: c, ev: { evHigh, evLow, evCash, mod: effectiveMod, depth } };
  }

  /********************
   * UI: styles + overlay + draggable
   ********************/
  injectStyleOnce();

  function injectStyleOnce() {
    if (document.getElementById("bloodawn-hl-style")) return;
    const style = document.createElement("style");
    style.id = "bloodawn-hl-style";
    style.textContent = `
      .bloodawn-hl-ui { box-sizing:border-box; }
      .bloodawn-hl-best {
        outline: 2px solid rgba(155,209,255,0.95) !important;
        box-shadow: 0 0 0 2px rgba(155,209,255,0.20), 0 0 14px rgba(155,209,255,0.22) !important;
        border-radius: 10px !important;
      }
      .bloodawn-hl-cash {
        outline: 2px solid rgba(255,210,120,0.95) !important;
        box-shadow: 0 0 0 2px rgba(255,210,120,0.18), 0 0 14px rgba(255,210,120,0.18) !important;
        border-radius: 10px !important;
      }
    `;
    document.head.appendChild(style);
  }

  const overlay = document.createElement("div");
  overlay.className = "bloodawn-hl-ui";
  overlay.style.cssText = [
    "position:fixed",
    "z-index:999999",
    "background:rgba(10,14,20,0.92)",
    "color:#eaf2ff",
    "border:1px solid rgba(120,170,255,0.25)",
    "border-radius:12px",
    "padding:10px 12px",
    "font:12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial",
    "max-width:min(520px, 92vw)",
    `transform:scale(${settings.overlayScale})`,
    "transform-origin:bottom right",
    "display:none",
    "touch-action:none",
    "user-select:none"
  ].join(";");
  document.body.appendChild(overlay);

  function applyOverlayPos() {
    const p = settings.overlayPos || {};
    if (Number.isFinite(p.left) && Number.isFinite(p.top)) {
      overlay.style.left = `${p.left}px`;
      overlay.style.top = `${p.top}px`;
      overlay.style.right = "auto";
      overlay.style.bottom = "auto";
    } else {
      overlay.style.right = `${Number.isFinite(p.right) ? p.right : 12}px`;
      overlay.style.bottom = `${Number.isFinite(p.bottom) ? p.bottom : 12}px`;
      overlay.style.left = "auto";
      overlay.style.top = "auto";
    }
  }
  applyOverlayPos();

  let toastMsg = "";
  function toast(msg) {
    toastMsg = msg;
    renderOverlay(lastModel);
    setTimeout(() => {
      if (toastMsg === msg) {
        toastMsg = "";
        renderOverlay(lastModel);
      }
    }, 2200);
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;" }[c])); }
  function pct(x) { return (x * 100).toFixed(1) + "%"; }
  function btnCss() {
    return [
      "background:rgba(255,255,255,0.10)",
      "border:1px solid rgba(255,255,255,0.16)",
      "color:#eaf2ff",
      "border-radius:8px",
      "padding:5px 8px",
      "cursor:pointer",
    ].join(";");
  }

  function clearHighlights(btns, cashBtn) {
    const nodes = [btns?.low, btns?.high, getClickable(btns?.low), getClickable(btns?.high)].filter(Boolean);
    for (const n of nodes) n.classList.remove("bloodawn-hl-best");
    if (cashBtn) {
      cashBtn.classList.remove("bloodawn-hl-cash");
      getClickable(cashBtn)?.classList.remove("bloodawn-hl-cash");
    }
  }

  function highlightBest(btns, rec) {
    if (!btns || (!btns.low && !btns.high)) return;
    const bestNode = (rec === "HIGH") ? btns.high : btns.low;
    const bestClick = getClickable(bestNode);
    if (bestNode) bestNode.classList.add("bloodawn-hl-best");
    if (bestClick) bestClick.classList.add("bloodawn-hl-best");
  }

  function highlightCash(cashBtn) {
    if (!cashBtn) return;
    cashBtn.classList.add("bloodawn-hl-cash");
    getClickable(cashBtn)?.classList.add("bloodawn-hl-cash");
  }

  function riskLabel(c) {
    if (c < 0.15) return "COINFLIP";
    if (c < 0.30) return "LOW";
    if (c < 0.45) return "MED";
    return "HIGH";
  }

  function renderOverlay(model) {
    if (!settings.overlayEnabled) { overlay.style.display = "none"; return; }
    overlay.style.display = "block";

    const header = `
      <div data-hl="drag" style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;cursor:move;">
        <div><b>High-Low Brain</b> <span style="opacity:.7">v4.1.0</span></div>
        <div style="opacity:.7">${settings.mode.toUpperCase()}</div>
      </div>
      <div style="opacity:.75">
        Deck: ${state.deckKnown ? "KNOWN" : "UNKNOWN"} | Cards since reset: ${state.cardsSeen} | Cap: ${settings.capCards}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
        <button data-act="reset" style="${btnCss()}">Reset Deck</button>
        <button data-act="autoshuf" style="${btnCss()}">Auto-shuffle: ${settings.autoShuffleEnabled ? "ON" : "OFF"}</button>
        <button data-act="autocap" style="${btnCss()}">Auto-cap: ${settings.autoCapEnabled ? "ON" : "OFF"}</button>
        <button data-act="cap" style="${btnCss()}">Cap: ${settings.capCards}</button>
        <button data-act="hide" style="${btnCss()}">Hide-worst: ${settings.hideWorstEnabled ? "ON" : "OFF"}</button>
        <button data-act="mode" style="${btnCss()}">Mode: ${settings.mode.toUpperCase()}</button>
        <button data-act="tie" style="${btnCss()}">Tie: ${settings.tieMode.toUpperCase()}</button>
        <button data-act="depth" style="${btnCss()}">EV depth: ${settings.evDepth}</button>
        <button data-act="resetpos" style="${btnCss()}">Reset pos</button>
      </div>
      <div style="opacity:.75;margin-top:6px;">Hotkeys: Alt+O overlay | Alt+H hide/highlight | Alt+R reset</div>
    `;

    const toast = toastMsg ? `<div style="margin-top:6px;color:#9bd1ff;">${esc(toastMsg)}</div>` : "";

    if (!model) {
      overlay.innerHTML = header + toast;
      return;
    }

    const risk = riskLabel(model.conf);
    const warn = (model.conf < settings.riskConfidenceCutoff) ? `<div style="margin-top:4px;color:rgba(255,210,120,0.95)"><b>LOW EDGE:</b> coinflip zone.</div>` : "";

    const evBlock = (model.ev && settings.mode === "profit") ? `
      <div style="opacity:.9;margin-top:6px;">
        <b>EV (fraction of pot):</b>
        <div>High: ${model.ev.evHigh.toFixed(3)} | Low: ${model.ev.evLow.toFixed(3)} | Cash: ${model.ev.evCash.toFixed(3)}</div>
        <div style="opacity:.8">mod=${(model.ev.mod * 100).toFixed(0)}% | depth=${model.ev.depth} | tie=${settings.tieMode.toUpperCase()}</div>
      </div>
    ` : "";

    overlay.innerHTML = header + `
      <hr style="border:none;border-top:1px solid rgba(255,255,255,0.1);margin:8px 0;">
      <div><b>Dealer:</b> ${esc(model.dealerRank)} <span style="opacity:.7">| CONF ${model.conf.toFixed(2)} (${esc(risk)})</span></div>
      <div style="opacity:.85">Remaining: lower ${model.rel.lower} | higher ${model.rel.higher} | equal ${model.rel.equal} | total ${model.rel.total}</div>

      <div style="margin-top:6px;">
        <div><b>P(win if HIGH):</b> ${pct(model.pHigh)}</div>
        <div><b>P(win if LOW):</b> ${pct(model.pLow)}</div>
        <div><b>P(equal):</b> ${pct(model.pTie)}</div>
      </div>

      <div style="margin-top:6px;">
        <div><b>Pick:</b> <span style="color:#9bd1ff">${esc(model.rec)}</span> <span style="opacity:.7">(${esc(model.used)})</span></div>
        ${warn}
        ${evBlock}
        ${model.domNote ? `<div style="opacity:.8;margin-top:4px">${esc(model.domNote)}</div>` : ""}
      </div>

      ${toast}
    `;
  }

  overlay.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const act = b.getAttribute("data-act");

    if (act === "reset") resetDeck("manual");

    if (act === "autoshuf") { settings.autoShuffleEnabled = !settings.autoShuffleEnabled; saveSettings(); toast(`Auto-shuffle ${settings.autoShuffleEnabled ? "ON" : "OFF"}`); }
    if (act === "autocap") { settings.autoCapEnabled = !settings.autoCapEnabled; saveSettings(); toast(`Auto-cap ${settings.autoCapEnabled ? "ON" : "OFF"}`); }

    if (act === "cap") {
      settings.capCards = (settings.capCards === 32) ? 52 : 32;
      saveSettings();
      toast(`Cap set to ${settings.capCards}`);
    }

    if (act === "hide") { settings.hideWorstEnabled = !settings.hideWorstEnabled; saveSettings(); toast(`Hide-worst ${settings.hideWorstEnabled ? "ON" : "OFF"}`); }

    if (act === "mode") { settings.mode = (settings.mode === "profit") ? "merit" : "profit"; saveSettings(); toast(`Mode ${settings.mode.toUpperCase()}`); }

    if (act === "tie") {
      settings.tieMode = (settings.tieMode === "push") ? "loss" : "push";
      saveSettings();
      toast(`Tie mode ${settings.tieMode.toUpperCase()}`);
    }

    if (act === "depth") {
      settings.evDepth = (settings.evDepth >= 4) ? 1 : (settings.evDepth + 1);
      saveSettings();
      toast(`EV depth ${settings.evDepth}`);
    }

    if (act === "resetpos") {
      settings.overlayPos = { left: null, top: null, right: 12, bottom: 12 };
      saveSettings();
      applyOverlayPos();
      toast("Position reset");
    }
  });

  // draggable
  let dragging = false, dragX = 0, dragY = 0, baseL = 0, baseT = 0, pid = null;

  overlay.addEventListener("pointerdown", (e) => {
    if (!e.target.closest('[data-hl="drag"]')) return;
    dragging = true;
    pid = e.pointerId;
    const r = overlay.getBoundingClientRect();
    dragX = e.clientX; dragY = e.clientY;
    baseL = r.left; baseT = r.top;

    overlay.style.left = `${baseL}px`;
    overlay.style.top = `${baseT}px`;
    overlay.style.right = "auto";
    overlay.style.bottom = "auto";
    overlay.setPointerCapture(pid);
  });

  overlay.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const r = overlay.getBoundingClientRect();
    const dx = e.clientX - dragX;
    const dy = e.clientY - dragY;

    const maxL = Math.max(0, window.innerWidth - r.width);
    const maxT = Math.max(0, window.innerHeight - r.height);

    const nl = Math.max(0, Math.min(maxL, baseL + dx));
    const nt = Math.max(0, Math.min(maxT, baseT + dy));

    overlay.style.left = `${nl}px`;
    overlay.style.top = `${nt}px`;
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    try { overlay.releasePointerCapture(pid); } catch {}

    const r = overlay.getBoundingClientRect();
    settings.overlayPos = { left: Math.round(r.left), top: Math.round(r.top), right: 12, bottom: 12 };
    saveSettings();
  }
  overlay.addEventListener("pointerup", endDrag);
  overlay.addEventListener("pointercancel", endDrag);

  /********************
   * Strict auto-shuffle detection (ignore overlay, ignore “Auto-shuffle”)
   ********************/
  const SHUFFLE_RX = /\b(?:the\s+)?deck\s+(?:has|have|was)\s+(?:been\s+)?(?:re)?shuffl(?:ed|ing)\b/i;
  const BAD_RX = /(auto[-\s]?shuff|deck\s+snapshot|reset\s+deck|hide-worst|mode:\s|risk:\s)/i;

  function isInsideOverlay(node) {
    if (!node || node.nodeType !== 1) return false;
    return !!node.closest?.(".bloodawn-hl-ui");
  }

  function shuffleTextLooksReal(text) {
    if (!text) return false;
    const t = String(text).trim();
    if (!t || t.length > 260) return false;
    if (BAD_RX.test(t)) return false;
    return SHUFFLE_RX.test(t);
  }

  let lastShuffleAt = 0;
  function onShuffleDetected(source, text) {
    if (!settings.autoShuffleEnabled) return;
    const now = Date.now();
    if (now - lastShuffleAt < 1500) return;
    lastShuffleAt = now;
    resetDeck(`auto-shuffle(${source})`);
  }

  function installShuffleObserver() {
    const obs = new MutationObserver((muts) => {
      if (!settings.autoShuffleEnabled) return;
      for (const m of muts) {
        for (const n of (m.addedNodes || [])) {
          if (n.nodeType !== 1) continue;
          if (isInsideOverlay(n)) continue;
          const txt = (n.textContent || "").trim();
          if (shuffleTextLooksReal(txt)) { onShuffleDetected("mut:add", txt); return; }
        }
        if (m.type === "characterData") {
          const host = m.target?.parentElement;
          if (!host || isInsideOverlay(host)) continue;
          const txt = (host.textContent || "").trim();
          if (shuffleTextLooksReal(txt)) { onShuffleDetected("mut:char", txt); return; }
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });

    // light polling for toast frameworks
    setInterval(() => {
      if (!settings.autoShuffleEnabled) return;
      const toastSelectors = [
        "[role='alert']",
        ".toast", ".toast-message", ".notification", ".alert", ".message",
        ".noty_layout", ".noty_bar", ".noty_body", ".noty_text",
      ];
      for (const sel of toastSelectors) {
        const nodes = $all(sel, document);
        for (const n of nodes) {
          if (isInsideOverlay(n)) continue;
          const txt = (n.textContent || "").trim();
          if (shuffleTextLooksReal(txt)) { onShuffleDetected("poll", txt); return; }
        }
      }
    }, 450);
  }

  /********************
   * Main loop
   ********************/
  let rafPending = false;
  function scheduleUpdate() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      updateOnce();
    });
  }

  function updateOnce() {
    const container = $(".highlow-main-wrap");
    if (!container) { renderOverlay(lastModel); return; }

    // cap safety
    if (settings.autoCapEnabled && state.cardsSeen >= settings.capCards) {
      resetDeck(`cap(${settings.capCards})`);
      return;
    }

    const startBtn = findStartButton(container);
    const dealerEl = $(".dealer-card", container);
    const playerEl = $(".you-card", container);

    // If we're on start screen, clear last seen *without resetting deck*
    if (startBtn && isVisible(startBtn)) {
      state.lastDealer = null;
      state.lastPlayer = null;
      pendingCarryoverValue = null;
      saveState();
      renderOverlay(lastModel);
      return;
    }

    if (!dealerEl || !playerEl) { renderOverlay(lastModel); return; }

    const dealerText = getCardTextFromCardEl(dealerEl);
    const playerText = getCardTextFromCardEl(playerEl);

    const dealerVal = getCardValueFromText(dealerText);
    const playerVal = getCardValueFromText(playerText);

    const btns = findHighLowButtons(container);
    const cashBtn = findCashoutButton(container);
    clearHighlights(btns, cashBtn);

    const domNote = (!btns.low || !btns.high) ? "Buttons not found; still computing overlay." : "";

    // Track dealer card reveal (avoid double count on carryover)
    if (dealerVal != null && dealerVal !== state.lastDealer) {
      const isCarry = (pendingCarryoverValue != null && dealerVal === pendingCarryoverValue);
      if (!isCarry) consumeCard(dealerVal);
      pendingCarryoverValue = null;
      state.lastDealer = dealerVal;
      state.lastPlayer = null;
      saveState();
    }

    // Track player reveal
    if (playerVal != null && playerVal !== state.lastPlayer) {
      consumeCard(playerVal);
      state.lastPlayer = playerVal;
      pendingCarryoverValue = playerVal; // can become next dealer
      saveState();
      renderOverlay(lastModel);
      return;
    }

    // Decision phase: dealer visible, player hidden/blank
    if (dealerVal != null && (playerText === "" || playerVal == null)) {
      const mod = parsePercentFromDom(container); // may be null
      const model = recommend(dealerVal, mod, settings.mode);
      model.dealerRank = dealerText.toUpperCase();
      model.domNote = domNote;

      lastModel = model;
      renderOverlay(lastModel);

      // apply UI behavior
      if (btns.low && btns.high) {
        const lowNode = btns.low;
        const highNode = btns.high;

        // show by default
        lowNode.style.display = "";
        highNode.style.display = "";

        if (settings.mode === "profit" && model.rec === "CASH") {
          if (cashBtn) highlightCash(cashBtn);
          // keep both visible; user can still choose
          return;
        }

        if (settings.hideWorstEnabled) {
          if (model.rec === "HIGH") lowNode.style.display = "none";
          else if (model.rec === "LOW") highNode.style.display = "none";
        } else {
          // highlight best pick
          if (model.rec === "HIGH" || model.rec === "LOW") highlightBest(btns, model.rec);
        }
      }

      return;
    }

    renderOverlay(lastModel);
  }

  /********************
   * Hotkeys
   ********************/
  document.addEventListener("keydown", (e) => {
    if (!e.altKey) return;
    const k = (e.key || "").toLowerCase();
    if (k === "o") { settings.overlayEnabled = !settings.overlayEnabled; saveSettings(); toast(`Overlay ${settings.overlayEnabled ? "ON" : "OFF"}`); renderOverlay(lastModel); }
    if (k === "h") { settings.hideWorstEnabled = !settings.hideWorstEnabled; saveSettings(); toast(`Hide-worst ${settings.hideWorstEnabled ? "ON" : "OFF"}`); }
    if (k === "r") { resetDeck("manual"); }
  });

  /********************
   * Boot
   ********************/
  installShuffleObserver();

  const boot = setInterval(() => {
    const container = $(".highlow-main-wrap");
    if (!container) return;

    clearInterval(boot);

    const obs = new MutationObserver(() => scheduleUpdate());
    obs.observe(container, { childList: true, subtree: true, characterData: true });

    scheduleUpdate();
    toast("Loaded. Tie=PUSH (default). Profit uses EV (High/Low/Cash).");
  }, 250);

  /********************
   * Persistence
   ********************/
  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      if (!raw) return { ...DEFAULTS };
      const obj = JSON.parse(raw);
      return { ...DEFAULTS, ...obj, overlayPos: { ...DEFAULTS.overlayPos, ...(obj.overlayPos || {}) } };
    } catch {
      return { ...DEFAULTS };
    }
  }
  function saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch {}
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_STATE);
      if (!raw) return { counts: freshCounts(), cardsSeen: 0, deckKnown: false, lastDealer: null, lastPlayer: null };
      const obj = JSON.parse(raw);

      const c = new Uint8Array(15);
      if (Array.isArray(obj.counts) && obj.counts.length === 15) {
        for (let i = 0; i < 15; i++) c[i] = obj.counts[i] || 0;
      } else {
        for (let v = 2; v <= 14; v++) c[v] = 4;
      }

      return {
        counts: c,
        cardsSeen: obj.cardsSeen || 0,
        deckKnown: !!obj.deckKnown,
        lastDealer: obj.lastDealer ?? null,
        lastPlayer: obj.lastPlayer ?? null,
      };
    } catch {
      return { counts: freshCounts(), cardsSeen: 0, deckKnown: false, lastDealer: null, lastPlayer: null };
    }
  }
})();