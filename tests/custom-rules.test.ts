// Partie personnalisée : règles modifiables, cartes bannies et limitées.
import { describe, expect, it } from "vitest";
import { applyAction, createGame, getLegalActions, validateDeck, type Action, type GameRules, type GameState } from "../src/engine";
import { ctx, db, freezer } from "./helpers";

function start(rules: Partial<GameRules>): GameState {
  const r = createGame({ decks: { P1: freezer.deck!, P2: freezer.deck! }, seed: 3, counterPrompt: { P1: "only_if_playable", P2: "only_if_playable" }, rules }, db);
  if (!r.ok) throw new Error(r.errors.join());
  return r.state;
}
function play(s: GameState, ...actions: Action[]): GameState {
  for (const a of actions) {
    const r = applyAction(s, a, ctx);
    if (!r.ok) throw new Error(`${JSON.stringify(a)} : ${r.error}`);
    s = r.state;
  }
  return s;
}
const choose = (s: GameState) => play(s, { type: "CHOOSE_FIRST_PLAYER", player: s.pending!.player, first: "P1" });

describe("Cartes bannies et limitées", () => {
  it("Soif de sang glaciale est limitée à 1 exemplaire en partie officielle", () => {
    const deck = { ...freezer.deck!, main: { ...freezer.deck!.main, "BT1-107": 2, "BT9-123": 3 } };
    expect(validateDeck(deck, db).some((e) => e.includes("limitée à 1"))).toBe(true);
    expect(validateDeck(deck, db, { ...start({}).rules, ignoreLimited: true })).toEqual([]);
  });

  it("une carte bannie n'est permise qu'en partie personnalisée", () => {
    const banned = new Map(db);
    banned.set("SD8-04", { ...db.get("SD8-04")!, banned: true });
    expect(validateDeck(freezer.deck!, banned).some((e) => e.includes("bannie"))).toBe(true);
    expect(validateDeck(freezer.deck!, banned, { ...start({}).rules, allowBanned: true })).toEqual([]);
  });

  it("nombre d'exemplaires et taille du deck modifiables", () => {
    const deck = { ...freezer.deck!, main: { "BT24-133": 10 } };
    expect(validateDeck(deck, db).length).toBeGreaterThan(0);
    expect(validateDeck(deck, db, { ...start({}).rules, maxCopies: 10, deckMin: 10 })).toEqual([]);
  });
});

describe("Règles de début de partie", () => {
  it("Vie, main de départ et Énergies de départ", () => {
    let s = choose(start({ startingLife: 3, startingHand: 8, startingEnergy: 2 }));
    expect(s.players.P1.hand).toHaveLength(8);
    s = play(s, { type: "MULLIGAN", player: "P1", redraw: false }, { type: "MULLIGAN", player: "P2", redraw: false });
    expect(s.players.P1.life).toHaveLength(3);
    expect(s.players.P2.energy).toHaveLength(2);
  });

  it("sans repioche, la partie commence directement", () => {
    const s = choose(start({ mulligan: false }));
    expect(s.pending).toEqual({ type: "CHARGE", player: "P1" });
  });

  it("Leaders éveillés dès le début", () => {
    const s = choose(start({ mulligan: false, awakenedLeaders: true }));
    expect(s.players.P1.leader.side).toBe("back");
    expect(s.players.P2.leader.side).toBe("back");
  });

  it("cartes au choix dans le deck : le premier joueur, puis le second, puis le premier tour", () => {
    let s = choose(start({ mulligan: false, tutorAtStart: 2 }));
    expect(s.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P1", max: 2 });
    const pick = (st: GameState) => (st.pending as { options: string[] }).options.slice(0, 2);
    s = play(s, { type: "CHOOSE_CARDS", player: "P1", uids: pick(s) });
    expect(s.players.P1.hand).toHaveLength(8);
    expect(s.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P2" });
    s = play(s, { type: "CHOOSE_CARDS", player: "P2", uids: pick(s) });
    expect(s.pending).toEqual({ type: "CHARGE", player: "P1" });
  });
});

describe("Règles pendant la partie", () => {
  it("pioche par tour, pioche au premier tour, plusieurs Énergies, attaque au premier tour", () => {
    let s = choose(start({ mulligan: false, drawPerTurn: 2, firstTurnDraw: true, chargePerTurn: 2, firstTurnAttack: true }));
    expect(s.players.P1.hand).toHaveLength(8); // 6 + 2 au premier tour
    const hand = s.players.P1.hand;
    s = play(s, { type: "CHARGE_ENERGY", player: "P1", uid: hand[0]!.uid });
    expect(s.pending).toEqual({ type: "CHARGE", player: "P1" });
    s = play(s, { type: "CHARGE_ENERGY", player: "P1", uid: s.players.P1.hand[0]!.uid });
    expect(s.pending).toEqual({ type: "MAIN", player: "P1" });
    expect(s.players.P1.energy).toHaveLength(2);
    expect(getLegalActions(s, "P1", ctx).some((a) => a.type === "ATTACK")).toBe(true);
  });

  it("règles officielles : rien ne change", () => {
    const s = choose(start({}));
    expect(s.players.P1.hand).toHaveLength(6);
    expect(s.pending).toEqual({ type: "MULLIGAN", player: "P1" });
  });
});

describe("Enregistrement d'une partie personnalisée", () => {
  it("les règles sont gardées dans le fichier de partie et la relecture les réutilise", async () => {
    const { newRecord, replayGame } = await import("../src/engine");
    const decks = { P1: freezer.deck!, P2: freezer.deck! };
    const record = newRecord(3, decks, { P1: "only_if_playable", P2: "only_if_playable" }, { startingLife: 2, mulligan: false });
    const s0 = start({ startingLife: 2, mulligan: false });
    record.actions.push({ type: "CHOOSE_FIRST_PLAYER", player: s0.pending!.player, first: "P1" });
    const r = replayGame(record, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.players.P2.life).toHaveLength(2);
  });
});
