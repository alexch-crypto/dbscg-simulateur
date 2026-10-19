// Interface de test dans le navigateur.
//
// Trois modes :
//  - Solo (par défaut) : vous jouez les deux côtés. P1 en bas, P2 en haut, les deux mains
//    visibles, pas d'écran « passez l'ordinateur ».
//  - Deux joueurs sur le même écran : chacun ne voit que son jeu, avec un écran de passage.
//  - En ligne : un joueur crée une room (il est l'hôte, P1, et fait tourner le moteur), l'autre
//    la rejoint avec le code (P2). L'invité ne reçoit que sa vue et ses coups autorisés.
//
// On joue en CLIQUANT SUR LES CARTES : les cartes qui ont une action possible sont surlignées ;
// un clic affiche leurs actions dans le panneau de droite. Pour choisir des cartes (cartes de
// Vie, cibles d'un effet...), on clique dessus puis on valide.
//
// Cette page joue le rôle de l'« hôte » : elle garde l'état complet et appelle le moteur, mais
// n'affiche que des vues de joueur (getPlayerView). Aucune règle du jeu n'est codée ici.

import freezerFile from "../../cards/freezer.json";
import {
  applyAction,
  buildCardDatabase,
  createGame,
  getLegalActions,
  getPlayerView,
  newRecord,
  parseCardFile,
  replayGame,
  type Action,
  type CardDefinition,
  type CardView,
  type CounterPrompt,
  type GameContext,
  type GameEvent,
  type GameRecord,
  type GameState,
  type LeaderState,
  type PlayerId,
  type PlayerView,
  type PlayerZonesView,
  type VisibleCard,
} from "../engine";
import { GUEST, HOST, OnlineGuest, OnlineHost, type HostMessage } from "../net/online";
import { hostRoom, joinRoom, normalizeCode, type GuestLink, type HostLink } from "../net/peer";
import { COLOR_NAMES, cardName, describeAction, describeEvent, describePending, nameOf, phaseName } from "./labels";
import "./style.css";

// ---------------------------------------------------------------------------
// Données et état de l'interface
// ---------------------------------------------------------------------------

const freezer = parseCardFile(freezerFile);
const db = buildCardDatabase([freezer.cards]);
const ctx: GameContext = { cards: db };

type Mode = "solo" | "hotseat" | "online";

let state: GameState | null = null;
let seed = 0;
/** Enregistrement de la partie (graine, decks, coups joués) pour l'export. */
let record: GameRecord;
let log: string[] = [];
let mode: Mode = "solo";
/** Réglage des fenêtres de contre de chaque joueur. */
const counterPrompt: Record<PlayerId, CounterPrompt> = { P1: "only_if_playable", P2: "only_if_playable" };
/** Jeu en ligne : rôle, objets de partie et de connexion, état de la connexion. */
let onlineHost: OnlineHost | null = null;
let onlineGuest: OnlineGuest | null = null;
let hostLink: HostLink | null = null;
let guestLink: GuestLink | null = null;
let roomCode = "";
let netStatus = "";
/** Réglage des fenêtres de contre du joueur en ligne (par défaut : toujours demander). */
let myPrompt: CounterPrompt = "always";
/** Mode deux joueurs : joueur devant l'écran, et écran de passage affiché ou non. */
let screenOwner: PlayerId = "P1";
let revealed = false;
let errorMessage = "";
/** Journal masqué (préférence mémorisée dans le navigateur). */
let logHidden = (() => {
  try {
    return localStorage.getItem("dbscg.logHidden") === "1";
  } catch {
    return false;
  }
})();

/** Carte sélectionnée (ses actions sont affichées dans le panneau). */
let selectedCard: string | null = null;
/** Deck Z ouvert (son contenu est affiché dans le panneau de droite), ou aucun. */
let openZDeck: PlayerId | null = null;
/** Dispersion ouverte dans le panneau de droite (null = fermée). */
let openDrop: PlayerId | null = null;
/** Cartes / positions cochées pour une décision « choisissez X cartes ». */
const picked = new Set<string>();
/** Paiement personnalisé : Énergies sélectionnées en cliquant dessus, et marqueurs. */
const selectedEnergy = new Set<string>();
let selectedMarkers = 0;
/** Coups proposés actuellement (les boutons y font référence par leur position). */
let currentActions: Action[] = [];

const app = document.getElementById("app")!;

// ---------------------------------------------------------------------------
// Partie : création, coups, export / import
// ---------------------------------------------------------------------------

