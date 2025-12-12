const STORAGE_KEY = "impostor_rial_data_v5";

const DEFAULT_CATEGORIES = {};

let state = {
    players: [],
    numPlayers: 5,
    numImpostors: 1,
    impostorsKnowEachOther: false,
    categories: {},
    activeCategories: new Set(),
    currentWord: null,
    currentImpostorsIndexes: [],
    currentPlayerIndex: 0
};

let holdTimeout = null;
let cardCurrentlyFlipped = false;
let revealUnlocked = false;
let revealImpostorsState = 0;

// =========================================================
// Web Audio SFX (mobile-precise click + flip, no overlap)
// iOS-safe: hard unlock + auto-resume + safe event options
// =========================================================

const SFX_CLICK_URL = "assets/audio/mouse-click.mp3";
const SFX_FLIP_URL = "assets/audio/flipcard.mp3";

let audioCtx = null;
let clickBuffer = null;
let flipBuffer = null;

let lastClickSource = null;
let lastFlipSource = null;

let audioInitPromise = null;

// --- Safe addEventListener options (older iOS fallback) ---
let supportsListenerOptions = false;
(() => {
    try {
        const dummy = () => { };
        const opts = Object.defineProperty({}, "passive", {
            get() { supportsListenerOptions = true; }
        });
        window.addEventListener("testPassive", dummy, opts);
        window.removeEventListener("testPassive", dummy, opts);
    } catch (_) {
        supportsListenerOptions = false;
    }
})();

function on(el, type, handler, options) {
    if (!supportsListenerOptions) {
        const capture = !!(options && options.capture);
        el.addEventListener(type, handler, capture);
        return;
    }
    el.addEventListener(type, handler, options || false);
}

const PRESS_EVENT = window.PointerEvent ? "pointerdown" : "touchstart";

// Prefetch network early (no autoplay issues; just download)
const sfxPrefetchPromise = Promise.all([
    fetch(SFX_CLICK_URL).then(r => r.arrayBuffer()),
    fetch(SFX_FLIP_URL).then(r => r.arrayBuffer())
]).catch((err) => {
    console.warn("SFX prefetch failed:", err);
    return [null, null];
});

function ensureAudioContext() {
    if (audioCtx) return audioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
    return audioCtx;
}

// iOS hard unlock: play a silent buffer once to fully unlock audio pipeline
function hardUnlockWebAudio(ctx) {
    if (!ctx) return;
    try {
        const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start(0);
    } catch (_) { }
}

async function initAudio() {
    if (audioInitPromise) return audioInitPromise;

    audioInitPromise = (async () => {
        const ctx = ensureAudioContext();
        if (!ctx) return;

        // Resume if suspended (mobile)
        if (ctx.state === "suspended") {
            try { await ctx.resume(); } catch (_) { }
        }

        // Hard unlock early (important for iOS mute cases)
        hardUnlockWebAudio(ctx);

        const [clickArr, flipArr] = await sfxPrefetchPromise;
        if (!clickArr || !flipArr) return;

        // decodeAudioData may detach ArrayBuffer -> slice()
        try {
            clickBuffer = await ctx.decodeAudioData(clickArr.slice(0));
            flipBuffer = await ctx.decodeAudioData(flipArr.slice(0));
        } catch (err) {
            console.warn("decodeAudioData failed:", err);
        }

        // Extra hard unlock after decode (safe)
        hardUnlockWebAudio(ctx);
    })();

    return audioInitPromise;
}

function stopSource(src) {
    if (!src) return;
    try { src.stop(0); } catch (_) { }
}

function createAndStart(buffer, kind) {
    const ctx = audioCtx;
    if (!ctx || !buffer) return;

    // "Last wins" per kind
    if (kind === "click") stopSource(lastClickSource);
    if (kind === "flip") stopSource(lastFlipSource);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0);

    if (kind === "click") lastClickSource = src;
    if (kind === "flip") lastFlipSource = src;
}

function playBuffer(buffer, kind) {
    const ctx = audioCtx;
    if (!ctx || !buffer) return;

    // If mobile suspended (returning from background), resume then play
    if (ctx.state === "suspended") {
        ctx.resume().then(() => {
            hardUnlockWebAudio(ctx);
            createAndStart(buffer, kind);
        }).catch(() => { });
        return;
    }

    createAndStart(buffer, kind);
}

