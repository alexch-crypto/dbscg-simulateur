import { describe, expect, it } from "vitest";
import { applyAction, createGame, getLegalActions, newRecord, replayGame, type GameRecord } from "../src/engine";
import { ctx, db, freezer } from "./helpers";

/** Joue une partie au hasard parmi les coups autorisés et renvoie son enregistrement. */
function randomGame(seed: number, maxMoves = 600): { record: GameRecord; finalState: unknown } {
  const decks = { P1: freezer.deck!, P2: freezer.deck! };
  const created = createGame({ decks, seed }, db);
  if (!created.ok) throw new Error(created.errors.join());
  let state = created.state;
  const record = newRecord(seed, decks);
  let x = seed;
  const pick = (n: number) => ((x = (x * 1103515245 + 12345) % 2147483648), x % n);
  for (let i = 0; i < maxMoves && !state.result; i++) {
    const legal = getLegalActions(state, state.pending!.player, ctx).filter((a) => a.type !== "CONCEDE");
    const action = legal[pick(legal.length)]!;
    const r = applyAction(state, action, ctx);
    if (!r.ok) throw new Error(r.error);
    state = r.state;
    record.actions.push(action);
  }
  return { record, finalState: state };
}

describe("Rejouer une partie à l'identique", () => {
  it("graine + decks + coups => exactement le même état final (20 parties complètes)", () => {
    for (let seed = 100; seed < 120; seed++) {
      const { record, finalState } = randomGame(seed);
      const replay = replayGame(record, ctx);
      expect(replay.ok).toBe(true);
      if (replay.ok) expect(replay.state).toEqual(finalState);
    }
  });

  it("l'enregistrement passe par un fichier JSON sans rien perdre", () => {
    const { record, finalState } = randomGame(7);
    const fromFile = JSON.parse(JSON.stringify(record));
    const replay = replayGame(fromFile, ctx);
    if (!replay.ok) throw new Error(replay.error);
    expect(replay.state).toEqual(finalState);
  });

  it("rejouer une partie à moitié redonne l'état de la partie à ce moment-là", () => {
    const { record } = randomGame(8);
    const half = { ...record, actions: record.actions.slice(0, 40) };
    const a = replayGame(half, ctx);
    const b = replayGame(JSON.parse(JSON.stringify(half)), ctx);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.state).toEqual(b.state);
  });

  it("un coup modifié (triche ou fichier abîmé) est détecté, avec son numéro", () => {
    const { record } = randomGame(9);
    const tampered = structuredClone(record);
    tampered.actions[3] = { type: "END_MAIN_PHASE", player: "P1" };
    const replay = replayGame(tampered, ctx);
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.actionIndex).toBe(3);
      expect(replay.error).toContain("coup n°4 refusé");
    }
  });

  it("refuse un fichier qui n'est pas une partie", () => {
    expect(replayGame({ hello: "world" }, ctx)).toEqual({ ok: false, error: "ce fichier n'est pas une partie enregistrée" });
    expect(replayGame(null, ctx).ok).toBe(false);
  });
});
