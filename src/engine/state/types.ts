// État complet d'une partie. Uniquement des données simples (pas de classes, pas de Map) :
// l'état doit pouvoir être converti en JSON et renvoyé tel quel (sauvegarde, réseau, serveur).
// Cet état contient TOUT, y compris les informations secrètes : il ne doit jamais être
// envoyé à un joueur. Un joueur reçoit seulement sa vue (voir view.ts).

export type PlayerId = "P1" | "P2";
export const PLAYER_IDS: readonly PlayerId[] = ["P1", "P2"];
export const opponentOf = (p: PlayerId): PlayerId => (p === "P1" ? "P2" : "P1");

/** Mode Action (carte droite) ou mode Inertie (carte tournée). */
export type Mode = "active" | "rest";

/** Un exemplaire physique de carte pendant la partie. */
export interface CardInstance {
  /** Identifiant unique dans la partie (ex. "P1-17"), attribué au hasard pour ne rien révéler. */
  uid: string;
  /** Numéro de carte dans la base (ex. "BT24-133"). */
  cardId: string;
  /** Propriétaire (0-3-3). */
  owner: PlayerId;
  mode: Mode;
  /**
   * Carte face visible dans une zone normalement secrète (ex. carte de Vie face visible).
   * Dans une zone publique, la carte est toujours visible et ce champ n'est pas utilisé.
   */
  faceUp: boolean;
}

export interface LeaderState {
  uid: string;
  cardId: string;
  /** Face avant ou face arrière (après Éveil, 22-2-4). */
  side: "front" | "back";
  mode: Mode;
}

/** Zones contenant des cartes. L'ordre des listes compte : index 0 = dessus du deck. */
export interface PlayerZones {
  deck: CardInstance[];
  hand: CardInstance[];
  life: CardInstance[];
  energy: CardInstance[];
  battle: CardInstance[];
  combo: CardInstance[];
  drop: CardInstance[];
  zEnergy: CardInstance[];
  /** Dimension parallèle : cartes placées de côté face (20-8-1). */
  warp: CardInstance[];
  /** Cartes retirées de la partie (ex. [Ultimate], 22-14-3) : visibles par tous. */
  removed: CardInstance[];
}
export type ZoneName = keyof PlayerZones;

/** Zones secrètes : seules les cartes face visible (faceUp) y sont montrées. */
export const SECRET_ZONES: readonly ZoneName[] = ["deck", "hand", "life"];

export interface PlayerState extends PlayerZones {
  id: PlayerId;
  leader: LeaderState;
  /** Marqueurs Énergie (1-14), ex. celui du second joueur (6-2-1-11). */
  energyMarkers: number;
}

export type Phase = "setup" | "charge" | "main" | "end" | "game_over";

/**
 * Décision qu'un joueur précis doit prendre avant que la partie puisse avancer.
 * Tant qu'elle existe, seules les actions qui y répondent (et l'abandon) sont acceptées.
 */
