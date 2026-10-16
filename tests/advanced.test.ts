import { describe, expect, it } from "vitest";
import { applyAction, getLegalActions, type Action, type GameState, type PlayerId } from "../src/engine";
import { powerOf } from "../src/engine/rules/battle";
import { normalPlayPayment } from "../src/engine/rules/play";
import { ctx, expectRefused, give, p1Main, p2Main, play } from "./helpers";

// Tous ces tests se passent pendant le premier tour de P2 (sauf mention contraire).
// Coûts utiles : Overdrive BT24-133 = 10, Empereur planétaire BT27-136 = 9, Phase finale BT24-134 = 8,
// Second Changement BT24-136 = 6, Transformation effroyable BT27-076 = 6, Piccolo P-561 = 4,
// Départ de l'Invasion BT24-105 = 3, Krillin BT24-068 = 3, Zarbon P-223 = 2, Towa P-055 = 3 (noire).

const successor = (uid: string, sacrifice: string[], payment: { energy: string[]; markers: number }, variant = 0): Action => ({
  type: "SUCCESSOR",
  player: "P2",
  uid,
  sacrifice,
  payment,
  variant,
});
const pay = (...energy: string[]) => ({ energy, markers: 0 });

describe("22-38 : [Successeur]", () => {
  /** P2 : l'Overdrive en main, 3 Énergies (vert, jaune, vert-jaune) et deux cartes à sacrifier. */
  function setup() {
    const s = p2Main();
    const overdrive = give(s, "P2", "BT24-133", "hand");
    const g = give(s, "P2", "P-223", "energy");
    const y = give(s, "P2", "BT24-105", "energy");
    const gy = give(s, "P2", "BT9-123", "energy");
    const six = give(s, "P2", "BT24-136", "battle"); // vert-jaune, 6
    const four = give(s, "P2", "P-561", "battle"); // vert, 4
    return { s, overdrive, g, y, gy, six, four };
  }

  it("Overdrive (coût 10) : sacrifier 6 + 4, payer (vert)(jaune)(1) et piocher 2 => la carte est jouée", () => {
    const { s, overdrive, g, y, gy, six, four } = setup();
    expect(getLegalActions(s, "P2", ctx).some((a) => a.type === "SUCCESSOR" && a.uid === overdrive.uid)).toBe(true);
    const handBefore = s.players.P2.hand.length;
    const r = play(s, successor(overdrive.uid, [six.uid, four.uid], pay(g.uid, y.uid, gy.uid)));
    expect(r.events).toContainEqual(expect.objectContaining({ type: "SUCCESSOR_ACTIVATED", uid: overdrive.uid }));
    expect(r.state.players.P2.drop.map((c) => c.uid)).toEqual(expect.arrayContaining([six.uid, four.uid]));
    expect(r.state.players.P2.battle.map((c) => c.uid)).toEqual([overdrive.uid]);
    expect(r.state.players.P2.hand).toHaveLength(handBefore - 1 + 2); // -Overdrive +2 pioches (coût)
    expect(r.state.players.P2.energy.every((c) => c.mode === "rest")).toBe(true);
    expect(r.events).toContainEqual(expect.objectContaining({ type: "CARD_PLAYED_BY_SKILL", uid: overdrive.uid, from: "hand" }));
  });

  it("le total doit être EXACTEMENT égal : 11 est refusé", () => {
    const { s, overdrive, g, y, gy, six, four } = setup();
    const extra = give(s, "P2", "SD8-04", "battle"); // 2 => 6 + 4 + 2 = 12
    expectRefused(s, successor(overdrive.uid, [six.uid, four.uid, extra.uid], pay(g.uid, y.uid, gy.uid)), "exactement égal à 10");
    expectRefused(s, successor(overdrive.uid, [six.uid], pay(g.uid, y.uid, gy.uid)), "exactement égal à 10");
  });

  it("seules des cartes exclusivement vertes, jaunes ou vert-jaune peuvent être sacrifiées (pas Towa, noire)", () => {
    const { s, overdrive, g, y, gy, six } = setup();
    const towa = give(s, "P2", "P-055", "battle"); // noire, 3
    const one = give(s, "P2", "BT24-068", "battle"); // vert, 3 — 6 + 3 + ... pour comparer
    expectRefused(s, successor(overdrive.uid, [six.uid, towa.uid, one.uid], pay(g.uid, y.uid, gy.uid)), "exclusivement vertes");
  });

  it("sans combinaison exacte possible, Successeur n'est pas proposé", () => {
    const s = p2Main();
    const overdrive = give(s, "P2", "BT24-133", "hand");
    for (const id of ["P-223", "BT24-105", "BT9-123"]) give(s, "P2", id, "energy");
    give(s, "P2", "BT24-136", "battle"); // 6 seulement
    expect(getLegalActions(s, "P2", ctx).some((a) => a.type === "SUCCESSOR" && a.uid === overdrive.uid)).toBe(false);
  });

  it("Empereur planétaire : (vert) OU (jaune), piochez 1, puis son « Quand cette carte est jouée via Successeur » se déclenche", () => {
    const s = p2Main();
    const emperor = give(s, "P2", "BT27-136", "hand");
    const y = give(s, "P2", "BT24-105", "energy"); // jaune seulement
    give(s, "P2", "BT24-106", "energy");
    give(s, "P2", "BT27-080", "energy"); // 3 Énergies (condition)
    const six = give(s, "P2", "BT27-076", "battle"); // jaune 6
    const three = give(s, "P2", "BT24-068", "battle"); // vert 3
    const target = give(s, "P1", "BT24-106", "battle");
    // Variante 1 = (jaune) : payée avec l'Énergie jaune.
    const r = play(s, successor(emperor.uid, [six.uid, three.uid], pay(y.uid), 1));
    expect(r.events).toContainEqual(expect.objectContaining({ type: "AUTO_TRIGGERED", uid: emperor.uid }));
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P2", options: [target.uid] });
  });

  it("Phase de Transformation finale : condition « Leader <Freezer> vert » remplie avec le Leader Freezer", () => {
    const s = p2Main();
    const finale = give(s, "P2", "BT24-134", "hand");
    give(s, "P2", "P-223", "energy");
    give(s, "P2", "BT24-105", "energy");
    give(s, "P2", "BT24-136", "battle"); // 6
    give(s, "P2", "SD8-04", "battle"); // 2
    expect(getLegalActions(s, "P2", ctx).some((a) => a.type === "SUCCESSOR" && a.uid === finale.uid)).toBe(true);
  });
});

