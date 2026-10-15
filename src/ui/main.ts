// Interface de test : deux joueurs sur le même écran (« hot seat »).
//
// Cette page joue le rôle de l'« hôte » : elle garde l'état complet de la partie et appelle
// le moteur. Mais elle n'AFFICHE que la vue du joueur assis devant l'écran (getPlayerView),
// exactement comme le fera plus tard le mode en ligne. Aucune règle du jeu n'est codée ici.

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
  type GameRecord,
  type CardDefinition,
  type CardView,
  type GameContext,
  type GameEvent,
  type GameState,
  type LeaderState,
  type PlayerId,
  type PlayerView,
  type PlayerZonesView,
  type VisibleCard,
} from "../engine";
import { COLOR_NAMES, cardName, describeAction, describeEvent, describePending, nameOf, phaseName } from "./labels";
import "./style.css";

// ---------------------------------------------------------------------------
// Données et état de l'interface
// ---------------------------------------------------------------------------

const freezer = parseCardFile(freezerFile);
const db = buildCardDatabase([freezer.cards]);
const ctx: GameContext = { cards: db };

let state: GameState;
let seed = 0;
/** Enregistrement de la partie (graine, decks, coups joués) pour l'export. */
let record: GameRecord;
let log: string[] = [];
/** Joueur actuellement devant l'écran (dont on affiche la vue). */
let screenOwner: PlayerId = "P1";
/** false = écran « passez l'ordinateur » affiché, rien de secret n'est visible. */
let revealed = false;
let errorMessage = "";
/** Paiement personnalisé : Énergies sélectionnées en cliquant dessus, et marqueurs. */
const selectedEnergy = new Set<string>();
let selectedMarkers = 0;
/** Coups proposés actuellement (les boutons y font référence par leur position). */
let currentActions: Action[] = [];

const app = document.getElementById("app")!;

function newGame(): void {
  seed = Math.floor(Math.random() * 1_000_000);
  const decks = { P1: freezer.deck!, P2: freezer.deck! };
  const result = createGame({ decks, seed }, db);
  if (!result.ok) {
    app.textContent = `Deck invalide : ${result.errors.join(" ; ")}`;
    return;
  }
  state = result.state;
  record = newRecord(seed, decks);
  log = [];
  addToLog(result.events, "P1");
  errorMessage = "";
  clearSelection();
  screenOwner = state.pending!.player;
  revealed = false;
  render();
}

function addToLog(events: GameEvent[], viewer: PlayerId): void {
  const view = getPlayerView(state, viewer);
  for (const e of events) log.push(describeEvent(e, view, db));
}

function clearSelection(): void {
  selectedEnergy.clear();
  selectedMarkers = 0;
}

function act(action: Action): void {
  // Paiement personnalisé : remplace le paiement suggéré par la sélection du joueur.
  if ((action.type === "PLAY_CARD" || action.type === "COMBO") && (selectedEnergy.size > 0 || selectedMarkers > 0)) {
    action = { ...action, payment: { energy: [...selectedEnergy], markers: selectedMarkers } };
  }
  const r = applyAction(state, action, ctx);
  if (!r.ok) {
    errorMessage = r.error;
    render();
    return;
  }
  state = r.state;
  record.actions.push(action);
  errorMessage = "";
  clearSelection();
  addToLog(r.events, action.player);
  // Si c'est maintenant à l'autre joueur de décider, on cache l'écran.
  const next = state.pending?.player;
  if (next && next !== screenOwner) {
    screenOwner = next;
    revealed = false;
  }
  render();
}