export type PendingDecision =
  /** 6-2-1-4 : le joueur désigné par le hasard choisit qui joue en premier. */
  | { type: "CHOOSE_FIRST_PLAYER"; player: PlayerId }
  /** 6-2-1-9 : le joueur peut repiocher sa main une fois. */
  | { type: "MULLIGAN"; player: PlayerId }
  /** 7-2-11 : le joueur actif peut placer une carte de sa main dans sa Zone d'Énergie. */
  | { type: "CHARGE"; player: PlayerId }
  /** 7-3-4 : timing libre de la phase principale du joueur actif. */
  | { type: "MAIN"; player: PlayerId }
  /** 8-1-3 / 22-4 : le défenseur peut activer [Bloqueur] avec une de ses cartes. */
  | { type: "BLOCKER"; player: PlayerId }
  /** 8-2-4 : timing libre de l'étape d'Attaque (joueur actif). */
  | { type: "OFFENSE"; player: PlayerId }
  /** 8-3-4 : timing libre de l'étape de Défense (joueur non actif). */
  | { type: "DEFENSE"; player: PlayerId }
  /**
   * 21-3 : le joueur qui subit des dégâts choisit `amount` cartes de sa Zone de Vie, toutes
   * en même temps. Avec [Coup Critique] (`critical`), elles vont en Dispersion au lieu de la main.
   */
  | { type: "TAKE_DAMAGE"; player: PlayerId; amount: number; critical: boolean }
  /** 8-5-2 / 8-5-3 : placer jusqu'à une carte de sa Zone de Combo dans sa Zone d'Énergie Z. */
  | { type: "COMBO_TO_Z"; player: PlayerId }
  /**
   * 5-2 : choisir des cartes pendant la résolution d'un effet. `looked` : cartes d'une zone
   * secrète que le joueur regarde (ex. le dessus de son deck, 20-12) — visibles par lui seul.
   */
  | {
      type: "CHOOSE_CARDS";
      player: PlayerId;
      min: number;
      max: number;
      options: string[];
      prompt: string;
      looked?: { uid: string; cardId: string }[];
    }
  /** Choisir des positions dans la main adverse, à l'aveugle. */
  | { type: "CHOOSE_BLIND"; player: PlayerId; owner: PlayerId; min: number; max: number; prompt: string }
  /** Choisir une option (« Vous pouvez... » oui/non, quel mot-clé annuler...). */
  | { type: "CHOOSE_OPTION"; player: PlayerId; options: { id: string; label: string }[]; prompt: string }
  /**
   * 3-9-2 : choisir des cartes de sa Zone de Vie pendant un effet (« rajoutez à votre main une
   * carte de vos points de vie »). On choisit des POSITIONS, à l'aveugle.
   */
  | { type: "CHOOSE_LIFE"; player: PlayerId; min: number; max: number; prompt: string }
  /** 9-6-3 : plusieurs [Auto.] du même joueur sont en attente : il choisit laquelle résoudre. */
  | { type: "CHOOSE_AUTO"; player: PlayerId; options: { id: number; label: string }[] };

/** Une instruction d'effet, au format du fichier de cartes (ex. { do: "draw", count: 1 }). */
export type EffectStep = Record<string, unknown> & { do: string };

/**
 * Que faire une fois un effet ou un point de contrôle terminé. Ce sont de simples étiquettes
 * (et non des fonctions) pour que l'état reste convertible en JSON.
 */
export type Continuation =
  /** Revenir à un timing libre (phase principale, étape d'Attaque...). */
  | { kind: "restore"; pending: PendingDecision }
  /** Reprendre le point de contrôle en cours (d'autres [Auto.] peuvent attendre). */
  | { kind: "checkpoint" }
  /** 8-1 : après les [Auto.] de la déclaration d'attaque, passer au blocage. */
  | { kind: "blocker_step" }
  /** 8-4-9 : après l'étape des Dégâts, passer à l'étape de Fin de Combat. */
  | { kind: "battle_end_step" };

/**
 * Effet en cours de résolution (9). Il peut s'arrêter pour attendre un choix du joueur,
 * puis reprendre à l'instruction `index`.
 */
export interface EffectResolution {
  /** Maître de l'effet (« vous », 0-3-2-2). */
  player: PlayerId;
  /** Carte à l'origine de l'effet (« cette carte »). */
  source: { uid: string; cardId: string };
  steps: EffectStep[];
  index: number;
  /** Ce qu'il faut faire une fois l'effet résolu. */
  then: Continuation;
  /** Cartes choisies et mémorisées par une instruction (`save_as`), ex. « la carte choisie ». */
  saved: Record<string, string[]>;
  /** Cartes en attente d'un second choix dans l'instruction en cours (ex. quel mot-clé annuler). */
  memo: string[];
}

/**
 * Effet continu sur une carte en jeu, jusqu'à la fin du tour `untilTurn` (inclus), ou jusqu'à
 * la fin du combat si `battleOnly`. Il disparaît si la carte quitte la zone (9-9-2).
 */
