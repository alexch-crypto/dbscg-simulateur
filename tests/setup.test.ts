import { describe, expect, it } from "vitest";
import { createGame, ENGINE_VERSION, getLegalActions, getPlayerView, opponentOf, type GameState, type PlayerId } from "../src/engine";
import { ctx, db, expectRefused, freezer, newMirrorGame, play } from "./helpers";

/** Partie où le premier joueur a été choisi (`first`), en attente des repioches. */
function afterFirstChosen(first: PlayerId, seed = 42): GameState {
  const s = newMirrorGame(seed);
  return play(s, { type: "CHOOSE_FIRST_PLAYER", player: s.pending!.player, first }).state;
}

const allCards = (s: GameState, p: PlayerId) => {
  const z = s.players[p];
  return [...z.deck, ...z.hand, ...z.life, ...z.energy, ...z.battle, ...z.combo, ...z.drop, ...z.zEnergy];
};

describe("Installation du projet", () => {
  it("le moteur se charge", () => {
    expect(ENGINE_VERSION).toBe("0.1.0");
  });
});

describe("6-2-1-4 : choix du premier joueur", () => {
  it("le hasard désigne un joueur, qui doit choisir qui commence", () => {
    const r = createGame({ decks: { P1: freezer.deck!, P2: freezer.deck! }, seed: 42 }, db);
    if (!r.ok) throw new Error();
    const winner = r.events.find((e) => e.type === "COIN_TOSS");
    expect(winner).toBeDefined();
    expect(r.state.pending).toEqual({ type: "CHOOSE_FIRST_PLAYER", player: (winner as { winner: PlayerId }).winner });
  });

  it("le tirage au sort désigne parfois P1, parfois P2", () => {
    const winners = new Set(Array.from({ length: 20 }, (_, seed) => newMirrorGame(seed).pending!.player));
    expect(winners).toEqual(new Set(["P1", "P2"]));
  });

  it("seul le joueur désigné peut choisir", () => {
    const s = newMirrorGame();
    const other = opponentOf(s.pending!.player);
    expectRefused(s, { type: "CHOOSE_FIRST_PLAYER", player: other, first: other }, "c'est à");
  });

  it("le joueur désigné peut choisir de jouer en second", () => {
    const s = newMirrorGame();
    const chooser = s.pending!.player;
    const after = play(s, { type: "CHOOSE_FIRST_PLAYER", player: chooser, first: opponentOf(chooser) }).state;
    expect(after.firstPlayer).toBe(opponentOf(chooser));
  });

  it("on ne peut pas repiocher avant que le premier joueur soit choisi", () => {
    const s = newMirrorGame();
    expectRefused(s, { type: "MULLIGAN", player: s.pending!.player, redraw: true }, "décision attendue");
  });

  it("coups autorisés : le joueur désigné a 2 choix (+ abandon), l'autre seulement l'abandon", () => {
    const s = newMirrorGame();
    const chooser = s.pending!.player;
    expect(getLegalActions(s, chooser, ctx).map((a) => a.type)).toEqual([
      "CHOOSE_FIRST_PLAYER",
      "CHOOSE_FIRST_PLAYER",
      "CONCEDE",
    ]);
    expect(getLegalActions(s, opponentOf(chooser), ctx)).toEqual([{ type: "CONCEDE", player: opponentOf(chooser) }]);
  });
});

describe("6-2-1-7 et 6-2-1-9 : mélange et main de départ", () => {
  it("chaque joueur mélange son deck et pioche six cartes", () => {
    const s = newMirrorGame();
    const { state, events } = play(s, { type: "CHOOSE_FIRST_PLAYER", player: s.pending!.player, first: "P1" });
    for (const p of ["P1", "P2"] as const) {
      expect(state.players[p].hand).toHaveLength(6);
      expect(state.players[p].deck).toHaveLength(47);
      expect(events).toContainEqual({ type: "DECK_SHUFFLED", player: p });
      expect(events).toContainEqual({ type: "CARDS_DRAWN", player: p, count: 6 });
    }
  });

  it("le mélange change l'ordre du deck", () => {
    const s = newMirrorGame();
    const before = s.players.P1.deck.map((c) => c.uid);
    const after = afterFirstChosen("P1").players.P1;
    expect([...after.hand, ...after.deck].map((c) => c.uid)).not.toEqual(before);
  });
});