describe("Leader Freezer éveillé : Successeur avec les cartes adverses (une fois par tour)", () => {
  function setup() {
    const s = p2Main();
    s.players.P2.leader.side = "back";
    const second = give(s, "P2", "BT24-136", "hand"); // 6, coût Successeur (jaune)
    const y = give(s, "P2", "BT24-105", "energy");
    const theirs = give(s, "P1", "BT24-105", "battle"); // 3 (adverse)
    const mine = give(s, "P2", "BT24-106", "battle"); // 3
    return { s, second, y, theirs, mine };
  }

  it("une carte adverse compte comme une carte exclusivement verte et part dans la Dispersion de son propriétaire", () => {
    const { s, second, y, theirs, mine } = setup();
    const r = play(s, successor(second.uid, [theirs.uid, mine.uid], pay(y.uid)));
    expect(r.state.players.P1.drop.map((c) => c.uid)).toContain(theirs.uid);
    expect(r.state.players.P2.battle.map((c) => c.uid)).toContain(second.uid);
  });

  it("sans le Leader éveillé, les cartes adverses ne peuvent pas être choisies", () => {
    const { s, second, y, theirs, mine } = setup();
    s.players.P2.leader.side = "front";
    expectRefused(s, successor(second.uid, [theirs.uid, mine.uid], pay(y.uid)), "22-38");
  });

  it("une seule fois par tour : au deuxième Successeur, plus de cartes adverses", () => {
    const { s, second, y, theirs, mine } = setup();
    let st = play(s, successor(second.uid, [theirs.uid, mine.uid], pay(y.uid))).state;
    const other = give(st, "P2", "BT24-136", "hand");
    const y2 = give(st, "P2", "BT24-106", "energy");
    const theirs2 = give(st, "P1", "BT24-106", "battle");
    const mine2 = give(st, "P2", "BT24-068", "battle");
    expectRefused(st, successor(other.uid, [theirs2.uid, mine2.uid], pay(y2.uid)), "22-38");
  });
});

describe("Augmenter un coût pour viser pile : Freezer, Départ de l'Invasion (BT24-105)", () => {
  it("déclarer +3 : son coût passe de 3 à 6 pour le tour, et elle peut servir seule pour un Successeur à 6", () => {
    const s = p2Main();
    const freezer = give(s, "P2", "BT24-105", "battle");
    const declare = getLegalActions(s, "P2", ctx).find(
      (a): a is Extract<Action, { type: "ACTIVATE" }> => a.type === "ACTIVATE" && a.uid === freezer.uid && a.x === 3,
    );
    expect(declare).toBeDefined();
    let r = play(s, declare!);
    expect(r.events).toContainEqual({ type: "COST_MODIFIED", uids: [freezer.uid], amount: 3 });
    // [Une fois par tour] : plus proposée.
    expect(getLegalActions(r.state, "P2", ctx).some((a) => a.type === "ACTIVATE" && a.uid === freezer.uid && a.index === 2)).toBe(false);
    const second = give(r.state, "P2", "BT24-136", "hand");
    const y = give(r.state, "P2", "BT24-106", "energy");
    r = play(r.state, successor(second.uid, [freezer.uid], pay(y.uid)));
    expect(r.state.players.P2.battle.map((c) => c.uid)).toEqual([second.uid]);
  });

  it("le nombre déclaré doit être entre 0 et 3", () => {
    const s = p2Main();
    const freezer = give(s, "P2", "BT24-105", "battle");
    expectRefused(s, { type: "ACTIVATE", player: "P2", uid: freezer.uid, index: 2, payment: pay(), x: 4 }, "20-5");
  });
});

