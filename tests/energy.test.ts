import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyCostModifiers,
  checkPayment,
  findPayment,
  getLegalActions,
  paymentForCost,
  type Action,
  type EnergySource,
} from "../src/engine";
import { availableEnergySources } from "../src/engine/rules/energy";
import { ctx, db, expectRefused, give, p1Main, p2Main, play, startedMirrorGame } from "./helpers";

const G = (id: string): EnergySource => ({ id, colors: ["green"] });
const Y = (id: string): EnergySource => ({ id, colors: ["yellow"] });
const GY = (id: string): EnergySource => ({ id, colors: ["green", "yellow"] });

describe("Coût à payer (5-3-1)", () => {
  it("coût total 2 dont 1 vert = 1 orbe vert + 1 de n'importe quelle couleur", () => {
    expect(paymentForCost(db.get("P-223")!.cost!)).toEqual({ colors: { green: 1 }, generic: 1 });
  });

  it("Cell Xeno : 12 dont 3 verts et 3 jaunes", () => {
    expect(paymentForCost(db.get("BT9-137")!.cost!)).toEqual({ colors: { green: 3, yellow: 3 }, generic: 6 });
  });

  it("5-3-1-1 : coût de couleur supérieur au coût total => on paie le coût de couleur", () => {
    expect(paymentForCost({ total: 1, specified: { red: 2 } })).toEqual({ colors: { red: 2 }, generic: 0 });
  });

  it("coût 0 : rien à payer (5-3-2)", () => {
    expect(paymentForCost({ total: 0, specified: {} })).toEqual({ colors: {}, generic: 0 });
  });
});

describe("Réductions et augmentations de coût", () => {
  it("Piccolo Daimaô réduit à 0 : l'orbe vert reste à payer (1-2-3)", () => {
    const cost = applyCostModifiers(db.get("P-561")!.cost!, [{ kind: "total", amount: -5 }]);
    expect(cost).toEqual({ total: 0, specified: { green: 1 } });
    expect(paymentForCost(cost)).toEqual({ colors: { green: 1 }, generic: 0 });
  });

  it("augmentation du coût total (Freezer BT24-105 : +3)", () => {
    const cost = applyCostModifiers(db.get("BT24-105")!.cost!, [{ kind: "total", amount: 3 }]);
    expect(paymentForCost(cost)).toEqual({ colors: { yellow: 2 }, generic: 4 });
  });

  it("20-21-2 : réduire de (jaune)(jaune)(jaune) retire les orbes ET le coût total (Son Gohan BT28-081)", () => {
    const cost = applyCostModifiers(db.get("BT28-081")!.cost!, [{ kind: "colors", colors: { yellow: -3 } }]);
    expect(cost).toEqual({ total: 1, specified: {} });
  });

  it("20-21-2-1 : réduire plus d'orbes qu'il n'y en a => le total baisse seulement de ce qui est possible", () => {
    const cost = applyCostModifiers({ total: 3, specified: { yellow: 1 } }, [{ kind: "colors", colors: { yellow: -3 } }]);
    expect(cost).toEqual({ total: 2, specified: {} });
  });

  it("20-21-1 : augmenter de (vert) ajoute un orbe et augmente le total", () => {
    const cost = applyCostModifiers({ total: 2, specified: { green: 1 } }, [{ kind: "colors", colors: { green: 1 } }]);
    expect(cost).toEqual({ total: 3, specified: { green: 2 } });
  });

  it("0-2-11 : le coût ne descend pas sous 0, mais seulement une fois tous les modificateurs appliqués", () => {
    const cost = applyCostModifiers({ total: 4, specified: {} }, [
      { kind: "total", amount: -5 },
      { kind: "total", amount: 2 },
    ]);
    expect(cost.total).toBe(1);
    expect(applyCostModifiers({ total: 2, specified: {} }, [{ kind: "total", amount: -5 }]).total).toBe(0);
  });
});

