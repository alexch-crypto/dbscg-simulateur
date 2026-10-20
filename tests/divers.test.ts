// Cartes isolées (cards/divers.json).
import { describe, expect, it } from "vitest";
import diversFile from "../cards/divers.json";
import { applyAction, buildCardDatabase, getLegalActions, parseCardFile, type Action, type CardInstance, type GameContext, type GameEvent, type GameState, type PlayerId } from "../src/engine";
import { freezer, startedMirrorGame } from "./helpers";

const divers = parseCardFile(diversFile);
const ctx: GameContext = { cards: buildCardDatabase([freezer.cards, divers.cards]) };

function play(s: GameState, ...actions: Action[]): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  for (const a of actions) {
    const r = applyAction(s, a, ctx);
    if (!r.ok) throw new Error(`refusé ${JSON.stringify(a)} : ${r.error}`);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

const heles = (player: PlayerId): CardInstance => ({ uid: `${player}-HS`, cardId: "DB2-176", owner: player, mode: "active", faceUp: false });

/** Déplace un exemplaire d'une carte Freezer du deck vers une zone. */
function give(s: GameState, player: PlayerId, cardId: string, zone: "hand" | "energy" | "battle" | "drop"): CardInstance {
  const p = s.players[player];
  const i = p.deck.findIndex((c) => c.cardId === cardId);
  const card = p.deck.splice(i, 1)[0]!;
  card.faceUp = zone !== "hand";
  card.mode = "active";
  p[zone].push(card);
  return card;
}

describe("Xeres et Sawar (DB2-176)", () => {
  it("fiche : vert-jaune, coût 2, 16000, Combo 1 / 10000, Fuite d'énergie", () => {
    expect(divers.errors).toEqual([]);
    const def = ctx.cards.get("DB2-176")!;
    expect([def.colors, def.cost, def.power, def.combo]).toEqual([["green", "yellow"], { total: 2, specified: { green: 1, yellow: 1 } }, 16000, { cost: 1, power: 10000 }]);
  });

  describe("placée en Énergie", () => {
    function setup(withPair: boolean) {
      const s = startedMirrorGame(); // P1 en phase de Recharge
      s.players.P1.hand.push(heles("P1"));
      const green = give(s, "P1", "P-223", "drop"); // verte
      const yellow = withPair ? give(s, "P1", "BT24-105", "drop") : null; // jaune
      return { s, green, yellow };
    }

    it("on peut transférer une verte et une jaune de la Dispersion : la Fuite d'énergie est annulée", () => {
      const { s, green, yellow } = setup(true);
      let r = play(s, { type: "CHARGE_ENERGY", player: "P1", uid: "P1-HS" });
      expect(r.state.pending).toMatchObject({ type: "CHOOSE_OPTION", player: "P1" });
      r = play(r.state, { type: "CHOOSE_OPTION", player: "P1", id: "yes" });
      // Les deux cartes sont choisies en même temps.
      expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P1", min: 2, max: 2 });
      r = play(r.state, { type: "CHOOSE_CARDS", player: "P1", uids: [green.uid, yellow!.uid] });
      expect(r.state.players.P1.warp.map((c) => c.uid).sort()).toEqual([green.uid, yellow!.uid].sort());
      expect(r.state.players.P1.energy.find((c) => c.uid === "P1-HS")!.mode).toBe("active");
      expect(r.state.pending).toEqual({ type: "MAIN", player: "P1" });
    });

    it("une carte vert-jaune ne compte qu'une fois : il faut une verte ET une jaune différentes", () => {
      const { s, green } = setup(false);
      // Dispersion : une verte (Zarbon) + une seule vert-jaune (Anilaza).
      const both = give(s, "P1", "BT9-123", "drop");
      const other = give(s, "P1", "P-223", "drop"); // une 2e verte
      let r = play(s, { type: "CHARGE_ENERGY", player: "P1", uid: "P1-HS" });
      r = play(r.state, { type: "CHOOSE_OPTION", player: "P1", id: "yes" });
      // Deux vertes : refusé (pas de jaune).
      const bad = applyAction(r.state, { type: "CHOOSE_CARDS", player: "P1", uids: [green.uid, other.uid] }, ctx);
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error).toContain("une de chaque");
      // Verte + vert-jaune : accepté.
      r = play(r.state, { type: "CHOOSE_CARDS", player: "P1", uids: [green.uid, both.uid] });
      expect(r.state.players.P1.warp.map((c) => c.uid).sort()).toEqual([green.uid, both.uid].sort());
      expect(r.state.players.P1.energy.find((c) => c.uid === "P1-HS")!.mode).toBe("active");
    });

    it("si on refuse, elle reste en mode Inertie", () => {
      const { s } = setup(true);
      let r = play(s, { type: "CHARGE_ENERGY", player: "P1", uid: "P1-HS" });
      r = play(r.state, { type: "CHOOSE_OPTION", player: "P1", id: "no" });
      expect(r.state.players.P1.energy.find((c) => c.uid === "P1-HS")!.mode).toBe("rest");
      expect(r.state.players.P1.warp).toHaveLength(0);
      expect(r.state.pending).toEqual({ type: "MAIN", player: "P1" });
    });

    it("sans une verte ET une jaune dans la Dispersion, la question n'est pas posée", () => {
      const { s } = setup(false);
      const r = play(s, { type: "CHARGE_ENERGY", player: "P1", uid: "P1-HS" });
      expect(r.state.players.P1.energy.find((c) => c.uid === "P1-HS")!.mode).toBe("rest");
      expect(r.state.pending).toEqual({ type: "MAIN", player: "P1" });
    });
  });

  it("Activation : (vert)(jaune) — joue jusqu'à deux cartes de coût 2 ou moins, Capacités annulées ; l'adversaire défausse", () => {
    const s0 = startedMirrorGame();
    const s = play(s0, { type: "CHARGE_ENERGY", player: "P1", uid: null }).state;
    const card = heles("P1");
    card.faceUp = true;
    s.players.P1.battle.push(card);
    give(s, "P1", "P-223", "energy"); // vert
    give(s, "P1", "BT24-105", "energy"); // jaune
    const zarbon = give(s, "P1", "P-223", "hand"); // vert, coût 2
    const anilaza = give(s, "P1", "BT9-123", "hand"); // vert-jaune, coût 2
    const big = give(s, "P1", "BT24-106", "hand"); // jaune, coût 3 : pas proposé
    const oppHand = s.players.P2.hand.length;
    const act = getLegalActions(s, "P1", ctx).find((a) => a.type === "ACTIVATE" && a.uid === card.uid)!;
    let r = play(s, act);
    while (r.state.pending?.type === "COUNTER_WINDOW") r = play(r.state, { type: "PASS_COUNTER", player: r.state.pending.player });
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P1", max: 2 });
    const options = (r.state.pending as { options: string[] }).options;
    expect(options).toEqual(expect.arrayContaining([zarbon.uid, anilaza.uid]));
    // Toutes les cartes proposées : cartes de Combat vertes ou jaunes de coût 2 ou moins.
    for (const uid of options) {
      const def = ctx.cards.get(r.state.players.P1.hand.find((c) => c.uid === uid)!.cardId)!;
      expect(def.type).toBe("battle");
      expect(def.cost!.total as number).toBeLessThanOrEqual(2);
    }
    expect((r.state.pending as { options: string[] }).options).not.toContain(big.uid);
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P1", uids: [zarbon.uid, anilaza.uid] });
    expect(r.state.players.P1.battle.map((c) => c.uid)).toEqual(expect.arrayContaining([zarbon.uid, anilaza.uid]));
    for (const uid of [zarbon.uid, anilaza.uid]) expect(r.state.effects).toContainEqual({ uid, kind: "negate_all", untilTurn: r.state.turnNumber });
    // Puis l'adversaire choisit une carte de sa main et la défausse.
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P2", min: 1, max: 1 });
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [(r.state.pending as { options: string[] }).options[0]!] });
    expect(r.state.players.P2.hand).toHaveLength(oppHand - 1);
    // Une fois par tour.
    expect(getLegalActions(r.state, "P1", ctx).some((a) => a.type === "ACTIVATE" && a.uid === card.uid)).toBe(false);
  });
});