function showSetup(): void {
  const prompt = (p: PlayerId) => `
    <label class="setting">
      <input type="checkbox" data-prompt="${p}" ${counterPrompt[p] === "always" ? "checked" : ""}>
      <b>${p}</b> : toujours me demander si je veux contrer
      <span class="hint">(décoché : la partie ne s'arrête que si ${p} a un contre jouable)</span>
    </label>`;
  app.innerHTML = `
    <div class="pass-screen">
      <h1>Nouvelle partie</h1>
      <p>Freezer contre Freezer.</p>
      <label class="setting"><input type="radio" name="mode" data-mode="solo" ${mode === "solo" ? "checked" : ""}>
        <b>Solo</b> — je joue les deux côtés (les deux mains visibles, pas d'écran de passage)</label>
      <label class="setting"><input type="radio" name="mode" data-mode="hotseat" ${mode === "hotseat" ? "checked" : ""}>
        <b>Deux joueurs sur le même écran</b> — chacun ne voit que son jeu</label>
      <label class="setting"><input type="radio" name="mode" data-mode="online" ${mode === "online" ? "checked" : ""}>
        <b>En ligne</b> — contre un ami, chacun sur son ordinateur</label>
      ${
        mode === "online"
          ? `<h3>Fenêtres de contre</h3>
      <label class="setting"><input type="checkbox" data-my-prompt ${myPrompt === "always" ? "checked" : ""}>
        Toujours me demander si je veux contrer
        <span class="hint">(conseillé en ligne : sinon l'adversaire pourrait deviner que vous avez un contre)</span></label>
      <div class="online-choice">
        <button data-host>Créer une room</button>
        <span>ou</span>
        <input type="text" placeholder="Code de la room" data-code maxlength="12" value="${esc(roomCode)}">
        <button data-join>Rejoindre</button>
      </div>
      ${netStatus ? `<p class="error">${esc(netStatus)}</p>` : ""}`
          : `<h3>Fenêtres de contre</h3>
      ${prompt("P1")}${prompt("P2")}
      <button data-start>Commencer la partie</button>`
      }
    </div>`;
}

/** Salle d'attente en ligne (avant que la partie commence). */
function showLobby(): void {
  const isHost = onlineHost !== null;
  app.innerHTML = `
    <div class="pass-screen">
      <h1>${isHost ? "Room créée" : "Connexion à la room"}</h1>
      ${
        isHost
          ? roomCode
            ? `<p>Donnez ce code à votre adversaire :</p><p class="room-code">${esc(roomCode)}</p>
               <p class="hint">${esc(netStatus || "En attente de l'adversaire…")}</p>`
            : `<p class="hint">${esc(netStatus || "Ouverture de la room…")}</p>`
          : `<p>Code : <b>${esc(roomCode)}</b></p><p class="hint">${esc(netStatus || "Connexion…")}</p>`
      }
      <button data-new>Annuler</button>
    </div>`;
}

/** Ferme la connexion en ligne en cours (s'il y en a une). */
function leaveOnline(): void {
  hostLink?.close();
  guestLink?.close();
  hostLink = null;
  guestLink = null;
  onlineHost = null;
  onlineGuest = null;
  netStatus = "";
}

/** Crée une room : ce navigateur devient l'hôte (P1) et fait tourner le moteur. */
function createRoom(): void {
  leaveOnline();
  log = [];
  resetSelection();
  roomCode = "";
  onlineHost = new OnlineHost(
    ctx,
    freezer.deck!,
    myPrompt,
    (msg: HostMessage) => hostLink?.send(msg),
    (events) => {
      if (onlineHost?.record) seed = onlineHost.record.seed;
      addToLog(events);
      render();
    },
  );
  hostLink = hostRoom({
    onReady: (code) => {
      roomCode = code;
      netStatus = "";
      render();
    },
    onGuestConnected: () => {
      netStatus = "";
      if (onlineHost?.state) log.push("(Votre adversaire est de retour.)");
      render();
    },
    onGuestLeft: () => {
      netStatus = "Votre adversaire s'est déconnecté. Il peut revenir avec le même code.";
      render();
    },
    onMessage: (msg) => onlineHost?.receive(msg),
    onError: (message) => {
      netStatus = message;
      render();
    },
  });
  render();
}

/** Rejoint une room avec son code : ce navigateur devient l'invité (P2). */
function joinGame(code: string): void {
  const clean = normalizeCode(code);
  if (clean.length < 4) {
    netStatus = "Entrez le code donné par votre adversaire.";
    return showSetup();
  }
  leaveOnline();
  log = [];
  resetSelection();
  roomCode = clean;
  onlineGuest = new OnlineGuest(
    (msg) => guestLink?.send(msg),
    (events) => {
      errorMessage = onlineGuest?.lastError ?? "";
      addToLog(events);
      render();
    },
  );
  guestLink = joinRoom(clean, {
    onConnected: () => {
      netStatus = "";
      onlineGuest?.hello(freezer.deck!, myPrompt);
      render();
    },
    onClosed: () => {
      netStatus = "Connexion perdue avec l'hôte.";
      render();
    },
    onMessage: (msg) => onlineGuest?.receive(msg),
    onError: (message) => {
      netStatus = message;
      if (!onlineGuest?.snapshot) {
        leaveOnline();
        mode = "online";
        return showSetup();
      }
      render();
    },
  });
  render();
}

function resetSelection(): void {
  selectedCard = null;
  picked.clear();
  selectedEnergy.clear();
  selectedMarkers = 0;
}

function newGame(): void {
  seed = Math.floor(Math.random() * 1_000_000);
  const decks = { P1: freezer.deck!, P2: freezer.deck! };
  const result = createGame({ decks, seed, counterPrompt: { ...counterPrompt } }, db);
  if (!result.ok) {
    app.textContent = `Deck invalide : ${result.errors.join(" ; ")}`;
    return;
  }
  state = result.state;
  record = newRecord(seed, decks, { ...counterPrompt });
  log = [];
  addToLog(result.events);
  errorMessage = "";
  resetSelection();
  screenOwner = state.pending!.player;
  revealed = false;
  render();
}

function addToLog(events: GameEvent[]): void {
  const view = currentView();
  for (const e of events) log.push(describeEvent(e, view, db));
}

function act(action: Action): void {
  if (!hasGame()) return;
  // Paiement personnalisé : remplace le paiement suggéré par la sélection du joueur.
  if (
    (action.type === "PLAY_CARD" ||
      action.type === "COMBO" ||
      action.type === "ACTIVATE" ||
      action.type === "SUCCESSOR" ||
      action.type === "PLAY_Z" ||
      action.type === "Z_AWAKEN" ||
      (action.type === "DECLARE_COUNTER" && !action.alt)) &&
    (selectedEnergy.size > 0 || selectedMarkers > 0)
  ) {
    action = { ...action, payment: { energy: [...selectedEnergy], markers: selectedMarkers } };
  }
  // En ligne : l'hôte applique le coup lui-même ; l'invité l'envoie à l'hôte, qui répondra.
  if (onlineHost) {
    const error = onlineHost.actLocal(action);
    errorMessage = error ?? "";
    if (!error) resetSelection();
    return render();
  }
  if (onlineGuest) {
    resetSelection();
    onlineGuest.act(action);
    return render();
  }
  if (!state) return;
  const r = applyAction(state, action, ctx);
  if (!r.ok) {
    errorMessage = r.error;
    render();
    return;
  }
  state = r.state;
  record.actions.push(action);
  errorMessage = "";
  resetSelection();
  addToLog(r.events);
  const next = state.pending?.player;
  if (mode === "hotseat" && next && next !== screenOwner) {
    screenOwner = next;
    revealed = false;
  }
  render();
}

function exportGame(): void {
  const data = onlineHost?.record ?? record;
  if (!data) return;
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `partie-${seed}-coup${data.actions.length}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function importGame(file: File): Promise<void> {
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    errorMessage = "ce fichier n'est pas un fichier JSON valide";
    render();
    return;
  }
  const replay = replayGame(data, ctx);
  if (!replay.ok) {
    errorMessage = `chargement impossible : ${replay.error}`;
    render();
    return;
  }
  const loaded = data as GameRecord;
  state = replay.state;
  seed = loaded.seed;
  record = { ...loaded, actions: [...loaded.actions] };
  log = [];
  addToLog(replay.events);
  log.push(`(Partie chargée : ${loaded.actions.length} coups rejoués.)`);
  errorMessage = "";
  resetSelection();
  screenOwner = state.pending?.player ?? "P1";
  revealed = false;
  render();
}

// ---------------------------------------------------------------------------
// Vues
// ---------------------------------------------------------------------------

/** Une partie est-elle affichable (locale, ou en ligne une fois commencée) ? */
const hasGame = (): boolean => state !== null || onlineHost?.state != null || onlineGuest?.snapshot != null;

/** En ligne : le joueur de ce navigateur. */
const onlineMe = (): PlayerId | null => (onlineHost ? HOST : onlineGuest ? GUEST : null);

/** Joueur qui doit décider maintenant (celui dont on affiche les actions). */
function decider(): PlayerId {
  if (onlineHost?.state) return onlineHost.state.pending?.player ?? onlineHost.state.turnPlayer;
  if (onlineGuest?.snapshot) return onlineGuest.snapshot.view.pending?.player ?? onlineGuest.snapshot.view.turnPlayer;
  return state?.pending?.player ?? state?.turnPlayer ?? "P1";
}

/** Coups autorisés du joueur de cet écran (vide s'il n'a rien à décider). */
function legalActions(): Action[] {
  if (onlineHost) return onlineHost.snapshot(HOST)?.actions ?? [];
  if (onlineGuest) return onlineGuest.snapshot?.actions ?? [];
  if (!state) return [];
  if (mode === "solo" || state.pending?.player === screenOwner) return getLegalActions(state, decider(), ctx);
  return [];
}

/**
 * Vue affichée. En Solo : la main et les choix de chaque joueur sont visibles (vue du joueur
 * qui décide, avec la main de l'autre prise dans sa propre vue). En mode deux joueurs : la vue
 * du joueur devant l'écran seulement.
 */
function currentView(): PlayerView {
  if (onlineHost?.state) return getPlayerView(onlineHost.state, HOST);
  if (onlineGuest?.snapshot) return onlineGuest.snapshot.view;
  const s = state!;
  if (mode === "hotseat") return getPlayerView(s, screenOwner);
  const main = getPlayerView(s, decider());
  const other = decider() === "P1" ? "P2" : "P1";
  return { ...main, players: { ...main.players, [other]: getPlayerView(s, other).players[other] } };
}

/** Joueur affiché en bas de l'écran. */
const bottomPlayer = (): PlayerId => onlineMe() ?? (mode === "solo" ? "P1" : screenOwner);

// ---------------------------------------------------------------------------
// Actions rattachées aux cartes
// ---------------------------------------------------------------------------

/** Carte à laquelle une action est rattachée (on clique sur cette carte pour la voir). */
function anchorOf(a: Action): string | null {
  switch (a.type) {
    case "PLAY_CARD":
    case "COMBO":
    case "ACTIVATE":
    case "SUCCESSOR":
    case "OVER_REALM":
    case "DECLARE_COUNTER":
    case "PLAY_Z":
    case "Z_AWAKEN":
      return a.uid;
    case "CHARGE_ENERGY":
    case "DECLARE_BLOCKER":
    case "COMBO_TO_Z_ENERGY":
      return a.uid;
    case "ATTACK":
      return a.attacker;
    case "AWAKEN":
      return `${a.player}-L`;
    default:
      return null;
  }
}

/** Décisions où l'on choisit des cartes en cliquant dessus, puis on valide. */
const PICK_DECISIONS = ["CHOOSE_CARDS", "TAKE_DAMAGE", "CHOOSE_LIFE", "CHOOSE_BLIND"];

/** Ce qui peut être coché pour la décision en cours : identifiant de carte ou de position. */
function pickables(view: PlayerView): Set<string> {
  const p = view.pending;
  if (!p) return new Set();
  switch (p.type) {
    case "CHOOSE_CARDS":
      return new Set(p.options);
    case "TAKE_DAMAGE":
    case "CHOOSE_LIFE":
      return new Set(view.players[p.player].life.map((_, i) => `life:${p.player}:${i}`));
    case "CHOOSE_BLIND":
      return new Set(view.players[p.owner].hand.map((_, i) => `hand:${p.owner}:${i}`));
    default:
      return new Set();
  }
}

/** Bornes du nombre de choix pour la décision en cours. */
function pickBounds(view: PlayerView): { min: number; max: number } {
  const p = view.pending!;
  if (p.type === "TAKE_DAMAGE") {
    const n = Math.min(p.amount, view.players[p.player].life.length);
    return { min: n, max: n };
  }
  if (p.type === "CHOOSE_CARDS" || p.type === "CHOOSE_LIFE" || p.type === "CHOOSE_BLIND") return { min: p.min, max: p.max };
  return { min: 0, max: 0 };
}

/** Transforme les cases cochées en coup du moteur. */
function pickedAction(view: PlayerView): Action | null {
  const p = view.pending!;
  const positions = () => [...picked].map((id) => Number(id.split(":")[2]));
  switch (p.type) {
    case "CHOOSE_CARDS":
      return { type: "CHOOSE_CARDS", player: p.player, uids: [...picked] };
    case "TAKE_DAMAGE":
      return { type: "TAKE_LIFE", player: p.player, indices: positions() };
    case "CHOOSE_LIFE":
      return { type: "CHOOSE_LIFE", player: p.player, indices: positions() };
    case "CHOOSE_BLIND":
      return { type: "CHOOSE_BLIND", player: p.player, indices: positions() };
    default:
      return null;
  }
}

/** Le joueur qui décide peut-il choisir ses Énergies pour payer ? */
const paymentPossible = () =>
  currentActions.some((a) => ["PLAY_CARD", "COMBO", "ACTIVATE", "SUCCESSOR", "DECLARE_COUNTER"].includes(a.type));

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------

const esc = (text: string): string =>
  text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const isVisible = (c: CardView): c is VisibleCard => "uid" in c;

const KEYWORD_NAMES: Record<string, string> = {
  blocker: "Bloqueur",
  critical: "Coup Critique",
  double_strike: "Double Frappe",
  triple_strike: "Triple Frappe",
  quadruple_strike: "Quadruple Frappe",
  dual_attack: "Réplique",
  tri_attack: "Tri-offensive",
  energy_exhaust: "Fuite d'énergie",
  unique: "Unique",
  ultimate: "Ultimate",
  super_combo: "Super Combo",
  deflect: "Déflexion",
  successor: "Successeur",
  over_realm: "Espace-temps",
};

const colorDots = (colors: readonly string[]) =>
  colors.map((c) => `<span class="dot dot-${c}" title="${COLOR_NAMES[c] ?? c}"></span>`).join("");

function costText(def: CardDefinition): string {
  if (!def.cost) return "";
  const orbs = Object.entries(def.cost.specified)
    .map(([c, n]) => `${n} ${COLOR_NAMES[c] ?? c}`)
    .join(" + ");
  return `Coût ${def.cost.total}${orbs ? ` (${orbs})` : ""}`;
}

interface RenderInfo {
  view: PlayerView;
  actionable: Set<string>;
  pickable: Set<string>;
}

/** Texte d'aide au survol : nom complet et capacités. */
function hoverText(def: CardDefinition | undefined, cardId: string): string {
  if (!def) return cardId;
  const texts = def.abilities.map((a) => String(a["text"] ?? "")).filter(Boolean);
  return [`${def.name} (${cardId})`, ...texts].join("\n\n");
}

/**
 * Une carte en miniature. `position` (ex. « life:P1:3 ») sert quand on choisit des cartes par
 * leur place (Vie, main adverse à l'aveugle) ; sinon la carte est identifiée par son uid.
 * Le détail complet (avec le texte des capacités) s'affiche à droite quand on la sélectionne.
 */
function cardBox(c: CardView, info: RenderInfo, position?: string): string {
  if (!isVisible(c)) {
    // Carte cachée (main adverse, Vie) : elle peut quand même être cochée par position.
    const id = position ?? "";
    const classes = ["card", "mini", "hidden-card", info.pickable.has(id) ? "pickable" : "", picked.has(id) ? "picked" : ""];
    return `<div class="${classes.join(" ")}" ${id ? `data-slot="${esc(id)}"` : ""}>?</div>`;
  }
  const def = db.get(c.cardId);
  const id = position && info.pickable.has(position) ? position : c.uid;
  const classes = [
    "card",
    "mini",
    c.mode === "rest" ? "rest" : "",
    info.actionable.has(c.uid) ? "actionable" : "",
    info.pickable.has(id) ? "pickable" : "",
    picked.has(id) ? "picked" : "",
    selectedCard === c.uid ? "selected" : "",
    selectedEnergy.has(c.uid) ? "paying" : "",
  ];
  const cost = def?.cost ? `${def.cost.total}` : "";
  const power = def?.power !== undefined ? `${def.power / 1000}k` : def?.type === "extra" ? "Extra" : "";
  return `
    <div class="${classes.join(" ")}" data-card="${esc(c.uid)}" data-slot="${esc(id)}" title="${esc(hoverText(def, c.cardId))}">
      <div class="mini-top">${colorDots(def?.colors ?? [])}<span class="mini-cost">${cost}</span></div>
      <div class="mini-name">${esc(def?.name ?? c.cardId)}</div>
      <div class="mini-power">${power}${def?.combo ? ` <span class="mini-combo">+${def.combo.power / 1000}k</span>` : ""}${
        c.markers !== undefined ? ` <span class="markers">◆${c.markers}</span>` : ""
      }</div>
    </div>`;
}

function leaderBox(leader: LeaderState, info: RenderInfo): string {
  const def = db.get(leader.cardId);
  const face = leader.z ? db.get(leader.z.cardId) : leader.side === "front" ? def?.front : def?.back;
  const classes = [
    "card",
    "mini",
    "leader",
    leader.mode === "rest" ? "rest" : "",
    info.actionable.has(leader.uid) ? "actionable" : "",
    info.pickable.has(leader.uid) ? "pickable" : "",
    picked.has(leader.uid) ? "picked" : "",
    selectedCard === leader.uid ? "selected" : "",
  ];
  const texts = face?.abilities.map((a) => String(a["text"] ?? "")).filter(Boolean) ?? [];
  return `
    <div class="${classes.join(" ")}" data-card="${esc(leader.uid)}" data-slot="${esc(leader.uid)}" title="${esc(
      [face?.name ?? "", ...texts].join("\n\n"),
    )}">
      <div class="mini-top">${colorDots(face?.colors ?? [])}<span class="mini-cost">${leader.z ? "Leader Z" : leader.side === "front" ? "Leader" : "Éveillé"}</span></div>
      <div class="mini-name">${esc(face?.name ?? leader.cardId)}</div>
      <div class="mini-power">${(face?.power ?? 0) / 1000}k</div>
    </div>`;
}

/** Une zone sur UNE ligne : si elle déborde, elle défile horizontalement. */
function zone(title: string, cards: readonly CardView[], info: RenderInfo, slotPrefix?: string, extraClass = ""): string {
  const content =
    cards.length > 0
      ? cards.map((c, i) => cardBox(c, info, slotPrefix ? `${slotPrefix}:${i}` : undefined)).join("")
      : `<span class="empty">—</span>`;
  return `<div class="zone ${extraClass}"><div class="zone-title">${title} (${cards.length})</div><div class="cards strip">${content}</div></div>`;
}

function playerArea(p: PlayerZonesView, info: RenderInfo, top: boolean): string {
  const deciding = state?.pending?.player === p.id;
  const head = `<div class="pl-head">
      <b>${p.id}</b>${deciding ? ` <span class="turn-badge">à vous de jouer</span>` : ""}
      <span class="counter">Deck <b>${p.deckCount}</b></span>
      <span class="counter">Main <b>${p.hand.length}</b></span>
      <span class="counter">Marqueurs <b>${p.energyMarkers}</b></span>
      <span class="counter" title="${esc(p.drop.map((c) => (isVisible(c) ? cardName(db, c.cardId) : "?")).join(", "))}">Dispersion <b>${p.drop.length}</b></span>
      <span class="counter">Dim. parallèle <b>${p.warp.length}</b></span>
      ${p.removed.length ? `<span class="counter">Retirées <b>${p.removed.length}</b></span>` : ""}
    </div>`;
  const field = `<div class="pl-row">
      <div class="zone"><div class="zone-title">Leader</div><div class="cards">${leaderBox(p.leader, info)}</div></div>
      ${zone("Vie", p.life, info, `life:${p.id}`, "life")}
      ${zone("Énergie", p.energy, info, undefined, "grow")}
      ${zone("Unisson", p.unison, info)}
      ${p.combo.length > 0 ? zone("Combo", p.combo, info) : ""}
      ${zone("Énergie Z", p.zEnergy, info)}
    </div>`;
  const battle = `<div class="pl-row">${zone("Zone de Combat", p.battle, info, undefined, "grow")}</div>`;
  const hand = `<div class="pl-row">${zone("Main", p.hand, info, `hand:${p.id}`, "grow")}${dropPile(p, info)}${zPile(p, info)}</div>`;
  // Disposition comme sur une table : la main au bord, la Zone de Combat vers le centre.
  const rows = top ? [head, hand, field, battle] : [head, battle, field, hand];
  return `<section class="player ${deciding ? "deciding" : ""}">${rows.join("")}</section>`;
}

/** Deck Z : une pile d'une seule carte face cachée ; un clic l'ouvre dans le panneau de droite. */
function zPile(p: PlayerZonesView, info: RenderInfo): string {
  const hasAction = p.zDeck.some((c) => isVisible(c) && info.actionable.has(c.uid));
  const classes = ["card", "mini", "zpile", hasAction ? "actionable" : "", openZDeck === p.id ? "selected" : ""];
  return `<div class="zone"><div class="zone-title">Deck Z</div><div class="cards">
    <div class="${classes.join(" ")}" data-zpile="${p.id}" title="Cliquer pour ouvrir / fermer le deck Z">
      <div class="mini-name">Deck Z</div><div class="mini-power">${p.zDeck.length} carte(s)</div>
      <div class="mini-combo">${openZDeck === p.id ? "fermer" : "ouvrir"}</div>
    </div></div></div>`;
}

/**
 * Dispersion : une pile ; un clic l'ouvre dans le panneau de droite. Surlignée quand une de ses
 * cartes peut agir (ex. Zarbon, Élite cosmique) ou doit être choisie.
 */
function dropPile(p: PlayerZonesView, info: RenderInfo): string {
  const busy = p.drop.some((c) => info.actionable.has(c.uid) || info.pickable.has(c.uid));
  const top = p.drop[p.drop.length - 1];
  const classes = ["card", "mini", "zpile", "droppile", busy ? "actionable" : "", openDrop === p.id ? "selected" : ""];
  return `<div class="zone"><div class="zone-title">Dispersion</div><div class="cards">
    <div class="${classes.join(" ")}" data-droppile="${p.id}" title="Cliquer pour ouvrir / fermer la Dispersion">
      <div class="mini-name">${top ? esc(cardName(db, top.cardId)) : "Dispersion"}</div><div class="mini-power">${p.drop.length} carte(s)</div>
      <div class="mini-combo">${openDrop === p.id ? "fermer" : "ouvrir"}</div>
    </div></div></div>`;
}

/** Contenu de la Dispersion ouverte (zone publique). S'ouvre d'elle-même s'il faut y choisir une carte. */
function dropPanel(view: PlayerView, info: RenderInfo): string {
  const auto = (["P1", "P2"] as const).find((id) => view.players[id].drop.some((c) => info.pickable.has(c.uid)));
  const owner = openDrop ?? auto;
  if (!owner) return "";
  const p = view.players[owner];
  const content = p.drop.length > 0 ? [...p.drop].reverse().map((c) => cardBox(c, info)).join("") : `<span class="empty">vide</span>`;
  return `<div class="detail"><div class="zone-title">Dispersion de ${p.id} (${p.drop.length}) ${
    openDrop === owner ? `<button data-droppile="${p.id}">Fermer</button>` : ""
  }</div><div class="cards zdeck-open">${content}</div></div>`;
}

/** Contenu du deck Z ouvert (cartes visibles seulement pour leur propriétaire). */
function zDeckPanel(view: PlayerView, info: RenderInfo): string {
  if (!openZDeck) return "";
  const p = view.players[openZDeck];
  const visible = p.zDeck.filter(isVisible);
  const content =
    visible.length > 0
      ? visible.map((c) => cardBox(c, info)).join("")
      : p.zDeck.length > 0
        ? `<span class="hint">Cartes cachées (deck Z adverse).</span>`
        : `<span class="empty">vide</span>`;
  return `<div class="detail"><div class="zone-title">Deck Z de ${p.id} (${p.zDeck.length}) <button data-zpile="${p.id}">Fermer</button></div>
    <div class="cards zdeck-open">${content}</div></div>`;
}

/** Fiche détaillée de la carte sélectionnée (avec le texte de ses capacités). */
function cardDetail(view: PlayerView): string {
  if (!selectedCard) return "";
  let def: CardDefinition | undefined;
  let face: { name: string; colors: readonly string[]; power?: number; abilities: Record<string, unknown>[] } | undefined;
  for (const p of Object.values(view.players)) {
    if (p.leader.uid === selectedCard) {
      def = db.get(p.leader.z?.cardId ?? p.leader.cardId);
      face = p.leader.z ? def : p.leader.side === "front" ? def?.front : def?.back;
    }
    for (const z of [p.hand, p.battle, p.energy, p.combo, p.zEnergy, p.zDeck, p.unison, p.drop, p.warp, p.removed]) {
      const c = z.find((x) => isVisible(x) && x.uid === selectedCard);
      if (c && isVisible(c)) {
        def = db.get(c.cardId);
        face = def;
      }
    }
  }
  if (!def || !face) return "";
  const keywords = def.keywords.map((k) => KEYWORD_NAMES[k.id] ?? k.id);
  const texts = face.abilities.map((a) => String(a["text"] ?? "")).filter(Boolean);
  return `<div class="detail">
    <div class="card-name">${colorDots(face.colors)} ${esc(face.name)} <span class="hint">${esc(def.id)}</span></div>
    <div class="card-line">${esc(def.type)}${def.cost ? ` · ${esc(costText(def))}` : ""}${face.power !== undefined ? ` · <b>${face.power}</b>` : ""}${
      def.combo ? ` · Combo +${def.combo.power} (coût ${def.combo.cost})` : ""
    }</div>
    ${keywords.length ? `<div class="card-line kw">${esc(keywords.join(", "))}</div>` : ""}
    ${texts.map((x) => `<div class="ability">${esc(x)}</div>`).join("")}
  </div>`;
}

function counterSummary(view: PlayerView): string {
  const w = view.counterWindow;
  if (!w) return "";
  const what = w.event.on === "play" ? `mise en jeu de ${esc(cardName(db, w.event.cardId))}` : "attaque";
  const chain = w.chain.map((l) => `${l.player} : ${esc(cardName(db, l.cardId))}`).join(" → ");
  return `<div class="battle">🛡 Fenêtre de contre (${what})${chain ? ` — contres déclarés : ${chain}` : ""}</div>`;
}

function battleSummary(view: PlayerView): string {
  const b = view.battle;
  if (!b) return "";
  const target = b.target.uid !== b.defender.uid ? ` (bloqué, cible d'origine : ${esc(nameOf(view, db, b.target.uid))})` : "";
  return `<div class="battle">⚔ Combat : <b>${esc(nameOf(view, db, b.attacker.uid))}</b> attaque <b>${esc(
    nameOf(view, db, b.defender.uid),
  )}</b>${target}</div>`;
}

