// Lecture d'un fichier de cartes JSON (format décrit dans docs/LISEZMOI-cartes.md).
// Aucune lecture de fichier ici : on reçoit le JSON déjà décodé, pour que ce code
// fonctionne aussi bien dans le navigateur que sur un serveur.

import {
  CARD_TYPES,
  COLORS,
  type CardDefinition,
  type CardFace,
  type CardType,
  type Color,
  type DeckList,
  type DeckZone,
  type EnergyCost,
  type Keyword,
  type RawAbility,
} from "./types";

export interface CardFileResult {
  cards: CardDefinition[];
  deck?: DeckList;
  /** Erreurs bloquantes : la carte concernée n'est pas chargée. */
  errors: string[];
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Valeur incertaine dans le JSON : chaîne commençant par "?". */
const isUncertain = (v: unknown): v is string => typeof v === "string" && v.startsWith("?");

class CardReader {
  readonly warnings: string[] = [];
  readonly errors: string[] = [];

  constructor(private readonly where: string) {}

  error(msg: string): void {
    this.errors.push(`${this.where} : ${msg}`);
  }

  string(obj: Json, key: string, required: boolean): string | undefined {
    const v = obj[key];
    if (v === undefined) {
      if (required) this.error(`champ "${key}" manquant`);
      return undefined;
    }
    if (typeof v !== "string") {
      this.error(`champ "${key}" doit être un texte`);
      return undefined;
    }
    return v;
  }

  number(obj: Json, key: string, required: boolean): number | undefined {
    const v = obj[key];
    if (v === undefined) {
      if (required) this.error(`champ "${key}" manquant`);
      return undefined;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
      this.error(`champ "${key}" doit être un nombre`);
      return undefined;
    }
    return v;
  }

  stringList(obj: Json, key: string): string[] {
    const v = obj[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) {
      this.error(`champ "${key}" doit être une liste de textes`);
      return [];
    }
    return v;
  }

  color(raw: string): Color | undefined {
    let name = raw;
    if (isUncertain(name)) {
      name = name.slice(1);
      this.warnings.push(`couleur "${name}" à confirmer`);
    }
    if (!(COLORS as readonly string[]).includes(name)) {
      this.error(`couleur inconnue "${raw}"`);
      return undefined;
    }
    return name as Color;
  }

  colors(obj: Json): Color[] {
    return this.stringList(obj, "colors")
      .map((c) => this.color(c))
      .filter((c): c is Color => c !== undefined);
  }

  /** Orbes : objet { green: 1 } ou texte incertain "?{ green: 3, yellow: 3 }" / "?". */
  specified(raw: unknown): Partial<Record<Color, number>> {
    if (isUncertain(raw)) {
      const result: Partial<Record<Color, number>> = {};
      for (const m of raw.matchAll(/(\w+)\s*:\s*(\d+)/g)) {
        const color = this.color(m[1]!);
        if (color) result[color] = Number(m[2]);
      }
      this.warnings.push(
        Object.keys(result).length > 0
          ? `orbes de couleur supposés ${JSON.stringify(result)}, à confirmer`
          : "orbes de couleur inconnus, à confirmer",
      );
      return result;
    }
    if (!isObject(raw)) {
      this.error(`"cost.specified" doit être un objet`);
      return {};
    }
    const result: Partial<Record<Color, number>> = {};
    for (const [name, count] of Object.entries(raw)) {
      const color = this.color(name);
      if (typeof count !== "number" || count < 0) this.error(`orbes "${name}" invalides`);
      else if (color) result[color] = count;
    }
    return result;
  }

  cost(obj: Json): EnergyCost | undefined {
    const raw = obj["cost"];
    if (raw === undefined) return undefined;
    if (!isObject(raw)) {
      this.error(`"cost" doit être un objet`);
      return undefined;
    }
    const total = raw["total"];
    if (total !== "X" && (typeof total !== "number" || total < 0)) {
      this.error(`"cost.total" doit être un nombre ou "X"`);
      return undefined;
    }
    return { total, specified: this.specified(raw["specified"] ?? {}) };
  }