describe("Zarbon, Accompagnateur : réduction du prochain Successeur", () => {
  it("le coût (vert)(jaune)(1) de l'Overdrive devient (vert)", () => {
    const s = p2Main();
    s.successorDiscounts.push({ player: "P2", filter: { zone: "hand", character: "Freezer" }, colors: { yellow: 1 }, generic: 1, untilTurn: s.turnNumber });
    const overdrive = give(s, "P2", "BT24-133", "hand");
    const g = give(s, "P2", "P-223", "energy");
    const six = give(s, "P2", "BT24-136", "battle");
    const four = give(s, "P2", "P-561", "battle");
    const r = play(s, successor(overdrive.uid, [six.uid, four.uid], pay(g.uid)));
    expect(r.state.players.P2.battle.map((c) => c.uid)).toEqual([overdrive.uid]);
    expect(r.state.successorDiscounts).toEqual([]); // la réduction est consommée
  });
});

describe("22-15 : [Espace-temps] (Towa)", () => {
  function setup(dropCount: number) {
    const s = p2Main();
    const towa = give(s, "P2", "P-055", "hand");
    for (let i = 0; i < dropCount; i++) s.players.P2.drop.push(s.players.P2.deck.shift()!);
    return { s, towa };
  }

  it("avec 3 cartes en Dispersion : toute la Dispersion part en Dimension parallèle et Towa est jouée sans payer", () => {
    const { s, towa } = setup(4);
    let r = play(s, { type: "OVER_REALM", player: "P2", uid: towa.uid });
    expect(r.state.players.P2.drop).toHaveLength(0);
    expect(r.state.players.P2.warp).toHaveLength(4);
    expect(r.state.players.P2.battle.map((c) => c.uid)).toEqual([towa.uid]);
    // « Quand vous jouez cette carte avec Espace-temps » : Leader +5000, puis l'adversaire défausse.
    expect(powerOf(r.state, { player: "P2", uid: "P2-L" }, ctx)).toBe(15000);
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P1", min: 1, max: 1 });
    const discard = (r.state.pending as { options: string[] }).options[0]!;
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P1", uids: [discard] });
    // 22-15-6 : à la fin du tour, Towa part en Dimension parallèle.
    r = play(r.state, { type: "END_MAIN_PHASE", player: "P2" });
    expect(r.state.players.P2.battle).toHaveLength(0);
    expect(r.state.players.P2.warp.map((c) => c.uid)).toContain(towa.uid);
  });

  it("moins de 3 cartes en Dispersion : pas d'Espace-temps", () => {
    const { s, towa } = setup(2);
    expect(getLegalActions(s, "P2", ctx).some((a) => a.type === "OVER_REALM")).toBe(false);
    expectRefused(s, { type: "OVER_REALM", player: "P2", uid: towa.uid }, "22-15");
  });

  it("22-15-7 : une seule fois par tour", () => {
    const { s, towa } = setup(3);
    let st = play(s, { type: "OVER_REALM", player: "P2", uid: towa.uid }).state;
    st = play(st, { type: "CHOOSE_CARDS", player: "P1", uids: [(st.pending as { options: string[] }).options[0]!] }).state;
    give(st, "P2", "P-055", "hand");
    for (let i = 0; i < 3; i++) st.players.P2.drop.push(st.players.P2.deck.shift()!);
    expect(getLegalActions(st, "P2", ctx).some((a) => a.type === "OVER_REALM")).toBe(false);
  });
});