function playClick() {
    if (!audioCtx || !clickBuffer) {
        initAudio()
            .then(() => { if (clickBuffer) playBuffer(clickBuffer, "click"); })
            .catch(() => { });
        return;
    }
    playBuffer(clickBuffer, "click");
}

function playFlip() {
    if (!audioCtx || !flipBuffer) {
        initAudio()
            .then(() => { if (flipBuffer) playBuffer(flipBuffer, "flip"); })
            .catch(() => { });
        return;
    }
    playBuffer(flipBuffer, "flip");
}

function isInteractiveForClickSound(target) {
    // Buttons (enabled) or evidence cards
    const btn = target && target.closest ? target.closest("button") : null;
    if (btn) return !btn.disabled;
    return !!(target && target.classList && target.classList.contains("evidence-card"));
}

// Prime audio on first real user gesture (must be user-initiated on iOS)
function primeAudioOnFirstGesture() {
    initAudio().catch(() => { });
}

// One-time prime
on(document, PRESS_EVENT, primeAudioOnFirstGesture, { once: true, capture: true, passive: true });

// Auto-resume on any press (iOS can suspend when backgrounded)
on(document, PRESS_EVENT, () => {
    if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume().then(() => hardUnlockWebAudio(audioCtx)).catch(() => { });
    }
}, { capture: true, passive: true });

// Fast + faithful click SFX on press (not click)
on(document, PRESS_EVENT, (e) => {
    if (!isInteractiveForClickSound(e.target)) return;
    playClick();
}, { capture: true, passive: true });

// =========================================================
// Game logic
// =========================================================

async function loadGameData() {
    const fileMapping = {
        "Animales": { file: "data/animales.json", key: "animales" },
        "Comida": { file: "data/comida.json", key: "comida" },
        "Coñas": { file: "data/conas.json", key: "conas" },
        "Famosos": { file: "data/famosos.json", key: "famosos" },
        "Famosos Españoles": { file: "data/famosos_espanoles.json", key: "famosos_espanoles" },
        "Lugares": { file: "data/lugares.json", key: "lugares" },
        "Objetos": { file: "data/objetos.json", key: "objetos" },
        "Personajes": { file: "data/personajes.json", key: "personajes" }
    };

    const loadedCats = {};

    loadedCats["Animales"] = ["Perro", "Gato"];

    try {
        for (const [catName, config] of Object.entries(fileMapping)) {
            try {
                const response = await fetch(config.file);
                if (response.ok) {
                    const data = await response.json();
                    if (data[config.key] && Array.isArray(data[config.key])) {
                        loadedCats[catName] = data[config.key];
                    }
                }
            } catch (err) {
                console.warn(`Could not load ${config.file}`, err);
            }
        }
        state.categories = loadedCats;
        if (state.activeCategories.size === 0) {
            state.activeCategories = new Set(Object.keys(loadedCats));
        }
        renderEvidenceBoard();
    } catch (e) {
        console.error("Master load error", e);
    }
}

function loadData() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed.activeCategories)) {
                state.activeCategories = new Set(parsed.activeCategories);
            }
        } catch (e) {
            console.warn("Error al cargar datos, valores por defecto.");
        }
    }
    loadGameData();
}

