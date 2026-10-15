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
  /** 5-2 : choisir des cartes pendant la résolution d'un effet. */
  | { type: "CHOOSE_CARDS"; player: PlayerId; min: number; max: number; options: string[]; prompt: string };

/** Une instruction d'effet, au format du fichier de cartes (ex. { do: "draw", count: 1 }). */
export type EffectStep = Record<string, unknown> & { do: string };

/**
 * Effet en cours de résolution (9). Il peut s'arrêter pour attendre un choix du joueur,
 * puis reprendre à l'instruction `index`.
 */
export interface EffectResolution {
  /** Maître de l'effet (« vous », 0-3-2-2). */
  player: PlayerId;
  /** Carte à l'origine de l'effet. */
  source: string;
  steps: EffectStep[];
  index: number;
  /** Décision à rétablir une fois l'effet résolu (timing libre d'où l'activation est partie). */
  resume: PendingDecision;
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
  result: GameResult | null;
}