describe("Réductions et coûts modifiés par les cartes elles-mêmes", () => {
  it("Piccolo Daimaô : -1 par carte de Combat verte non « Saiyan » en Dispersion ; l'orbe vert reste dû", () => {
    const s = p2Main();
    const piccolo = give(s, "P2", "P-561", "hand");
    expect(normalPlayPayment(s, "P2", piccolo, ctx)).toEqual({ colors: { green: 1 }, generic: 3 });
    for (const id of ["P-223", "BT10-075"]) s.players.P2.drop.push({ ...give(s, "P2", id, "hand") });
    s.players.P2.hand = s.players.P2.hand.filter((c) => !s.players.P2.drop.some((d) => d.uid === c.uid));
    expect(normalPlayPayment(s, "P2", piccolo, ctx)).toEqual({ colors: { green: 1 }, generic: 1 });
    // Paragus est « Saiyan » : il ne compte pas.
    s.players.P2.drop.push(give(s, "P2", "SD8-04", "hand"));
    s.players.P2.hand = s.players.P2.hand.filter((c) => !s.players.P2.drop.some((d) => d.uid === c.uid));
    expect(normalPlayPayment(s, "P2", piccolo, ctx)).toEqual({ colors: { green: 1 }, generic: 1 });
    // Jusqu'à 0 : il faut toujours payer l'orbe vert.
    for (const id of ["BT24-068", "BT14-082", "P-223", "BT10-075"]) {
      const c = s.players.P2.deck.find((x) => x.cardId === id);
      if (c) s.players.P2.drop.push(s.players.P2.deck.splice(s.players.P2.deck.indexOf(c), 1)[0]!);
    }
    expect(normalPlayPayment(s, "P2", piccolo, ctx)).toEqual({ colors: { green: 1 }, generic: 0 });
  });

  it("Empereur planétaire : coût de Combo réduit de 1 s'il y a une carte vert-jaune parmi vos Énergies", () => {
    const s = p2Main();
    s.players.P2.energyMarkers = 0; // sinon le marqueur Énergie paierait le coût de Combo
    const emperor = give(s, "P2", "BT27-136", "hand");
    let st = play(s, { type: "ATTACK", player: "P2", attacker: "P2-L", target: "P1-L" }).state;
    const combo = (state: GameState) =>
      getLegalActions(state, "P2", ctx).find((a): a is Extract<Action, { type: "COMBO" }> => a.type === "COMBO" && a.uid === emperor.uid);
    expect(combo(st)).toBeUndefined(); // coût 1, aucune Énergie
    st = structuredClone(s);
    give(st, "P2", "BT9-123", "energy", "rest"); // vert-jaune (en mode Inertie : ne paie rien)
    st = play(st, { type: "ATTACK", player: "P2", attacker: "P2-L", target: "P1-L" }).state;
    expect(combo(st)?.payment).toEqual({ energy: [], markers: 0 }); // coût 0
  });

  it("Anilaza : sa [Fuite d'énergie] est annulée s'il y a déjà une autre carte vert-jaune parmi vos Énergies", () => {
    let s = p1Main();
    // Premier tour : posée seule => mode Inertie.
    s = structuredClone(play(s, { type: "END_MAIN_PHASE", player: "P1" }).state);
    const first = give(s, "P2", "BT9-123", "hand");
    s = play(s, { type: "CHARGE_ENERGY", player: "P2", uid: first.uid }).state;
    expect(s.players.P2.energy[0]!.mode).toBe("rest");
    s = play(s, { type: "END_MAIN_PHASE", player: "P2" }, { type: "CHARGE_ENERGY", player: "P1", uid: null }, { type: "END_MAIN_PHASE", player: "P1" }).state;
    // Tour suivant : une autre vert-jaune est déjà là => la nouvelle arrive en mode Action.
    const second = give(s, "P2", "BT9-123", "hand");
    s = play(s, { type: "CHARGE_ENERGY", player: "P2", uid: second.uid }).state;
    expect(s.players.P2.energy.find((c) => c.uid === second.uid)!.mode).toBe("active");
  });
});

describe("Robustesse : parties au hasard avec Successeur et Espace-temps", () => {
  it("tous les coups proposés sont acceptés (30 parties)", () => {
    for (let seed = 400; seed < 430; seed++) {
      let s = p2Main(seed);
      let x = seed;
      const pickIndex = (n: number) => ((x = (x * 1103515245 + 12345) % 2147483648), x % n);
      for (let move = 0; move < 600 && !s.result; move++) {
        const player: PlayerId = s.pending!.player;
        const legal = getLegalActions(s, player, ctx).filter((a) => a.type !== "CONCEDE");
        // On favorise les Successeurs et Espace-temps quand ils sont possibles.
        const special = legal.filter((a) => a.type === "SUCCESSOR" || a.type === "OVER_REALM");
        const action = special.length > 0 && pickIndex(2) === 0 ? special[pickIndex(special.length)]! : legal[pickIndex(legal.length)]!;
        const r = applyAction(s, action, ctx);
        if (!r.ok) throw new Error(`seed ${seed}, coup ${move} : ${JSON.stringify(action)} → ${r.error}`);
        s = r.state;
      }
    }
  });
});
