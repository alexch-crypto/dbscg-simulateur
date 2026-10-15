// Vue d'un joueur : ce qu'il a le droit de voir, et rien d'autre.
// C'est ce qui sera envoyé par le réseau à chaque joueur.

import {
  PLAYER_IDS,
  type CardInstance,
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
  result: GameState["result"];
  players: Record<PlayerId, PlayerZonesView>;
}

const show = (c: CardInstance): VisibleCard => ({ uid: c.uid, cardId: c.cardId, owner: c.owner, mode: c.mode });
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

export function getPlayerView(state: GameState, viewer: PlayerId): PlayerView {
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
    result: state.result,
    players,
  };
}