describe("6-2-1-9 : repioche", () => {
  for (const first of ["P1", "P2"] as const) {
    it(`le premier joueur (${first}) décide en premier`, () => {
      const s = afterFirstChosen(first);
      expect(s.pending).toEqual({ type: "MULLIGAN", player: first });
      expectRefused(s, { type: "MULLIGAN", player: opponentOf(first), redraw: false }, `c'est à ${first}`);
    });
  }

  it("repiocher : la main repart dans le deck, mélange, six nouvelles cartes", () => {
    const s = afterFirstChosen("P1");
    const oldHand = s.players.P1.hand.map((c) => c.uid);
    const { state, events } = play(s, { type: "MULLIGAN", player: "P1", redraw: true });
    const p1 = state.players.P1;
    expect(p1.hand).toHaveLength(6);
    expect(p1.deck).toHaveLength(47);
    expect(p1.hand.map((c) => c.uid)).not.toEqual(oldHand);
    expect(allCards(state, "P1")).toHaveLength(53);
    expect(events).toEqual([
      { type: "MULLIGAN", player: "P1", redraw: true },
      { type: "DECK_SHUFFLED", player: "P1" },
      { type: "CARDS_DRAWN", player: "P1", count: 6 },
    ]);
  });

  it("garder sa main : rien ne change", () => {
    const s = afterFirstChosen("P1");
    const { state } = play(s, { type: "MULLIGAN", player: "P1", redraw: false });
    expect(state.players.P1.hand).toEqual(s.players.P1.hand);
    expect(state.players.P1.deck).toEqual(s.players.P1.deck);
  });

  it("une seule repioche par joueur", () => {
    const s = afterFirstChosen("P1");
    const { state } = play(s, { type: "MULLIGAN", player: "P1", redraw: true });
    expectRefused(state, { type: "MULLIGAN", player: "P1", redraw: true }, "c'est à P2");
  });
});

describe("6-2-1-10 à 6-2-1-12 : Vie, marqueur Énergie, début de partie", () => {
  for (const first of ["P1", "P2"] as const) {
    it(`fin de la mise en place quand ${first} commence`, () => {
      const s = afterFirstChosen(first);
      const second = opponentOf(first);
      const { state, events } = play(
        s,
        { type: "MULLIGAN", player: first, redraw: false },
        { type: "MULLIGAN", player: second, redraw: false },
      );
      for (const p of ["P1", "P2"] as const) {
        expect(state.players[p].life).toHaveLength(8);
        expect(state.players[p].hand).toHaveLength(6);
        expect(state.players[p].deck).toHaveLength(39);
        expect(state.players[p].life.every((c) => !c.faceUp)).toBe(true);
      }
      // 6-2-1-11 : seul le second joueur reçoit un marqueur Énergie.
      expect(state.players[second].energyMarkers).toBe(1);
      expect(state.players[first].energyMarkers).toBe(0);
      // 6-2-1-12
      expect(state.turnPlayer).toBe(first);
      expect(state.turnNumber).toBe(1);
      expect(state.phase).toBe("charge");
      expect(state.pending).toEqual({ type: "CHARGE", player: first });
      expect(events).toContainEqual({ type: "TURN_STARTED", player: first, turnNumber: 1 });
    });
  }

  it("les cartes de Vie sont les huit du dessus du deck APRÈS les repioches", () => {
    // P1 repioche, P2 garde sa main : on note le dessus des deux decks juste avant la pose des Vies.
    const s = play(afterFirstChosen("P1"), { type: "MULLIGAN", player: "P1", redraw: true }).state;
    const top8 = (p: PlayerId) => s.players[p].deck.slice(0, 8).map((c) => c.uid);
    const expected = { P1: top8("P1"), P2: top8("P2") };
    const { state } = play(s, { type: "MULLIGAN", player: "P2", redraw: false });
    for (const p of ["P1", "P2"] as const) {
      expect(state.players[p].life.map((c) => c.uid)).toEqual(expected[p]);
      expect(allCards(state, p)).toHaveLength(53);
    }
  });
});

describe("Mise en place : déterminisme et secret", () => {
  const fullSetup = (seed: number) => {
    const s = newMirrorGame(seed);
    return play(
      s,
      { type: "CHOOSE_FIRST_PLAYER", player: s.pending!.player, first: "P2" },
      { type: "MULLIGAN", player: "P2", redraw: true },
      { type: "MULLIGAN", player: "P1", redraw: true },
    );
  };

  it("même graine et mêmes actions => même partie", () => {
    expect(fullSetup(99)).toEqual(fullSetup(99));
  });

  it("graines différentes => mains différentes", () => {
    expect(fullSetup(1).state.players.P1.hand).not.toEqual(fullSetup(2).state.players.P1.hand);
  });

  it("les événements ne révèlent aucune carte", () => {
    const text = JSON.stringify(fullSetup(5).events);
    expect(text).not.toMatch(/P[12]-\d/); // aucun identifiant de carte
    expect(text).not.toMatch(/BT|EB|SD|P-\d/); // aucun numéro de carte
  });

  it("pendant la repioche, chaque joueur voit sa main mais pas celle de l'autre", () => {
    const s = afterFirstChosen("P1");
    const view = getPlayerView(s, "P1");
    expect(view.players.P1.hand.every((c) => "cardId" in c)).toBe(true);
    expect(view.players.P2.hand).toEqual(Array(6).fill({ hidden: true }));
    expect(view.pending).toEqual({ type: "MULLIGAN", player: "P1" });
  });
});
