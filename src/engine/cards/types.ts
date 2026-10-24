// Forme interne d'une carte pour le moteur.
// Le fichier JSON (cards/*.json) est converti dans cette forme par loader.ts.

export const COLORS = ["red", "blue", "green", "yellow", "black", "white"] as const;
export type Color = (typeof COLORS)[number];

export const CARD_TYPES = [
  "leader",
  "battle",
  "extra",
  "unison",
  "z_leader",
  "z_battle",
  "z_extra",
  "z_unison",
] as const;
export type CardType = (typeof CARD_TYPES)[number];

/** Zone de construction de deck d'où vient la carte. */
export type DeckZone = "main" | "side" | "z_deck";

/** Coût d'Énergie (1-2) : coût total + orbes de couleur obligatoires. */
export interface EnergyCost {
  /** "X" = coût choisi par le joueur (Unissons). */
  total: number | "X";
  /** Nombre d'orbes obligatoires par couleur. Peut dépasser le total (5-3-1-1). */
  specified: Partial<Record<Color, number>>;
}

export interface ComboStats {
  cost: number;
  power: number;
}

/** Mot-clé, avec une valeur éventuelle (ex. Espace-temps 3). */
export interface Keyword {
  id: string;
  value?: number;
}

/**
 * Capacité telle qu'écrite dans le JSON. Le moteur ne l'interprète pas encore :
 * elle est conservée pour les étapes « mots-clés » et « effets ».
 */
export type RawAbility = Record<string, unknown>;

/** Ce qui est imprimé sur une face de carte. */
export interface CardFace {
  name: string;
  colors: Color[];
  power?: number;
  character: string[];
  traits: string[];
  era?: string;
  keywords: Keyword[];
  abilities: RawAbility[];
}

export interface CardDefinition extends CardFace {
  /** Numéro de carte (ex. "BT24-056"), sert pour la limite de 4 exemplaires (6-1-5-1). */
  id: string;
  type: CardType;
  deckZone: DeckZone;
  cost?: EnergyCost;
  /** Coût d'Énergie Z (1-4). */
  zCost?: number;
  combo?: ComboStats;
  /** 19 : jeton créé par un effet (pas une vraie carte : jamais dans un deck). */
  token?: boolean;
  /** Leaders uniquement : face avant (front) et face arrière (back). */
  front?: CardFace;
  back?: CardFace;
  /** Interdite en partie officielle (liste des cartes bannies). */
  banned?: boolean;
  /** Carte limitée : nombre maximum d'exemplaires dans un deck officiel (ex. 1). */
  limit?: number;
  /** Données à faire confirmer par le joueur (valeurs commençant par "?", listes a_verifier). */
  warnings: string[];
}

export type CardDatabase = ReadonlyMap<string, CardDefinition>;

export interface DeckList {
  leader: string;
  /** Numéro de carte → nombre d'exemplaires. */
  main: Record<string, number>;
  zDeck: Record<string, number>;
}
