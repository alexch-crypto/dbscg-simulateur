// Interface dans le navigateur : les menus (menus.ts) puis la partie.
//
// Trois modes de partie :
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
import gogetaFile from "../../cards/gogeta.json";
import diversFile from "../../cards/divers.json";
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
  type PaymentChoice,
  type PlayerId,
  type PlayerView,
  type PlayerZonesView,
  type VisibleCard,
} from "../engine";
import { GUEST, HOST, OnlineGuest, OnlineHost, type HostMessage } from "../net/online";
import { hostRoom, joinRoom, normalizeCode, type GuestLink, type HostLink } from "../net/peer";
import { COLOR_NAMES, cardName, describeAction, describeEvent, describePending, nameOf, phaseName } from "./labels";
import { cardSheet, colorDots, costText, esc, isVisible, KEYWORD_NAMES } from "./common";
import { DeckStore, type SavedDeck } from "./decks";
import { goTo, leaveMenus, menuClick, menuInput, renderMenu, type MenuHost, type Mode } from "./menus";
import { applyTheme, loadPrefs, savePrefs } from "./prefs";
import { imageUrl, loadImages, setImagesEnabled } from "./images";
import "./style.css";

// ---------------------------------------------------------------------------
// Données et état de l'interface
// ---------------------------------------------------------------------------

const freezer = parseCardFile(freezerFile);
const gogeta = parseCardFile(gogetaFile);
const divers = parseCardFile(diversFile);
const db = buildCardDatabase([freezer.cards, gogeta.cards, divers.cards]);
const ctx: GameContext = { cards: db };

/** Préférences du joueur (pseudo, thème...) et ses decks, mémorisés dans le navigateur. */
const prefs = loadPrefs();
applyTheme(prefs.theme);
setImagesEnabled(prefs.showImages);
const decks = new DeckStore([
  { id: "freezer-base", name: "Freezer (deck de base)", list: freezer.deck!, builtIn: true },
  { id: "gogeta-base", name: "Gogeta GT (deck de base)", list: gogeta.deck!, builtIn: true },
]);
/** Decks et réglages de la dernière partie locale (pour « Rejouer »). */
let lastLocal: { decks: Record<PlayerId, SavedDeck>; prompts: Record<PlayerId, CounterPrompt> } | null = null;

let state: GameState | null = null;
let seed = 0;
/** Enregistrement de la partie (graine, decks, coups joués) pour l'export. */
let record: GameRecord;
let log: string[] = [];
let mode: Mode = "solo";
/** Jeu en ligne : rôle, objets de partie et de connexion, état de la connexion. */
let onlineHost: OnlineHost | null = null;
let onlineGuest: OnlineGuest | null = null;
let hostLink: HostLink | null = null;
let guestLink: GuestLink | null = null;
let roomCode = "";
let netStatus = "";
/** Mode deux joueurs : joueur devant l'écran, et écran de passage affiché ou non. */
let screenOwner: PlayerId = "P1";
let revealed = false;
let errorMessage = "";

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
/**
 * Geste en cours sur le plateau, avant d'envoyer le coup (on peut encore annuler) :
 *  - attack : une carte est choisie pour attaquer, on clique sur sa cible ;
 *  - pay    : on choisit soi-même les Énergies à passer en mode Inertie.
 */
type Intent = { kind: "attack"; attacker: string; target: string | null } | { kind: "pay"; action: Paid };
let intent: Intent | null = null;
/** Décision pour laquelle les cartes ont déjà été pré-sélectionnées (choix d'une seule carte possible). */
let preselectedFor = "";

const app = document.getElementById("app")!;

// ---------------------------------------------------------------------------
// Partie : création, coups, export / import
// ---------------------------------------------------------------------------

/** Menus du site (accueil, Jouer, decks, cartes, paramètres). */
const menuHost: MenuHost = {
  db,
  decks,
  prefs,
  netStatus: () => netStatus,
  canResume: () => state !== null && !state.result && !onlineHost && !onlineGuest,
  resume: () => {
    inMenu = false;
    leaveMenus();
    render();
  },
  startLocal: (chosenMode, chosen, prompts) => {
    mode = chosenMode;
    lastLocal = { decks: chosen, prompts };
    newGame();
  },
  createRoom: (deck, prompt) => createRoom(deck, prompt),
  joinRoom: (code, deck, prompt) => joinGame(code, deck, prompt),
  render: () => showMenu(),
};

