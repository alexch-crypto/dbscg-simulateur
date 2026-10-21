// Menus du site, avant la partie : accueil, Jouer, Mes decks (avec le constructeur de deck),
// Cartes (galerie), Paramètres (avec l'aide). Uniquement de l'affichage et des préférences :
// aucune règle du jeu ici (la validation des decks vient du moteur).

import { MAIN_DECK_MAX, MAIN_DECK_MIN, MAX_COPIES, Z_DECK_MAX, type CardDatabase, type CardDefinition, type CounterPrompt, type PlayerId } from "../engine";
import { cardSheet, colorDots, esc, KEYWORD_NAMES, TYPE_NAMES } from "./common";
import { countOf, deckErrors, deckFromFile, deckToFile, newId, type DeckStore, type SavedDeck } from "./decks";
import { COLOR_NAMES } from "./labels";
import { applyTheme, savePrefs, type Prefs, type Theme } from "./prefs";
import { clearImages, imageCount, imageUrl, importImages, setImagesEnabled } from "./images";
import { setFxSettings } from "./fx";
import { playSound, setAudioSettings } from "./audio";
import { importPlaymat, myPlaymat, resetPlaymat } from "./playmat";

export type Screen = "home" | "play" | "decks" | "deck-edit" | "cards" | "settings";
export type Mode = "solo" | "hotseat" | "online";

/** Ce que les menus demandent à la page principale (lancer une partie, se connecter...). */
export interface MenuHost {
  db: CardDatabase;
  decks: DeckStore;
  prefs: Prefs;
  /** Message de connexion en ligne (erreur, attente...). */
  netStatus(): string;
  /** Une partie locale est en cours et peut être reprise. */
  canResume(): boolean;
  resume(): void;
  startLocal(mode: "solo" | "hotseat", decks: Record<PlayerId, SavedDeck>, prompts: Record<PlayerId, CounterPrompt>): void;
  createRoom(deck: SavedDeck, prompt: CounterPrompt): void;
  joinRoom(code: string, deck: SavedDeck, prompt: CounterPrompt): void;
  render(): void;
}

/** État des menus (ce que le joueur a choisi ou tapé). */
const ui = {
  screen: "home" as Screen,
  mode: "solo" as Mode,
  deckFor: { P1: "", P2: "" } as Record<PlayerId, string>,
  prompts: null as Record<PlayerId, CounterPrompt> | null,
  code: "",
  /** Deck en cours de modification (copie de travail) et s'il a des changements non enregistrés. */
  editing: null as SavedDeck | null,
  dirty: false,
  editorSearch: "",
  editorPart: "main" as "main" | "z",
  gallery: { text: "", color: "", type: "", cost: "" },
  galleryCard: "" as string,
  message: "",
};

export const currentScreen = (): Screen => ui.screen;
export function goTo(screen: Screen): void {
  ui.screen = screen;
  ui.message = "";
}

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

/** Cartes d'un deck (ou de la base), sans les jetons, triées par type puis coût puis nom. */
function sortedCards(db: CardDatabase, filter: (d: CardDefinition) => boolean): CardDefinition[] {
  const order = ["leader", "battle", "extra", "unison", "z_leader", "z_battle", "z_extra", "z_unison"];
  return [...db.values()]
    .filter((d) => !d.token && filter(d))
    .sort(
      (a, b) =>
        order.indexOf(a.type) - order.indexOf(b.type) ||
        costValue(a) - costValue(b) ||
        a.name.localeCompare(b.name, "fr"),
    );
}

const costValue = (d: CardDefinition): number => (d.cost && typeof d.cost.total === "number" ? d.cost.total : -1);

const isMainType = (d: CardDefinition) => ["battle", "extra", "unison"].includes(d.type);
const isZType = (d: CardDefinition) => d.type.startsWith("z_");

function deckColors(deck: SavedDeck, db: CardDatabase): string[] {
  const leader = db.get(deck.list.leader);
  return [...(leader?.front?.colors ?? leader?.colors ?? [])];
}

const topBar = (title: string, back: Screen = "home") =>
  `<div class="menu-top"><button class="back" data-nav="${back}">← ${back === "home" ? "Accueil" : "Retour"}</button><h1>${esc(title)}</h1></div>`;

/** Petite tuile de carte pour la galerie et le constructeur de deck. */
function tile(def: CardDefinition, extra = "", attrs = ""): string {
  const power = def.power !== undefined ? `${def.power / 1000}k` : TYPE_NAMES[def.type] ?? def.type;
  const cost = def.cost ? String(def.cost.total) : def.zCost !== undefined ? `Z${def.zCost}` : "";
  const colors = def.front?.colors ?? def.colors;
  const img = imageUrl(def.id);
  if (img) {
    return `<div class="tile with-img color-${colors[0] ?? "none"}" ${attrs} data-cid="${esc(def.id)}"><img src="${img}" alt="${esc(def.name)}" loading="lazy">${extra}</div>`;
  }
  return `<div class="tile color-${colors[0] ?? "none"}" ${attrs} data-cid="${esc(def.id)}">
    <div class="tile-top">${colorDots(colors)}<span class="tile-cost">${esc(cost)}</span></div>
    <div class="tile-name">${esc(def.name)}</div>
    <div class="tile-bottom"><span>${esc(power)}</span>${def.combo ? `<span class="muted">+${def.combo.power / 1000}k</span>` : ""}</div>
    ${extra}
  </div>`;
}

