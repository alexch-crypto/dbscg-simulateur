// Import / export des decks du joueur (fichiers JSON échangés entre joueurs).
import { describe, expect, it } from "vitest";
import { deckFromFile, deckToFile, type SavedDeck } from "../src/ui/decks";
import { db, freezer } from "./helpers";
import { validateDeck } from "../src/engine";

describe("Decks : fichiers d'import / export", () => {
  const deck: SavedDeck = { id: "x", name: "Mon Freezer", list: freezer.deck! };

  it("un deck exporté puis importé est identique (nouveau numéro, même contenu)", () => {
    const back = deckFromFile(deckToFile(deck));
    expect(typeof back).not.toBe("string");
    const d = back as SavedDeck;
    expect(d.name).toBe("Mon Freezer");
    expect(d.list).toEqual(freezer.deck);
    expect(d.id).not.toBe("x");
    expect(validateDeck(d.list, db)).toEqual([]);
  });

  it("accepte aussi un fichier de cartes complet (sa partie « deck »)", () => {
    const text = JSON.stringify({ cards: [], deck: { leader: "BT24-056", main: { "BT3-104": 2 }, z_deck: { "P-405": 1 } } });
    const d = deckFromFile(text) as SavedDeck;
    expect(d.list).toEqual({ leader: "BT24-056", main: { "BT3-104": 2 }, zDeck: { "P-405": 1 } });
  });

  it("refuse un fichier qui n'est pas un deck", () => {
    expect(deckFromFile("pas du json")).toContain("JSON");
    expect(deckFromFile(JSON.stringify({ bonjour: 1 }))).toContain("pas de deck");
  });
});
