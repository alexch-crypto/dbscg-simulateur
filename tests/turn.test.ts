import { describe, expect, it } from "vitest";
import { getLegalActions, type GameEvent, type GameState } from "../src/engine";
import { checkDefeat } from "../src/engine/rules/defeat";
import { ctx, expectRefused, give, newMirrorGame, play, startedMirrorGame } from "./helpers";

// Dans startedMirrorGame, P1 joue en premier et personne n'a repioché.

/** Fin du tour du joueur actif sans rien faire (pas d'Énergie, fin de phase principale). */
function passTurn(s: GameState): { state: GameState; events: GameEvent[] } {
  const p = s.turnPlayer;
  return play(s, { type: "CHARGE_ENERGY", player: p, uid: null }, { type: "END_MAIN_PHASE", player: p });
}

describe("7-2 : phase de Recharge", () => {
  it("7-2-9-1 : le premier joueur ne pioche pas à son premier tour", () => {
    const s = startedMirrorGame();
    expect(s.turnPlayer).toBe("P1");
    expect(s.players.P1.hand).toHaveLength(6);
    expect(s.players.P1.deck).toHaveLength(39);
  });

  it("7-2-9 : le second joueur pioche dès son premier tour", () => {
    const { state, events } = passTurn(startedMirrorGame());
    expect(state.turnPlayer).toBe("P2");
    expect(state.turnNumber).toBe(2);
    expect(state.players.P2.hand).toHaveLength(7);
    expect(state.players.P2.deck).toHaveLength(38);
    expect(events).toContainEqual({ type: "CARDS_DRAWN", player: "P2", count: 1 });
  });

  it("7-2-9 : le premier joueur pioche à partir de son deuxième tour", () => {
    let s = startedMirrorGame();
    s = passTurn(s).state; // fin du tour 1 (P1)
    s = passTurn(s).state; // fin du tour 2 (P2)
    expect(s.turnPlayer).toBe("P1");
    expect(s.turnNumber).toBe(3);
    expect(s.players.P1.hand).toHaveLength(7);
  });

  it("7-2-11 : le joueur actif peut poser une carte de sa main en Énergie, en mode Action", () => {
    const s = startedMirrorGame();
    const card = give(s, "P1", "P-223", "hand"); // Zarbon : pas de [Fuite d'énergie]
    const { state, events } = play(s, { type: "CHARGE_ENERGY", player: "P1", uid: card.uid });
    expect(state.players.P1.energy).toEqual([{ ...card, mode: "active", faceUp: true }]);
    expect(events).toContainEqual({ type: "ENERGY_CHARGED", player: "P1", uid: card.uid, cardId: card.cardId, mode: "active" });
  });

  it("7-2-11 : poser une Énergie est facultatif", () => {
    const { state } = play(startedMirrorGame(), { type: "CHARGE_ENERGY", player: "P1", uid: null });
    expect(state.players.P1.energy).toHaveLength(0);
    expect(state.players.P1.hand).toHaveLength(6);
  });

  it("7-2-11 : la carte doit venir de la main du joueur", () => {
    const s = startedMirrorGame();
    expectRefused(s, { type: "CHARGE_ENERGY", player: "P1", uid: s.players.P1.life[0]!.uid }, "7-2-11");
    expectRefused(s, { type: "CHARGE_ENERGY", player: "P1", uid: s.players.P2.hand[0]!.uid }, "7-2-11");
  });

  it("seul le joueur actif pose une Énergie, une seule fois par tour", () => {
    const s = startedMirrorGame();
    expectRefused(s, { type: "CHARGE_ENERGY", player: "P2", uid: s.players.P2.hand[0]!.uid }, "c'est à P1");
    const after = play(s, { type: "CHARGE_ENERGY", player: "P1", uid: s.players.P1.hand[0]!.uid }).state;
    expectRefused(after, { type: "CHARGE_ENERGY", player: "P1", uid: after.players.P1.hand[0]!.uid }, "décision attendue : MAIN");
  });

  it("coups autorisés en Recharge : ne rien poser, ou une des 6 cartes de la main (+ abandon)", () => {
    const actions = getLegalActions(startedMirrorGame(), "P1", ctx);
    expect(actions.filter((a) => a.type === "CHARGE_ENERGY")).toHaveLength(7);
    expect(actions.at(-1)).toEqual({ type: "CONCEDE", player: "P1" });
  });

  it("7-2-7 : le joueur actif repasse en mode Action son Leader, ses cartes de Combat et ses Énergies", () => {
    let s = startedMirrorGame();
    s = play(s, { type: "CHARGE_ENERGY", player: "P1", uid: s.players.P1.hand[0]!.uid }).state;
    s = play(s, { type: "END_MAIN_PHASE", player: "P1" }).state;
    // Pendant le tour de P2, on met en Inertie des cartes des deux joueurs.
    s.players.P1.leader.mode = "rest";
    s.players.P1.energy[0]!.mode = "rest";
    s.players.P1.battle.push({ ...s.players.P1.hand.pop()!, mode: "rest", faceUp: true });
    s.players.P2.leader.mode = "rest";
    const { state, events } = passTurn(s);
    expect(state.players.P1.leader.mode).toBe("active");
    expect(state.players.P1.energy[0]!.mode).toBe("active");
    expect(state.players.P1.battle[0]!.mode).toBe("active");
    // Seul le joueur actif repasse ses cartes en mode Action.
    expect(state.players.P2.leader.mode).toBe("rest");
    expect(events).toContainEqual({ type: "CARDS_READIED", player: "P1" });
  });
});