describe("Vérification d'un paiement", () => {
  const zarbon = { colors: { green: 1 }, generic: 1 };

  it("accepte un paiement exact", () => {
    expect(checkPayment([G("a"), Y("b")], zarbon)).toBeNull();
  });

  it("refuse trop ou pas assez d'Énergies", () => {
    expect(checkPayment([G("a")], zarbon)).toContain("exactement 2");
    expect(checkPayment([G("a"), Y("b"), Y("c")], zarbon)).toContain("exactement 2");
  });

  it("refuse si l'orbe de couleur n'est pas couvert", () => {
    expect(checkPayment([Y("a"), Y("b")], zarbon)).toContain("coût de couleur");
  });

  it("une Énergie multicolore paie une de ses couleurs, au choix", () => {
    expect(checkPayment([GY("a"), Y("b")], zarbon)).toBeNull(); // GY paie le vert
    expect(checkPayment([GY("a"), G("b")], { colors: { yellow: 1 }, generic: 1 })).toBeNull(); // GY paie le jaune
  });

  it("une Énergie multicolore ne paie qu'un seul orbe", () => {
    expect(checkPayment([GY("a"), Y("b")], { colors: { green: 1, yellow: 1 }, generic: 0 })).toBeNull();
    expect(checkPayment([GY("a"), G("b")], { colors: { green: 1, yellow: 1 }, generic: 0 })).toBeNull();
    expect(checkPayment([GY("a"), G("b")], { colors: { yellow: 2 }, generic: 0 })).toContain("coût de couleur");
  });

  it("trouve l'attribution même quand l'ordre des cartes piège un choix naïf", () => {
    // Si la carte vert-jaune paie le vert, le jaune ne peut plus être payé : il faut l'inverse.
    expect(checkPayment([GY("a"), G("b")], { colors: { green: 1, yellow: 1 }, generic: 0 })).toBeNull();
  });

  it("findPayment propose un paiement valide, ou rien si c'est impossible (5-3-3)", () => {
    const chosen = findPayment([GY("a"), G("b"), Y("c")], zarbon)!;
    expect(checkPayment(chosen, zarbon)).toBeNull();
    expect(chosen.map((s) => s.id)).not.toContain("a"); // garde la multicolore
    expect(findPayment([Y("a"), Y("b")], zarbon)).toBeNull();
    expect(findPayment([G("a")], zarbon)).toBeNull();
  });
});

// --- Situations de jeu avec le deck Freezer ---