export type ContinuousEffect = { uid: string; untilTurn: number; battleOnly?: boolean } & (
  | /**
     * « ne peut pas passer en mode Action ». `chargeOnly` : seulement pendant la phase de
     * Recharge (7-2-7), sinon aussi via des effets ([Réplique], « passez en mode Action »).
     */ { kind: "lock_active"; chargeOnly: boolean }
  | /** « annulez ses Capacités » (9-1). */ { kind: "negate_all" }
  | /** « annulez sa Capacité-clef X ». */ { kind: "negate_keyword"; keyword: string }
  | /** « acquiert [X] ». */ { kind: "grant_keyword"; keyword: string }
);

/** Capacité [Auto.] d'une carte, en état de suspens (9-6-2). */
export interface QueuedAuto {
  /** Numéro unique (pour que le joueur puisse choisir l'ordre). */
  id: number;
  /** Maître de la Capacité. */
  player: PlayerId;
  /** Carte qui possède la Capacité (uid + numéro de carte, qui reste connu si elle change de zone). */
  source: { uid: string; cardId: string };
  /**
   * Copie de la Capacité au moment du déclenchement : elle se résout même si la carte a
   * changé de zone ou perdu ses Capacités entre-temps (9-6-11).
   */
  ability: Record<string, unknown>;
  /** Clé pour les limites « Une fois par tour » / « Limite X ». */
  abilityKey: string;
}

/** Modification de puissance temporaire (« +10000 de puissance pour tout le tour »). */
export interface PowerModifier {
  uid: string;
  amount: number;
  until: "turn" | "battle";
}

/** Désigne un Leader ou une carte de Combat en jeu. */
export interface CardRef {
  player: PlayerId;
  uid: string;
}

/** Combat en cours (8-1-2). */
export interface BattleState {
  /** Carte attaquante (8-1-2-1). */
  attacker: CardRef;
  /** Carte de défense : la carte attaquée, ou le Bloqueur qui l'a remplacée (22-4-3). */
  defender: CardRef;
  /** Carte visée par la déclaration d'attaque. */
  target: CardRef;
  step: "attack_declared" | "offense" | "defense" | "damage" | "end";
  /**
   * Capacités [Auto.] en attente (en état de suspens), résolues plus tard dans le combat.
   * Elles se résolvent même si la carte perd ses Capacités entre-temps.
   */
  pendingAutos: PendingAuto[];
}

/** Capacité [Auto.] en suspens. */
export type PendingAuto =
  /** 22-8 : [Réplique] / [Tri-offensive] — passer la carte en mode Action après le combat. */
  { kind: "dual_attack"; card: CardRef; usageKey: string };

export type GameResult =
  | { kind: "win"; winner: PlayerId; reason: string }
  | { kind: "draw"; reason: string };

export interface GameState {
  /** État du générateur de hasard (secret : jamais envoyé aux joueurs). */
  rng: number;
  players: Record<PlayerId, PlayerState>;
  /** Joueur qui joue en premier (null tant qu'il n'est pas décidé, 6-2-1-4). */
  firstPlayer: PlayerId | null;
  /** Joueur actif (0-3-2-1). */
  turnPlayer: PlayerId;
  /** Numéro du tour, 0 pendant la mise en place. */
  turnNumber: number;
  phase: Phase;
  /** Décision attendue (null si aucune). */
  pending: PendingDecision | null;
  /** Combat en cours (null en dehors d'un combat). */
  battle: BattleState | null;
  /** Effet en cours de résolution (null si aucun). */
  resolving: EffectResolution | null;
  /**
   * Compteurs « par tour » (Une fois par tour, Limite X, Réplique...), remis à zéro au
   * début de chaque tour. Clé = capacité + carte, valeur = nombre d'utilisations.
   */
  turnUsage: Record<string, number>;
  /** [Auto.] en état de suspens, en attente du prochain point de contrôle (9-6). */
  autoQueue: QueuedAuto[];
  /** Point de contrôle en cours : ce qu'il faudra faire une fois toutes les [Auto.] résolues. */
  checkpointThen: Continuation | null;
  /** Prochain numéro d'[Auto.] en suspens. */
  nextAutoId: number;
  /** Modifications de puissance temporaires en cours. */
  powerMods: PowerModifier[];
  /** Autres effets continus en cours (verrouillage, annulation, mots-clés donnés). */
  effects: ContinuousEffect[];
  result: GameResult | null;
}
