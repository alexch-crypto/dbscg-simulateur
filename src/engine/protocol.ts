// Le « protocole » du moteur : les actions (ce que les joueurs envoient) et les événements
// (ce que le moteur annonce). Tout est en JSON simple, prêt à passer par le réseau.
//
// IMPORTANT : un événement est envoyé aux DEUX joueurs. Il ne doit donc contenir que des
// informations publiques (ex. « P1 pioche 2 cartes », jamais lesquelles). Les détails
// secrets se lisent dans la vue de chaque joueur (view.ts).

import type { CardDatabase } from "./cards/types";
import type { GameResult, Phase, PlayerId } from "./state/types";

export type Action =
  /** 0-1-3-4 : abandonner, possible à tout moment. */
  | { type: "CONCEDE"; player: PlayerId }
  /** 6-2-1-4 : désigner le joueur qui joue en premier. */
  | { type: "CHOOSE_FIRST_PLAYER"; player: PlayerId; first: PlayerId }
  /** 6-2-1-9 : repiocher sa main (redraw: true) ou la garder (redraw: false). */
  | { type: "MULLIGAN"; player: PlayerId; redraw: boolean }
  /** 7-2-11 : placer une carte de sa main (uid) dans sa Zone d'Énergie, ou rien (null). */
  | { type: "CHARGE_ENERGY"; player: PlayerId; uid: string | null }
  /** 7-3-4-1 / 5-5-2 : jouer une carte de Combat depuis sa main en payant son coût. */
  | { type: "PLAY_CARD"; player: PlayerId; uid: string; payment: PaymentChoice }
  /** 7-3-4-5 : terminer sa phase principale. */
  | { type: "END_MAIN_PHASE"; player: PlayerId }
  /** 8-1-1 : attaquer avec son Leader ou une carte de Combat (uids) une cible adverse. */
  | { type: "ATTACK"; player: PlayerId; attacker: string; target: string }
  /** 22-4 : activer [Bloqueur] avec une de ses cartes (uid), ou ne pas bloquer (null). */
  | { type: "DECLARE_BLOCKER"; player: PlayerId; uid: string | null }
  /** 5-7 : utiliser une carte (de la main ou de la Zone de Combat) pour une Combo. */
  | { type: "COMBO"; player: PlayerId; uid: string; payment: PaymentChoice }
  /** 8-2-4-3 / 8-3-4-3 : finir son étape d'Attaque ou de Défense. */
  | { type: "END_STEP"; player: PlayerId }
  /** 21-3 : choisir, d'un coup, les cartes de sa Zone de Vie qui partent (positions, 0 = première). */
  | { type: "TAKE_LIFE"; player: PlayerId; indices: number[] }
  /** 8-5-2 / 8-5-3 : placer une carte de sa Zone de Combo en Énergie Z (uid), ou aucune (null). */
  | { type: "COMBO_TO_Z_ENERGY"; player: PlayerId; uid: string | null }
  /** 22-2 : activer l'[Éveil] de son Leader (phase principale, étape d'Attaque ou de Défense). */
  | { type: "AWAKEN"; player: PlayerId }
  /** 5-2 : répondre à une demande de choix pendant la résolution d'un effet. */
  | { type: "CHOOSE_CARDS"; player: PlayerId; uids: string[] };

/** Ce que le joueur passe en mode Inertie pour payer : ses Énergies (uids) et des marqueurs Énergie. */
export interface PaymentChoice {
  energy: string[];
  markers: number;
}

export type GameEvent =
  | { type: "COIN_TOSS"; winner: PlayerId }
  | { type: "FIRST_PLAYER_CHOSEN"; chooser: PlayerId; first: PlayerId }
  | { type: "DECK_SHUFFLED"; player: PlayerId }
  | { type: "CARDS_DRAWN"; player: PlayerId; count: number }
  | { type: "MULLIGAN"; player: PlayerId; redraw: boolean }
  | { type: "LIFE_PLACED"; player: PlayerId; count: number }
  | { type: "ENERGY_MARKER_PLACED"; player: PlayerId; count: number }
  | { type: "TURN_STARTED"; player: PlayerId; turnNumber: number }
  | { type: "CARDS_READIED"; player: PlayerId }
  /** La Zone d'Énergie est publique : la carte posée est révélée. */
  | { type: "ENERGY_CHARGED"; player: PlayerId; uid: string; cardId: string; mode: "active" | "rest" }
  | { type: "PHASE_STARTED"; player: PlayerId; phase: Phase }
  | {
      type: "CARD_PLAYED";
      player: PlayerId;
      uid: string;
      cardId: string;
      energyRested: string[];
      markersUsed: number;
    }
  | { type: "TURN_ENDED"; player: PlayerId }
  | { type: "ATTACK_DECLARED"; player: PlayerId; attacker: string; target: string }
  | { type: "BLOCKER_DECLARED"; player: PlayerId; uid: string }
  | { type: "BATTLE_STEP"; step: "offense" | "defense" | "damage" | "end" }
  /** Une carte utilisée pour une Combo est révélée (main) ou visible (Zone de Combat) : information publique. */
  | {
      type: "COMBO";
      player: PlayerId;
      uid: string;
      cardId: string;
      from: "hand" | "battle";
      energyRested: string[];
      markersUsed: number;
    }
  | { type: "POWER_COMPARED"; attacker: number; defender: number }
  | { type: "DAMAGE_DEALT"; player: PlayerId; amount: number; critical: boolean }
  /**
   * Cartes de Vie perdues (vers la main, ou la Dispersion avec [Coup Critique]).
   * `cardIds[i]` n'est connu (non null) que si la carte va en Dispersion ou était face visible.
   */
  | { type: "LIFE_LOST"; player: PlayerId; indices: number[]; to: "hand" | "drop"; cardIds: (string | null)[] }
  | { type: "CARD_KO"; player: PlayerId; uid: string; cardId: string }
  /** Carte retirée de la partie (ex. [Ultimate], 22-14-3). */
  | { type: "CARD_REMOVED"; player: PlayerId; uid: string; cardId: string }
  /** Carte repassée en mode Action par une Capacité (ex. [Réplique]). */
  | { type: "CARD_READIED"; player: PlayerId; uid: string; reason: "dual_attack" }
  | { type: "Z_ENERGY_PLACED"; player: PlayerId; uid: string; cardId: string }
  | { type: "COMBO_ZONE_CLEARED"; player: PlayerId; count: number }
  | { type: "BATTLE_ENDED" }
  | { type: "AWAKEN_ACTIVATED"; player: PlayerId }
  | { type: "LEADER_FLIPPED"; player: PlayerId; side: "front" | "back" }
  | { type: "ENERGY_SET_ACTIVE"; player: PlayerId; uids: string[] }
  | { type: "GAME_OVER"; result: GameResult };

/** Informations fixes dont le moteur a besoin (la base de cartes). */
export interface GameContext {
  cards: CardDatabase;
}