describe("5-5-2 : jouer une carte de Combat", () => {
  it("payer le coût exact place la carte en Zone de Combat, en mode Action", () => {
    const s = p1Main();
    const e1 = give(s, "P1", "BT9-123", "energy");
    const e2 = give(s, "P1", "BT24-105", "energy");
    const zarbon = give(s, "P1", "P-223", "hand");
    const { state, events } = play(s, {
      type: "PLAY_CARD",
      player: "P1",
      uid: zarbon.uid,
      payment: { energy: [e1.uid, e2.uid], markers: 0 },
    });
    const p1 = state.players.P1;
    expect(p1.battle).toEqual([{ ...zarbon, mode: "active", faceUp: true }]);
    expect(p1.hand.find((c) => c.uid === zarbon.uid)).toBeUndefined();
    expect(p1.energy.map((c) => c.mode)).toEqual(["rest", "rest"]);
    expect(events).toContainEqual({
      type: "PLAY_DECLARED",
      player: "P1",
      uid: zarbon.uid,
      cardId: "P-223",
      energyRested: [e1.uid, e2.uid],
      markersUsed: 0,
    });
  });

  it("5-3-3 : avec 3 Énergies, impossible de jouer une carte qui coûte 5", () => {
    const s = p1Main();
    const energies = [give(s, "P1", "BT24-105", "energy"), give(s, "P1", "BT24-105", "energy"), give(s, "P1", "BT24-106", "energy")];
    const zarbon5 = give(s, "P1", "BT27-080", "hand");
    expectRefused(
      s,
      { type: "PLAY_CARD", player: "P1", uid: zarbon5.uid, payment: { energy: energies.map((e) => e.uid), markers: 0 } },
      "exactement 5",
    );
    const playable = getLegalActions(s, "P1", ctx).filter((a) => a.type === "PLAY_CARD" && a.uid === zarbon5.uid);
    expect(playable).toEqual([]);
  });

  it("refuse un paiement qui ne couvre pas les orbes (2 jaunes payés avec du vert)", () => {
    const s = p1Main();
    const energies = [give(s, "P1", "P-223", "energy"), give(s, "P1", "P-561", "energy"), give(s, "P1", "BT24-105", "energy")];
    const freezer = give(s, "P1", "BT24-106", "hand"); // coût 3 dont 2 jaunes
    expectRefused(
      s,
      { type: "PLAY_CARD", player: "P1", uid: freezer.uid, payment: { energy: energies.map((e) => e.uid), markers: 0 } },
      "coût de couleur",
    );
  });

  it("une Énergie multicolore vert-jaune peut payer un orbe jaune", () => {
    const s = p1Main();
    const energies = [give(s, "P1", "BT9-123", "energy"), give(s, "P1", "BT24-105", "energy"), give(s, "P1", "P-223", "energy")];
    const freezer = give(s, "P1", "BT24-106", "hand"); // coût 3 dont 2 jaunes
    const r = applyAction(
      s,
      { type: "PLAY_CARD", player: "P1", uid: freezer.uid, payment: { energy: energies.map((e) => e.uid), markers: 0 } },
      ctx,
    );
    expect(r.ok).toBe(true);
  });

  it("refuse de payer plus que le coût", () => {
    const s = p1Main();
    const energies = [give(s, "P1", "P-223", "energy"), give(s, "P1", "P-223", "energy"), give(s, "P1", "BT24-105", "energy")];
    const card = give(s, "P1", "BT14-082", "hand"); // coût 2
    expectRefused(
      s,
      { type: "PLAY_CARD", player: "P1", uid: card.uid, payment: { energy: energies.map((e) => e.uid), markers: 0 } },
      "exactement 2",
    );
  });

  it("5-3-3 : une Énergie déjà en mode Inertie ne peut pas payer", () => {
    const s = p1Main();
    const tapped = give(s, "P1", "P-223", "energy", "rest");
    const other = give(s, "P1", "BT24-105", "energy");
    const card = give(s, "P1", "BT14-082", "hand");
    expectRefused(
      s,
      { type: "PLAY_CARD", player: "P1", uid: card.uid, payment: { energy: [tapped.uid, other.uid], markers: 0 } },
      "déjà en mode Inertie",
    );
  });

  it("refuse les Énergies adverses, une même Énergie deux fois, une carte hors de la main", () => {
    const s = p1Main();
    const mine = give(s, "P1", "P-223", "energy");
    const theirs = give(s, "P2", "P-223", "energy");
    const card = give(s, "P1", "BT14-082", "hand");
    const payment = (energy: string[]) => ({ energy, markers: 0 });
    expectRefused(s, { type: "PLAY_CARD", player: "P1", uid: card.uid, payment: payment([mine.uid, theirs.uid]) }, "n'est pas dans votre Zone d'Énergie");
    expectRefused(s, { type: "PLAY_CARD", player: "P1", uid: card.uid, payment: payment([mine.uid, mine.uid]) }, "deux fois");
    expectRefused(s, { type: "PLAY_CARD", player: "P1", uid: s.players.P1.life[0]!.uid, payment: payment([]) }, "votre main");
  });

  it("12-2 : une Extra ne se « joue » pas : elle s'active (Contre, Activation)", () => {
    const s = p1Main();
    const kinto = give(s, "P1", "BT3-104", "hand");
    const e = give(s, "P1", "BT24-105", "energy");
    expectRefused(s, { type: "PLAY_CARD", player: "P1", uid: kinto.uid, payment: { energy: [e.uid], markers: 0 } }, "seules les cartes de Combat et les Unissons");
  });

  it("7-3-4-1 : on ne joue pas de carte pendant la phase de Recharge, ni pendant le tour adverse", () => {
    const s = startedMirrorGame();
    const e = give(s, "P1", "P-223", "energy");
    const e2 = give(s, "P1", "BT24-105", "energy");
    const card = give(s, "P1", "BT14-082", "hand");
    const action: Action = { type: "PLAY_CARD", player: "P1", uid: card.uid, payment: { energy: [e.uid, e2.uid], markers: 0 } };
    expectRefused(s, action, "décision attendue : CHARGE");
    const p2Turn = play(play(s, { type: "CHARGE_ENERGY", player: "P1", uid: null }).state, { type: "END_MAIN_PHASE", player: "P1" }).state;
    expectRefused(p2Turn, action, "décision attendue");
  });

  it("jouer plusieurs cartes dans le même tour, tant qu'il reste de l'énergie", () => {
    let s = p1Main();
    const e = [0, 1, 2, 3].map(() => give(s, "P1", "BT9-123", "energy"));
    const a = give(s, "P1", "P-223", "hand");
    const b = give(s, "P1", "BT14-082", "hand");
    s = play(
      s,
      { type: "PLAY_CARD", player: "P1", uid: a.uid, payment: { energy: [e[0]!.uid, e[1]!.uid], markers: 0 } },
      { type: "PLAY_CARD", player: "P1", uid: b.uid, payment: { energy: [e[2]!.uid, e[3]!.uid], markers: 0 } },
    ).state;
    expect(s.players.P1.battle).toHaveLength(2);
    expect(s.pending).toEqual({ type: "MAIN", player: "P1" });
  });
});