// ---------------------------------------------------------------------------
// Écrans
// ---------------------------------------------------------------------------

export function renderMenu(host: MenuHost): string {
  switch (ui.screen) {
    case "home":
      return home(host);
    case "play":
      return play(host);
    case "decks":
      return decksScreen(host);
    case "deck-edit":
      return deckEditor(host);
    case "cards":
      return gallery(host);
    case "settings":
      return settings(host);
  }
}

function home(host: MenuHost): string {
  const who = host.prefs.pseudo ? `Salut ${esc(host.prefs.pseudo)} !` : "Bienvenue !";
  const tiles: [Screen, string, string, string][] = [
    ["play", "⚔", "Jouer", "Solo, à deux sur le même écran ou en ligne contre un ami"],
    ["decks", "🂠", "Mes decks", "Voir, créer et modifier vos decks"],
    ["cards", "🔍", "Cartes", "Toutes les cartes du simulateur, avec leurs effets"],
    ["settings", "⚙", "Paramètres", "Pseudo, thème, réglages… et l'aide"],
  ];
  return `<div class="menu home">
    <div class="home-title">
      <h1>Dragon Ball Super Card Game <span>Masters</span></h1>
      <p class="muted">Simulateur · ${who}</p>
    </div>
    ${host.canResume() ? `<button class="resume" data-resume>▶ Reprendre la partie en cours</button>` : ""}
    <div class="home-grid">
      ${tiles
        .map(
          ([screen, icon, title, text]) =>
            `<button class="home-tile" data-nav="${screen}"><span class="home-icon">${icon}</span><b>${title}</b><span class="muted">${text}</span></button>`,
        )
        .join("")}
    </div>
  </div>`;
}

function play(host: MenuHost): string {
  const decks = host.decks.all();
  const playable = decks.filter((d) => deckErrors(d, host.db).length === 0);
  for (const p of ["P1", "P2"] as const) {
    if (!playable.some((d) => d.id === ui.deckFor[p])) ui.deckFor[p] = playable[0]?.id ?? "";
  }
  if (!ui.prompts) ui.prompts = { P1: host.prefs.counterPrompt, P2: host.prefs.counterPrompt };
  const deckSelect = (p: PlayerId, label: string) => `
    <label class="field"><span>${label}</span>
      <select data-deck-for="${p}">${playable
        .map((d) => `<option value="${esc(d.id)}" ${d.id === ui.deckFor[p] ? "selected" : ""}>${esc(d.name)}</option>`)
        .join("")}</select></label>`;
  const prompt = (p: PlayerId, label: string) => `
    <label class="check"><input type="checkbox" data-prompt="${p}" ${ui.prompts![p] === "always" ? "checked" : ""}>
      ${label} : toujours demander si je veux contrer
      <span class="hint">Décoché : la partie ne s'arrête que s'il y a un contre jouable (plus rapide, mais l'adversaire peut le deviner).</span></label>`;
  const modes: [Mode, string, string][] = [
    ["solo", "Solo", "Vous jouez les deux côtés, les deux mains sont visibles."],
    ["hotseat", "Deux joueurs, même écran", "Chacun ne voit que son jeu ; on se passe l'ordinateur."],
    ["online", "En ligne", "Contre un ami, chacun sur son ordinateur, avec un code de room."],
  ];
  const status = host.netStatus();
  const body =
    playable.length === 0
      ? `<p class="error">Aucun deck jouable : allez dans « Mes decks » pour en construire un.</p>`
      : ui.mode === "online"
        ? `<div class="panel">
            <h2>Votre deck</h2>${deckSelect("P1", "Deck")}
            ${prompt("P1", "Moi")}
            <div class="online-choice">
              <button class="primary big" data-host>Créer une room</button>
              <span class="muted">ou</span>
              <input type="text" placeholder="Code" data-code maxlength="12" value="${esc(ui.code)}">
              <button class="big" data-join>Rejoindre</button>
            </div>
            ${status ? `<p class="error">${esc(status)}</p>` : ""}
          </div>`
        : `<div class="panel">
            <h2>Decks</h2>
            <div class="two">${deckSelect("P1", "Joueur 1 (P1)")}${deckSelect("P2", "Joueur 2 (P2)")}</div>
            <h2>Fenêtres de contre</h2>
            ${prompt("P1", "P1")}${prompt("P2", "P2")}
            <button class="primary big" data-start>Commencer la partie</button>
          </div>`;
  return `<div class="menu">${topBar("Jouer")}
    <div class="mode-grid">${modes
      .map(
        ([m, title, text]) =>
          `<button class="mode-card ${ui.mode === m ? "active" : ""}" data-play-mode="${m}"><b>${title}</b><span class="muted">${text}</span></button>`,
      )
      .join("")}</div>
    ${body}
  </div>`;
}