function saveData() {
    const toSave = {
        activeCategories: Array.from(state.activeCategories)
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
}

function switchSection(id) {
    document.querySelectorAll(".section").forEach(sec => {
        sec.classList.remove("active");
    });
    document.getElementById(id).classList.add("active");
}

function randomFromArray(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Number controls
function updateNumPlayers(delta) {
    const newValue = state.numPlayers + delta;
    if (newValue >= 3 && newValue <= 20) {
        state.numPlayers = newValue;
        document.getElementById("numPlayersDisplay").textContent = state.numPlayers;
        renderSuspectInputs();

        document.getElementById("btnPlayersDown").disabled = state.numPlayers <= 3;
        document.getElementById("btnPlayersUp").disabled = state.numPlayers >= 20;

        const maxImpostors = Math.floor((state.numPlayers - 1) / 2);
        if (state.numImpostors > maxImpostors) {
            state.numImpostors = maxImpostors;
            if (state.numImpostors < 1) state.numImpostors = 1;
            document.getElementById("numImpostorsDisplay").textContent = state.numImpostors;
        }

        const currentMaxImpostors = Math.floor((state.numPlayers - 1) / 2);
        document.getElementById("btnImpostorsDown").disabled = state.numImpostors <= 1;
        document.getElementById("btnImpostorsUp").disabled = state.numImpostors >= currentMaxImpostors;
    }
}

function updateNumImpostors(delta) {
    const maxImpostors = Math.floor((state.numPlayers - 1) / 2);
    const newValue = state.numImpostors + delta;
    if (newValue >= 1 && newValue <= maxImpostors) {
        state.numImpostors = newValue;
        document.getElementById("numImpostorsDisplay").textContent = state.numImpostors;

        document.getElementById("btnImpostorsDown").disabled = state.numImpostors <= 1;
        document.getElementById("btnImpostorsUp").disabled = state.numImpostors >= maxImpostors;
    }
}

// Configuración
function setImpostorsKnow(value) {
    state.impostorsKnowEachOther = value;
    const yesBtn = document.getElementById("btnImpostorsKnowYes");
    const noBtn = document.getElementById("btnImpostorsKnowNo");

    if (value === true) {
        yesBtn.classList.add("active");
        noBtn.classList.remove("active");
    } else {
        noBtn.classList.add("active");
        yesBtn.classList.remove("active");
    }
}

function validateConfig() {
    const errorEl = document.getElementById("configError");
    errorEl.textContent = "";

    if (!(state.numPlayers >= 3)) {
        errorEl.textContent = "ERROR: Mínimo 3 sospechosos requeridos.";
        return false;
    }
    const maxImpostors = Math.floor((state.numPlayers - 1) / 2);
    if (!(state.numImpostors >= 1 && state.numImpostors <= maxImpostors)) {
        errorEl.textContent = "ERROR: Número de impostores incorrecto.";
        return false;
    }
    return true;
}

// Categorías
function renderEvidenceBoard() {
    const board = document.getElementById("evidenceBoard");
    board.innerHTML = "";
    const names = Object.keys(state.categories).sort();

    names.forEach(name => {
        const card = document.createElement("div");
        card.className = "evidence-card" + (state.activeCategories.has(name) ? " selected" : "");

        card.innerHTML = `<div class="evidence-name">${name}</div>`;

        card.addEventListener("click", () => {
            if (state.activeCategories.has(name)) {
                state.activeCategories.delete(name);
            } else {
                state.activeCategories.add(name);
            }
            saveData();
            renderEvidenceBoard();
        });

        board.appendChild(card);
    });
}

// Nombres
function renderSuspectInputs() {
    const container = document.getElementById("suspectsContainer");
    container.innerHTML = "";

    for (let i = 0; i < state.numPlayers; i++) {
        const card = document.createElement("div");
        card.className = "suspect-card";

        const number = document.createElement("div");
        number.className = "suspect-number";
        number.textContent = i + 1;

        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = `Sospechoso ${i + 1}`;
        input.dataset.index = i;

        if (state.players[i]) {
            input.value = state.players[i];
        }

        card.appendChild(number);
        card.appendChild(input);
        container.appendChild(card);
    }
}

function collectPlayersFromInputs() {
    const inputs = document.querySelectorAll("#suspectsContainer input");
    const players = [];
    inputs.forEach((input, idx) => {
        const name = input.value.trim();
        players.push(name || `Sospechoso ${idx + 1}`);
    });
    state.players = players;
}

// Ronda
function prepareRound() {
    const namesError = document.getElementById("namesError");
    const catError = document.getElementById("categoriesError");
    namesError.textContent = "";
    catError.textContent = "";

    if (!validateConfig()) return false;

    collectPlayersFromInputs();
    if (state.players.length < 3) {
        namesError.textContent = "ERROR: Faltan nombres de sospechosos.";
        return false;
    }

    if (state.activeCategories.size === 0) {
        catError.textContent = "ERROR: Selecciona al menos una categoría de evidencia.";
        switchSection("categoriesSection");
        return false;
    }

    const activeCats = Array.from(state.activeCategories);
    const validCats = activeCats.filter(c => state.categories[c] && state.categories[c].length > 0);

    if (validCats.length === 0) {
        catError.textContent = "ERROR: Las categorías seleccionadas no tienen palabras o no se han cargado.";
        switchSection("categoriesSection");
        return false;
    }

    const selectedCat = randomFromArray(validCats);
    const words = state.categories[selectedCat];

    state.currentWord = randomFromArray(words);

    const numPlayers = state.players.length;
    const indexes = Array.from({ length: numPlayers }, (_, i) => i);
    shuffleArray(indexes);
    state.currentImpostorsIndexes = indexes.slice(0, state.numImpostors);
    state.currentPlayerIndex = 0;

    revealImpostorsState = 0;
    const btnReveal = document.getElementById("btnRevealImpostors");
    const list = document.getElementById("impostorsList");
    const roundWord = document.getElementById("roundWord");
    if (btnReveal) {
        btnReveal.disabled = false;
        btnReveal.textContent = "Revelar Impostor(es)";
    }
    if (list) {
        list.style.display = "none";
        list.textContent = "";
    }
    if (roundWord) {
        roundWord.textContent = "[CLASIFICADO]";
        roundWord.classList.add("classified");
        roundWord.classList.remove("revealed");
    }

    return true;
}

function isImpostor(playerIndex) {
    return state.currentImpostorsIndexes.includes(playerIndex);
}

function newGameSameSettings() {
    if (prepareRound()) {
        startRevealPhase();
    }
}

function startRevealPhase() {
    switchSection("revealSection");
    resetCard();
    const playerName = state.players[state.currentPlayerIndex];
    document.getElementById("currentPlayerName").textContent = playerName;
}

function nextPlayerOrPlay() {
    state.currentPlayerIndex++;
    if (state.currentPlayerIndex >= state.players.length) {
        switchSection("playSection");
        const startingName = randomFromArray(state.players);
        document.getElementById("startingPlayer").textContent = startingName;
    } else {
        resetCard();
        const playerName = state.players[state.currentPlayerIndex];
        document.getElementById("currentPlayerName").textContent = playerName;
    }
}

// Carta
function resetCard() {
    const roleCard = document.getElementById("roleCard");
    const main = document.getElementById("cardFrontMain");
    const sub = document.getElementById("cardFrontSub");
    roleCard.classList.remove("flipped");
    cardCurrentlyFlipped = false;
    revealUnlocked = false;
    main.textContent = "";
    sub.textContent = "";

    const btn = document.getElementById("btnNextPlayer");
    btn.classList.add("is-hidden");
    btn.classList.remove("is-visible");
}

function fillCardForCurrentPlayer() {
    const idx = state.currentPlayerIndex;
    const isImp = isImpostor(idx);
    const main = document.getElementById("cardFrontMain");
    const sub = document.getElementById("cardFrontSub");

    if (isImp) {
        main.textContent = "IMPOSTOR";
        main.classList.add("impostor-text");
        if (state.impostorsKnowEachOther && state.numImpostors > 1) {
            const others = state.currentImpostorsIndexes
                .filter(i => i !== idx)
                .map(i => state.players[i]);
            if (others.length > 0) {
                sub.textContent = "Otros impostores: " + others.join(", ");
            } else {
                sub.textContent = "";
            }
        } else {
            sub.textContent = "";
        }
    } else {
        main.textContent = state.currentWord;
        main.classList.remove("impostor-text");
    }
}

function onHoldStart() {
    if (holdTimeout) clearTimeout(holdTimeout);

    holdTimeout = setTimeout(() => {
        playFlip(); // Sound on open (WebAudio)
        const roleCard = document.getElementById("roleCard");
        fillCardForCurrentPlayer();
        roleCard.classList.add("flipped");
        cardCurrentlyFlipped = true;

        if (!revealUnlocked) {
            const btn = document.getElementById("btnNextPlayer");
            btn.classList.remove("is-hidden");
            btn.classList.add("is-visible");
            revealUnlocked = true;
        }
    }, 50);
}

function onHoldEnd() {
    if (holdTimeout) {
        clearTimeout(holdTimeout);
        holdTimeout = null;
    }
    if (cardCurrentlyFlipped) {
        playFlip(); // Sound on close (WebAudio)
        const roleCard = document.getElementById("roleCard");
        roleCard.classList.remove("flipped");
        cardCurrentlyFlipped = false;
    }
}

function handleRevealImpostors() {
    const btn = document.getElementById("btnRevealImpostors");
    const list = document.getElementById("impostorsList");
    const roundWord = document.getElementById("roundWord");
    if (!btn || !list) return;

    if (revealImpostorsState === 0) {
        btn.textContent = "Confirmar Revelación";
        list.style.display = "none";
        revealImpostorsState = 1;
    } else if (revealImpostorsState === 1) {
        const names = state.currentImpostorsIndexes.map(i => state.players[i]);
        if (roundWord) {
            roundWord.textContent = state.currentWord;
            roundWord.classList.remove("classified");
            roundWord.classList.add("revealed");
        }
        list.textContent = "IMPOSTOR(ES): " + names.join(", ");
        list.style.display = "block";
        btn.disabled = true;
        revealImpostorsState = 2;
    }
}

// PWA Install functionality
let deferredPrompt;
let isPWAAvailable = false;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    isPWAAvailable = true;
});

