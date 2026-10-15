import { describe, expect, it } from "vitest";
import { applyAction, createGame, getPlayerView, type GameState } from "../src/engine";
import { nextRandom, shuffleInPlace } from "../src/engine/rng";
import { ctx, db, freezer, newMirrorGame } from "./helpers";

/** Déplace les n premières cartes du deck d'un joueur vers une zone (préparation de scénario). */
function moveFromDeck(state: GameState, player: "P1" | "P2", zone: "hand" | "life" | "battle", n: number) {
  const p = state.players[player];
  p[zone].push(...p.deck.splice(0, n));
}

describe("Création d'une partie", () => {
  it("place chaque Leader côté face (6-2-1-2) et les 53 cartes dans le deck", () => {
    const s = newMirrorGame();
    for (const p of [s.players.P1, s.players.P2]) {
      expect(p.leader).toMatchObject({ cardId: "BT24-056", side: "front", mode: "active" });
      expect(p.deck).toHaveLength(53);
      expect(p.hand).toHaveLength(0);
    }
    expect(s.phase).toBe("setup");
    expect(s.firstPlayer).toBeNull();
  });

  it("chaque exemplaire a un identifiant unique", () => {
    const s = newMirrorGame();
    const uids = [...s.players.P1.deck, ...s.players.P2.deck].map((c) => c.uid);
    expect(new Set(uids).size).toBe(106);
  });

  it("refuse un deck illégal", () => {
    const badDeck = { ...freezer.deck!, main: { ...freezer.deck!.main, "BT24-133": 5 } };
    const result = createGame({ decks: { P1: badDeck, P2: freezer.deck! }, seed: 1 }, db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("P1 : 6-1-5-1 : BT24-133 en 5 exemplaires (maximum 4)");
  });

  it("l'état passe en JSON et revient identique (sauvegarde / réseau)", () => {
    const s = newMirrorGame();
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe("Hasard à graine", () => {
  it("même graine => même mélange", () => {
    const a = newMirrorGame(7);
    const b = newMirrorGame(7);
    expect(a).toEqual(b);
  });

  it("graines différentes => mélanges différents", () => {
    const list = () => Array.from({ length: 50 }, (_, i) => i);
    const a = list();
    const b = list();
    shuffleInPlace({ rng: 1 }, a);
    shuffleInPlace({ rng: 2 }, b);
    expect(a).not.toEqual(b);
  });

  it("les tirages restent dans [0, 1)", () => {
    const holder = { rng: 123 };
    for (let i = 0; i < 1000; i++) {
      const x = nextRandom(holder);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe("Vue d'un joueur : informations cachées", () => {
  const scenario = () => {
    const s = newMirrorGame();
    moveFromDeck(s, "P1", "hand", 6);
    moveFromDeck(s, "P1", "life", 8);
    moveFromDeck(s, "P1", "battle", 1);
    return s;
  };

  it("je vois ma propre main", () => {
    const s = scenario();
    const view = getPlayerView(s, "P1");
    expect(view.players.P1.hand.map((c) => ("uid" in c ? c.uid : null))).toEqual(s.players.P1.hand.map((c) => c.uid));
  });

  it("je ne vois pas la main adverse, seulement le nombre de cartes", () => {
    const s = scenario();
    const view = getPlayerView(s, "P2");
    expect(view.players.P1.hand).toEqual(Array(6).fill({ hidden: true }));
  });

  it("personne ne voit le deck, pas même son propriétaire : seulement le nombre", () => {
    const s = scenario();
    for (const viewer of ["P1", "P2"] as const) {
      const view = getPlayerView(s, viewer);
      expect(view.players.P1.deckCount).toBe(53 - 15);
      expect(view.players.P1).not.toHaveProperty("deck");
    }
  });

  it("les cartes de Vie sont cachées aux deux joueurs", () => {
    const s = scenario();
    expect(getPlayerView(s, "P1").players.P1.life).toEqual(Array(8).fill({ hidden: true }));
    expect(getPlayerView(s, "P2").players.P1.life).toEqual(Array(8).fill({ hidden: true }));
  });

  it("une carte de Vie face visible est montrée aux deux joueurs, à sa position", () => {
    const s = scenario();
    s.players.P1.life[2]!.faceUp = true;
    const card = s.players.P1.life[2]!;
    for (const viewer of ["P1", "P2"] as const) {
      const life = getPlayerView(s, viewer).players.P1.life;
      expect(life[2]).toEqual({ uid: card.uid, cardId: card.cardId, owner: "P1", mode: "active" });
      expect(life.filter((c) => "hidden" in c)).toHaveLength(7);
    }
  });

  it("une carte révélée de la main adverse est visible", () => {
    const s = scenario();
    s.players.P1.hand[0]!.faceUp = true;
    const hand = getPlayerView(s, "P2").players.P1.hand;
    expect(hand[0]).toMatchObject({ uid: s.players.P1.hand[0]!.uid });
    expect(hand.slice(1)).toEqual(Array(5).fill({ hidden: true }));
  });

  it("les zones publiques sont visibles par l'adversaire", () => {
    const s = scenario();
    expect(getPlayerView(s, "P2").players.P1.battle).toHaveLength(1);
  });

  it("aucun identifiant de carte cachée ne fuit dans la vue adverse", () => {
    const s = scenario();
    const hiddenUids = [...s.players.P1.hand, ...s.players.P1.life, ...s.players.P1.deck].map((c) => c.uid);
    const text = JSON.stringify(getPlayerView(s, "P2"));
    for (const uid of hiddenUids) expect(text).not.toContain(`"${uid}"`);
  });

  it("le générateur de hasard n'est jamais envoyé aux joueurs", () => {
    const s = scenario();
    expect(getPlayerView(s, "P1")).not.toHaveProperty("rng");
    expect(JSON.stringify(getPlayerView(s, "P2"))).not.toContain(`"rng"`);
  });
});

describe("Actions", () => {
  it("0-1-3-4 : un joueur peut concéder et perd immédiatement", () => {
    const s = newMirrorGame();
    const r = applyAction(s, { type: "CONCEDE", player: "P2" }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.result).toEqual({ kind: "win", winner: "P1", reason: "0-1-3-4 : abandon" });
    expect(r.events).toEqual([{ type: "GAME_OVER", result: r.state.result }]);
  });

  it("l'état d'origine n'est jamais modifié par une action", () => {
    const s = newMirrorGame();
    const before = structuredClone(s);
    applyAction(s, { type: "CONCEDE", player: "P1" }, ctx);
    expect(s).toEqual(before);
  });

  it("aucune action n'est possible une fois la partie terminée", () => {
    const s = newMirrorGame();
    const r = applyAction(s, { type: "CONCEDE", player: "P1" }, ctx);
    if (!r.ok) throw new Error(r.error);
    expect(applyAction(r.state, { type: "CONCEDE", player: "P2" }, ctx)).toEqual({
      ok: false,
      error: "la partie est terminée",
    });
  });

  it("une action passe en JSON et revient identique (réseau)", () => {
    const action = { type: "CONCEDE", player: "P1" } as const;
    expect(JSON.parse(JSON.stringify(action))).toEqual(action);
  });
});