function deckSummary(deck: SavedDeck, host: MenuHost): string {
  const leader = host.db.get(deck.list.leader);
  const errors = deckErrors(deck, host.db);
  return `<div class="deck-card">
    <div class="deck-head">${colorDots(deckColors(deck, host.db))} <b>${esc(deck.name)}</b>${deck.builtIn ? ` <span class="tag">de base</span>` : ""}</div>
    <div class="muted">Leader : ${esc(leader?.name ?? deck.list.leader)}</div>
    <div class="muted">${countOf(deck.list.main)} cartes · deck Z ${countOf(deck.list.zDeck)}</div>
    <div class="${errors.length ? "error" : "ok"}">${errors.length ? `⚠ ${errors.length} problème(s)` : "✔ Jouable"}</div>
    <div class="deck-buttons">
      <button data-deck-open="${esc(deck.id)}">${deck.builtIn ? "Voir" : "Modifier"}</button>
      <button data-deck-dup="${esc(deck.id)}">Dupliquer</button>
      <button data-deck-export="${esc(deck.id)}">Exporter</button>
      ${deck.builtIn ? "" : `<button class="danger" data-deck-del="${esc(deck.id)}">Supprimer</button>`}
    </div>
  </div>`;
}

function decksScreen(host: MenuHost): string {
  return `<div class="menu">${topBar("Mes decks")}
    <div class="toolbar">
      <button class="primary" data-deck-new>+ Nouveau deck</button>
      <label class="file-button">Importer un deck<input type="file" accept=".json,application/json" data-deck-import hidden></label>
      ${ui.message ? `<span class="hint">${esc(ui.message)}</span>` : ""}
    </div>
    <div class="deck-grid">${host.decks
      .all()
      .map((d) => deckSummary(d, host))
      .join("")}</div>
    <p class="hint">Vos decks sont enregistrés dans ce navigateur. Pour les garder ou les partager, exportez-les en fichier.</p>
  </div>`;
}

/** Courbe des coûts et répartition des couleurs / types du deck principal. */
function deckStats(deck: SavedDeck, db: CardDatabase): string {
  const curve = new Array<number>(11).fill(0);
  const colors: Record<string, number> = {};
  const types: Record<string, number> = {};
  for (const [id, n] of Object.entries(deck.list.main)) {
    const def = db.get(id);
    if (!def) continue;
    curve[Math.min(10, Math.max(0, costValue(def)))]! += n;
    for (const c of def.colors) colors[c] = (colors[c] ?? 0) + n;
    types[def.type] = (types[def.type] ?? 0) + n;
  }
  const max = Math.max(1, ...curve);
  return `<div class="stats">
    <div class="curve">${curve
      .map(
        (n, cost) =>
          `<div class="bar-col" title="${n} carte(s) de coût ${cost}${cost === 10 ? " ou plus" : ""}"><span class="bar-n">${n || ""}</span><div class="bar" style="height:${Math.round((n / max) * 60)}px"></div><span class="bar-label">${cost === 10 ? "10+" : cost}</span></div>`,
      )
      .join("")}</div>
    <div class="muted">${Object.entries(colors)
      .map(([c, n]) => `${colorDots([c])} ${n} ${COLOR_NAMES[c] ?? c}`)
      .join(" · ")}</div>
    <div class="muted">${Object.entries(types)
      .map(([t, n]) => `${n} ${TYPE_NAMES[t] ?? t}`)
      .join(" · ")}</div>
  </div>`;
}

function deckLines(part: Record<string, number>, db: CardDatabase, which: "main" | "z", readOnly: boolean): string {
  const entries = Object.entries(part)
    .map(([id, n]) => ({ def: db.get(id), id, n }))
    .sort((a, b) => (a.def && b.def ? costValue(a.def) - costValue(b.def) || a.def.name.localeCompare(b.def.name, "fr") : 0));
  if (entries.length === 0) return `<p class="empty">vide</p>`;
  return entries
    .map(
      ({ def, id, n }) => `<div class="deck-line" data-gallery-card="${esc(id)}" data-cid="${esc(id)}">
        <span class="n">${n}×</span>${colorDots(def?.colors ?? [])}<span class="cost">${def?.cost ? def.cost.total : def?.zCost !== undefined ? `Z${def.zCost}` : ""}</span>
        <span class="name">${esc(def?.name ?? `${id} (inconnue)`)}</span>
        ${readOnly ? "" : `<button data-deck-minus="${which}:${esc(id)}" title="Retirer un exemplaire">−</button><button data-deck-plus="${which}:${esc(id)}" title="Ajouter un exemplaire">+</button>`}
      </div>`,
    )
    .join("");
}

