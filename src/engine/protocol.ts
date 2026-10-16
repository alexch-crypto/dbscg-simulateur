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
  | { type: "CHOOSE_CARDS"; player: PlayerId; uids: string[] }
  /** Choisir des positions de sa Zone de Vie pendant un effet (0 = première). */
  | { type: "CHOOSE_LIFE"; player: PlayerId; indices: number[] }
  /** 9-6-3 : choisir quelle [Auto.] en attente résoudre maintenant. */
  | { type: "CHOOSE_AUTO"; player: PlayerId; id: number }
  /** Choisir des positions dans la main adverse, à l'aveugle. */
  | { type: "CHOOSE_BLIND"; player: PlayerId; indices: number[] }
  /** Choisir une option (oui/non, mot-clé...). */
  | { type: "CHOOSE_OPTION"; player: PlayerId; id: string }
  /**
   * 9-4 : activer une Capacité [Activation] d'une carte (Leader, Zone de Combat, main ou
   * Dispersion). `index` = position de la Capacité sur la carte ; `payment` = Énergies payées
   * pour le coût d'énergie de la Capacité (s'il y en a un).
   */
  | { type: "ACTIVATE"; player: PlayerId; uid: string; index: number; payment: PaymentChoice }
  /** 9-7 : ne rien déclarer pendant une fenêtre de contre. */
  | { type: "PASS_COUNTER"; player: PlayerId }
  /**
   * 22-10 : déclarer le [Contre] d'une carte de sa main. `alt` : payer avec le coût alternatif
   * indiqué par la carte (ex. une carte de Vie au lieu de l'énergie).
   */
  | { type: "DECLARE_COUNTER"; player: PlayerId; uid: string; alt: boolean; payment: PaymentChoice };

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
  /** 5-5-2-1 : la mise en jeu est déclarée (coût payé, carte révélée), avant la fenêtre de contre. */
  | {
      type: "PLAY_DECLARED";
      player: PlayerId;
      uid: string;
      cardId: string;
      energyRested: string[];
      markersUsed: number;
    }
  /** 5-5-2-3 : la carte arrive dans la Zone de Combat. */
  | { type: "CARD_PLAYED"; player: PlayerId; uid: string; cardId: string }
  | { type: "COUNTER_WINDOW_OPENED"; on: "play" | "attack"; player: PlayerId }
  | { type: "COUNTER_WINDOW_CLOSED" }
  /** Un [Contre] est déclaré : la carte est révélée. */
  | { type: "COUNTER_DECLARED"; player: PlayerId; uid: string; cardId: string; text: string }
  | { type: "COUNTER_RESOLVING"; player: PlayerId; cardId: string }
  | { type: "ATTACK_NEGATED" }
  | { type: "ATTACKS_LIMITED"; player: PlayerId; remaining: number; battleCardsOnly: boolean }
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
  /** Carte jouée via une Capacité (5-5-3), sans payer son coût. */
  | { type: "CARD_PLAYED_BY_SKILL"; player: PlayerId; uid: string; cardId: string; from: "hand" | "drop"; mode: "active" | "rest" }
  /** Capacité [Activation] activée (9-4) : la carte est révélée si elle était en main. */
  | { type: "ABILITY_ACTIVATED"; player: PlayerId; uid: string; cardId: string; index: number; text: string }
  | { type: "CARDS_LOCKED"; uids: string[] }
  | { type: "SKILLS_NEGATED"; uids: string[] }
  | { type: "KEYWORD_NEGATED"; uid: string; keyword: string }
  | { type: "KEYWORDS_GRANTED"; uids: string[]; keywords: string[] }
  /** Cartes défaussées (main → Dispersion, zone publique : révélées). */
  | { type: "CARDS_DISCARDED"; player: PlayerId; cardIds: string[] }
  | { type: "CARDS_TO_WARP"; player: PlayerId; cardIds: string[] }
  | { type: "CARD_TO_DROP"; player: PlayerId; uid: string; cardId: string; from: string }
  /** Le joueur regarde des cartes du dessus de son deck (l'adversaire voit seulement le nombre). */
  | { type: "DECK_LOOKED"; player: PlayerId; count: number }
  /** Cartes ajoutées à la main depuis le deck (révélées seulement si l'effet le demande). */
  | { type: "CARDS_TO_HAND"; player: PlayerId; from: "deck"; cardIds: (string | null)[] }
  /** Une [Auto.] se met en suspens (9-6-2). */
  | { type: "AUTO_TRIGGERED"; player: PlayerId; uid: string; cardId: string }
  /** Une [Auto.] en attente ne se résout pas (limite atteinte, condition non remplie...). */
  | { type: "AUTO_CANCELLED"; player: PlayerId; cardId: string; reason: string }
  /** Une partie d'effet que le moteur ne sait pas encore faire a été ignorée. */
  | { type: "NOT_IMPLEMENTED"; player: PlayerId; cardId: string; what: string }
  | { type: "CARDS_MODE_CHANGED"; uids: string[]; mode: "active" | "rest" }
  | { type: "POWER_MODIFIED"; uid: string; amount: number; until: "turn" | "battle" }
  /** Cartes de Vie rajoutées à la main par un effet (cardIds connus seulement si face visible). */
  | { type: "LIFE_TO_HAND"; player: PlayerId; indices: number[]; cardIds: (string | null)[] }
  | { type: "GAME_OVER"; result: GameResult };

/** Informations fixes dont le moteur a besoin (la base de cartes). */
export interface GameContext {
  cards: CardDatabase;
}
