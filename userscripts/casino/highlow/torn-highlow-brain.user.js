// ==UserScript==
// @name         Torn High-Low Brain - Profit + Merit (Upgraded)
// @namespace    https://github.com/Blood-Dawn/TornCity
// @version      3.1.0
// @description  Probability overlay + best-pick logic using tracked deck; tie-aware; auto shuffle handling; optional hide-worst.
// @author       Bloodawn
// @match        https://www.torn.com/page.php?sid=highlow*
// @grant        none
// @license      MIT
// ==/UserScript==

/**
 * (Bloodawn)
 * File: torn-highlow-brain.user.js
 * Purpose: High-Low probability overlay + decision engine (profit + merit) with persistent deck tracking.
 */



(function () {
  "use strict";

  /********************
   * Constants & Config
   ********************/
  const LS_SETTINGS = "bloodawn_highlow_settings_v1";
  const LS_STATE = "bloodawn_highlow_state_v1";

  const CARD_VALUES = { "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10, "J": 11, "Q": 12, "K": 13, "A": 14 };
  const VALUE_TO_RANK = Object.fromEntries(Object.entries(CARD_VALUES).map(([k, v]) => [v, k]));

  // Torn High-Low reshuffles after 16 full rounds (32 cards seen). Keep it configurable anyway.
  const DEFAULTS = {
    overlayEnabled: true,
    hideWorstEnabled: true,
    mode: "profit", // "profit" | "merit"
    autoResetOnShuffleText: true,
    autoResetOnCardLimit: true,
    cardLimit: 32,
    // IMPORTANT: deck persists across games; do NOT reset on loss by default.
    resetOnLoss: false,
    // Advanced decision upgrades
    lookaheadTieBreaker: true,
    monteCarloEnabled: false,     // optional heavy mode for close calls
    mcRollouts: 1200,
    mcHorizon: 4,
    mcTriggerEdge: 0.03,          // run MC if |pHigh - pLow| < 3 percentage points
    // UI
    overlayScale: 1.0,
  };

  const settings = loadSettings();

  // State persisted so you can refresh the page without losing your shoe tracking.
  const state = loadState();

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

  // Best-effort: tries to locate pot + modifier text without hardcoding a brittle selector.
  function readPotAndModifier(container) {
    const textBlobs = $all("*", container).map(n => (n && n.childElementCount === 0 ? n.textContent : "")).filter(Boolean);

    // Pot often has a $.
    let pot = null;
    for (const t of textBlobs) {
      if (t.includes("$")) { pot = parseMoney(t); if (pot !== null) break; }
    }

    // Modifier often appears like "23%" somewhere.
    let mod = null;
    for (const t of textBlobs) {
      if (t.includes("%")) { mod = parsePercent(t); if (mod !== null && mod > 0 && mod < 1) break; }
    }

    return { pot, mod };
  }

  /********************
   * Deck tracking
   ********************/
  function freshCounts() {
    // index 0..14, we use 2..14
    const counts = new Uint8Array(15);
    for (let v = 2; v <= 14; v++) counts[v] = 4;
    return counts;
  }

  function resetDeck(reason) {
    state.counts = freshCounts();
    state.cardsSeen = 0;
    state.deckKnown = true;
    state.lastDealer = null;
    state.lastPlayer = null;
    state.lastPot = null;
    state.tieIsPush = true; // default based on community understanding; still auto-validated.
    state.lastOutcome = "reset:" + reason;
    saveState();
    flash(`Deck reset (${reason})`);
  }

  function consumeCard(v) {
    if (v == null) return false;
    if (!state.counts || state.counts.length !== 15) state.counts = freshCounts();

    if (state.counts[v] === 0) {
      // Desync: you "saw" a 5th copy. Mark unknown; keep operating but warn.
      state.deckKnown = false;
      state.lastOutcome = "desync";
      saveState();
      flash(`Desync: saw extra ${VALUE_TO_RANK[v]}. Tracking marked UNKNOWN.`);
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

  function topRanks(filterFn, limit = 3) {
    const arr = [];
    for (let v = 2; v <= 14; v++) {
      const n = state.counts[v] || 0;
      if (n <= 0) continue;
      if (filterFn && !filterFn(v)) continue;
      arr.push({ v, n });
    }
    arr.sort((a, b) => b.n - a.n || b.v - a.v);
    return arr.slice(0, limit).map(x => `${VALUE_TO_RANK[x.v]}(${x.n})`).join(", ");
  }

  /********************
   * Decision engine
   ********************/
  function oneStepLookaheadBestAction(dealerValue) {
    // Tie case only: higher == lower, so immediate pWin ties.
    // We break ties by looking at the expected next-hand "best immediate win chance" assuming you win this hand.
    const { lower, higher, total } = countsRelativeTo(dealerValue);
    if (total <= 0) return "HIGH";
    if (higher !== lower) return higher > lower ? "HIGH" : "LOW";

    const eHigh = expectedNextEdgeIfWin(dealerValue, true);
    const eLow = expectedNextEdgeIfWin(dealerValue, false);
    return (eHigh >= eLow) ? "HIGH" : "LOW";
  }

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

      // simulate removing that next dealer card
      c[v]--;
      const { lower, higher, equal } = countsRelativeTo(v);
      c[v]++;

      // tie is "push" but doesn't increase pot; for next-step edge we care about chance to be correct (win), not just non-loss.
      const pHigh = (higher + equal) ? higher / (lower + higher + equal) : 0;
      const pLow = (lower + equal) ? lower / (lower + higher + equal) : 0;
      const best = Math.max(pHigh, pLow);

      acc += (n / winTotal) * best;
    }
    return acc;
  }

  function monteCarloScoreFirstAction(dealerValue, firstAction, horizon, rollouts, mode, modPct, tieIsPush) {
    // Simulates survival/pot growth starting with firstAction.
    // Subsequent actions use greedy policy (best immediate pWin or EV).
    const baseCounts = state.counts;
    const basePotFactor = 1.0; // we work in multipliers relative to current pot
    const m = (typeof modPct === "number" && modPct > 0 && modPct < 1) ? modPct : 0.25;

    function drawCard(counts) {
      let total = 0;
      for (let v = 2; v <= 14; v++) total += counts[v];
      if (total <= 0) return null;
      let r = Math.floor(Math.random() * total);
      for (let v = 2; v <= 14; v++) {
        const n = counts[v];
        if (r < n) return v;
        r -= n;
      }
      return null;
    }

    function bestGreedyAction(dVal, counts) {
      let lower = 0, higher = 0, equal = counts[dVal] || 0, total = 0;
      for (let v = 2; v <= 14; v++) {
        const n = counts[v] || 0;
        total += n;
        if (v < dVal) lower += n;
        else if (v > dVal) higher += n;
      }
      if (total <= 0) return "HIGH";
      const pHighWin = higher / total;
      const pLowWin = lower / total;
      if (mode === "merit") return (pHighWin >= pLowWin) ? "HIGH" : "LOW";

      // profit: same ordering unless you want to penalize ties; keep it simple EV
      const pTie = equal / total;
      const highEV = pHighWin * (1 + m) + (tieIsPush ? pTie : 0);
      const lowEV  = pLowWin  * (1 + m) + (tieIsPush ? pTie : 0);
      return (highEV >= lowEV) ? "HIGH" : "LOW";
    }

    let sum = 0;
    for (let i = 0; i < rollouts; i++) {
      const counts = new Uint8Array(baseCounts); // copy
      let potFactor = basePotFactor;
      let d = dealerValue;

      // remove current dealer from counts only if it still exists (we track it separately in real game)
      // In real tracking, dealer card is already consumed when revealed. Here we assume it's already consumed.
      // So do nothing.

      let alive = true;
      for (let step = 0; step < horizon; step++) {
        const act = (step === 0) ? firstAction : bestGreedyAction(d, counts);

        const next = drawCard(counts);
        if (next == null) { break; }
        counts[next]--;

        if (next === d) {
          // tie
          if (!tieIsPush) { alive = false; potFactor = 0; break; }
          // push: pot unchanged, dealer becomes that card
          d = next;
          continue;
        }

        const win = (act === "HIGH") ? (next > d) : (next < d);
        if (win) {
          potFactor *= (1 + m);
          d = next;
        } else {
          alive = false;
          potFactor = 0;
          break;
        }
      }

      // merit objective = survival probability; profit objective = expected pot factor
      sum += (mode === "merit") ? (alive ? 1 : 0) : potFactor;
    }
    return sum / rollouts;
  }

  function decide(dealerValue, modPct) {
    const { lower, higher, equal, total } = countsRelativeTo(dealerValue);
    if (total <= 0) return { rec: "HIGH", pHigh: 0, pLow: 0, pTie: 0, edge: 0, used: "fallback" };

    const pHigh = higher / total;
    const pLow = lower / total;
    const pTie = equal / total;

    // Base recommendation (max pWin)
    let rec = (pHigh > pLow) ? "HIGH" : (pLow > pHigh) ? "LOW" : "TIE";

    // Tie-breaker
    let used = "max-pWin";
    if (rec === "TIE") {
      if (settings.lookaheadTieBreaker) {
        rec = oneStepLookaheadBestAction(dealerValue);
        used = "lookahead";
      } else {
        rec = (dealerValue <= 8) ? "HIGH" : "LOW";
        used = "midpoint";
      }
    }

    // Optional Monte Carlo for close calls
    const edge = Math.abs(pHigh - pLow);
    if (settings.monteCarloEnabled && edge < settings.mcTriggerEdge) {
      const tieIsPush = !!state.tieIsPush;
      const sHigh = monteCarloScoreFirstAction(dealerValue, "HIGH", settings.mcHorizon, settings.mcRollouts, settings.mode, modPct, tieIsPush);
      const sLow  = monteCarloScoreFirstAction(dealerValue, "LOW",  settings.mcHorizon, settings.mcRollouts, settings.mode, modPct, tieIsPush);
      rec = (sHigh >= sLow) ? "HIGH" : "LOW";
      used = `MC(${settings.mcRollouts}x,h${settings.mcHorizon})`;
    }

    return { rec, pHigh, pLow, pTie, edge, used };
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
    "max-width:360px",
    `transform:scale(${settings.overlayScale})`,
    "transform-origin:bottom right",
    "display:none",
  ].join(";");
  document.body.appendChild(overlay);

  function pct(x) { return (x * 100).toFixed(1) + "%"; }
  function flash(msg) {
    // quick toast inside overlay
    state.toast = msg;
    setTimeout(() => { if (state.toast === msg) { state.toast = ""; renderOverlay(null); } }, 2200);
    renderOverlay(null);
  }

  function renderOverlay(model) {
    if (!settings.overlayEnabled) {
      overlay.style.display = "none";
      return;
    }
    overlay.style.display = "block";

    const deckStatus = state.deckKnown ? "KNOWN" : "UNKNOWN";
    const tieMode = state.tieIsPush ? "PUSH" : "LOSS?";
    const toast = state.toast ? `<div style="margin-top:6px;color:#9bd1ff;">${escapeHtml(state.toast)}</div>` : "";

    const header = `
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;">
        <div><b>High-Low Brain</b> <span style="opacity:.7">v3.1.0</span></div>
        <div style="opacity:.7">${settings.mode.toUpperCase()}</div>
      </div>
      <div style="opacity:.75">Deck: ${deckStatus} | Cards since shuffle: ${state.cardsSeen}/${settings.cardLimit} | Tie: ${tieMode}</div>
      <div style="opacity:.75">Hotkeys: Alt+O overlay | Alt+H hide | Alt+R reset | Alt+M mode</div>
    `;

    if (!model) {
      overlay.innerHTML = header + toast;
      return;
    }

    const { dealerRank, lower, higher, equal, total, pHigh, pLow, pTie, rec, used, modPct, pot, profitHint } = model;

    overlay.innerHTML = header + `
      <hr style="border:none;border-top:1px solid rgba(255,255,255,0.1);margin:8px 0;">
      <div><b>Dealer:</b> ${dealerRank}</div>
      <div style="opacity:.85">Remaining: lower ${lower} | higher ${higher} | equal ${equal} | total ${total}</div>

      <div style="margin-top:6px;">
        <div><b>P(win if HIGH):</b> ${pct(pHigh)}</div>
        <div><b>P(win if LOW):</b> ${pct(pLow)}</div>
        <div><b>P(tie):</b> ${pct(pTie)} (no pot increase)</div>
      </div>

      <div style="margin-top:6px;">
        <div><b>Recommend:</b> <span style="color:#9bd1ff">${rec}</span> <span style="opacity:.7">(${used})</span></div>
        <div style="opacity:.8">Most likely next: ${topRanks(null, 3) || "n/a"}</div>
        <div style="opacity:.8">If HIGH wins: ${topRanks(v => v > CARD_VALUES[dealerRank], 3) || "n/a"}</div>
        <div style="opacity:.8">If LOW wins: ${topRanks(v => v < CARD_VALUES[dealerRank], 3) || "n/a"}</div>
      </div>

      <div style="margin-top:6px;opacity:.85">
        <div><b>Modifier:</b> ${modPct != null ? pct(modPct) : "n/a"} | <b>Pot:</b> ${pot != null ? "$" + pot.toLocaleString() : "n/a"}</div>
        ${profitHint ? `<div><b>Profit hint:</b> ${profitHint}</div>` : ""}
      </div>

      ${toast}
    `;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[c]));
  }

  /********************
   * Game loop (DOM observation)
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

    const candidates = [
      $(".game-result-wrap", container),
      container,
      document.body
    ].filter(Boolean);

    for (const node of candidates) {
      const t = (node.textContent || "").toLowerCase();
      if (t.includes("deck") && (t.includes("shuffle") || t.includes("reshuffle") || t.includes("shuffled") || t.includes("reshuffled"))) {
        return true;
      }
    }
    return false;
  }

  function detectLoss(container) {
    const result = $(".game-result-wrap", container);
    const t = (result?.textContent || "").toLowerCase();
    if (!t) return false;
    if (t.includes("lost") || t.includes("lose") || t.includes("incorrect")) return true;
    return false;
  }

  function updateTieModeOnReveal(dealerValue, playerValue, container) {
    if (dealerValue == null || playerValue == null) return;
    if (dealerValue !== playerValue) return;

    // Tie observed. Determine whether it's a push by watching for end-state signals.
    // If the game immediately ends or pot resets, treat as not-push.
    const { pot } = readPotAndModifier(container);

    // If loss screen shows up after tie, it's not a push.
    const tieLooksLikeLoss = detectLoss(container);

    if (tieLooksLikeLoss) {
      state.tieIsPush = false;
    } else {
      // if pot remains same (or non-zero) and game continues, it is likely a push.
      // (we keep the default of push).
      state.tieIsPush = true;
    }
    saveState();
  }

  function profitStopHint(pWin, pTie, modPct, pot) {
    if (settings.mode !== "profit") return null;
    if (pot == null || modPct == null) return null;

    const m = modPct;
    const tieIsPush = !!state.tieIsPush;

    // EV if you play this hand (relative to current pot), assuming you pick the best side:
    // EV = pWin*(1+m) + pTie*(tieIsPush?1:0)
    const evFactor = (pWin * (1 + m)) + (tieIsPush ? pTie : 0);

    // Torn: cash out after seeing dealer gives 50% pot.
    const halfCash = 0.5;

    // if EV is below half cash, suggest taking half rather than playing the hand.
    if (evFactor < halfCash) return `EV ${evFactor.toFixed(3)}x < 0.500x, consider HALF-CASH`;
    return `EV ${evFactor.toFixed(3)}x vs 0.500x half-cash`;
  }

  function updateOnce() {
    const container = $(".highlow-main-wrap");
    if (!container) return;

    // Auto reset: shuffle text
    if (detectShuffleText(container)) {
      resetDeck("shuffle-text");
      return;
    }

    // Auto reset: card limit
    if (settings.autoResetOnCardLimit && state.cardsSeen >= settings.cardLimit) {
      // When we hit the known reshuffle threshold, reset so the next card is treated as fresh-shoe.
      resetDeck(`card-limit(${settings.cardLimit})`);
      // continue; (still render)
    }

    const dealerEl = $(".dealer-card span.rating", container);
    const playerEl = $(".you-card span.rating", container);
    const lowBtnWrap = $(".actions-wrap .action-btn-wrap.low", container);
    const highBtnWrap = $(".actions-wrap .action-btn-wrap.high", container);

    if (!dealerEl || !playerEl || !lowBtnWrap || !highBtnWrap) {
      renderOverlay(null);
      return;
    }

    const dealerText = (dealerEl.textContent || "").trim();
    const playerText = (playerEl.textContent || "").trim();

    const dealerValue = getCardValueFromText(dealerText);
    const playerValue = getCardValueFromText(playerText);

    // Track dealer changes
    if (dealerValue != null && dealerValue !== state.lastDealer) {
      // Consume dealer card once per change
      consumeCard(dealerValue);
      state.lastDealer = dealerValue;
      state.lastPlayer = null; // reset player tracking for this round
      saveState();
    }

    // Player revealed
    if (playerValue != null && playerValue !== state.lastPlayer) {
      consumeCard(playerValue);
      updateTieModeOnReveal(state.lastDealer, playerValue, container);
      state.lastPlayer = playerValue;
      saveState();

      // On reveal, hide buttons (choice already made)
      lowBtnWrap.style.display = "none";
      highBtnWrap.style.display = "none";

      // Loss handling: do NOT reset deck by default (deck persists across games)
      if (settings.resetOnLoss && detectLoss(container)) {
        resetDeck("loss");
      }
      renderOverlay(null);
      return;
    }

    // Decision point: player hidden, dealer shown
    if (dealerValue != null && playerText === "") {
      const { pot, mod } = readPotAndModifier(container);
      const rel = countsRelativeTo(dealerValue);
      const d = decide(dealerValue, mod);

      // Hide-worst UX
      if (settings.hideWorstEnabled) {
        if (d.rec === "HIGH") {
          lowBtnWrap.style.display = "none";
          highBtnWrap.style.display = "";
        } else if (d.rec === "LOW") {
          highBtnWrap.style.display = "none";
          lowBtnWrap.style.display = "";
        } else {
          // if somehow unresolved
          lowBtnWrap.style.display = "";
          highBtnWrap.style.display = "";
        }
      } else {
        lowBtnWrap.style.display = "";
        highBtnWrap.style.display = "";
      }

      const bestPWin = Math.max(d.pHigh, d.pLow);
      const profitHint = profitStopHint(bestPWin, d.pTie, mod, pot);

      renderOverlay({
        dealerRank: dealerText.toUpperCase(),
        lower: rel.lower, higher: rel.higher, equal: rel.equal, total: rel.total,
        pHigh: d.pHigh, pLow: d.pLow, pTie: d.pTie,
        rec: d.rec, used: d.used,
        modPct: mod, pot,
        profitHint,
      });
      return;
    }

    // No dealer yet or between states
    lowBtnWrap.style.display = "none";
    highBtnWrap.style.display = "none";
    renderOverlay(null);
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
      renderOverlay(null);
    } else if (k === "h") {
      settings.hideWorstEnabled = !settings.hideWorstEnabled;
      saveSettings();
      flash(`Hide-worst ${settings.hideWorstEnabled ? "ON" : "OFF"}`);
    } else if (k === "r") {
      resetDeck("manual");
    } else if (k === "m") {
      settings.mode = (settings.mode === "profit") ? "merit" : "profit";
      saveSettings();
      flash(`Mode: ${settings.mode.toUpperCase()}`);
    }
  });

  /********************
   * Init
   ********************/
  function waitForGame() {
    const container = $(".highlow-main-wrap");
    if (!container) return false;
    return true;
  }

  function start() {
    if (!state.counts || state.counts.length !== 15) {
      state.counts = freshCounts();
      state.deckKnown = false; // until first shuffle/reset
      state.cardsSeen = 0;
      state.tieIsPush = true;
      saveState();
    }

    // MutationObserver for fast updates
    const container = $(".highlow-main-wrap");
    if (!container) return;

    const obs = new MutationObserver(() => scheduleUpdate());
    obs.observe(container, { childList: true, subtree: true, characterData: true });

    // Initial paint
    scheduleUpdate();
    flash("Tracking loaded (Alt+R to reset if needed)");
  }

  const boot = setInterval(() => {
    if (waitForGame()) {
      clearInterval(boot);
      start();
    }
  }, 250);

  /********************
   * Persistence
   ********************/
  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      if (!raw) return { ...DEFAULTS };
      const obj = JSON.parse(raw);
      return { ...DEFAULTS, ...obj };
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
          lastPot: null,
          lastOutcome: "",
          toast: "",
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
        tieIsPush: obj.tieIsPush !== false, // default true
        lastDealer: obj.lastDealer ?? null,
        lastPlayer: obj.lastPlayer ?? null,
        lastPot: obj.lastPot ?? null,
        lastOutcome: obj.lastOutcome || "",
        toast: "",
      };
    } catch {
      return {
        counts: freshCounts(),
        cardsSeen: 0,
        deckKnown: false,
        tieIsPush: true,
        lastDealer: null,
        lastPlayer: null,
        lastPot: null,
        lastOutcome: "",
        toast: "",
      };
    }
  }

  function saveState() {
    try {
      localStorage.setItem(LS_STATE, JSON.stringify({
        counts: Array.from(state.counts || []),
        cardsSeen: state.cardsSeen || 0,
        deckKnown: !!state.deckKnown,
        tieIsPush: !!state.tieIsPush,
        lastDealer: state.lastDealer,
        lastPlayer: state.lastPlayer,
        lastPot: state.lastPot,
        lastOutcome: state.lastOutcome || "",
      }));
    } catch {}
  }
})();