function deckEditor(host: MenuHost): string {
  const deck = ui.editing;
  if (!deck) {
    ui.screen = "decks";
    return decksScreen(host);
  }
  const db = host.db;
  const readOnly = !!deck.builtIn;
  const errors = deckErrors(deck, db);
  const leaders = sortedCards(db, (d) => d.type === "leader");
  const main = countOf(deck.list.main);
  const z = countOf(deck.list.zDeck);
  const search = ui.editorSearch.toLowerCase();
  const pool = sortedCards(db, (d) => (ui.editorPart === "main" ? isMainType(d) : isZType(d))).filter(
    (d) => !search || `${d.name} ${d.id} ${d.character.join(" ")} ${d.traits.join(" ")}`.toLowerCase().includes(search),
  );
  const partCounts = ui.editorPart === "main" ? deck.list.main : deck.list.zDeck;
  const detail = ui.galleryCard && db.get(ui.galleryCard);
  return `<div class="menu wide">${topBar(readOnly ? "Voir le deck" : "Modifier le deck", "decks")}
    <div class="editor">
      <section class="panel">
        <div class="toolbar">
          <input class="deck-name" data-deck-name value="${esc(deck.name)}" ${readOnly ? "disabled" : ""} maxlength="40">
          ${
            readOnly
              ? `<button data-deck-dup="${esc(deck.id)}">Dupliquer pour modifier</button>`
              : `<button class="primary" data-deck-save ${ui.dirty ? "" : "disabled"}>${ui.dirty ? "Enregistrer" : "Enregistré ✔"}</button>`
          }
        </div>
        <label class="field"><span>Leader</span><select data-deck-leader ${readOnly ? "disabled" : ""}>${leaders
          .map((l) => `<option value="${esc(l.id)}" ${l.id === deck.list.leader ? "selected" : ""}>${esc(l.name)} (${esc(l.id)})</option>`)
          .join("")}</select></label>
        ${deckStats(deck, db)}
        ${
          errors.length
            ? `<div class="error-box">${errors.map((e) => `<div>⚠ ${esc(e)}</div>`).join("")}</div>`
            : `<div class="ok">✔ Deck jouable</div>`
        }
        <h2>Deck principal <span class="muted">${main} / ${MAIN_DECK_MIN}–${MAIN_DECK_MAX}</span></h2>
        ${deckLines(deck.list.main, db, "main", readOnly)}
        <h2>Deck Z <span class="muted">${z} / ${Z_DECK_MAX} max</span></h2>
        ${deckLines(deck.list.zDeck, db, "z", readOnly)}
      </section>
      <section class="panel">
        ${detail ? `<div class="detail sheet">${cardSheet(detail)}<button data-gallery-close>Fermer</button></div>` : ""}
        ${
          readOnly
            ? `<p class="hint">Deck de base : dupliquez-le pour le modifier. Cliquez sur une carte de la liste pour lire son texte.</p>`
            : `<div class="toolbar">
                <button class="${ui.editorPart === "main" ? "primary" : ""}" data-editor-part="main">Cartes du deck</button>
                <button class="${ui.editorPart === "z" ? "primary" : ""}" data-editor-part="z">Cartes Z</button>
                <input type="search" placeholder="Rechercher (nom, personnage, origine…)" data-editor-search value="${esc(ui.editorSearch)}">
              </div>
              <p class="hint">Cliquez sur une carte pour l'ajouter (${MAX_COPIES} exemplaires maximum). Survolez-la pour lire son texte.</p>
              <div class="tile-grid">${pool
                .map((d) => {
                  const n = partCounts[d.id] ?? 0;
                  return tile(d, n ? `<span class="tile-count">${n}</span>` : "", `data-deck-plus="${ui.editorPart}:${esc(d.id)}"`);
                })
                .join("")}</div>`
        }
      </section>
    </div>
  </div>`;
}

function gallery(host: MenuHost): string {
  const g = ui.gallery;
  const text = g.text.toLowerCase();
  const cards = sortedCards(host.db, (d) => {
    const colors = d.front?.colors ?? d.colors;
    if (g.color && !colors.includes(g.color as never)) return false;
    if (g.type && d.type !== g.type) return false;
    if (g.cost !== "") {
      const c = costValue(d);
      if (g.cost === "7" ? c < 7 : c !== Number(g.cost)) return false;
    }
    if (!text) return true;
    const abilities = (d.type === "leader" ? [...(d.front?.abilities ?? []), ...(d.back?.abilities ?? [])] : d.abilities).map((a) => String(a["text"] ?? ""));
    const keywords = d.keywords.map((k) => KEYWORD_NAMES[k.id] ?? k.id);
    return `${d.name} ${d.id} ${d.character.join(" ")} ${d.traits.join(" ")} ${keywords.join(" ")} ${abilities.join(" ")}`.toLowerCase().includes(text);
  });
  const option = (value: string, label: string, current: string) => `<option value="${esc(value)}" ${value === current ? "selected" : ""}>${esc(label)}</option>`;
  const detail = g && ui.galleryCard ? host.db.get(ui.galleryCard) : undefined;
  return `<div class="menu wide">${topBar("Cartes")}
    <div class="toolbar">
      <input type="search" placeholder="Rechercher : nom, effet, mot-clé…" data-gallery-text value="${esc(g.text)}">
      <select data-gallery-color>${option("", "Toutes les couleurs", g.color)}${Object.entries(COLOR_NAMES)
        .map(([c, n]) => option(c, n, g.color))
        .join("")}</select>
      <select data-gallery-type>${option("", "Tous les types", g.type)}${Object.entries(TYPE_NAMES)
        .map(([t, n]) => option(t, n, g.type))
        .join("")}</select>
      <select data-gallery-cost>${option("", "Tous les coûts", g.cost)}${["0", "1", "2", "3", "4", "5", "6"]
        .map((c) => option(c, `Coût ${c}`, g.cost))
        .join("")}${option("7", "Coût 7 ou plus", g.cost)}</select>
      <span class="muted">${cards.length} carte(s)</span>
    </div>
    <div class="gallery">
      <div class="tile-grid">${cards.map((d) => tile(d, "", `data-gallery-card="${esc(d.id)}"`)).join("")}</div>
      ${detail ? `<aside class="panel sheet">${cardSheet(detail)}<button data-gallery-close>Fermer</button></aside>` : ""}
    </div>
  </div>`;
}

