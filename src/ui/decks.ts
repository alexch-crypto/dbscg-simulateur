// Decks du joueur : le deck de base (fourni avec le site, non modifiable) et les decks créés,
// mémorisés dans le navigateur. Import / export en fichier JSON pour les échanger.

import { validateDeck, type CardDatabase, type DeckList, normalizeRules, type GameRules } from "../engine";

export interface SavedDeck {
  id: string;
  name: string;
  list: DeckList;
  /** Deck fourni avec le site : on peut le dupliquer, pas le modifier. */
  builtIn?: boolean;
  /** Deck « sans limites », pour les parties personnalisées (cartes bannies, plus d'exemplaires...). */
  custom?: boolean;
}

const KEY = "dbscg.decks";

/** Format d'un deck exporté (même forme que la partie « deck » des fichiers de cartes). */
interface DeckFile {
  format: "dbscg-deck";
  name: string;
  leader: string;
  main: Record<string, number>;
  z_deck: Record<string, number>;
}

export class DeckStore {
  private user: SavedDeck[] = [];

  constructor(private readonly builtIns: SavedDeck[]) {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
      if (Array.isArray(raw)) this.user = raw.filter(isSavedDeck);
    } catch {
      this.user = [];
    }
  }

  all(): SavedDeck[] {
    return [...this.builtIns, ...this.user];
  }

  get(id: string): SavedDeck | undefined {
    return this.all().find((d) => d.id === id);
  }

  /** Ajoute ou remplace un deck du joueur. */
  save(deck: SavedDeck): void {
    if (deck.builtIn) return;
    const i = this.user.findIndex((d) => d.id === deck.id);
    if (i >= 0) this.user[i] = deck;
    else this.user.push(deck);
    this.persist();
  }

  remove(id: string): void {
    this.user = this.user.filter((d) => d.id !== id);
    this.persist();
  }

  /** Copie modifiable d'un deck. */
  duplicate(id: string): SavedDeck | undefined {
    const source = this.get(id);
    if (!source) return undefined;
    const copy: SavedDeck = { id: newId(), name: `${source.name} (copie)`, list: structuredClone(source.list) };
    this.save(copy);
    return copy;
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.user));
    } catch {
      // Stockage indisponible : les decks ne seront pas gardés après fermeture de la page.
    }
  }
}

export const newId = (): string => `deck-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

function isSavedDeck(v: unknown): v is SavedDeck {
  const d = v as SavedDeck;
  return !!d && typeof d.id === "string" && typeof d.name === "string" && !!d.list && typeof d.list.leader === "string";
}

/** Nombre total de cartes d'une partie du deck. */
export const countOf = (part: Record<string, number>): number => Object.values(part).reduce((a, b) => a + b, 0);

/** Règles les plus larges d'une partie personnalisée : ce qu'un deck « sans limites » peut contenir. */
export const FREE_RULES: GameRules = normalizeRules({ allowBanned: true, ignoreLimited: true, maxCopies: 99, deckMin: 1, deckMax: 200, zDeckMax: 50 });

/** Erreurs de construction du deck selon des règles (officielles par défaut ; vide si jouable). */
export const deckErrors = (deck: SavedDeck, db: CardDatabase, rules?: GameRules): string[] => validateDeck(deck.list, db, rules);

/** Contenu du fichier exporté. */
export function deckToFile(deck: SavedDeck): string {
  const file: DeckFile = { format: "dbscg-deck", name: deck.name, leader: deck.list.leader, main: deck.list.main, z_deck: deck.list.zDeck };
  return JSON.stringify(file, null, 1);
}

/** Lit un fichier de deck. Renvoie le deck, ou un message d'erreur. */
export function deckFromFile(text: string): SavedDeck | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "ce fichier n'est pas un fichier JSON valide";
  }
  const f = raw as Partial<DeckFile> & { deck?: Partial<DeckFile> };
  // On accepte aussi un fichier de cartes complet (sa partie « deck »).
  const d = f.deck && typeof f.deck.leader === "string" ? f.deck : f;
  if (typeof d.leader !== "string" || typeof d.main !== "object" || d.main === null) return "ce fichier ne contient pas de deck";
  const counts = (part: unknown): Record<string, number> => {
    const result: Record<string, number> = {};
    if (part && typeof part === "object") {
      for (const [id, n] of Object.entries(part)) if (typeof n === "number" && n > 0) result[id] = Math.floor(n);
    }
    return result;
  };
  return {
    id: newId(),
    name: typeof f.name === "string" && f.name.trim() ? f.name.trim().slice(0, 40) : "Deck importé",
    list: { leader: d.leader, main: counts(d.main), zDeck: counts(d.z_deck) },
  };
}
