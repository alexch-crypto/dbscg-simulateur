import { describe, expect, it } from "vitest";
import { getLegalActions, getPlayerView, type Action, type GameState, type PlayerId } from "../src/engine";
import { powerOf } from "../src/engine/rules/battle";
import { ctx, expectRefused, give, p2Main, play } from "./helpers";

// Leader Freezer BT24-056 : [Éveil] « Quand votre total de points de vie est de 4 ou moins :
// piochez une carte et passez jusqu'à une de vos Énergies en mode Action ». Face arrière : 15 000.

const awaken = (player: PlayerId): Action => ({ type: "AWAKEN", player });

/** Laisse `n` cartes de Vie à un joueur (les autres partent en main). */
function setLife(s: GameState, player: PlayerId, n: number): void {
  const p = s.players[player];
  p.hand.push(...p.life.splice(n));
}

describe("22-2 : [Éveil] du Leader Freezer", () => {
  it("impossible avec 5 points de vie : la condition n'est pas remplie", () => {
    const s = p2Main();
    setLife(s, "P2", 5);
    expectRefused(s, awaken("P2"), "5 points de vie (il faut 4 ou moins)");
    expect(getLegalActions(s, "P2", ctx)).not.toContainEqual(awaken("P2"));
  });

  it("avec 4 points de vie : pioche, choix d'une Énergie à relever, puis le Leader se retourne", () => {
    const s = p2Main();
    setLife(s, "P2", 4);
    const tired = give(s, "P2", "BT24-105", "energy", "rest");
    give(s, "P2", "BT24-106", "energy", "active");
    const handBefore = s.players.P2.hand.length;
    expect(getLegalActions(s, "P2", ctx)).toContainEqual(awaken("P2"));

    // Activation : la pioche se fait, puis le moteur attend le choix de l'Énergie.
    let r = play(s, awaken("P2"));
    expect(r.state.players.P2.hand).toHaveLength(handBefore + 1);
    expect(r.state.pending).toEqual({
      type: "CHOOSE_CARDS",
      player: "P2",
      min: 0,
      max: 1,
      options: [tired.uid], // seulement les Énergies en mode Inertie
      prompt: "Choisissez jusqu'à 1 carte(s) à passer en mode Action",
    });
    expect(r.state.players.P2.leader.side).toBe("front"); // pas encore retourné

    // Choix : l'Énergie repasse en mode Action, puis le Leader se retourne (22-2-4).
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [tired.uid] });
    expect(r.state.players.P2.energy.every((c) => c.mode === "active")).toBe(true);
    expect(r.state.players.P2.leader.side).toBe("back");
    expect(r.events.map((e) => e.type)).toEqual(["CARDS_MODE_CHANGED", "LEADER_FLIPPED"]);
    expect(r.state.pending).toEqual({ type: "MAIN", player: "P2" });
    expect(r.state.resolving).toBeNull();
  });

  it("« jusqu'à une » : on peut ne relever aucune Énergie", () => {
    const s = p2Main();
    setLife(s, "P2", 4);
    const tired = give(s, "P2", "BT24-105", "energy", "rest");
    const st = play(s, awaken("P2"), { type: "CHOOSE_CARDS", player: "P2", uids: [] }).state;
    expect(st.players.P2.energy.find((c) => c.uid === tired.uid)!.mode).toBe("rest");
    expect(st.players.P2.leader.side).toBe("back");
  });

  it("5-2-6 : sans Énergie en mode Inertie, pas de question : le Leader se retourne directement", () => {
    const s = p2Main();
    setLife(s, "P2", 3);
    const { state, events } = play(s, awaken("P2"));
    expect(state.players.P2.leader.side).toBe("back");
    expect(state.pending).toEqual({ type: "MAIN", player: "P2" });
    expect(events.map((e) => e.type)).toEqual(["AWAKEN_ACTIVATED", "CARDS_DRAWN", "LEADER_FLIPPED"]);
  });

  it("le choix est contrôlé : pas plus d'une Énergie, et seulement parmi celles proposées", () => {
    const s = p2Main();
    setLife(s, "P2", 4);
    const a = give(s, "P2", "BT24-105", "energy", "rest");
    const b = give(s, "P2", "BT24-106", "energy", "rest");
    const standing = give(s, "P2", "BT9-123", "energy", "active");
    const st = play(s, awaken("P2")).state;
    expectRefused(st, { type: "CHOOSE_CARDS", player: "P2", uids: [a.uid, b.uid] }, "entre 0 et 1");
    expectRefused(st, { type: "CHOOSE_CARDS", player: "P2", uids: [standing.uid] }, "ne peut pas être choisie");
    expectRefused(st, { type: "CHOOSE_CARDS", player: "P1", uids: [] }, "c'est à P2");
    expectRefused(st, { type: "END_MAIN_PHASE", player: "P2" }, "décision attendue : CHOOSE_CARDS");
  });

  it("la face arrière n'a pas d'[Éveil] : impossible de s'éveiller deux fois", () => {
    const s = p2Main();
    setLife(s, "P2", 2);
    const st = play(s, awaken("P2")).state;
    expectRefused(st, awaken("P2"), "pas de Capacité [Éveil]");
  });

  it("face arrière : le Leader a 15 000 de puissance", () => {
    const s = p2Main();
    setLife(s, "P2", 4);
    const st = play(s, awaken("P2")).state;
    expect(powerOf(st, { player: "P2", uid: "P2-L" }, ctx)).toBe(15000);
  });

  it("21-10-2 : le Leader garde son mode Inertie en se retournant", () => {
    const s = p2Main();
    setLife(s, "P2", 4);
    let st = play(s, { type: "ATTACK", player: "P2", attacker: "P2-L", target: "P1-L" }).state;
    st = play(st, awaken("P2")).state; // pendant l'étape d'Attaque
    expect(st.players.P2.leader).toMatchObject({ side: "back", mode: "rest" });
    expect(st.pending).toEqual({ type: "OFFENSE", player: "P2" });
  });

  it("1-5-4-1-2 : l'attaquant s'éveille pendant son étape d'Attaque et frappe avec 15 000", () => {
    const s = p2Main();
    setLife(s, "P2", 4);
    give(s, "P1", "P-223", "hand");
    const { events } = play(
      s,
      { type: "ATTACK", player: "P2", attacker: "P2-L", target: "P1-L" },
      awaken("P2"),
      { type: "END_STEP", player: "P2" },
      { type: "END_STEP", player: "P1" },
    );
    expect(events).toContainEqual({ type: "POWER_COMPARED", attacker: 15000, defender: 10000 });
  });

  it("1-5-4-1-3 : le défenseur s'éveille pendant son étape de Défense et repousse l'attaque", () => {
    const s = p2Main();
    setLife(s, "P1", 4);
    let st = play(s, { type: "ATTACK", player: "P2", attacker: "P2-L", target: "P1-L" }, { type: "END_STEP", player: "P2" }).state;
    expect(getLegalActions(st, "P1", ctx)).toContainEqual(awaken("P1"));
    st = play(st, awaken("P1")).state;
    expect(st.pending).toEqual({ type: "DEFENSE", player: "P1" }); // retour à l'étape de Défense
    const r = play(st, { type: "END_STEP", player: "P1" });
    expect(r.events).toContainEqual({ type: "POWER_COMPARED", attacker: 10000, defender: 15000 });
    expect(r.state.players.P1.life).toHaveLength(4);
  });

  it("pas d'Éveil pendant le tour adverse en dehors de l'étape de Défense", () => {
    const s = p2Main();
    setLife(s, "P1", 4);
    expectRefused(s, awaken("P1"), "c'est à P2"); // phase principale de P2
    const offense = play(s, { type: "ATTACK", player: "P2", attacker: "P2-L", target: "P1-L" }).state;
    expectRefused(offense, awaken("P1"), "c'est à P2"); // étape d'Attaque de P2
  });

  it("21-2-2-2 : si la pioche de l'Éveil vide le deck, le joueur perd immédiatement", () => {
    const s = p2Main();
    setLife(s, "P2", 4);
    give(s, "P2", "BT24-105", "energy", "rest");
    s.players.P2.drop.push(...s.players.P2.deck.splice(1));
    const { state } = play(s, awaken("P2"));
    expect(state.result).toMatchObject({ kind: "win", winner: "P1" });
    expect(state.pending).toBeNull();
    expect(state.resolving).toBeNull();
  });

  it("les options d'un choix ne sont montrées qu'au joueur qui choisit", () => {
    const s = p2Main();
    setLife(s, "P2", 4);
    give(s, "P2", "BT24-105", "energy", "rest");
    const st = play(s, awaken("P2")).state;
    expect(getPlayerView(st, "P2").pending).toMatchObject({ type: "CHOOSE_CARDS", options: [expect.any(String)] });
    expect(getPlayerView(st, "P1").pending).toMatchObject({ type: "CHOOSE_CARDS", options: [] });
  });
});