function settings(host: MenuHost): string {
  const p = host.prefs;
  const theme = (value: Theme, label: string) =>
    `<label class="check inline"><input type="radio" name="theme" data-theme-choice="${value}" ${p.theme === value ? "checked" : ""}> ${label}</label>`;
  return `<div class="menu">${topBar("Paramètres")}
    <section class="panel">
      <h2>Profil</h2>
      <label class="field"><span>Pseudo</span><input data-pref-pseudo maxlength="20" value="${esc(p.pseudo)}" placeholder="Affiché à votre adversaire en ligne"></label>
      <h2>Apparence</h2>
      <div>${theme("dark", "Sombre")}${theme("light", "Clair")}${theme("auto", "Comme mon ordinateur")}</div>
      <h2>Partie</h2>
      <label class="check"><input type="checkbox" data-pref-prompt ${p.counterPrompt === "always" ? "checked" : ""}>
        Par défaut, toujours demander si je veux contrer
        <span class="hint">Conseillé en ligne : sinon l'adversaire peut deviner que vous avez un contre en main.</span></label>
      <label class="check"><input type="checkbox" data-pref-log ${p.logHidden ? "checked" : ""}> Masquer le journal de la partie</label>
      <h2>Sons et animations</h2>
      <label class="check"><input type="checkbox" data-pref-sound ${p.sound ? "checked" : ""}> Sons</label>
      <label class="field"><span>Volume</span><input type="range" min="0" max="1" step="0.05" value="${p.volume}" data-pref-volume></label>
      <button data-sound-test>Tester le son</button>
      <label class="check"><input type="checkbox" data-pref-music ${p.music ? "checked" : ""}> Musique de combat pendant la partie</label>
      <label class="field"><span>Volume de la musique</span><input type="range" min="0" max="1" step="0.05" value="${p.musicVolume}" data-pref-music-volume></label>
      <label class="check"><input type="checkbox" data-pref-anim ${p.animations ? "checked" : ""}> Animations (cartes jouées, flèches d'attaque, dégâts...)</label>
      <h2>Tapis de jeu</h2>
      <p class="hint">Sans image, le tapis orange avec une Dragon Ball est utilisé. En ligne, votre adversaire voit votre tapis (l'image est réduite avant l'envoi) et vous voyez le sien.</p>
      <div class="playmat-preview ${myPlaymat() ? "" : "mat-default"}"${myPlaymat() ? ` style="background-image: url('${myPlaymat()}')"` : ""}></div>
      <div class="toolbar">
        <label class="file-button">Choisir une image de tapis<input type="file" accept="image/*" data-playmat-import hidden></label>
        ${myPlaymat() ? `<button data-playmat-reset>Revenir au tapis par défaut</button>` : ""}
      </div>
      <h2>Images des cartes</h2>
      <p class="hint">Les images restent uniquement dans ce navigateur : elles ne sont jamais envoyées ni publiées.
        Choisissez les fichiers du dossier <b>images-cartes</b> (nommés par numéro de carte, ex. BT24-056.jpg).</p>
      <label class="check"><input type="checkbox" data-pref-images ${p.showImages ? "checked" : ""}> Afficher les images des cartes</label>
      <div class="toolbar">
        <label class="file-button">Importer des images<input type="file" accept="image/*" multiple data-images-import hidden></label>
        ${imageCount() > 0 ? `<button class="danger" data-images-clear>Effacer les images (${imageCount()})</button>` : `<span class="muted">Aucune image importée.</span>`}
        ${ui.message ? `<span class="hint">${esc(ui.message)}</span>` : ""}
      </div>
    </section>
    ${help()}
  </div>`;
}