describe("7-3 et 7-4 : phase principale et phase de Fin", () => {
  it("après la Recharge, le joueur actif est en timing libre de phase principale", () => {
    const { state } = play(startedMirrorGame(), { type: "CHARGE_ENERGY", player: "P1", uid: null });
    expect(state.phase).toBe("main");
    expect(state.pending).toEqual({ type: "MAIN", player: "P1" });
  });

  it("seul le joueur actif peut terminer sa phase principale", () => {
    const { state } = play(startedMirrorGame(), { type: "CHARGE_ENERGY", player: "P1", uid: null });
    expectRefused(state, { type: "END_MAIN_PHASE", player: "P2" }, "c'est à P1");
  });

  it("7-4-7 : à la fin du tour, l'adversaire devient le joueur actif", () => {
    const { state, events } = passTurn(startedMirrorGame());
    expect(events.map((e) => e.type)).toEqual([
      "PHASE_STARTED", // phase principale
      "PHASE_STARTED", // phase de Fin
      "TURN_ENDED",
      "TURN_STARTED",
      "CARDS_READIED",
      "CARDS_DRAWN",
    ]);
    expect(state.pending).toEqual({ type: "CHARGE", player: "P2" });
  });

  it("une partie peut enchaîner de nombreux tours", () => {
    let s = startedMirrorGame();
    for (let i = 0; i < 20; i++) s = passTurn(s).state;
    expect(s.turnNumber).toBe(21);
    expect(s.turnPlayer).toBe("P1");
  });
});

describe("21-2 : défaite", () => {
  it("21-2-2-2 : piocher sa dernière carte fait perdre immédiatement", () => {
    const s = startedMirrorGame();
    s.players.P2.drop.push(...s.players.P2.deck.splice(1)); // il reste 1 carte à P2
    const { state, events } = passTurn(s);
    expect(state.players.P2.deck).toHaveLength(0);
    expect(state.result).toEqual({ kind: "win", winner: "P1", reason: "P2 perd — 21-2-2-2 : plus de carte dans le deck" });
    expect(state.phase).toBe("game_over");
    expect(state.pending).toBeNull();
    expect(events.at(-1)).toEqual({ type: "GAME_OVER", result: state.result });
    // La phase de Recharge s'arrête là : P2 n'a pas à choisir d'Énergie.
    expectRefused(state, { type: "CHARGE_ENERGY", player: "P2", uid: null }, "la partie est terminée");
  });

  it("21-2-2-2 : le deck vide fait perdre même sans pioche", () => {
    const s = newMirrorGame();
    s.phase = "main";
    s.players.P1.life.push(...s.players.P1.deck.splice(0, 8));
    s.players.P2.life.push(...s.players.P2.deck.splice(0, 8));
    s.players.P1.drop.push(...s.players.P1.deck.splice(0));
    const events: GameEvent[] = [];
    expect(checkDefeat(s, events)).toBe(true);
    expect(s.result).toMatchObject({ kind: "win", winner: "P2" });
  });

  it("21-2-2-1 : plus de carte dans la Zone de Vie fait perdre", () => {
    const s = startedMirrorGame();
    s.players.P1.hand.push(...s.players.P1.life.splice(0));
    expect(checkDefeat(s, [])).toBe(true);
    expect(s.result).toEqual({ kind: "win", winner: "P2", reason: "P1 perd — 21-2-2-1 : plus de carte dans la Zone de Vie" });
  });

  it("0-1-3-3 : défaite simultanée des deux joueurs = match nul", () => {
    const s = startedMirrorGame();
    s.players.P1.drop.push(...s.players.P1.deck.splice(0));
    s.players.P2.drop.push(...s.players.P2.deck.splice(0));
    expect(checkDefeat(s, [])).toBe(true);
    expect(s.result?.kind).toBe("draw");
  });

  it("pas de défaite pendant la mise en place (Zone de Vie encore vide)", () => {
    const s = newMirrorGame();
    expect(checkDefeat(s, [])).toBe(false);
    expect(s.result).toBeNull();
  });

  it("une partie normale ne se termine pas toute seule", () => {
    expect(checkDefeat(startedMirrorGame(), [])).toBe(false);
  });
});