/** true tant que le joueur est dans les menus (et pas sur le plateau). */
let inMenu = true;

function showMenu(): void {
  inMenu = true;
  app.innerHTML = renderMenu(menuHost);
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
function createRoom(deck: SavedDeck, prompt: CounterPrompt): void {
  leaveOnline();
  // Une partie en ligne remplace la partie locale éventuellement en cours.
  state = null;
  mode = "online";
  inMenu = false;
  leaveMenus();
  log = [];
  resetSelection();
  roomCode = "";
  onlineHost = new OnlineHost(
    ctx,
    deck.list,
    prompt,
    (msg: HostMessage) => hostLink?.send(msg),
    (events) => {
      if (onlineHost?.record) seed = onlineHost.record.seed;
      addToLog(events);
      render();
    },
  );
  onlineHost.names.P1 = prefs.pseudo;
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
function joinGame(code: string, deck: SavedDeck, prompt: CounterPrompt): void {
  const clean = normalizeCode(code);
  if (clean.length < 4) {
    netStatus = "Entrez le code donné par votre adversaire.";
    return showMenu();
// Images des cartes enregistrées dans ce navigateur : on redessine une fois chargées.
void loadImages().then(() => render());
  }
  leaveOnline();
  // Une partie en ligne remplace la partie locale éventuellement en cours.
  state = null;
  mode = "online";
  inMenu = false;
  leaveMenus();
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
      onlineGuest?.hello(deck.list, prompt, prefs.pseudo);
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
        netStatus = message;
        goTo("play");
        return showMenu();
      }
      render();
    },
  });
  render();
}

function resetSelection(): void {
  intent = null;
  selectedCard = null;
  picked.clear();
  selectedEnergy.clear();
  selectedMarkers = 0;
}

function newGame(): void {
  if (!lastLocal) return showMenu();
  seed = Math.floor(Math.random() * 1_000_000);
  const lists = { P1: lastLocal.decks.P1.list, P2: lastLocal.decks.P2.list };
  const counterPrompt = { ...lastLocal.prompts };
  const result = createGame({ decks: lists, seed, counterPrompt }, db);
  if (!result.ok) {
    netStatus = `Deck invalide : ${result.errors.join(" ; ")}`;
    return showMenu();
  }
  inMenu = false;
  leaveMenus();
  netStatus = "";
  state = result.state;
  record = newRecord(seed, lists, counterPrompt);
  log = [];
  addToLog(result.events);
  errorMessage = "";
  resetSelection();
  screenOwner = state.pending!.player;
  revealed = false;
  render();
}

/** Coups de l'adversaire annoncés par une notification en ligne. */
const TOAST_EVENTS = new Set<GameEvent["type"]>([
  "PLAY_DECLARED",
  "CARD_PLAYED_BY_SKILL",
  "ATTACK_DECLARED",
  "BLOCKER_DECLARED",
  "COUNTER_DECLARED",
  "ABILITY_ACTIVATED",
  "SUCCESSOR_ACTIVATED",
  "OVER_REALM_ACTIVATED",
  "Z_PLAY_DECLARED",
  "AWAKEN_ACTIVATED",
  "COMBO",
  "TOKEN_CREATED",
]);

function addToLog(events: GameEvent[]): void {
  const view = currentView();
  const me = onlineMe();
  for (const e of events) {
    const text = describeEvent(e, view, db);
    log.push(text);
    // En ligne : ce que fait l'adversaire, et les dégâts que l'on subit, s'affichent aussi en notification.
    if (!me || !("player" in e)) continue;
    if ((e.player !== me && TOAST_EVENTS.has(e.type)) || (e.type === "DAMAGE_DEALT" && e.player === me)) toast(text, e.type === "DAMAGE_DEALT");
  }
}

