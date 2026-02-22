// ==UserScript==
// @name         Torn High-Low Brain (Bloodawn) - Profit + Merit (DOM Fix)
// @namespace    https://github.com/Blood-Dawn/TornCity
// @version      3.1.2
// @description  Probability overlay + suggests High/Low using tracked deck; robust button detection; optional hide-worst; shuffle/desync reset.
// @author       Bloodawn
// @match        https://www.torn.com/page.php?sid=highlow*
// @grant        none
// @license      MIT
// ==/UserScript==

/**
 * (Bloodawn)
 * File: torn-highlow-brain.user.js
 * Purpose: High-Low probability overlay + suggestion engine (profit + merit), robust DOM selectors.
 */

(function () {
  "use strict";

  /********************
   * Storage keys
   ********************/
  const LS_SETTINGS = "bloodawn_highlow_settings_v2";
  const LS_STATE = "bloodawn_highlow_state_v2";

  /********************
   * Card mapping
   ********************/
  const CARD_VALUES = { "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10, "J": 11, "Q": 12, "K": 13, "A": 14 };
  const VALUE_TO_RANK = Object.fromEntries(Object.entries(CARD_VALUES).map(([k, v]) => [v, k]));

  /********************
   * Defaults
   ********************/
  const DEFAULTS = {
    overlayEnabled: true,
    hideWorstEnabled: true,
    mode: "profit", // profit | merit
    lookaheadTieBreaker: true,
    // Resets
    autoResetOnShuffleText: true,
    autoResetOnCardLimit: true,
    cardLimit: 32,              // conservative reshuffle heuristic
    autoResetOnLoss: false,     // optional (toggle with Alt+L)
    // UI
    overlayScale: 1.0,
  };

  const settings = loadSettings();
  const state = loadState();

  // Keeps the last computed decision visible on results screens
  let lastDecisionModel = null;

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
    // primary
    const rating = cardEl.querySelector("span.rating");
    if (rating && rating.textContent != null) {
      const t = rating.textContent.trim();
      if (t) return t;
    }
    // fallback: find any leaf text that matches a rank
    const leaves = $all("*", cardEl).filter(n => n.childElementCount === 0 && n.textContent);
    for (const n of leaves) {
      const t = n.textContent.trim().toUpperCase();
      if (t in CARD_VALUES) return t;
    }
    return "";
  }

  function parseMoney(str) {
    if (!str) return null;
    const s = String(str).replace(/,/g, "");
    const m = s.match(/\$?\s*([0-9]+(\.[0-9]+)?)/);
    if (!m) return null;
    return Number(m[1]);
  }

  function parsePercent(str) {
    if (!str) return null;
    const m = String(str).match(/(-?\d+(\.\d+)?)\s*%/);
    if (!m) return null;
    return Number(m[1]) / 100;
  }

  function readPotAndModifier(container) {
    // best-effort scraping
    const textBlobs = $all("*", container)
      .filter(n => n.childElementCount === 0 && n.textContent)
      .map(n => n.textContent)
      .filter(Boolean);

    let pot = null;
    for (const t of textBlobs) {
      if (t.includes("$")) { pot = parseMoney(t); if (pot != null) break; }
    }

    let mod = null;
    for (const t of textBlobs) {
      if (t.includes("%")) { mod = parsePercent(t); if (mod != null && mod > 0 && mod < 1) break; }
    }

    return { pot, mod };
  }

  /********************
   * Robust action button detection
   ********************/
  function findHighLowButtons(container) {
    const actions = $(".actions-wrap", container) || container;

    // 1) try known class patterns
    let lowWrap = $(".action-btn-wrap.low", actions) || $(".action-btn-wrap.lower", actions);
    let highWrap = $(".action-btn-wrap.high", actions) || $(".action-btn-wrap.higher", actions);

    // 2) scan action button wrappers by text
    if (!lowWrap || !highWrap) {
      const wraps = $all(".action-btn-wrap", actions);
      for (const w of wraps) {
        const t = (w.textContent || "").trim().toLowerCase();
        if (!lowWrap && (t === "low" || t.includes("lower"))) lowWrap = w;
        if (!highWrap && (t === "high" || t.includes("higher"))) highWrap = w;
      }
    }

    // 3) fallback: scan actual buttons/links by text (some layouts skip wrapper classes)
    if (!lowWrap || !highWrap) {
      const clicks = $all("button,a", actions);
      for (const b of clicks) {
        const t = (b.textContent || "").trim().toLowerCase();
        if (!lowWrap && (t === "low" || t.includes("lower"))) lowWrap = b;
        if (!highWrap && (t === "high" || t.includes("higher"))) highWrap = b;
      }
    }

    return { low: lowWrap, high: highWrap };
  }

  /********************
   * Deck tracking
   ********************/
  function freshCounts() {
    const counts = new Uint8Array(15);
    for (let v = 2; v <= 14; v++) counts[v] = 4;
    return counts;
  }

  function saveState() {
    try {
      localStorage.setItem(LS_STATE, JSON.stringify({
        counts: Array.from(state.counts || []),
        cardsSeen: state.cardsSeen || 0,
        deckKnown: !!state.deckKnown,
        tieIsPush: !!state.tieIsPush,
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
    saveState();
    flash(`Reset: ${reason}`);
  }

  function consumeCard(v) {
    if (v == null) return false;
    if (!state.counts || state.counts.length !== 15) state.counts = freshCounts();

    if (state.counts[v] === 0) {
      state.deckKnown = false;
      saveState();
      flash(`Desync: extra ${VALUE_TO_RANK[v]} seen. Alt+R to reset.`);
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
   * Decision engine
   ********************/
  function expectedNextEdgeIfWin(dealerValue, chooseHigh) {
    const c = state.counts;
    let winTotal = 0;

    for (let v = 2; v <= 14; v++) {
      const n = c[v] || 0;
      if (!n) continue;
      if (chooseHigh ? (v > dealerValue) : (v < dealerValue)) winTotal += n;
    }
    if (!winTotal) return 0;

    let acc = 0;
    for (let v = 2; v <= 14; v++) {
      const n = c[v] || 0;
      if (!n) continue;
      if (!(chooseHigh ? (v > dealerValue) : (v < dealerValue))) continue;

      c[v]--;
      const rel = countsRelativeTo(v);
      c[v]++;

      const bestNext = (rel.total > 0) ? Math.max(rel.higher, rel.lower) / rel.total : 0;
      acc += (n / winTotal) * bestNext;
    }
    return acc;
  }

  function decide(dealerValue) {
    const rel = countsRelativeTo(dealerValue);
    if (rel.total <= 0) return { rec: "HIGH", pHigh: 0, pLow: 0, pTie: 0, used: "fallback", rel };

    const pHigh = rel.higher / rel.total;
    const pLow = rel.lower / rel.total;
    const pTie = rel.equal / rel.total;

    let rec = (pHigh > pLow) ? "HIGH" : (pLow > pHigh) ? "LOW" : "TIE";
    let used = "max-pWin";

    if (rec === "TIE") {
      if (settings.lookaheadTieBreaker) {
        const eHigh = expectedNextEdgeIfWin(dealerValue, true);
        const eLow = expectedNextEdgeIfWin(dealerValue, false);
        rec = (eHigh >= eLow) ? "HIGH" : "LOW";
        used = "lookahead";
      } else {
        rec = (dealerValue <= 8) ? "HIGH" : "LOW";
        used = "midpoint";
      }
    }

    return { rec, pHigh, pLow, pTie, used, rel };
  }

  /********************
   * Overlay UI
   ********************/
  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:fixed",
    "right:12px",
    "bottom:12px",
    "z-index:999999",
    "background:rgba(10,14,20,0.92)",
    "color:#eaf2ff",
    "border:1px solid rgba(120,170,255,0.25)",
    "border-radius:12px",
    "padding:10px 12px",
    "font:12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial",
    "max-width:380px",
    `transform:scale(${settings.overlayScale})`,
    "transform-origin:bottom right",
    "display:none",
  ].join(";");
  document.body.appendChild(overlay);

  let toastMsg = "";
  function flash(msg) {
    toastMsg = msg;
    renderOverlay(lastDecisionModel);
    setTimeout(() => { if (toastMsg === msg) { toastMsg = ""; renderOverlay(lastDecisionModel); } }, 2200);
  }
  function pct(x) { return (x * 100).toFixed(1) + "%"; }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;" }[c])); }

  function renderOverlay(model) {
    if (!settings.overlayEnabled) { overlay.style.display = "none"; return; }
    overlay.style.display = "block";

    const header = `
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;">
        <div><b>High-Low Brain</b> <span style="opacity:.7">v3.1.2</span></div>
        <div style="opacity:.7">${settings.mode.toUpperCase()}</div>
      </div>
      <div style="opacity:.75">Deck: ${state.deckKnown ? "KNOWN" : "UNKNOWN"} | Cards since reset: ${state.cardsSeen}/${settings.cardLimit}</div>
      <div style="opacity:.75">Hotkeys: Alt+O overlay | Alt+H hide | Alt+R reset | Alt+M mode | Alt+L loss-reset</div>
    `;

    const toast = toastMsg ? `<div style="margin-top:6px;color:#9bd1ff;">${esc(toastMsg)}</div>` : "";

    if (!model) {
      overlay.innerHTML = header + toast;
      return;
    }

    overlay.innerHTML = header + `
      <hr style="border:none;border-top:1px solid rgba(255,255,255,0.1);margin:8px 0;">
      <div><b>Dealer:</b> ${esc(model.dealerRank)}</div>
      <div style="opacity:.85">Remaining: lower ${model.rel.lower} | higher ${model.rel.higher} | equal ${model.rel.equal} | total ${model.rel.total}</div>

      <div style="margin-top:6px;">
        <div><b>P(win if HIGH):</b> ${pct(model.pHigh)}</div>
        <div><b>P(win if LOW):</b> ${pct(model.pLow)}</div>
        <div><b>P(tie):</b> ${pct(model.pTie)}</div>
      </div>

      <div style="margin-top:6px;">
        <div><b>Pick:</b> <span style="color:#9bd1ff">${esc(model.rec)}</span> <span style="opacity:.7">(${esc(model.used)})</span></div>
        ${model.domNote ? `<div style="opacity:.8">${esc(model.domNote)}</div>` : ""}
      </div>

      ${toast}
    `;
  }

  /********************
   * Update loop
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

  function detectShuffleText(container) {
    if (!settings.autoResetOnShuffleText) return false;
    const t = (container.textContent || "").toLowerCase();
    return (t.includes("deck") && (t.includes("shuffle") || t.includes("shuffled") || t.includes("reshuffle") || t.includes("reshuffled")));
  }

  function detectLoss(container) {
    const wrap = $(".game-result-wrap", container);
    const t = (wrap?.textContent || "").toLowerCase();
    return (t.includes("lost") || t.includes("lose") || t.includes("incorrect"));
  }

  function updateOnce() {
    const container = $(".highlow-main-wrap");
    if (!container) { renderOverlay(lastDecisionModel); return; }

    if (detectShuffleText(container)) {
      resetDeck("shuffle-text");
      return;
    }

    if (settings.autoResetOnCardLimit && state.cardsSeen >= settings.cardLimit) {
      resetDeck(`card-limit(${settings.cardLimit})`);
      // continue (still compute)
    }

    const dealerCardEl = $(".dealer-card", container);
    const playerCardEl = $(".you-card", container);
    if (!dealerCardEl || !playerCardEl) { renderOverlay(lastDecisionModel); return; }

    const dealerText = getCardTextFromCardEl(dealerCardEl);
    const playerText = getCardTextFromCardEl(playerCardEl);

    const dealerValue = getCardValueFromText(dealerText);
    const playerValue = getCardValueFromText(playerText);

    // Always try to locate action buttons, but never require them to compute probabilities
    const btns = findHighLowButtons(container);
    const domNote = (!btns.low || !btns.high) ? "Note: could not detect Lower/Higher nodes (overlay still computed)" : "";

    // Track dealer reveal
    if (dealerValue != null && dealerValue !== state.lastDealer) {
      consumeCard(dealerValue);
      state.lastDealer = dealerValue;
      state.lastPlayer = null;
      saveState();
    }

    // Track player reveal (results screen)
    if (playerValue != null && playerValue !== state.lastPlayer) {
      consumeCard(playerValue);
      state.lastPlayer = playerValue;
      saveState();

      if (settings.autoResetOnLoss && detectLoss(container)) {
        resetDeck("loss");
      }

      renderOverlay(lastDecisionModel);
      return;
    }

    // Decision point: dealer known, player hidden (playerValue null)
    if (dealerValue != null && playerValue == null) {
      const d = decide(dealerValue);

      // Save + show model
      lastDecisionModel = {
        dealerRank: dealerText.toUpperCase(),
        pHigh: d.pHigh,
        pLow: d.pLow,
        pTie: d.pTie,
        rec: d.rec,
        used: d.used,
        rel: d.rel,
        domNote,
      };
      renderOverlay(lastDecisionModel);

      // Hide-worst only if we found buttons
      if (settings.hideWorstEnabled && btns.low && btns.high) {
        if (d.rec === "HIGH") {
          btns.low.style.display = "none";
          btns.high.style.display = "";
        } else if (d.rec === "LOW") {
          btns.high.style.display = "none";
          btns.low.style.display = "";
        } else {
          btns.low.style.display = "";
          btns.high.style.display = "";
        }
      } else if (btns.low && btns.high) {
        btns.low.style.display = "";
        btns.high.style.display = "";
      }

      return;
    }

    // Otherwise: show last known decision if any
    renderOverlay(lastDecisionModel);
  }

  /********************
   * Hotkeys
   ********************/
  document.addEventListener("keydown", (e) => {
    if (!e.altKey) return;
    const k = (e.key || "").toLowerCase();

    if (k === "o") {
      settings.overlayEnabled = !settings.overlayEnabled;
      saveSettings();
      flash(`Overlay ${settings.overlayEnabled ? "ON" : "OFF"}`);
      renderOverlay(lastDecisionModel);
    } else if (k === "h") {
      settings.hideWorstEnabled = !settings.hideWorstEnabled;
      saveSettings();
      flash(`Hide-worst ${settings.hideWorstEnabled ? "ON" : "OFF"}`);
    } else if (k === "r") {
      resetDeck("manual");
    } else if (k === "m") {
      settings.mode = (settings.mode === "profit") ? "merit" : "profit";
      saveSettings();
      flash(`Mode ${settings.mode.toUpperCase()}`);
    } else if (k === "l") {
      settings.autoResetOnLoss = !settings.autoResetOnLoss;
      saveSettings();
      flash(`Auto-reset on loss ${settings.autoResetOnLoss ? "ON" : "OFF"}`);
    }
  });

  /********************
   * Init
   ********************/
  const overlayBoot = setInterval(() => {
    const container = $(".highlow-main-wrap");
    if (!container) return;

    clearInterval(overlayBoot);

    const obs = new MutationObserver(() => scheduleUpdate());
    obs.observe(container, { childList: true, subtree: true, characterData: true });

    // initial
    scheduleUpdate();
    flash("Loaded. If odds missing: Alt+R reset.");
  }, 250);

  /********************
   * Persistence
   ********************/
  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      if (!raw) return { ...DEFAULTS };
      return { ...DEFAULTS, ...JSON.parse(raw) };
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
      if (!raw) {
        return {
          counts: freshCounts(),
          cardsSeen: 0,
          deckKnown: false,
          tieIsPush: true,
          lastDealer: null,
          lastPlayer: null,
        };
      }
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
        tieIsPush: obj.tieIsPush !== false,
        lastDealer: obj.lastDealer ?? null,
        lastPlayer: obj.lastPlayer ?? null,
      };
    } catch {
      return {
        counts: freshCounts(),
        cardsSeen: 0,
        deckKnown: false,
        tieIsPush: true,
        lastDealer: null,
        lastPlayer: null,
      };
    }
  }
})();