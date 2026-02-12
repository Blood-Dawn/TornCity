// ==UserScript==
// @name         Torn High-Low Brain (Overlay + Profit)
// @namespace    https://github.com/Blood-Dawn/TornCity
// @version      3.0.0
// @description  Probability-based helper for Torn Casino High-Low. Shows overlay + suggests High/Low (and optional Hide-worst mode).
// @author       Bloodawn
// @match        https://www.torn.com/page.php?sid=highlow
// @grant        none
// ==/UserScript==

/**
 * (Bloodawn)
 * File: torn-highlow-brain.user.js
 * Purpose: High-Low helper overlay + decision support using tracked remaining deck.
 */

(function() {
    'use strict';

    // ---------- Settings ----------
    const STORAGE_KEY = "bloodawn_hilo_settings_v3";
    const CHECK_INTERVAL_MS = 200;

    const DEFAULTS = {
        overlayEnabled: true,
        hideWorstButton: true,
        mode: "profit", // profit | merit (placeholder)
        panelPos: { top: 110, right: 20 }
    };

    const CARD_VALUES = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

    // ---------- State ----------
    let s = loadSettings();
    let remaining = {};
    let isActive = false;
    let lastDealer = null;
    let lastPlayer = null;

    // ---------- Utils ----------
    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return structuredClone(DEFAULTS);
            const parsed = JSON.parse(raw);
            return {
                ...structuredClone(DEFAULTS),
                ...parsed,
                panelPos: { ...DEFAULTS.panelPos, ...(parsed.panelPos || {}) }
            };
        } catch {
            return structuredClone(DEFAULTS);
        }
    }

    function saveSettings() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    }

    function rankToValue(txt) {
        if (!txt) return null;
        const t = txt.trim().toUpperCase();
        return CARD_VALUES[t] ?? null;
    }

    function resetDeck() {
        remaining = {};
        for (const k of Object.keys(CARD_VALUES)) remaining[CARD_VALUES[k]] = 4;
        lastDealer = null;
        lastPlayer = null;
        isActive = true;
    }

    function removeFromDeck(v) {
        if (v == null) return false;
        if (remaining[v] == null) return false;
        if (remaining[v] <= 0) return false;
        remaining[v]--;
        return true;
    }

    function countsRelativeTo(dealer) {
        let lower = 0, higher = 0, total = 0;
        for (const [vStr, c] of Object.entries(remaining)) {
            const v = Number(vStr);
            total += c;
            if (v < dealer) lower += c;
            else if (v > dealer) higher += c;
        }
        return { lower, higher, total };
    }

    function pct(n, d) {
        if (!d) return 0;
        return (n / d) * 100;
    }

    // ---------- Overlay ----------
    const ui = makeOverlay();

    function makeOverlay() {
        const wrap = document.createElement("div");
        wrap.id = "bloodawn-hilo-overlay";
        wrap.style.position = "fixed";
        wrap.style.zIndex = "999999";
        wrap.style.top = `${s.panelPos.top}px`;
        wrap.style.right = `${s.panelPos.right}px`;
        wrap.style.width = "250px";
        wrap.style.padding = "10px";
        wrap.style.borderRadius = "10px";
        wrap.style.background = "rgba(0,0,0,0.75)";
        wrap.style.color = "#fff";
        wrap.style.fontSize = "12px";
        wrap.style.backdropFilter = "blur(3px)";
        wrap.style.userSelect = "none";
        wrap.style.display = s.overlayEnabled ? "block" : "none";

        wrap.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <div style="font-weight:700;">Hi-Lo Brain</div>
                <div style="opacity:.85;">Bloodawn</div>
            </div>

            <div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;">
                <button data-act="mode" style="${btnCss()}">Mode: <span data-k="mode">${s.mode}</span></button>
                <button data-act="toggleHide" style="${btnCss()}">Hide-worst: <span data-k="hide">${s.hideWorstButton ? "on" : "off"}</span></button>
                <button data-act="reset" style="${btnCss()}">Reset</button>
            </div>

            <div style="line-height:1.5;">
                <div><b>Current</b></div>
                <div>Suggest: <span data-k="suggest">-</span></div>
                <div>P(win/lose/tie): <span data-k="p">-</span></div>
                <div>Hand: <span data-k="hand">-</span></div>
                <div>Deck left: <span data-k="deck">-</span></div>
                <div>Streak: <span data-k="streak">-</span></div>
                <div>Last: <span data-k="last">-</span></div>
            </div>

            <div style="margin-top:8px;opacity:.75;font-size:11px;">
                Hotkeys: <b>Alt+O</b> overlay, <b>Alt+H</b> hide, <b>Alt+R</b> reset, <b>Alt+M</b> mode
            </div>
        `;

        // drag
        let dragging = false, sx = 0, sy = 0, st = 0, sr = 0;
        wrap.addEventListener("mousedown", (e) => {
            if ((e.target || {}).tagName === "BUTTON") return;
            dragging = true;
            sx = e.clientX; sy = e.clientY;
            st = parseInt(wrap.style.top, 10);
            sr = parseInt(wrap.style.right, 10);
        });
        window.addEventListener("mousemove", (e) => {
            if (!dragging) return;
            const dy = e.clientY - sy;
            const dx = e.clientX - sx;
            wrap.style.top = `${Math.max(0, st + dy)}px`;
            wrap.style.right = `${Math.max(0, sr - dx)}px`;
        });
        window.addEventListener("mouseup", () => {
            if (!dragging) return;
            dragging = false;
            s.panelPos.top = parseInt(wrap.style.top, 10);
            s.panelPos.right = parseInt(wrap.style.right, 10);
            saveSettings();
        });

        wrap.addEventListener("click", (e) => {
            const b = e.target.closest("button");
            if (!b) return;
            const act = b.getAttribute("data-act");
            if (act === "reset") { resetDeck(); renderOverlay({ last: "manual reset" }); }
            if (act === "toggleHide") { s.hideWorstButton = !s.hideWorstButton; saveSettings(); refreshToggleText(); }
            if (act === "mode") { s.mode = (s.mode === "profit") ? "merit" : "profit"; saveSettings(); refreshToggleText(); }
        });

        function refreshToggleText() {
            wrap.querySelector('[data-k="hide"]').textContent = s.hideWorstButton ? "on" : "off";
            wrap.querySelector('[data-k="mode"]').textContent = s.mode;
        }

        document.body.appendChild(wrap);
        return {
            wrap,
            set: (k, v) => {
                const el = wrap.querySelector(`[data-k="${k}"]`);
                if (el) el.textContent = v;
            },
            show: (yes) => { wrap.style.display = yes ? "block" : "none"; }
        };
    }

    function btnCss() {
        return [
            "background:rgba(255,255,255,0.12)",
            "border:1px solid rgba(255,255,255,0.18)",
            "color:#fff",
            "border-radius:8px",
            "padding:6px 8px",
            "cursor:pointer"
        ].join(";") + ";";
    }

    function renderOverlay({ dealerTxt="-", suggest="-", p="-", hand="-", deck="-", streak="-", last="-" } = {}) {
        ui.set("suggest", suggest);
        ui.set("p", p);
        ui.set("hand", hand);
        ui.set("deck", deck);
        ui.set("streak", streak);
        ui.set("last", last);
    }

    // ---------- Hotkeys ----------
    window.addEventListener("keydown", (e) => {
        if (!e.altKey) return;
        const k = e.key.toLowerCase();
        if (k === "o") {
            s.overlayEnabled = !s.overlayEnabled;
            ui.show(s.overlayEnabled);
            saveSettings();
        } else if (k === "h") {
            s.hideWorstButton = !s.hideWorstButton;
            saveSettings();
            // reflect in UI
            const el = document.querySelector('#bloodawn-hilo-overlay [data-k="hide"]');
            if (el) el.textContent = s.hideWorstButton ? "on" : "off";
        } else if (k === "r") {
            resetDeck();
            renderOverlay({ last: "hotkey reset" });
        } else if (k === "m") {
            s.mode = (s.mode === "profit") ? "merit" : "profit";
            saveSettings();
            const el = document.querySelector('#bloodawn-hilo-overlay [data-k="mode"]');
            if (el) el.textContent = s.mode;
        }
    }, { passive: true });

    // ---------- Core DOM loop ----------
    function qs(sel) { return document.querySelector(sel); }

    function getEls() {
        return {
            dealerCard: qs(".dealer-card"),
            playerCard: qs(".you-card"),
            lowBtn: qs(".actions-wrap .action-btn-wrap.low"),
            highBtn: qs(".actions-wrap .action-btn-wrap.high"),
            startBtn: qs(".action-btn-wrap.startGame"),
            resultWrap: qs(".game-result-wrap"),
            mainWrap: qs(".highlow-main-wrap"),
            pot: qs(".currentPot-wrap .value") || qs(".current-pot .value"),
            streak: qs(".currentPot-wrap .streak") || qs(".streak")
        };
    }

    function setBtnVisible(btn, yes) {
        if (!btn) return;
        btn.style.display = yes ? "inline-block" : "none";
    }

    function applyHideWorst({ lowBtn, highBtn }, dealerVal) {
        const { lower, higher, total } = countsRelativeTo(dealerVal);
        const pLow = pct(lower, total);
        const pHigh = pct(higher, total);
        const pTie = Math.max(0, 100 - pLow - pHigh);

        let suggest = "TIE";
        if (higher > lower) suggest = "HIGH";
        else if (lower > higher) suggest = "LOW";
        else suggest = (dealerVal <= 7) ? "HIGH" : "LOW";

        // optional: hide the worse button
        if (s.hideWorstButton) {
            if (suggest === "HIGH") { setBtnVisible(lowBtn, false); setBtnVisible(highBtn, true); }
            else { setBtnVisible(highBtn, false); setBtnVisible(lowBtn, true); }
        } else {
            setBtnVisible(lowBtn, true);
            setBtnVisible(highBtn, true);
        }

        renderOverlay({
            suggest,
            p: `${pHigh.toFixed(1)} / ${(100 - pHigh - pTie).toFixed(1)} / ${pTie.toFixed(1)}`,
            hand: `Dealer ${dealerVal}`,
            deck: `${total}`,
            last: `L:${lower} H:${higher}`
        });
    }

    function tick() {
        const { dealerCard, playerCard, lowBtn, highBtn, startBtn, resultWrap, mainWrap } = getEls();
        if (!dealerCard || !playerCard || !lowBtn || !highBtn || !mainWrap) return;

        const gameEnded = (startBtn && startBtn.offsetParent !== null) ||
                          (resultWrap && resultWrap.offsetParent !== null) ||
                          (mainWrap.offsetParent === null);

        // start screen visible -> not active until click
        if (startBtn && startBtn.offsetParent !== null && !isActive) {
            setBtnVisible(lowBtn, false);
            setBtnVisible(highBtn, false);
            renderOverlay({ last: "waiting start" });
        }

        if (gameEnded && isActive) {
            isActive = false;
            lastDealer = null;
            lastPlayer = null;
            setBtnVisible(lowBtn, false);
            setBtnVisible(highBtn, false);
            renderOverlay({ last: "game ended" });
            return;
        }

        // if not active, bail
        if (!isActive) return;

        const dealerTxt = dealerCard.querySelector("span.rating")?.textContent ?? "";
        const playerTxt = (playerCard.querySelector("span.rating")?.textContent ?? "").trim();

        const dealerVal = rankToValue(dealerTxt);
        const playerVal = rankToValue(playerTxt);

        // new dealer card
        if (dealerVal != null && dealerVal !== lastDealer) {
            removeFromDeck(dealerVal);
            lastDealer = dealerVal;
            lastPlayer = null;
        }

        // player card revealed
        if (playerTxt !== "" && playerVal != null && playerVal !== lastPlayer) {
            removeFromDeck(playerVal);
            lastPlayer = playerVal;
            setBtnVisible(lowBtn, false);
            setBtnVisible(highBtn, false);
            renderOverlay({ last: `resolved -> ${playerVal}` });
            return;
        }

        // player hidden + dealer shown -> suggest
        if (playerTxt === "" && dealerVal != null) {
            applyHideWorst({ lowBtn, highBtn }, dealerVal);
        } else {
            setBtnVisible(lowBtn, false);
            setBtnVisible(highBtn, false);
        }
    }

    // Start hook
    function init() {
        const { startBtn } = getEls();

        // baseline: if we land mid-game, reset to full deck so it’s usable
        resetDeck();

        if (startBtn) {
            startBtn.addEventListener("click", () => {
                resetDeck();
                // wait for DOM to update; tick loop will handle
            }, { passive: true });
        }

        // polling loop is more resilient than mutation on Torn UI changes
        setInterval(tick, CHECK_INTERVAL_MS);
    }

    // wait for page
    const boot = setInterval(() => {
        const { dealerCard, playerCard, lowBtn, highBtn, mainWrap } = getEls();
        if (dealerCard && playerCard && lowBtn && highBtn && mainWrap) {
            clearInterval(boot);
            init();
        }
    }, 250);

})();