// ---------------------------------------------------------------------------
// Notifications et aperçu des cartes (hors de #app, qui est redessiné à chaque coup)
// ---------------------------------------------------------------------------

const toasts = document.createElement("div");
toasts.className = "toasts";
document.body.append(toasts);

function toast(text: string, danger = false): void {
  const el = document.createElement("div");
  el.className = `toast${danger ? " danger" : ""}`;
  el.textContent = text;
  toasts.append(el);
  setTimeout(() => el.classList.add("leaving"), 3500);
  setTimeout(() => el.remove(), 4000);
}

const preview = document.createElement("div");
preview.className = "preview";
document.body.append(preview);
let previewFor = "";

/** Aperçu lisible de la carte survolée (texte complet), placé à côté de la souris. */
document.addEventListener("mouseover", (event) => {
  const el = (event.target as HTMLElement).closest<HTMLElement>("[data-cid]");
  const cid = el?.dataset["cid"] ?? "";
  if (cid === previewFor) return;
  previewFor = cid;
  const def = cid ? db.get(cid) : undefined;
  if (!def) {
    preview.classList.remove("shown");
    return;
  }
  const img = imageUrl(cid, el?.dataset["back"] === "1");
  preview.innerHTML = img ? `<img class="preview-img" src="${img}" alt="">${cardSheet(def)}` : cardSheet(def);
  preview.classList.toggle("with-img", !!img);
  preview.classList.add("shown");
});
document.addEventListener("mousemove", (event) => {
  if (!preview.classList.contains("shown")) return;
  const pad = 18;
  const { innerWidth: w, innerHeight: h } = window;
  const r = preview.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + r.width > w - 8) x = event.clientX - r.width - pad;
  if (y + r.height > h - 8) y = Math.max(8, h - r.height - 8);
  preview.style.left = `${Math.max(8, x)}px`;
  preview.style.top = `${y}px`;
});
document.addEventListener("mousedown", () => {
  preview.classList.remove("shown");
  previewFor = "";
});