const button = (a: Action, view: PlayerView, extraClass = "") =>
  `<button class="${extraClass}" data-action="${currentActions.indexOf(a)}">${esc(describeAction(a, view, db))}</button>`;

function actionsPanel(view: PlayerView, info: RenderInfo): string {
  const me = decider();
  const online = onlineMe();
  const canSee = online ? view.pending?.player === online : mode === "solo" || view.pending?.player === screenOwner;
  let html = "";
  if (!view.result && canSee) {
    html += `<p class="prompt">${me} — ${esc(describePending(view.pending))}</p>`;
    const p = view.pending;
    // Cartes regardées (dessus du deck) : affichées comme des cartes cochables.
    if (p?.type === "CHOOSE_CARDS" && p.looked) {
      html += `<div class="zone"><div class="zone-title">Cartes regardées (vous seul les voyez)</div><div class="cards">${p.looked
        .map((c) => cardBox({ uid: c.uid, cardId: c.cardId, owner: me, mode: "active" }, info))
        .join("")}</div></div>`;
    }
    if (p && PICK_DECISIONS.includes(p.type)) {
      const { min, max } = pickBounds(view);
      const n = picked.size;
      const ok = n >= min && n <= max;
      const what = min === max ? `${min}` : `entre ${min} et ${max}`;
      html += `<p class="hint">Cliquez sur les cartes surlignées pour en choisir ${what} (choisies : ${n}).</p>`;
      html += `<button class="primary" data-validate ${ok ? "" : "disabled"}>Valider le choix</button>`;
    } else {
      // Actions de la carte sélectionnée.
      if (selectedCard) {
        const mine = currentActions.filter((a) => anchorOf(a) === selectedCard);
        html += `<div class="group"><h3>${esc(nameOf(view, db, selectedCard))}</h3>${
          mine.length ? mine.map((a) => button(a, view)).join("") : `<p class="hint">Aucune action pour cette carte maintenant.</p>`
        }</div>`;
      } else if (info.actionable.size > 0) {
        html += `<p class="hint">Cliquez sur une carte surlignée pour voir ce qu'elle peut faire.</p>`;
      }
      // Actions générales (sans carte associée).
      const general = currentActions.filter((a) => anchorOf(a) === null && a.type !== "CONCEDE");
      if (general.length) html += `<div class="group">${general.map((a) => button(a, view, "primary")).join("")}</div>`;
      if (paymentPossible()) {
        const custom = selectedEnergy.size > 0 || selectedMarkers > 0;
        const markers = view.players[me].energyMarkers;
        html += `<p class="hint">Paiement ${
          custom
            ? `<b>choisi</b> : ${selectedEnergy.size} Énergie(s) + ${selectedMarkers} marqueur(s) <button data-clear>Effacer</button>`
            : "automatique — pour choisir vous-même, cochez vos Énergies avec la touche Ctrl + clic"
        }${markers > 0 ? ` · Marqueurs : <input type="number" min="0" max="${markers}" value="${selectedMarkers}" data-markers>` : ""}</p>`;
      }
    }
  } else if (!view.result) {
    html += `<p class="prompt">En attente de ${view.pending?.player}${online ? " (votre adversaire)" : ""}…</p>`;
  }
  if (errorMessage) html += `<p class="error">Coup refusé : ${esc(errorMessage)}</p>`;
  const concede = currentActions.find((a) => a.type === "CONCEDE");
  if (concede) html += `<div class="group"><button class="danger" data-action="${currentActions.indexOf(concede)}">Abandonner</button></div>`;
  return html;
}

