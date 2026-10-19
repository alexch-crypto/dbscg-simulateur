import { describe, expect, it } from "vitest";
import freezerFile from "../cards/freezer.json";
import { buildCardDatabase, parseCardFile, validateDeck, type DeckList } from "../src/engine";

const freezer = parseCardFile(freezerFile);
const db = buildCardDatabase([freezer.cards]);

/** Carte de Combat minimale valide, à modifier dans chaque test. */
const battleCard = (overrides: Record<string, unknown> = {}) => ({
  id: "TEST-001",
  type: "battle",
  name: "Carte de test",
  colors: ["red"],
  cost: { total: 2, specified: { red: 1 } },
  power: 10000,
  combo: { cost: 0, power: 5000 },
  ...overrides,
});

describe("Lecture du fichier deck Freezer", () => {
  it("charge les 31 cartes sans erreur", () => {
    expect(freezer.errors).toEqual([]);
    // 31 cartes + le jeton Meda créé par Clones meurtriers (19-1-2).
    expect(freezer.cards).toHaveLength(32);
    expect(freezer.cards.filter((c) => c.token).map((c) => c.id)).toEqual(["EB1-037-JETON1"]);
  });

  it("lit les deux faces du Leader", () => {
    const leader = db.get("BT24-056")!;
    expect(leader.type).toBe("leader");
    expect(leader.front?.power).toBe(10000);
    expect(leader.back?.power).toBe(15000);
    expect(leader.back?.name).toBe("Freezer, Fléau des Saiyans");
  });

  it("lit coût, couleurs, puissance et combo d'une carte de Combat", () => {
    const zarbon = db.get("P-223")!;
    expect(zarbon.cost).toEqual({ total: 2, specified: { green: 1 } });
    expect(zarbon.colors).toEqual(["green"]);
    expect(zarbon.power).toBe(5000);
    expect(zarbon.combo).toEqual({ cost: 0, power: 5000 });
  });

  it("reconnaît le mot-clé Bloqueur", () => {
    expect(db.get("P-223")!.keywords).toContainEqual({ id: "blocker" });
  });

  it("lit les mots-clés avec valeur (Espace-temps 3)", () => {
    expect(db.get("P-055")!.keywords).toContainEqual({ id: "over_realm", value: 3 });
  });

  it("garde les orbes supposés mais les signale à confirmer", () => {
    const overdrive = db.get("BT24-133")!;
    expect(overdrive.cost?.specified).toEqual({ green: 3, yellow: 3 });
    expect(overdrive.warnings.some((w) => w.includes("à confirmer"))).toBe(true);
  });

  it("orbes confirmés par le joueur : Cell Xeno 3 verts + 3 jaunes, Kinto-un 1 jaune", () => {
    expect(db.get("BT9-137")!.cost).toEqual({ total: 12, specified: { green: 3, yellow: 3 } });
    expect(db.get("BT3-104")!.cost).toEqual({ total: 1, specified: { yellow: 1 } });
    expect(db.get("BT3-104")!.warnings).toEqual([]);
  });

  it("signale des orbes totalement inconnus", () => {
    const result = parseCardFile({ cards: [battleCard({ cost: { total: 3, specified: "?" } })] });
    expect(result.cards[0]!.cost?.specified).toEqual({});
    expect(result.cards[0]!.warnings).toContain("orbes de couleur inconnus, à confirmer");
  });

  it("signale une couleur incertaine", () => {
    expect(db.get("BT29-107")!.colors).toEqual(["white"]);
    expect(db.get("BT29-107")!.warnings).toContain(`couleur "white" à confirmer`);
  });

  it("lit la composition du deck en ignorant le Side Deck", () => {
    expect(freezer.deck?.leader).toBe("BT24-056");
    expect(Object.values(freezer.deck!.main).reduce((a, b) => a + b, 0)).toBe(53);
    expect(freezer.deck!.main["EX19-12"]).toBeUndefined();
  });
});