function act(action: Action): void {
  if (!hasGame()) return;
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
    case "UNION_FUSION":
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

/** Coup qui se paie en Énergies (jouer, activer, combo, contrer...). */
type Paid = Extract<Action, { payment: PaymentChoice }>;
const isPaid = (a: Action): a is Paid => "payment" in a;
const needed = (a: Paid): number => a.payment.energy.length + a.payment.markers;

/** Le joueur a-t-il vraiment le choix des Énergies pour payer ce coup ? */
function hasPaymentChoice(a: Action, view: PlayerView): a is Paid {
  if (!isPaid(a) || needed(a) === 0) return false;
  const p = view.players[a.player];
  const active = p.energy.filter((c) => isVisible(c) && c.mode === "active").length;
  return active + p.energyMarkers > needed(a);
}

/** Un bouton d'action : soit le coup part tout de suite, soit on passe en mode paiement. */
function startAction(a: Action): void {
  if (hasPaymentChoice(a, currentView())) {
    intent = { kind: "pay", action: a };
    selectedEnergy.clear();
    for (const uid of a.payment.energy) selectedEnergy.add(uid);
    selectedMarkers = a.payment.markers;
    errorMessage = "";
    return render();
  }
  act(a);
}

/** Cibles possibles d'une attaque avec `attacker`. */
const attackTargets = (attacker: string): string[] =>
  currentActions.flatMap((a) => (a.type === "ATTACK" && a.attacker === attacker ? [a.target] : []));

/** Le joueur de cet écran peut-il décider maintenant ? */
function canDecide(view: PlayerView): boolean {
  const online = onlineMe();
  return !view.result && (online ? view.pending?.player === online : mode === "solo" || view.pending?.player === screenOwner);
}

/** Texte court d'un bouton : le coup, sans le détail du paiement (choisi ensuite). */
const shortLabel = (a: Action, view: PlayerView): string => describeAction(a, view, db).replace(/ — (payer avec : .*|gratuit)$/, "");

// ---------------------------------------------------------------------------
// Affichage// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------

interface RenderInfo {
  view: PlayerView;
  actionable: Set<string>;
  pickable: Set<string>;
  /** Cibles possibles de l'attaque en cours de visée. */
  targets: Set<string>;
  /** Énergies qu'on peut cocher pour payer. */
  payable: Set<string>;
}

/** Classes d'une carte selon le geste en cours (visée, paiement). */
function gestureClasses(uid: string, info: RenderInfo): string[] {
  return [
    info.targets.has(uid) ? "targetable" : "",
    intent?.kind === "attack" && intent.target === uid ? "targeted" : "",
    intent?.kind === "attack" && intent.attacker === uid ? "attacking" : "",
    info.payable.has(uid) ? "payable" : "",
  ];
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
    ...gestureClasses(c.uid, info),
  ];
  const cost = def?.cost ? `${def.cost.total}` : "";
  const power = def?.power !== undefined ? `${def.power / 1000}k` : def?.type === "extra" ? "Extra" : "";
  return `
    <div class="${classes.join(" ")}${artStyle(c.cardId) ? " has-img" : ""}" data-card="${esc(c.uid)}" data-slot="${esc(id)}" data-cid="${esc(c.cardId)}"${artStyle(c.cardId)}>
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
    ...gestureClasses(leader.uid, info),
  ];
  return `
    <div class="${classes.join(" ")}${artStyle(leader.z?.cardId ?? leader.cardId, !leader.z && leader.side === "back") ? " has-img" : ""}" data-card="${esc(leader.uid)}" data-slot="${esc(leader.uid)}" data-cid="${esc(leader.z?.cardId ?? leader.cardId)}"${
      !leader.z && leader.side === "back" ? ` data-back="1"` : ""
    }${artStyle(leader.z?.cardId ?? leader.cardId, !leader.z && leader.side === "back")}>
      <div class="mini-top">${colorDots(face?.colors ?? [])}<span class="mini-cost">${leader.z ? "Leader Z" : leader.side === "front" ? "Leader" : "Éveillé"}</span></div>
      <div class="mini-name">${esc(face?.name ?? leader.cardId)}</div>
      <div class="mini-power">${(face?.power ?? 0) / 1000}k</div>
    </div>`;
}

/** Fond d'une carte miniature : son illustration (si le joueur a importé les images). */
function artStyle(cardId: string, back = false): string {
  const url = imageUrl(cardId, back);
  return url ? ` style="background-image: linear-gradient(transparent 35%, rgba(0,0,0,.8)), url('${url}')"` : "";
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
      <b>${playerLabel(p.id)}</b>${deciding ? ` <span class="turn-badge">à vous de jouer</span>` : ""}
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
  `<button class="${extraClass}" data-action="${currentActions.indexOf(a)}">${esc(shortLabel(a, view))}</button>`;

/**
 * Bandeau au-dessus du plateau : consigne du geste en cours (cible d'attaque, paiement) ou du
 * choix de cartes demandé par le moteur, avec Valider / Annuler.
 */
function promptBar(view: PlayerView, info: RenderInfo): string {
  if (!canDecide(view)) return "";
  const bar = (text: string, buttons: string, extra = "") =>
    `<div class="prompt-bar"><div class="prompt-text">${text}${extra}</div><div class="prompt-buttons">${buttons}</div></div>`;
  if (intent?.kind === "attack") {
    const who = esc(nameOf(view, db, intent.attacker));
    const text = intent.target
      ? `⚔ ${who} attaque <b>${esc(nameOf(view, db, intent.target))}</b>`
      : `⚔ Attaque avec ${who} : cliquez sur la cible (entourée en rouge)`;
    return bar(text, `<button class="primary" data-confirm ${intent.target ? "" : "disabled"}>Valider l'attaque</button><button data-cancel>Annuler</button>`);
  }
  if (intent?.kind === "pay") {
    const a = intent.action;
    const n = needed(a);
    const chosen = selectedEnergy.size + selectedMarkers;
    const markers = view.players[a.player].energyMarkers;
    const cost = a.type === "PLAY_CARD" ? cardCostHint(view, a.uid) : "";
    return bar(
      `💠 ${esc(shortLabel(a, view))} — choisissez ${n} Énergie(s) à passer en mode Inertie (${chosen}/${n})${cost}`,
      `<button class="primary" data-confirm ${chosen === n ? "" : "disabled"}>Payer</button><button data-cancel>Annuler</button>`,
      markers > 0 ? ` · marqueurs Énergie : <input type="number" min="0" max="${markers}" value="${selectedMarkers}" data-markers>` : "",
    );
  }
  const p = view.pending;
  if (p && PICK_DECISIONS.includes(p.type)) {
    const { min, max } = pickBounds(view);
    const n = picked.size;
    const what = min === max ? `${min}` : `${min} à ${max}`;
    return bar(
      `🎯 ${esc(describePending(p))} <span class="muted">(${what} · choisie(s) : ${n})</span>`,
      `<button class="primary" data-validate ${n >= min && n <= max ? "" : "disabled"}>Valider</button>`,
    );
  }
  return "";
}