  keywords(obj: Json): Keyword[] {
    const raw = obj["keywords"];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      this.error(`"keywords" doit être une liste`);
      return [];
    }
    const result: Keyword[] = [];
    for (const k of raw) {
      if (typeof k === "string") result.push({ id: k });
      else if (isObject(k) && Object.keys(k).length === 1) {
        const [id, value] = Object.entries(k)[0]!;
        if (typeof value === "number") result.push({ id, value });
        else this.error(`mot-clé "${id}" : valeur invalide`);
      } else this.error(`mot-clé invalide ${JSON.stringify(k)}`);
    }
    return result;
  }

  abilities(obj: Json): RawAbility[] {
    const raw = obj["abilities"];
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || !raw.every(isObject)) {
      this.error(`"abilities" doit être une liste d'objets`);
      return [];
    }
    return raw;
  }

  face(obj: Json, powerRequired: boolean): CardFace {
    return {
      name: this.string(obj, "name", true) ?? "",
      colors: this.colors(obj),
      power: this.number(obj, "power", powerRequired),
      character: this.stringList(obj, "character"),
      traits: this.stringList(obj, "traits"),
      era: this.string(obj, "era", false),
      keywords: this.keywords(obj),
      abilities: this.abilities(obj),
    };
  }
}

/** Types qui doivent avoir une puissance et des stats de Combo. */
const BATTLE_LIKE: readonly CardType[] = ["battle", "z_battle"];

function readCard(raw: unknown, index: number): { card?: CardDefinition; errors: string[] } {
  if (!isObject(raw)) return { errors: [`carte n°${index + 1} : ce n'est pas un objet`] };
  const id = typeof raw["id"] === "string" ? raw["id"] : undefined;
  const r = new CardReader(id ?? `carte n°${index + 1}`);
  if (!id) r.error(`champ "id" manquant`);

  const type = r.string(raw, "type", true);
  if (type !== undefined && !(CARD_TYPES as readonly string[]).includes(type)) {
    r.error(`type inconnu "${type}"`);
  }
  const cardType = type as CardType;

  const deckZoneRaw = r.string(raw, "deck_zone", false) ?? "main";
  if (!["main", "side", "z_deck"].includes(deckZoneRaw)) r.error(`deck_zone inconnue "${deckZoneRaw}"`);

  let card: CardDefinition;
  if (cardType === "leader") {
    const front = isObject(raw["front"]) ? r.face(raw["front"], true) : undefined;
    const back = isObject(raw["back"]) ? r.face(raw["back"], true) : undefined;
    if (!front) r.error(`Leader sans face avant ("front")`);
    if (!back) r.error(`Leader sans face arrière ("back")`);
    card = {
      ...(front ?? r.face({}, false)),
      id: id ?? "",
      type: cardType,
      deckZone: deckZoneRaw as DeckZone,
      front,
      back,
      warnings: r.warnings,
    };
  } else {
    const isBattle = BATTLE_LIKE.includes(cardType);
    card = {
      ...r.face(raw, isBattle),
      id: id ?? "",
      type: cardType,
      deckZone: deckZoneRaw as DeckZone,
      cost: r.cost(raw),
      zCost: r.number(raw, "z_cost", false),
      warnings: r.warnings,
    };
    if (cardType === "battle" && !card.cost) r.error(`carte de Combat sans coût ("cost")`);
    const combo = raw["combo"];
    if (isObject(combo)) {
      const cost = r.number(combo, "cost", true);
      const power = r.number(combo, "power", true);
      if (cost !== undefined && power !== undefined) card.combo = { cost, power };
    } else if (combo !== undefined) {
      r.error(`"combo" doit être un objet`);
    }
  }

  // Statut en tournoi : « "banned": true » (bannie) ou « "limit": 1 » (limitée à 1 exemplaire).
  if (raw["banned"] === true) card.banned = true;
  else if (raw["banned"] !== undefined) r.error(`"banned" doit valoir true`);
  const limit = r.number(raw, "limit", false);
  if (limit !== undefined) card.limit = limit;

  const toCheck = raw["a_verifier"];
  if (Array.isArray(toCheck)) {
    for (const note of toCheck) if (typeof note === "string") r.warnings.push(note);
  }

  return r.errors.length > 0 ? { errors: r.errors } : { card, errors: [] };
}