const KEYWORD_HELP: [string, string][] = [
  ["Bloqueur", "Quand l'adversaire attaque, passez cette carte en mode Inertie : elle devient la carte attaquée."],
  ["Coup Critique", "Les cartes de Vie perdues à cause de cette carte vont dans la Dispersion au lieu de la main."],
  ["Double / Triple / Quadruple Frappe", "Inflige 2, 3 ou 4 dégâts au lieu d'un seul en attaquant un Leader."],
  ["Réplique / Tri-offensive", "Après le combat, la carte repasse en mode Action (1 ou 2 fois par tour)."],
  ["Fuite d'énergie", "Placée en Énergie, la carte arrive en mode Inertie."],
  ["Déflexion", "La carte ne peut pas être visée par les [Contre : Mise en jeu] adverses."],
  ["Unique", "Une seule carte de ce nom dans votre Zone de Combat."],
  ["Ultimate", "Un seul exemplaire par deck ; retirée de la partie quand elle quitte le jeu."],
  ["Super Combo", "4 cartes [Super Combo] maximum par deck."],
  ["Successeur", "Jouez la carte en sacrifiant des cartes de Combat dont le total des coûts est égal au sien, et en payant le coût indiqué."],
  ["Espace-temps X", "Avec X cartes ou plus en Dispersion, envoyez-les en Dimension parallèle et jouez la carte gratuitement ; elle y part à la fin du tour."],
  ["Éveil / Éveil Z", "Retournez votre Leader quand sa condition est remplie ; l'Éveil Z pose un Leader Z par-dessus."],
  ["Boost d'Esprit X", "Retirez X marqueurs de votre Unisson pour payer la Capacité."],
];

function help(): string {
  return `<section class="panel help">
    <h2>Aide</h2>
    <details open><summary>Jouer une partie</summary>
      <ul>
        <li>Les cartes <span class="hl orange">entourées en orange</span> peuvent agir : cliquez dessus, leurs actions s'affichent à droite.</li>
        <li>Quand il faut choisir des cartes, elles sont <span class="hl green">entourées en vert</span> : cliquez-les puis « Valider » dans le bandeau au-dessus du plateau (s'il n'y a qu'une carte possible, elle est déjà choisie).</li>
        <li>Pour attaquer : cliquez sur votre carte, puis sur la cible <b>entourée en rouge</b>, puis « Valider l'attaque ».</li>
        <li>Pour payer : si vous avez le choix des Énergies, celles proposées sont déjà cochées ; cliquez sur vos Énergies pour changer, puis « Payer ».</li>
        <li>Survolez une carte pour lire son texte en entier (avec son image, si vous avez importé les images dans les Paramètres).</li>
        <li>La <b>Dispersion</b> et le <b>Deck Z</b> sont des piles : un clic les ouvre dans le panneau de droite.</li>
        <li>Le <b>journal</b> raconte tout ce qui s'est passé. « Exporter » télécharge la partie (utile pour signaler un bug).</li>
      </ul>
    </details>
    <details><summary>Jouer en ligne</summary>
      <ul>
        <li>Les deux joueurs ouvrent le site et vont dans <b>Jouer → En ligne</b>.</li>
        <li>L'un clique sur « Créer une room » et donne le code de 6 lettres à l'autre, qui le tape et clique sur « Rejoindre ».</li>
        <li>Celui qui crée la room fait tourner la partie : il ne doit <b>pas recharger ni fermer sa page</b>. L'autre peut revenir avec le même code s'il est déconnecté.</li>
      </ul>
    </details>
    <details><summary>Construire un deck</summary>
      <ul>
        <li>Un Leader, un deck principal de ${MAIN_DECK_MIN} à ${MAIN_DECK_MAX} cartes, ${MAX_COPIES} exemplaires maximum par carte.</li>
        <li>Un deck Z de ${Z_DECK_MAX} cartes Z maximum.</li>
        <li>Le site vérifie le deck en direct et explique ce qui ne va pas.</li>
      </ul>
    </details>
    <details><summary>Mots-clés</summary>
      <dl class="lexicon">${KEYWORD_HELP.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      <p class="hint">Le manuel officiel fait foi : ces résumés servent seulement d'aide-mémoire.</p>
    </details>
  </section>`;
}

// ---------------------------------------------------------------------------
// Clics et saisies
// ---------------------------------------------------------------------------