function render(): void {
  if (!hasGame()) {
    if (onlineHost || onlineGuest) showLobby();
    else showSetup();
    return;
  }
  if (onlineGuest) errorMessage = onlineGuest.lastError;
  if (state && mode === "hotseat" && !revealed && !state.result) {
    app.innerHTML = `
      <div class="pass-screen">
        <h1>Passez l'ordinateur à ${screenOwner}</h1>
        <p>Le joueur ${screenOwner} doit prendre une décision. L'autre joueur ne doit pas regarder l'écran.</p>
        <button data-reveal>Je suis ${screenOwner} : afficher mon jeu</button>
      </div>`;
    return;
  }
  const view = currentView();
  const me = decider();
  currentActions = legalActions();
  const info: RenderInfo = {
    view,
    actionable: new Set(currentActions.map(anchorOf).filter((x): x is string => x !== null)),
    pickable: pickables(view),
  };
  const bottom = bottomPlayer();
  const top = bottom === "P1" ? "P2" : "P1";
  const result = view.result
    ? `<div class="result">${view.result.kind === "win" ? `🏆 ${view.result.winner} gagne la partie` : "Match nul"} — ${esc(
        view.result.reason,
      )} <button data-new>Nouvelle partie</button></div>`
    : "";
  app.innerHTML = `
    <header>
      <div><b>DBS Masters — simulateur</b>${
        onlineMe() ? ` · en ligne (room ${esc(roomCode)}, vous êtes ${onlineMe()})` : ` · graine ${seed}`
      }</div>
      <div>Tour ${view.turnNumber} · joueur actif : <b>${view.turnPlayer}</b> · ${phaseName(view.phase)}</div>
      <div class="header-buttons">
        <button data-new>Nouvelle partie</button>
        ${onlineGuest ? "" : `<button data-export title="Télécharge la partie (pour signaler un bug)">Exporter</button>`}
        ${
          onlineMe()
            ? ""
            : `<label class="file-button" title="Recharge une partie exportée">Charger<input type="file" accept=".json,application/json" data-import hidden></label>`
        }
      </div>
    </header>
    ${result}
    ${netStatus ? `<div class="net-status">${esc(netStatus)}</div>` : ""}
    <main>
      <div class="board">
        ${playerArea(view.players[top], info, true)}
        ${battleSummary(view)}
        ${counterSummary(view)}
        ${playerArea(view.players[bottom], info, false)}
      </div>
      <aside>
        <div class="actions">${zDeckPanel(view, info)}${dropPanel(view, info)}${cardDetail(view)}${actionsPanel(view, info)}</div>
        <div class="log ${logHidden ? "collapsed" : ""}">
          <h3>Journal <button data-toggle-log>${logHidden ? "Afficher" : "Masquer"}</button></h3>
          ${
            logHidden
              ? ""
              : log
                  .slice(-80)
                  .reverse()
                  .map((line) => `<div class="${line.startsWith("⚠") ? "warn" : ""}">${esc(line)}</div>`)
                  .join("")
          }
        </div>
      </aside>
    </main>`;
  // Quand il faut choisir des cartes, on les amène à l'écran.
  if (info.pickable.size > 0 && picked.size === 0) {
    document.querySelector(".card.pickable")?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

// ---------------------------------------------------------------------------
// Clics
// ---------------------------------------------------------------------------

app.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const el = target.closest<HTMLElement>(
    "[data-action],[data-reveal],[data-new],[data-clear],[data-export],[data-start],[data-validate],[data-slot],[data-toggle-log],[data-zpile],[data-droppile],[data-host],[data-join]",
  );
  if (!el) return;
  if (el.dataset["zpile"] !== undefined) {
    const owner = el.dataset["zpile"] as PlayerId;
    openZDeck = openZDeck === owner ? null : owner;
    return render();
  }
  if (el.dataset["droppile"] !== undefined) {
    const owner = el.dataset["droppile"] as PlayerId;
    openDrop = openDrop === owner ? null : owner;
    return render();
  }
  if (el.dataset["toggleLog"] !== undefined) {
    logHidden = !logHidden;
    try {
      localStorage.setItem("dbscg.logHidden", logHidden ? "1" : "0");
    } catch {
      // Stockage indisponible : la préférence ne sera simplement pas mémorisée.
    }
    return render();
  }
  if (el.dataset["action"] !== undefined) return act(currentActions[Number(el.dataset["action"])]!);
  if (el.dataset["validate"] !== undefined) {
    const action = pickedAction(currentView());
    if (action) act(action);
    return;
  }
  if (el.dataset["export"] !== undefined) return exportGame();
  if (el.dataset["start"] !== undefined) return newGame();
  if (el.dataset["host"] !== undefined) return createRoom();
  if (el.dataset["join"] !== undefined) {
    const input = app.querySelector<HTMLInputElement>("[data-code]");
    return joinGame(input?.value ?? "");
  }
  if (el.dataset["new"] !== undefined) {
    leaveOnline();
    state = null;
    return showSetup();
  }
  if (el.dataset["reveal"] !== undefined) {
    revealed = true;
    return render();
  }
  if (el.dataset["clear"] !== undefined) {
    selectedEnergy.clear();
    selectedMarkers = 0;
    return render();
  }
  const slot = el.dataset["slot"];
  if (slot === undefined || !hasGame()) return;
  const view = currentView();
  // 1) Décision « choisissez des cartes » : on coche / décoche.
  const pickable = pickables(view);
  if (pickable.has(slot)) {
    if (picked.has(slot)) picked.delete(slot);
    else {
      const { max } = pickBounds(view);
      if (max === 1) picked.clear();
      if (picked.size < max) picked.add(slot);
    }
    return render();
  }
  const uid = el.dataset["card"];
  if (!uid) return;
  // 2) Ctrl + clic sur une de ses Énergies : choisir soi-même le paiement.
  const energyOfDecider = view.players[decider()].energy.some((c) => isVisible(c) && c.uid === uid);
  if ((event as MouseEvent).ctrlKey && energyOfDecider && paymentPossible()) {
    if (selectedEnergy.has(uid)) selectedEnergy.delete(uid);
    else selectedEnergy.add(uid);
    return render();
  }
  // 3) Sinon : sélectionner la carte pour voir ses actions.
  selectedCard = selectedCard === uid ? null : uid;
  render();
});

app.addEventListener("change", (event) => {
  const el = event.target as HTMLInputElement;
  if (el.dataset["myPrompt"] !== undefined) {
    myPrompt = el.checked ? "always" : "only_if_playable";
  } else if (el.dataset["prompt"] !== undefined) {
    counterPrompt[el.dataset["prompt"] as PlayerId] = el.checked ? "always" : "only_if_playable";
  } else if (el.dataset["mode"] !== undefined) {
    mode = el.dataset["mode"] as Mode;
    netStatus = "";
    // Deux joueurs : par défaut, on demande toujours (pour ne rien révéler à l'adversaire).
    const prompt: CounterPrompt = mode === "hotseat" ? "always" : "only_if_playable";
    counterPrompt.P1 = prompt;
    counterPrompt.P2 = prompt;
    showSetup();
  } else if (el.dataset["import"] !== undefined && el.files?.[0]) {
    void importGame(el.files[0]);
  } else if (el.dataset["markers"] !== undefined) {
    selectedMarkers = Math.max(0, Number(el.value) || 0);
    render();
  }
});

app.addEventListener("keydown", (event) => {
  const el = event.target as HTMLInputElement;
  if (el.dataset["code"] !== undefined && event.key === "Enter") joinGame(el.value);
});

showSetup();