describe("Erreurs dans le fichier de cartes", () => {
  it("refuse une carte de Combat sans puissance", () => {
    const { power: _, ...noPower } = battleCard();
    const result = parseCardFile({ cards: [noPower] });
    expect(result.cards).toHaveLength(0);
    expect(result.errors).toContain(`TEST-001 : champ "power" manquant`);
  });

  it("refuse un type de carte inconnu", () => {
    const result = parseCardFile({ cards: [battleCard({ type: "sorcery" })] });
    expect(result.errors).toContain(`TEST-001 : type inconnu "sorcery"`);
  });

  it("refuse une couleur inconnue", () => {
    const result = parseCardFile({ cards: [battleCard({ colors: ["purple"] })] });
    expect(result.errors).toContain(`TEST-001 : couleur inconnue "purple"`);
  });

  it("refuse un numéro de carte en double", () => {
    const result = parseCardFile({ cards: [battleCard(), battleCard()] });
    expect(result.errors).toContain("TEST-001 : carte présente deux fois");
  });

  it("accepte un coût de couleur supérieur au coût total (5-3-1-1)", () => {
    const result = parseCardFile({ cards: [battleCard({ cost: { total: 1, specified: { red: 2 } } })] });
    expect(result.errors).toEqual([]);
  });

  it("garde les champs inconnus sans planter (import futur d'une grande base)", () => {
    const result = parseCardFile({ cards: [battleCard({ rarity: "SR", illustrator: "?" })] });
    expect(result.errors).toEqual([]);
  });
});

describe("Construction de deck (6-1)", () => {
  const deck = (main: Record<string, number>, overrides: Partial<DeckList> = {}): DeckList => ({
    leader: "BT24-056",
    main,
    zDeck: {},
    ...overrides,
  });

  it("le deck Freezer est légal", () => {
    expect(validateDeck(freezer.deck!, db)).toEqual([]);
  });

  it("6-1-3 : refuse un deck de 49 cartes", () => {
    const main = { ...freezer.deck!.main, "BT24-105": 2, "BT24-106": 1, "BT24-136": 2 }; // 53 - 4 = 49
    expect(validateDeck(deck(main), db)).toContain(
      "6-1-3 : le deck contient 49 cartes (il en faut entre 50 et 60)",
    );
  });

  it("6-1-3 : accepte 50 et 60 cartes, refuse 61", () => {
    const ids = ["BT24-133", "BT27-080", "BT27-136", "BT9-123", "SD8-04", "BT24-105", "BT24-106", "BT24-136",
      "BT10-088", "P-561", "BT24-068", "BT24-134", "BT27-076", "BT3-104", "EB1-037"];
    const build = (total: number) => {
      const main: Record<string, number> = {};
      let left = total;
      for (const id of ids) {
        const n = Math.min(4, left);
        if (n > 0) main[id] = n;
        left -= n;
      }
      return main;
    };
    expect(validateDeck(deck(build(50)), db)).toEqual([]);
    expect(validateDeck(deck(build(60)), db)).toEqual([]);
    expect(validateDeck(deck({ ...build(60), "P-223": 1 }), db)).toContain(
      "6-1-3 : le deck contient 61 cartes (il en faut entre 50 et 60)",
    );
  });

  it("6-1-5-1 : refuse 5 exemplaires d'une même carte", () => {
    const main = { ...freezer.deck!.main, "BT24-133": 5 };
    expect(validateDeck(deck(main), db)).toContain("6-1-5-1 : BT24-133 en 5 exemplaires (maximum 4)");
  });

  it("6-1-2 : refuse un Leader qui n'est pas un Leader", () => {
    expect(validateDeck(deck(freezer.deck!.main, { leader: "P-223" }), db)).toContain(
      "6-1-2 : P-223 n'est pas un Leader",
    );
  });

  it("signale une carte absente de la base", () => {
    const main = { ...freezer.deck!.main, "XX-999": 1 };
    expect(validateDeck(deck(main), db)).toContain("deck : carte XX-999 introuvable dans la base de cartes");
  });

  it("6-1-3 : refuse une carte Z dans le deck principal", () => {
    const main = { ...freezer.deck!.main, "BT25-102": 1 };
    expect(validateDeck(deck(main), db)).toContain("6-1-3 : BT25-102 (z_battle) ne peut pas être dans le deck");
  });

  it("6-1-4 : refuse un deck Z de plus de 10 cartes", () => {
    const zDeck = { "BT22-060": 4, "BT24-059": 4, "BT25-102": 3 };
    expect(validateDeck(deck(freezer.deck!.main, { zDeck }), db)).toContain(
      "6-1-4 : le deck Z contient 11 cartes (maximum 10)",
    );
  });
});