function download(name: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

function openEditor(deck: SavedDeck): void {
  ui.editing = structuredClone(deck);
  ui.dirty = false;
  ui.galleryCard = "";
  ui.editorSearch = "";
  ui.editorPart = "main";
  ui.screen = "deck-edit";
}

/** Ajoute (+1) ou retire (-1) un exemplaire d'une carte au deck en cours de modification. */
function changeCount(spec: string, delta: number): void {
  const deck = ui.editing;
  if (!deck || deck.builtIn) return;
  const [which, id] = [spec.slice(0, spec.indexOf(":")), spec.slice(spec.indexOf(":") + 1)];
  const part = which === "z" ? deck.list.zDeck : deck.list.main;
  const n = (part[id] ?? 0) + delta;
  if (delta > 0) {
    if ((part[id] ?? 0) >= MAX_COPIES) return void (ui.message = `${MAX_COPIES} exemplaires maximum`);
    if (which === "z" && countOf(deck.list.zDeck) >= Z_DECK_MAX) return;
    if (which === "main" && countOf(deck.list.main) >= MAIN_DECK_MAX) return;
  }
  if (n <= 0) delete part[id];
  else part[id] = n;
  ui.dirty = true;
}

/** Quitter le constructeur ? On demande d'abord s'il y a des modifications non enregistrées. */
function confirmLeave(): boolean {
  return !(ui.screen === "deck-edit" && ui.dirty) || window.confirm("Quitter sans enregistrer les modifications du deck ?");
}

/** Gère un clic dans les menus. Renvoie true si le clic a été traité. */
export function menuClick(el: HTMLElement, host: MenuHost): boolean {
  const d = el.dataset;
  if (d["nav"] !== undefined) {
    if (!confirmLeave()) return true;
    goTo(d["nav"] as Screen);
    if (ui.screen !== "deck-edit") ui.editing = null;
    ui.galleryCard = "";
    host.render();
    return true;
  }
  if (d["resume"] !== undefined) {
    host.resume();
    return true;
  }
  if (d["playMode"] !== undefined) {
    ui.mode = d["playMode"] as Mode;
    // Deux joueurs ou en ligne : par défaut, on demande toujours (pour ne rien révéler).
    const prompt: CounterPrompt = ui.mode === "solo" ? "only_if_playable" : host.prefs.counterPrompt;
    ui.prompts = { P1: prompt, P2: prompt };
    host.render();
    return true;
  }
  const chosen = (p: PlayerId) => host.decks.get(ui.deckFor[p]);
  if (d["start"] !== undefined) {
    const p1 = chosen("P1");
    const p2 = chosen("P2");
    if (p1 && p2) host.startLocal(ui.mode === "hotseat" ? "hotseat" : "solo", { P1: p1, P2: p2 }, { ...ui.prompts! });
    return true;
  }
  if (d["host"] !== undefined) {
    const deck = chosen("P1");
    if (deck) host.createRoom(deck, ui.prompts!.P1);
    return true;
  }
  if (d["join"] !== undefined) {
    const deck = chosen("P1");
    const input = document.querySelector<HTMLInputElement>("[data-code]");
    ui.code = input?.value ?? ui.code;
    if (deck) host.joinRoom(ui.code, deck, ui.prompts!.P1);
    return true;
  }
  if (d["deckNew"] !== undefined) {
    const leader = [...host.db.values()].find((x) => x.type === "leader");
    openEditor({ id: newId(), name: "Nouveau deck", list: { leader: leader?.id ?? "", main: {}, zDeck: {} } });
    ui.dirty = true;
    host.render();
    return true;
  }
  if (d["deckOpen"] !== undefined) {
    const deck = host.decks.get(d["deckOpen"]);
    if (deck) openEditor(deck);
    host.render();
    return true;
  }
  if (d["deckDup"] !== undefined) {
    if (!confirmLeave()) return true;
    const copy = host.decks.duplicate(d["deckDup"]);
    if (copy) openEditor(copy);
    host.render();
    return true;
  }
  if (d["deckDel"] !== undefined) {
    const deck = host.decks.get(d["deckDel"]);
    if (deck && window.confirm(`Supprimer le deck « ${deck.name} » ?`)) host.decks.remove(deck.id);
    host.render();
    return true;
  }
  if (d["deckExport"] !== undefined) {
    const deck = host.decks.get(d["deckExport"]);
    if (deck) download(`${deck.name.replace(/[^\w\- ]+/g, "_")}.json`, deckToFile(deck));
    return true;
  }
  if (d["deckSave"] !== undefined) {
    if (ui.editing) {
      host.decks.save(ui.editing);
      ui.dirty = false;
    }
    host.render();
    return true;
  }
  if (d["deckPlus"] !== undefined || d["deckMinus"] !== undefined) {
    changeCount(d["deckPlus"] ?? d["deckMinus"]!, d["deckPlus"] !== undefined ? 1 : -1);
    host.render();
    return true;
  }
  if (d["editorPart"] !== undefined) {
    ui.editorPart = d["editorPart"] as "main" | "z";
    host.render();
    return true;
  }
  if (d["galleryCard"] !== undefined) {
    ui.galleryCard = ui.galleryCard === d["galleryCard"] ? "" : d["galleryCard"]!;
    host.render();
    return true;
  }
  if (d["soundTest"] !== undefined) {
    playSound("play");
    setTimeout(() => playSound("attack"), 500);
    setTimeout(() => playSound("hit"), 1800);
    return true;
  }
  if (d["playmatReset"] !== undefined) {
    resetPlaymat();
    host.render();
    return true;
  }
  if (d["imagesClear"] !== undefined) {
    if (window.confirm("Effacer toutes les images de cartes de ce navigateur ?")) {
      void clearImages().then(() => {
        ui.message = "Images effacées.";
        host.render();
      });
    }
    return true;
  }
  if (d["galleryClose"] !== undefined) {
    ui.galleryCard = "";
    host.render();
    return true;
  }
  return false;
}

/** Gère une saisie (texte, case à cocher, liste) dans les menus. Renvoie true si traitée. */
export function menuInput(el: HTMLInputElement, host: MenuHost, final: boolean): boolean {
  const d = el.dataset;
  const prefs = host.prefs;
  // Champs de texte : on garde la saisie sans redessiner la page (pour ne pas perdre le curseur),
  // sauf pour les recherches, qui filtrent en direct.
  if (d["code"] !== undefined) {
    ui.code = el.value;
    return true;
  }
  if (d["deckName"] !== undefined) {
    if (ui.editing) {
      ui.editing.name = el.value.slice(0, 40) || "Sans nom";
      ui.dirty = true;
      const save = document.querySelector<HTMLButtonElement>("[data-deck-save]");
      if (save) {
        save.disabled = false;
        save.textContent = "Enregistrer";
      }
    }
    return true;
  }
  if (d["prefPseudo"] !== undefined) {
    prefs.pseudo = el.value.trim().slice(0, 20);
    savePrefs(prefs);
    return true;
  }
  if (!final && (d["editorSearch"] !== undefined || d["galleryText"] !== undefined)) {
    if (d["editorSearch"] !== undefined) ui.editorSearch = el.value;
    else ui.gallery.text = el.value;
    host.render();
    const again = document.querySelector<HTMLInputElement>(d["editorSearch"] !== undefined ? "[data-editor-search]" : "[data-gallery-text]");
    if (again) {
      again.focus();
      again.setSelectionRange(again.value.length, again.value.length);
    }
    return true;
  }
  if (!final) return false;
  if (d["deckFor"] !== undefined) ui.deckFor[d["deckFor"] as PlayerId] = el.value;
  else if (d["prompt"] !== undefined) ui.prompts![d["prompt"] as PlayerId] = el.checked ? "always" : "only_if_playable";
  else if (d["deckLeader"] !== undefined && ui.editing) {
    ui.editing.list.leader = el.value;
    ui.dirty = true;
  } else if (d["galleryColor"] !== undefined) ui.gallery.color = el.value;
  else if (d["galleryType"] !== undefined) ui.gallery.type = el.value;
  else if (d["galleryCost"] !== undefined) ui.gallery.cost = el.value;
  else if (d["themeChoice"] !== undefined) {
    prefs.theme = d["themeChoice"] as Theme;
    applyTheme(prefs.theme);
    savePrefs(prefs);
  } else if (d["prefPrompt"] !== undefined) {
    prefs.counterPrompt = el.checked ? "always" : "only_if_playable";
    ui.prompts = null;
    savePrefs(prefs);
  } else if (d["prefLog"] !== undefined) {
    prefs.logHidden = el.checked;
    savePrefs(prefs);
  } else if (
    d["prefSound"] !== undefined ||
    d["prefAnim"] !== undefined ||
    d["prefVolume"] !== undefined ||
    d["prefMusic"] !== undefined ||
    d["prefMusicVolume"] !== undefined
  ) {
    if (d["prefSound"] !== undefined) prefs.sound = el.checked;
    if (d["prefAnim"] !== undefined) prefs.animations = el.checked;
    if (d["prefVolume"] !== undefined) prefs.volume = Math.min(1, Math.max(0, Number(el.value) || 0));
    if (d["prefMusic"] !== undefined) prefs.music = el.checked;
    if (d["prefMusicVolume"] !== undefined) prefs.musicVolume = Math.min(1, Math.max(0, Number(el.value) || 0));
    setFxSettings(prefs);
    setAudioSettings(prefs);
    savePrefs(prefs);
  } else if (d["prefImages"] !== undefined) {
    prefs.showImages = el.checked;
    setImagesEnabled(el.checked);
    savePrefs(prefs);
  } else if (d["playmatImport"] !== undefined && el.files?.[0]) {
    void importPlaymat(el.files[0]).then((error) => {
      ui.message = error ? `Tapis : ${error}` : "Tapis importé.";
      host.render();
    });
    return true;
  } else if (d["imagesImport"] !== undefined && el.files && el.files.length > 0) {
    void importImages(el.files).then((n) => {
      ui.message = `${n} image(s) importée(s).`;
      host.render();
    });
    return true;
  } else if (d["deckImport"] !== undefined && el.files?.[0]) {
    void el.files[0].text().then((text) => {
      const deck = deckFromFile(text);
      if (typeof deck === "string") ui.message = `Import impossible : ${deck}`;
      else {
        host.decks.save(deck);
        ui.message = `Deck « ${deck.name} » importé.`;
      }
      host.render();
    });
    return true;
  } else return false;
  host.render();
  return true;
}

/** Sortie des menus pour lancer une partie : rien à garder en cours de modification. */
export function leaveMenus(): void {
  ui.editing = null;
  ui.dirty = false;
}