/** Télécharge l'enregistrement de la partie (fichier JSON). */
function exportGame(): void {
  const blob = new Blob([JSON.stringify(record, null, 1)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `partie-${seed}-coup${record.actions.length}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/** Charge un fichier de partie et rejoue tous ses coups. */
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
  addToLog(replay.events, "P1");
  log.push(`(Partie chargée : ${loaded.actions.length} coups rejoués.)`);
  errorMessage = "";
  clearSelection();
  screenOwner = state.pending?.player ?? "P1";
  revealed = false;
  render();
}

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------

const esc = (text: string): string =>
  text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const isVisible = (c: CardView): c is VisibleCard => "uid" in c;

/** Mots-clés gérés par le moteur, affichés sur les cartes. */
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
};

function colorDots(colors: readonly string[]): string {
  return colors.map((c) => `<span class="dot dot-${c}" title="${COLOR_NAMES[c] ?? c}"></span>`).join("");
}

function costText(def: CardDefinition): string {
  if (!def.cost) return "";
  const orbs = Object.entries(def.cost.specified)
    .map(([c, n]) => `${n} ${COLOR_NAMES[c] ?? c}`)
    .join(" + ");
  return `Coût ${def.cost.total}${orbs ? ` (dont ${orbs})` : ""}`;
}

function cardBox(c: CardView, options: { selectable?: boolean } = {}): string {
  if (!isVisible(c)) return `<div class="card hidden-card">?</div>`;
  const def = db.get(c.cardId);
  const classes = ["card", c.mode === "rest" ? "rest" : ""];
  const selected = selectedEnergy.has(c.uid);
  if (options.selectable) classes.push("selectable");
  if (selected) classes.push("selected");
  const keywords = def?.keywords.map((k) => KEYWORD_NAMES[k.id]).filter((k): k is string => k !== undefined) ?? [];
  return `
    <div class="${classes.join(" ")}" ${options.selectable ? `data-energy="${esc(c.uid)}"` : ""} title="${esc(c.cardId)}">
      <div class="card-name">${colorDots(def?.colors ?? [])} ${esc(def?.name ?? c.cardId)}</div>
      ${def ? `<div class="card-line">${esc(costText(def))}</div>` : ""}
      ${def?.power !== undefined ? `<div class="card-line"><b>${def.power}</b> de puissance</div>` : ""}
      ${def?.combo ? `<div class="card-line">Combo +${def.combo.power} (coût ${def.combo.cost})</div>` : ""}
      ${keywords.length ? `<div class="card-line kw">${keywords.join(", ")}</div>` : ""}
      ${def && def.type !== "battle" ? `<div class="card-line kw">${esc(def.type)}</div>` : ""}
      <div class="card-mode">${c.mode === "rest" ? "Inertie" : "Action"}${selected ? " · sélectionnée" : ""}</div>
    </div>`;
}

function leaderBox(leader: LeaderState): string {
  const def = db.get(leader.cardId);
  const face = leader.side === "front" ? def?.front : def?.back;
  return `
    <div class="card leader ${leader.mode === "rest" ? "rest" : ""}">
      <div class="card-name">${colorDots(face?.colors ?? [])} ${esc(face?.name ?? leader.cardId)}</div>
      <div class="card-line">Leader — ${leader.side === "front" ? "face avant" : "face arrière (éveillé)"}</div>
      <div class="card-line"><b>${face?.power ?? "?"}</b> de puissance</div>
      <div class="card-mode">${leader.mode === "rest" ? "Inertie" : "Action"}</div>
    </div>`;
}

function zone(title: string, cards: readonly CardView[], options: { selectable?: boolean; empty?: string } = {}): string {
  const content = cards.length > 0 ? cards.map((c) => cardBox(c, options)).join("") : `<span class="empty">${options.empty ?? "vide"}</span>`;
  return `<div class="zone"><div class="zone-title">${title} (${cards.length})</div><div class="cards">${content}</div></div>`;
}

function playerArea(p: PlayerZonesView, isMe: boolean, canSelectEnergy: boolean): string {
  const dropNames = p.drop.map((c) => (isVisible(c) ? cardName(db, c.cardId) : "?"));
  return `
    <section class="player ${isMe ? "me" : "opponent"}">
      <h2>${isMe ? `Moi (${p.id})` : `Adversaire (${p.id})`}</h2>
      <div class="row">
        <div class="zone"><div class="zone-title">Leader</div><div class="cards">${leaderBox(p.leader)}</div></div>
        <div class="zone counters">
          <div>Deck : <b>${p.deckCount}</b></div>
          <div>Vie : <b>${p.life.length}</b></div>
          <div>Main : <b>${p.hand.length}</b></div>
          <div>Marqueurs Énergie : <b>${p.energyMarkers}</b></div>
          <div>Dispersion : <b>${p.drop.length}</b></div>
        </div>
      </div>
      ${zone("Zone de Combat", p.battle)}
      ${zone("Énergie", p.energy, { selectable: canSelectEnergy })}
      ${p.combo.length > 0 ? zone("Zone de Combo", p.combo) : ""}
      ${p.zEnergy.length > 0 ? zone("Énergie Z", p.zEnergy) : ""}
      ${zone("Vie", p.life)}
      ${isMe ? zone("Ma main", p.hand) : ""}
      ${dropNames.length > 0 ? `<div class="drop">Dispersion : ${esc(dropNames.join(", "))}</div>` : ""}
      ${p.removed.length > 0 ? `<div class="drop">Retirées de la partie : ${esc(p.removed.map((c) => cardName(db, c.cardId)).join(", "))}</div>` : ""}
    </section>`;
}

function battleSummary(view: PlayerView): string {
  const b = view.battle;
  if (!b) return "";
  const target = b.target.uid !== b.defender.uid ? ` (bloqué, cible d'origine : ${esc(nameOf(view, db, b.target.uid))})` : "";
  return `<div class="battle">⚔ Combat : <b>${esc(nameOf(view, db, b.attacker.uid))}</b> attaque <b>${esc(
    nameOf(view, db, b.defender.uid),
  )}</b>${target}</div>`;
}

/** Ordre d'affichage des groupes de boutons. */
const GROUPS: [string, Action["type"][]][] = [
  [
    "Décision",
    [
      "CHOOSE_FIRST_PLAYER",
      "MULLIGAN",
      "CHARGE_ENERGY",
      "DECLARE_BLOCKER",
      "TAKE_LIFE",
      "COMBO_TO_Z_ENERGY",
      "CHOOSE_CARDS",
      "CHOOSE_LIFE",
      "CHOOSE_AUTO",
      "CHOOSE_BLIND",
      "CHOOSE_OPTION",
    ],
  ],
  ["Capacités", ["ACTIVATE"]],
  ["Jouer une carte", ["PLAY_CARD"]],
  ["Combos", ["COMBO"]],
  ["Attaquer", ["ATTACK"]],
  ["Leader", ["AWAKEN"]],
  ["Continuer", ["END_STEP", "END_MAIN_PHASE"]],
];

function actionsPanel(view: PlayerView): string {
  currentActions = getLegalActions(state, screenOwner, ctx);
  const myTurnToDecide = state.pending?.player === screenOwner;
  let html = "";
  if (myTurnToDecide) {
    html += `<p class="prompt">${esc(describePending(view.pending))}</p>`;
    const looked = view.pending?.type === "CHOOSE_CARDS" ? view.pending.looked : undefined;
    if (looked) {
      html += `<p class="hint">Cartes regardées (vous seul les voyez) : ${esc(looked.map((c) => cardName(db, c.cardId)).join(", "))}</p>`;
    }
    const usesPayment = currentActions.some((a) => a.type === "PLAY_CARD" || a.type === "COMBO");
    if (usesPayment) {
      const custom = selectedEnergy.size > 0 || selectedMarkers > 0;
      html += `<p class="hint">Paiement : ${
        custom
          ? `<b>personnalisé</b> (${selectedEnergy.size} Énergie(s) + ${selectedMarkers} marqueur(s)) <button data-clear>Effacer</button>`
          : "suggéré automatiquement (cliquez sur vos Énergies pour choisir vous-même)"
      }${
        view.players[screenOwner].energyMarkers > 0
          ? ` · Marqueurs utilisés : <input type="number" min="0" max="${view.players[screenOwner].energyMarkers}" value="${selectedMarkers}" data-markers>`
          : ""
      }</p>`;
    }
    for (const [title, types] of GROUPS) {
      const buttons = currentActions
        .map((a, i) => ({ a, i }))
        .filter(({ a }) => types.includes(a.type))
        .map(({ a, i }) => `<button data-action="${i}">${esc(describeAction(a, view, db))}</button>`);
      if (buttons.length > 0) html += `<div class="group"><h3>${title}</h3>${buttons.join("")}</div>`;
    }
  } else if (!state.result) {
    html += `<p class="prompt">En attente de ${state.pending?.player}.</p>`;
  }
  if (errorMessage) html += `<p class="error">Coup refusé : ${esc(errorMessage)}</p>`;
  const concede = currentActions.findIndex((a) => a.type === "CONCEDE");
  if (concede >= 0) html += `<div class="group"><button class="danger" data-action="${concede}">Abandonner</button></div>`;
  return html;
}

function render(): void {
  if (!revealed && !state.result) {
    app.innerHTML = `
      <div class="pass-screen">
        <h1>Passez l'ordinateur à ${screenOwner}</h1>
        <p>Le joueur ${screenOwner} doit prendre une décision. L'autre joueur ne doit pas regarder l'écran.</p>
        <button data-reveal>Je suis ${screenOwner} : afficher mon jeu</button>
      </div>`;
    return;
  }
  const view = getPlayerView(state, screenOwner);
  const opponent = screenOwner === "P1" ? "P2" : "P1";
  const canSelectEnergy =
    state.pending?.player === screenOwner && ["MAIN", "OFFENSE", "DEFENSE"].includes(state.pending.type);
  const result = view.result
    ? `<div class="result">${
        view.result.kind === "win" ? `🏆 ${view.result.winner} gagne la partie` : "Match nul"
      } — ${esc(view.result.reason)} <button data-new>Nouvelle partie</button></div>`
    : "";
  app.innerHTML = `
    <header>
      <div><b>DBS Masters — simulateur (test)</b> · graine ${seed}</div>
      <div>Tour ${view.turnNumber} · joueur actif : <b>${view.turnPlayer}</b> · ${phaseName(view.phase)}</div>
      <div class="header-buttons">
        <button data-new>Nouvelle partie</button>
        <button data-export title="Télécharge la partie (pour signaler un bug)">Exporter la partie</button>
        <label class="file-button" title="Recharge une partie exportée">Charger une partie<input type="file" accept=".json,application/json" data-import hidden></label>
      </div>
    </header>
    ${result}
    <main>
      <div class="board">
        ${playerArea(view.players[opponent], false, false)}
        ${battleSummary(view)}
        ${playerArea(view.players[screenOwner], true, canSelectEnergy)}
      </div>
      <aside>
        <div class="actions">${actionsPanel(view)}</div>
        <div class="log"><h3>Journal</h3>${log
          .slice(-60)
          .reverse()
          .map((line) => `<div>${esc(line)}</div>`)
          .join("")}</div>
      </aside>
    </main>`;
}

// Un seul écouteur pour tous les boutons (délégation d'événements).
app.addEventListener("click", (event) => {
  const el = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-action],[data-reveal],[data-new],[data-energy],[data-clear],[data-export]",
  );
  if (!el) return;
  if (el.dataset["action"] !== undefined) act(currentActions[Number(el.dataset["action"])]!);
  else if (el.dataset["export"] !== undefined) exportGame();
  else if (el.dataset["reveal"] !== undefined) {
    revealed = true;
    render();
  } else if (el.dataset["new"] !== undefined) newGame();
  else if (el.dataset["clear"] !== undefined) {
    clearSelection();
    render();
  } else if (el.dataset["energy"] !== undefined) {
    const uid = el.dataset["energy"];
    if (selectedEnergy.has(uid)) selectedEnergy.delete(uid);
    else selectedEnergy.add(uid);
    render();
  }
});
app.addEventListener("change", (event) => {
  const el = event.target as HTMLInputElement;
  if (el.dataset["import"] !== undefined && el.files?.[0]) {
    void importGame(el.files[0]);
  } else if (el.dataset["markers"] !== undefined) {
    selectedMarkers = Math.max(0, Number(el.value) || 0);
    render();
  }
});

newGame();
