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

// Audio
const audioClick = new Audio("assets/audio/mouse-click.mp3");
const audioFlip = new Audio("assets/audio/flipcard.mp3");

function playSound(audio) {
    if (!audio) return;
    audio.currentTime = 0;
    audio.play().catch(e => console.warn("Audio play failed:", e));
}

// Global click listener for sounds
document.addEventListener("click", (e) => {
    // Play on any button or element with .btn class, or specific interactive elements
    if (e.target.tagName === "BUTTON" || e.target.closest("button") || e.target.classList.contains("evidence-card")) {
        playSound(audioClick);
    }
});

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

    // Default fallback (minimal) if fetch fails
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
        // Default selection if empty
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
    // Load JSONs
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

        // Update button states
        document.getElementById("btnPlayersDown").disabled = state.numPlayers <= 3;
        document.getElementById("btnPlayersUp").disabled = state.numPlayers >= 20;

        // Adjust impostors if needed
        const maxImpostors = Math.floor((state.numPlayers - 1) / 2);
        if (state.numImpostors > maxImpostors) {
            state.numImpostors = maxImpostors;
            if (state.numImpostors < 1) state.numImpostors = 1; // Should not happen with min 3 players
            document.getElementById("numImpostorsDisplay").textContent = state.numImpostors;
        }

        // Re-evaluate impostor button states based on new player count
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

        // Update button states
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

    // Two-step selection: 1. Category, 2. Item
    const activeCats = Array.from(state.activeCategories);
    const validCats = activeCats.filter(c => state.categories[c] && state.categories[c].length > 0);

    if (validCats.length === 0) {
        catError.textContent = "ERROR: Las categorías seleccionadas no tienen palabras o no se han cargado.";
        switchSection("categoriesSection");
        return false;
    }

    // 1. Random Category
    const selectedCat = randomFromArray(validCats);
    const words = state.categories[selectedCat];

    // 2. Random Word
    state.currentWord = randomFromArray(words);

    const numPlayers = state.players.length;
    // state.currentWord is already set above
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
    document.getElementById("btnNextPlayer").style.display = "none";
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

function onHoldStart() {
    if (holdTimeout) {
        clearTimeout(holdTimeout);
    }
    holdTimeout = setTimeout(() => {
        playSound(audioFlip); // Sound on open
        const roleCard = document.getElementById("roleCard");
        fillCardForCurrentPlayer();
        roleCard.classList.add("flipped");
        cardCurrentlyFlipped = true;
        if (!revealUnlocked) {
            document.getElementById("btnNextPlayer").style.display = "inline-block";
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
        playSound(audioFlip); // Sound on close
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
    // Prevent the mini-infobar from appearing on mobile
    e.preventDefault();
    // Stash the event so it can be triggered later
    deferredPrompt = e;
    isPWAAvailable = true;
    // Keep the install button visible (it's already visible by default)
});

window.addEventListener('appinstalled', () => {
    // Hide the install button after successful installation
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

    // Home screen buttons
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
        btnInstall.addEventListener("click", async () => {
            if (!isPWAAvailable || !deferredPrompt) {
                alert("Para instalar esta aplicación, ábrela desde Chrome, Edge o Safari y busca la opción 'Añadir a pantalla de inicio' en el menú del navegador.");
                return;
            }
            // Show the install prompt
            deferredPrompt.prompt();
            // Wait for the user to respond to the prompt
            const { outcome } = await deferredPrompt.userChoice;
            console.log(`User response to the install prompt: ${outcome}`);
            // Clear the deferredPrompt for next time
            deferredPrompt = null;
            isPWAAvailable = false;
            // Hide the install button
            btnInstall.style.display = 'none';
        });
    }

    // Number controls
    document.getElementById("btnPlayersDown").addEventListener("click", () => updateNumPlayers(-1));
    document.getElementById("btnPlayersUp").addEventListener("click", () => updateNumPlayers(1));
    document.getElementById("btnImpostorsDown").addEventListener("click", () => updateNumImpostors(-1));
    document.getElementById("btnImpostorsUp").addEventListener("click", () => updateNumImpostors(1));

    // Initialize button states
    document.getElementById("btnPlayersDown").disabled = state.numPlayers <= 3;
    document.getElementById("btnPlayersUp").disabled = state.numPlayers >= 20;
    document.getElementById("btnImpostorsDown").disabled = state.numImpostors <= 1;
    const maxImpostors = Math.floor((state.numPlayers - 1) / 2);
    document.getElementById("btnImpostorsUp").disabled = state.numImpostors >= maxImpostors;

    document.getElementById("btnImpostorsKnowYes").addEventListener("click", () => {
        setImpostorsKnow(true);
    });
    document.getElementById("btnImpostorsKnowNo").addEventListener("click", () => {
        setImpostorsKnow(false);
    });

    // Navegación
    document.getElementById("btnToCategories").addEventListener("click", () => {
        if (validateConfig()) {
            switchSection("categoriesSection");
        }
    });

    document.getElementById("btnCategoriesBack").addEventListener("click", () => {
        switchSection("configSection");
    });

    document.getElementById("btnToNames").addEventListener("click", () => {
        switchSection("namesSection");
    });

    document.getElementById("btnNamesBack").addEventListener("click", () => {
        switchSection("categoriesSection");
    });

    document.getElementById("btnBackToConfig").addEventListener("click", () => {
        switchSection("configSection");
    });

    document.getElementById("btnStartGame").addEventListener("click", () => {
        if (prepareRound()) {
            startRevealPhase();
        }
    });

    // Carta: mantener pulsado
    const roleCard = document.getElementById("roleCard");
    roleCard.addEventListener("mousedown", onHoldStart);
    roleCard.addEventListener("touchstart", (e) => {
        e.preventDefault();
        onHoldStart();
    }, { passive: false });

    ["mouseup", "mouseleave"].forEach(ev => {
        roleCard.addEventListener(ev, onHoldEnd);
    });
    ["touchend", "touchcancel"].forEach(ev => {
        roleCard.addEventListener(ev, (e) => {
            e.preventDefault();
            onHoldEnd();
        }, { passive: false });
    });

    document.getElementById("btnNextPlayer").addEventListener("click", nextPlayerOrPlay);

    document.getElementById("btnNewGameSameSettings").addEventListener("click", () => {
        newGameSameSettings();
    });

    document.getElementById("btnRevealImpostors").addEventListener("click", handleRevealImpostors);
});
