// Vue d'un joueur : ce qu'il a le droit de voir, et rien d'autre.
// C'est ce qui sera envoyé par le réseau à chaque joueur.

import type { GameContext } from "./protocol";
import { comboPower, powerOf, printedPowerOf } from "./rules/battle";
import {
  PLAYER_IDS,
  type CardInstance,
  type CounterEvent,
  type CounterLink,
  type GameState,
  type LeaderState,
  type Mode,
  type PlayerId,
  type PlayerState,
} from "./state/types";

/** Carte visible : on connaît son identité. */
export interface VisibleCard {
  uid: string;
  cardId: string;
  owner: PlayerId;
  mode: Mode;
  /** Marqueurs (Unissons). */
  markers?: number;
}
/** Carte cachée : on sait seulement qu'elle est là (ni uid, ni numéro de carte). */
export interface HiddenCard {
  hidden: true;
}
export type CardView = VisibleCard | HiddenCard;

export interface PlayerZonesView {
  id: PlayerId;
  leader: LeaderState;
  energyMarkers: number;
  /** Personne ne connaît l'ordre ni le contenu du deck : seulement le nombre de cartes. */
  deckCount: number;
  /** Main : visible par son propriétaire ; pour l'adversaire, seules les cartes révélées. */
  hand: CardView[];
  /** Zone de Vie : chaque position, cachée sauf carte face visible. */
  life: CardView[];
  energy: VisibleCard[];
  battle: VisibleCard[];
  combo: VisibleCard[];
  drop: VisibleCard[];
  zEnergy: VisibleCard[];
  warp: VisibleCard[];
  removed: VisibleCard[];
  /** Deck Z : consultable par son propriétaire, caché pour l'adversaire (3-12-2 / 3-12-3). */
  zDeck: CardView[];
  /** Zone Unisson (publique, avec le nombre de marqueurs). */
  unison: VisibleCard[];
}

export interface PlayerView {
  viewer: PlayerId;
  firstPlayer: GameState["firstPlayer"];
  turnPlayer: PlayerId;
  turnNumber: number;
  phase: GameState["phase"];
  /** Qui doit décider quoi (information publique). */
  pending: GameState["pending"];
  /** Combat en cours (information publique). */
  battle: GameState["battle"];
  /** Fenêtre de contre en cours : événement et contres déclarés (publics : les cartes sont révélées). */
  counterWindow: { event: CounterEvent; chain: CounterLink[] } | null;
  /** Limites d'attaques en cours. */
  attackLimits: GameState["attackLimits"];
  /** Coûts supplémentaires pour attaquer en cours (publics). */
  attackTaxes: GameState["attackTaxes"];
  /** Restrictions en cours (publiques). */
  restrictions: GameState["restrictions"];
  /** Réglages des joueurs. */
  settings: GameState["settings"];
  /** Règles de la partie (officielles ou personnalisées). */
  rules: GameState["rules"];
  result: GameState["result"];
  players: Record<PlayerId, PlayerZonesView>;
  /**
   * Puissance actuelle (avec les effets en cours) et imprimée des Leaders, cartes de Combat et
   * Unissons, par uid. Information publique.
   */
  powers: Record<string, { power: number; printed: number }>;
  /** Puissance de Combo de chaque joueur (cartes en Zone de Combo, avec leurs bonus). */
  comboPowers: Record<PlayerId, number>;
}

const show = (c: CardInstance): VisibleCard => ({
  uid: c.uid,
  cardId: c.cardId,
  owner: c.owner,
  mode: c.mode,
  ...(c.markers !== undefined ? { markers: c.markers } : {}),
});
const HIDDEN: HiddenCard = { hidden: true };

function zonesFor(p: PlayerState, viewer: PlayerId): PlayerZonesView {
  const isOwner = p.id === viewer;
  return {
    id: p.id,
    leader: { ...p.leader },
    energyMarkers: p.energyMarkers,
    deckCount: p.deck.length,
    hand: p.hand.map((c) => (isOwner || c.faceUp ? show(c) : HIDDEN)),
    life: p.life.map((c) => (c.faceUp ? show(c) : HIDDEN)),
    energy: p.energy.map(show),
    battle: p.battle.map(show),
    combo: p.combo.map(show),
    drop: p.drop.map(show),
    zEnergy: p.zEnergy.map(show),
    warp: p.warp.map(show),
    removed: p.removed.map(show),
    zDeck: p.zDeck.map((c) => (isOwner || c.faceUp ? show(c) : HIDDEN)),
    unison: p.unison.map(show),
  };
}

/**
 * Décision attendue, vue par `viewer`. Les options d'un choix peuvent désigner des cartes
 * cachées (ex. choisir dans sa main) : seul le joueur qui choisit les reçoit.
 */
function pendingFor(state: GameState, viewer: PlayerId): GameState["pending"] {
  const pending = state.pending;
  if (!pending) return null;
  if (pending.type === "CHOOSE_CARDS" && pending.player !== viewer) {
    // Ni les options, ni les cartes regardées (zone secrète) ne sont montrées à l'autre joueur.
    const { looked: _hidden, ...rest } = pending;
    return { ...rest, options: [] };
  }
  return structuredClone(pending);
}

/** Puissances actuelles et imprimées de tout ce qui est en jeu (vide sans base de cartes). */
function powersOf(state: GameState, ctx?: GameContext): PlayerView["powers"] {
  const powers: PlayerView["powers"] = {};
  if (!ctx) return powers;
  for (const player of PLAYER_IDS) {
    const p = state.players[player];
    const uids = [
      p.leader.uid,
      ...p.battle.filter((c) => ctx.cards.get(c.cardId)?.power !== undefined).map((c) => c.uid),
      ...p.unison.map((c) => c.uid),
    ];
    for (const uid of uids) powers[uid] = { power: powerOf(state, { player, uid }, ctx), printed: printedPowerOf(state, { player, uid }, ctx) };
  }
  return powers;
}

/** `ctx` (la base de cartes) sert à calculer les puissances ; sans elle, elles sont absentes. */
export function getPlayerView(state: GameState, viewer: PlayerId, ctx?: GameContext): PlayerView {
  const players = {} as Record<PlayerId, PlayerZonesView>;
  for (const p of PLAYER_IDS) players[p] = zonesFor(state.players[p], viewer);
  // Le générateur de hasard (state.rng) n'est volontairement pas recopié.
  return {
    viewer,
    firstPlayer: state.firstPlayer,
    turnPlayer: state.turnPlayer,
    turnNumber: state.turnNumber,
    phase: state.phase,
    pending: pendingFor(state, viewer),
    battle: state.battle ? structuredClone(state.battle) : null,
    // Seulement l'information publique (pas la mécanique interne du moteur).
    counterWindow: state.counterWindow
      ? { event: structuredClone(state.counterWindow.event), chain: structuredClone(state.counterWindow.chain) }
      : null,
    attackLimits: structuredClone(state.attackLimits),
    attackTaxes: structuredClone(state.attackTaxes),
    restrictions: structuredClone(state.restrictions),
    settings: structuredClone(state.settings),
    rules: { ...state.rules },
    result: state.result,
    players,
    powers: powersOf(state, ctx),
    comboPowers: { P1: ctx ? comboPower(state, "P1", ctx) : 0, P2: ctx ? comboPower(state, "P2", ctx) : 0 },
  };
}