describe("1-14 : marqueur Énergie", () => {
  it("le marqueur a la couleur du Leader (Freezer : vert)", () => {
    const sources = availableEnergySources(p2Main(), "P2", db);
    expect(sources).toContainEqual({ id: "marker", colors: ["green"] });
  });

  it("le marqueur paie un orbe vert, puis il est retiré du jeu", () => {
    const s = p2Main();
    const y = give(s, "P2", "BT24-105", "energy");
    const card = give(s, "P2", "P-223", "hand"); // 1 vert + 1
    const { state, events } = play(s, {
      type: "PLAY_CARD",
      player: "P2",
      uid: card.uid,
      payment: { energy: [y.uid], markers: 1 },
    });
    expect(state.players.P2.energyMarkers).toBe(0);
    expect(state.players.P2.battle).toHaveLength(1);
    expect(events.find((e) => e.type === "PLAY_DECLARED")).toMatchObject({ markersUsed: 1 });
  });

  it("le marqueur d'un Leader vert ne paie pas un orbe jaune", () => {
    const s = p2Main();
    const y = give(s, "P2", "BT24-105", "energy");
    const g = give(s, "P2", "P-223", "energy");
    const freezer = give(s, "P2", "BT24-106", "hand"); // 2 jaunes + 1
    expectRefused(
      s,
      { type: "PLAY_CARD", player: "P2", uid: freezer.uid, payment: { energy: [y.uid, g.uid], markers: 1 } },
      "coût de couleur",
    );
  });

  it("Leader multicolore : le marqueur paie une de ses couleurs, au choix", () => {
    const s = p2Main();
    s.players.P2.leader.cardId = "TEST-LEADER-GY";
    const multiDb = new Map(db);
    multiDb.set("TEST-LEADER-GY", {
      ...db.get("BT24-056")!,
      id: "TEST-LEADER-GY",
      front: { ...db.get("BT24-056")!.front!, colors: ["green", "yellow"] },
    });
    expect(availableEnergySources(s, "P2", multiDb)).toContainEqual({ id: "marker", colors: ["green", "yellow"] });
  });

  it("refuse d'utiliser plus de marqueurs qu'on n'en a", () => {
    const s = p2Main();
    const card = give(s, "P2", "P-223", "hand");
    expectRefused(s, { type: "PLAY_CARD", player: "P2", uid: card.uid, payment: { energy: [], markers: 2 } }, "1-14");
  });

  it("le premier joueur n'a pas de marqueur", () => {
    expect(availableEnergySources(p1Main(), "P1", db).filter((x) => x.id === "marker")).toEqual([]);
  });
});

describe("Coups autorisés en phase principale", () => {
  it("ne propose que les cartes de Combat payables, avec un paiement valide", () => {
    const s = p2Main();
    give(s, "P2", "BT24-105", "energy");
    give(s, "P2", "BT9-123", "energy");
    const plays = getLegalActions(s, "P2", ctx).filter((a) => a.type === "PLAY_CARD");
    expect(plays.length).toBeGreaterThan(0);
    for (const action of plays) {
      const r = applyAction(s, action, ctx);
      expect(r.ok, JSON.stringify(action)).toBe(true);
      const card = db.get(s.players.P2.hand.find((c) => c.uid === (action as { uid: string }).uid)!.cardId)!;
      expect(card.type).toBe("battle");
    }
  });

  it("propose toujours de terminer la phase principale", () => {
    expect(getLegalActions(p1Main(), "P1", ctx)).toContainEqual({ type: "END_MAIN_PHASE", player: "P1" });
  });
});