function readCounts(raw: unknown, label: string, errors: string[]): Record<string, number> {
  if (raw === undefined) return {};
  if (!isObject(raw)) {
    errors.push(`deck : "${label}" doit être un objet { numéro: nombre }`);
    return {};
  }
  const result: Record<string, number> = {};
  for (const [id, n] of Object.entries(raw)) {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      errors.push(`deck : "${label}.${id}" doit être un nombre entier positif`);
    } else result[id] = n;
  }
  return result;
}

function readDeck(raw: unknown, errors: string[]): DeckList | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw) || typeof raw["leader"] !== "string") {
    errors.push(`deck : champ "leader" manquant`);
    return undefined;
  }
  // Le Side Deck ne sert qu'entre les manches d'un tournoi : ignoré en partie.
  return {
    leader: raw["leader"],
    main: readCounts(raw["main"], "main", errors),
    zDeck: readCounts(raw["z_deck"], "z_deck", errors),
  };
}

export function parseCardFile(json: unknown): CardFileResult {
  if (!isObject(json) || !Array.isArray(json["cards"])) {
    return { cards: [], errors: [`le fichier doit contenir une liste "cards"`] };
  }
  const errors: string[] = [];
  const cards: CardDefinition[] = [];
  const seen = new Set<string>();
  json["cards"].forEach((raw, i) => {
    const result = readCard(raw, i);
    errors.push(...result.errors);
    if (!result.card) return;
    if (seen.has(result.card.id)) errors.push(`${result.card.id} : carte présente deux fois`);
    else {
      seen.add(result.card.id);
      cards.push(result.card);
    }
  });
  const deck = readDeck(json["deck"], errors);
  return { cards: [...cards, ...tokenDefinitions(cards)], deck, errors };
}

/**
 * 19-1-2 : un jeton a les informations indiquées par l'effet qui le crée. Pour chaque instruction
 * `create_token` d'une carte, on fabrique une fiche de carte de Combat (sans coût d'énergie,
 * 19-1-6-1) et on note son numéro dans l'instruction (`token_id`).
 */
function tokenDefinitions(cards: CardDefinition[]): CardDefinition[] {
  const result: CardDefinition[] = [];
  for (const card of cards) {
    let k = 0;
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!isObject(value)) return;
      if (value["do"] === "create_token" && isObject(value["token"])) {
        const token = value["token"];
        const id = `${card.id}-JETON${++k}`;
        value["token_id"] = id;
        const combo = isObject(token["combo"]) ? token["combo"] : undefined;
        result.push({
          id,
          type: "battle",
          deckZone: "main",
          token: true,
          name: typeof token["name"] === "string" ? token["name"] : "Jeton",
          colors: [],
          power: typeof token["power"] === "number" ? token["power"] : 0,
          character: [],
          traits: [],
          keywords: [],
          abilities: [],
          ...(combo && typeof combo["cost"] === "number" && typeof combo["power"] === "number"
            ? { combo: { cost: combo["cost"], power: combo["power"] } }
            : {}),
          warnings: [],
        });
      }
      for (const v of Object.values(value)) visit(v);
    };
    visit(card.type === "leader" ? [card.front, card.back] : card.abilities);
  }
  return result;
}

/** Rassemble plusieurs fichiers de cartes en une seule base, indexée par numéro. */
export function buildCardDatabase(cardLists: CardDefinition[][]): Map<string, CardDefinition> {
  const db = new Map<string, CardDefinition>();
  for (const list of cardLists) for (const card of list) db.set(card.id, card);
  return db;
}