/** Rappel du coût imprimé d'une carte de la main (couleurs à respecter). */
function cardCostHint(view: PlayerView, uid: string): string {
  for (const p of Object.values(view.players)) {
    const c = p.hand.find((x) => isVisible(x) && x.uid === uid);
    const def = c && isVisible(c) ? db.get(c.cardId) : undefined;
    if (def?.cost) return ` <span class="muted">(${esc(costText(def))})</span>`;
  }
  return "";
}

function actionsPanel(view: PlayerView, info: RenderInfo): string {
  const me = decider();
  const online = onlineMe();
  let html = "";
  if (canDecide(view)) {
    html += `<p class="prompt">${me} — ${esc(describePending(view.pending))}</p>`;
    const p = view.pending;
    // Cartes regardées (dessus du deck) : affichées comme des cartes cochables.
    if (p?.type === "CHOOSE_CARDS" && p.looked) {
      html += `<div class="zone"><div class="zone-title">Cartes regardées (vous seul les voyez)</div><div class="cards">${p.looked
        .map((c) => cardBox({ uid: c.uid, cardId: c.cardId, owner: me, mode: "active" }, info))
        .join("")}</div></div>`;
    }
    if (p && PICK_DECISIONS.includes(p.type)) {
      html += `<p class="hint">Cliquez sur les cartes entourées en vert, puis « Valider » dans le bandeau au-dessus du plateau.</p>`;
    } else if (intent?.kind === "pay") {
      html += `<p class="hint">Cliquez sur vos Énergies pour choisir celles à utiliser, puis « Payer » dans le bandeau. Celles proposées par défaut sont déjà cochées.</p>`;
    } else {
      // Actions de la carte sélectionnée (l'attaque se fait en cliquant sur la cible).
      if (selectedCard) {
        const mine = currentActions.filter((a) => anchorOf(a) === selectedCard && a.type !== "ATTACK");
        const attacks = attackTargets(selectedCard).length;
        html += `<div class="group"><h3>${esc(nameOf(view, db, selectedCard))}</h3>${
          attacks ? `<p class="hint">⚔ Pour attaquer : cliquez sur la cible entourée en rouge.</p>` : ""
        }${
          mine.length
            ? mine.map((a) => button(a, view)).join("")
            : attacks
              ? ""
              : `<p class="hint">Aucune action pour cette carte maintenant.</p>`
        }</div>`;
      } else if (info.actionable.size > 0) {
        html += `<p class="hint">Cliquez sur une carte entourée en orange pour voir ce qu'elle peut faire.</p>`;
      }
      // Actions générales (sans carte associée).
      const general = currentActions.filter((a) => anchorOf(a) === null && a.type !== "CONCEDE");
      if (general.length) html += `<div class="group">${general.map((a) => button(a, view, "primary")).join("")}</div>`;
    }
  } else if (!view.result) {
    html += `<p class="prompt">En attente de ${view.pending?.player}${online ? " (votre adversaire)" : ""}…</p>`;
  }
  if (errorMessage) html += `<p class="error">Coup refusé : ${esc(errorMessage)}</p>`;
  const concede = currentActions.find((a) => a.type === "CONCEDE");
  if (concede) html += `<div class="group"><button class="danger" data-action="${currentActions.indexOf(concede)}">Abandonner</button></div>`;
  return html;
}