window.addEventListener('appinstalled', () => {
    const installBtn = document.getElementById('btnInstall');
    if (installBtn) {
        installBtn.style.display = 'none';
    }
    deferredPrompt = null;
});

// Init
window.addEventListener("DOMContentLoaded", () => {
    loadData();

    renderSuspectInputs();
    renderEvidenceBoard();
    setImpostorsKnow(false);

    const btnPlay = document.getElementById("btnPlay");
    if (btnPlay) {
        btnPlay.addEventListener("click", () => {
            switchSection("configSection");
        });
    }

    const btnConfigBack = document.getElementById("btnConfigBack");
    if (btnConfigBack) {
        btnConfigBack.addEventListener("click", () => {
            switchSection("homeSection");
        });
    }

    const btnInstall = document.getElementById("btnInstall");
    if (btnInstall) {
        btnInstall.addEventListener("click", () => {
            // Instead of alert/prompt, go to tutorial
            switchSection("installTutorialSection");
        });
    }

    const btnTutorialBack = document.getElementById("btnTutorialBack");
    if (btnTutorialBack) {
        btnTutorialBack.addEventListener("click", () => {
            switchSection("homeSection");
        });
    }

    document.getElementById("btnPlayersDown").addEventListener("click", () => updateNumPlayers(-1));
    document.getElementById("btnPlayersUp").addEventListener("click", () => updateNumPlayers(1));
    document.getElementById("btnImpostorsDown").addEventListener("click", () => updateNumImpostors(-1));
    document.getElementById("btnImpostorsUp").addEventListener("click", () => updateNumImpostors(1));

    document.getElementById("btnPlayersDown").disabled = state.numPlayers <= 3;
    document.getElementById("btnPlayersUp").disabled = state.numPlayers >= 20;
    document.getElementById("btnImpostorsDown").disabled = state.numImpostors <= 1;
    const maxImpostors = Math.floor((state.numPlayers - 1) / 2);
    document.getElementById("btnImpostorsUp").disabled = state.numImpostors >= maxImpostors;

    document.getElementById("btnImpostorsKnowYes").addEventListener("click", () => setImpostorsKnow(true));
    document.getElementById("btnImpostorsKnowNo").addEventListener("click", () => setImpostorsKnow(false));

    document.getElementById("btnToCategories").addEventListener("click", () => {
        if (validateConfig()) switchSection("categoriesSection");
    });

    document.getElementById("btnCategoriesBack").addEventListener("click", () => switchSection("configSection"));
    document.getElementById("btnToNames").addEventListener("click", () => switchSection("namesSection"));
    document.getElementById("btnNamesBack").addEventListener("click", () => switchSection("categoriesSection"));
    document.getElementById("btnBackToConfig").addEventListener("click", () => switchSection("configSection"));

    document.getElementById("btnStartGame").addEventListener("click", () => {
        if (prepareRound()) startRevealPhase();
    });

    const roleCard = document.getElementById("roleCard");
    roleCard.addEventListener("mousedown", onHoldStart);
    roleCard.addEventListener("touchstart", (e) => {
        e.preventDefault();
        onHoldStart();
    }, { passive: false });

    ["mouseup", "mouseleave"].forEach(ev => roleCard.addEventListener(ev, onHoldEnd));
    ["touchend", "touchcancel"].forEach(ev => {
        roleCard.addEventListener(ev, (e) => {
            e.preventDefault();
            onHoldEnd();
        }, { passive: false });
    });

    document.getElementById("btnNextPlayer").addEventListener("click", nextPlayerOrPlay);
    document.getElementById("btnNewGameSameSettings").addEventListener("click", () => newGameSameSettings());
    document.getElementById("btnRevealImpostors").addEventListener("click", handleRevealImpostors);
});