/** Nom affiché d'un joueur : son pseudo en ligne s'il en a un. */
function playerLabel(p: PlayerId): string {
  const names = onlineHost?.names ?? onlineGuest?.names;
  const name = names?.[p];
  return name ? `${esc(name)} (${p})` : p;
}

function render(): void {
  if (inMenu) return showMenu();
  if (!hasGame()) {
    if (onlineHost || onlineGuest) showLobby();
    else showMenu();
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
  currentActions = legalActions();
  // Un geste dont le coup n'est plus proposé (la situation a changé) est abandonné.
  if (intent?.kind === "attack" && attackTargets(intent.attacker).length === 0) intent = null;
  if (intent?.kind === "pay" && !canDecide(view)) intent = null;
  const pickable = pickables(view);
  // Nouvelle décision « choisissez des cartes » : si une seule carte est possible (ou si toutes
  // doivent être prises), elle est pré-sélectionnée ; il ne reste qu'à valider.
  const decisionKey = canDecide(view) && view.pending && PICK_DECISIONS.includes(view.pending.type) ? JSON.stringify(view.pending) : "";
  const newDecision = decisionKey !== preselectedFor;
  if (newDecision) {
    preselectedFor = decisionKey;
    picked.clear();
    if (decisionKey) {
      const { min, max } = pickBounds(view);
      if (pickable.size === 1 || (min > 0 && pickable.size === min)) for (const id of [...pickable].slice(0, max)) picked.add(id);
    }
  }
  const info: RenderInfo = {
    view,
    actionable: intent?.kind === "pay" ? new Set() : new Set(currentActions.map(anchorOf).filter((x): x is string => x !== null)),
    pickable,
    targets: new Set(intent?.kind === "attack" ? attackTargets(intent.attacker) : []),
    payable: new Set(
      intent?.kind === "pay" ? view.players[intent.action.player].energy.flatMap((c) => (isVisible(c) && c.mode === "active" ? [c.uid] : [])) : [],
    ),
  };
  const bottom = bottomPlayer();
  const top = bottom === "P1" ? "P2" : "P1";
  const result = view.result
    ? `<div class="result">${view.result.kind === "win" ? `🏆 ${playerLabel(view.result.winner)} gagne la partie` : "Match nul"} — ${esc(
        view.result.reason,
      )} ${onlineMe() ? "" : `<button data-replay>Rejouer</button>`} <button data-new>Menu</button></div>`
    : "";
  app.innerHTML = `
    <header>
      <div><b>DBS Masters — simulateur</b>${
        onlineMe() ? ` · en ligne (room ${esc(roomCode)}, vous êtes ${playerLabel(onlineMe()!)})` : ` · graine ${seed}`
      }</div>
      <div>Tour ${view.turnNumber} · joueur actif : <b>${view.turnPlayer}</b> · ${phaseName(view.phase)}</div>
      <div class="header-buttons">
        <button data-new title="Retour au menu">☰ Menu</button>
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
        ${promptBar(view, info)}
        ${playerArea(view.players[top], info, true)}
        ${battleSummary(view)}
        ${counterSummary(view)}
        ${playerArea(view.players[bottom], info, false)}
      </div>
      <aside>
        <div class="actions">${zDeckPanel(view, info)}${dropPanel(view, info)}${cardDetail(view)}${actionsPanel(view, info)}</div>
        <div class="log ${prefs.logHidden ? "collapsed" : ""}">
          <h3>Journal <button data-toggle-log>${prefs.logHidden ? "Afficher" : "Masquer"}</button></h3>
          ${
            prefs.logHidden
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
  if (info.pickable.size > 0 && newDecision) {
    document.querySelector(".card.pickable")?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

// ---------------------------------------------------------------------------
// Clics
// ---------------------------------------------------------------------------

app.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (inMenu) {
    const menuEl = target.closest<HTMLElement>("button, [data-gallery-card], [data-deck-plus], [data-deck-minus]");
    if (menuEl) menuClick(menuEl, menuHost);
    return;
  }
  const el = target.closest<HTMLElement>(
    "[data-action],[data-reveal],[data-new],[data-replay],[data-export],[data-validate],[data-confirm],[data-cancel],[data-slot],[data-toggle-log],[data-zpile],[data-droppile]",
  );
  if (!el) return;
  if (el.dataset["cancel"] !== undefined) {
    intent = null;
    selectedEnergy.clear();
    selectedMarkers = 0;
    return render();
  }
  if (el.dataset["confirm"] !== undefined) {
    if (intent?.kind === "attack" && intent.target) {
      const { attacker, target: aimed } = intent;
      const a = currentActions.find((x) => x.type === "ATTACK" && x.attacker === attacker && x.target === aimed);
      if (a) return act(a);
    }
    if (intent?.kind === "pay") {
      return act({ ...intent.action, payment: { energy: [...selectedEnergy], markers: selectedMarkers } });
    }
    return;
  }
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
    prefs.logHidden = !prefs.logHidden;
    savePrefs(prefs);
    return render();
  }
  if (el.dataset["action"] !== undefined) return startAction(currentActions[Number(el.dataset["action"])]!);
  if (el.dataset["validate"] !== undefined) {
    const action = pickedAction(currentView());
    if (action) act(action);
    return;
  }
  if (el.dataset["export"] !== undefined) return exportGame();
  if (el.dataset["replay"] !== undefined) return newGame();
  if (el.dataset["new"] !== undefined) {
    // Retour au menu. Une partie locale en cours reste en mémoire (« Reprendre ») ; une partie en
    // ligne se termine (on demande d'abord).
    const online = onlineHost !== null || onlineGuest !== null;
    const playing = online && hasGame() && !currentView().result;
    if (playing && !window.confirm("Quitter la partie en ligne ? La connexion avec votre adversaire sera coupée.")) return;
    if (online) leaveOnline();
    if (state?.result) state = null;
    goTo(online || !state ? "play" : "home");
    return showMenu();
  }
  if (el.dataset["reveal"] !== undefined) {
    revealed = true;
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
  // 2) Mode paiement : cocher / décocher ses Énergies (les autres cartes ne réagissent pas).
  if (intent?.kind === "pay") {
    const mine = view.players[intent.action.player].energy.some((c) => isVisible(c) && c.uid === uid && c.mode === "active");
    if (mine) {
      if (selectedEnergy.has(uid)) selectedEnergy.delete(uid);
      else if (selectedEnergy.size + selectedMarkers < needed(intent.action)) selectedEnergy.add(uid);
    }
    return render();
  }
  // 3) Visée d'une attaque : un clic sur une cible la choisit (il reste à valider).
  if (intent?.kind === "attack" && attackTargets(intent.attacker).includes(uid)) {
    intent.target = intent.target === uid ? null : uid;
    return render();
  }
  // 4) Sinon : sélectionner la carte. Si elle peut attaquer, ses cibles s'allument ; s'il n'y en a
  // qu'une, elle est déjà visée.
  selectedCard = selectedCard === uid ? null : uid;
  const targets = selectedCard ? attackTargets(selectedCard) : [];
  intent = selectedCard && targets.length > 0 ? { kind: "attack", attacker: selectedCard, target: targets.length === 1 ? targets[0]! : null } : null;
  render();
});

app.addEventListener("input", (event) => {
  if (inMenu) menuInput(event.target as HTMLInputElement, menuHost, false);
});

app.addEventListener("change", (event) => {
  const el = event.target as HTMLInputElement;
  if (inMenu) {
    menuInput(el, menuHost, true);
    return;
  }
  if (el.dataset["import"] !== undefined && el.files?.[0]) {
    void importGame(el.files[0]);
  } else if (el.dataset["markers"] !== undefined) {
    selectedMarkers = Math.max(0, Number(el.value) || 0);
    render();
  }
});

app.addEventListener("keydown", (event) => {
  const el = event.target as HTMLInputElement;
  if (inMenu && el.dataset["code"] !== undefined && event.key === "Enter") {
    menuInput(el, menuHost, false);
    document.querySelector<HTMLElement>("[data-join]")?.click();
  }
});

showMenu();
