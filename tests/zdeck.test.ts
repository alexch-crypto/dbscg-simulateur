import { describe, expect, it } from "vitest";
import { applyAction, getLegalActions, getPlayerView, type Action, type GameState, type PlayerId } from "../src/engine";
import { powerOf } from "../src/engine/rules/battle";
import { zPlayOptions } from "../src/engine/rules/zdeck";
import { ctx, expectRefused, give, newMirrorGame, p2Main, play } from "./helpers";

// Deck Z Freezer :
//  BT24-057 Freezer, Pleine Puissance à 100% — Leader Z, coût Z 2, Éveil Z (vert), 30 000
//  BT24-059 Cooler, Assistance fraternelle — Unisson Z, coût X (dont 1 vert), coût Z 1, 5 000
//  BT25-102 Ryan Shenron — Combat Z, coût 1 (jaune), coût Z 2, 15 000, [Déflexion]
//  BT28-081 Son Gohan — Combat Z, coût 4 (3 jaunes), coût Z 2 ; -(jaune)(jaune)(jaune) si
//           l'adversaire a 5 cartes ou plus en mode Inertie
//  BT22-060 Météore gigantesque — Extra Z, coût 1 (vert), coût Z 1
// Tous ces tests se passent pendant le premier tour de P2.

/** Donne des Énergies Z à un joueur (cartes prises dans son deck). */
function zEnergy(s: GameState, player: PlayerId, n: number): string[] {
  const p = s.players[player];
  const cards = p.deck.splice(0, n);
  for (const c of cards) c.faceUp = true;
  p.zEnergy.push(...cards);
  return cards.map((c) => c.uid);
}

const zCard = (s: GameState, player: PlayerId, cardId: string) => s.players[player].zDeck.find((c) => c.cardId === cardId)!;

/** Le coup PLAY_Z proposé par le moteur pour une carte Z (et une valeur de X). */
function playZ(s: GameState, uid: string, x?: number): Action {
  const a = getLegalActions(s, "P2", ctx).find((y) => y.type === "PLAY_Z" && y.uid === uid && y.x === x);
  if (!a) throw new Error(`PLAY_Z non proposé pour ${uid} (x=${x})`);
  return a;
}

describe("Deck Z : mise en place et secret", () => {
  it("6-2-1-8 : chaque joueur a son deck Z (9 cartes)", () => {
    const s = newMirrorGame();
    expect(s.players.P1.zDeck).toHaveLength(9);
    expect(s.players.P2.zDeck).toHaveLength(9);
  });

  it("3-12 : le propriétaire voit son deck Z, l'adversaire seulement le nombre de cartes", () => {
    const s = newMirrorGame();
    expect(getPlayerView(s, "P1").players.P1.zDeck.every((c) => "cardId" in c)).toBe(true);
    expect(getPlayerView(s, "P2").players.P1.zDeck).toEqual(Array(9).fill({ hidden: true }));
  });
});

describe("Carte de Combat Z : Ryan Shenron", () => {
  it("se joue en payant son énergie (jaune) ET 2 Énergies Z, qui vont dans la Dispersion", () => {
    const s = p2Main();
    give(s, "P2", "BT24-105", "energy"); // jaune
    const zs = zEnergy(s, "P2", 2);
    const ryan = zCard(s, "P2", "BT25-102");
    const target = give(s, "P1", "BT24-106", "battle");
    let r = play(s, playZ(s, ryan.uid));
    expect(r.state.players.P2.battle.map((c) => c.uid)).toEqual([ryan.uid]);
    expect(r.state.players.P2.zEnergy).toHaveLength(0);
    expect(r.state.players.P2.drop.map((c) => c.uid)).toEqual(expect.arrayContaining(zs));
    expect(r.state.players.P2.zDeck).toHaveLength(8);
    // « Quand cette carte est jouée » : passer une carte adverse en mode Inertie.
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", options: [target.uid] });
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [target.uid] });
    expect(r.state.players.P1.battle[0]!.mode).toBe("rest");
  });

  it("5-4-3 : sans assez d'Énergie Z, la carte n'est pas proposée", () => {
    const s = p2Main();
    give(s, "P2", "BT24-105", "energy");
    zEnergy(s, "P2", 1);
    const ryan = zCard(s, "P2", "BT25-102");
    expect(getLegalActions(s, "P2", ctx).some((a) => a.type === "PLAY_Z" && a.uid === ryan.uid)).toBe(false);
  });

  it("le coût d'Énergie Z doit être payé exactement, avec ses propres Énergies Z", () => {
    const s = p2Main();
    const y = give(s, "P2", "BT24-105", "energy");
    const zs = zEnergy(s, "P2", 3);
    const ryan = zCard(s, "P2", "BT25-102");
    const payment = { energy: [y.uid], markers: 0 };
    expectRefused(s, { type: "PLAY_Z", player: "P2", uid: ryan.uid, payment, zEnergy: zs }, "exactement 2");
  });

  it("14-1-4 : une carte Z mise KO est retirée de la partie au lieu d'aller en Dispersion", () => {
    const s = p1MainTurn2();
    const ryan = s.players.P1.zDeck.find((c) => c.cardId === "BT25-102")!;
    s.players.P1.zDeck.splice(s.players.P1.zDeck.indexOf(ryan), 1);
    s.players.P1.battle.push({ ...ryan, mode: "rest", faceUp: true });
    const piccolo = give(s, "P2", "P-561", "battle"); // 20 000 contre 15 000
    void piccolo;
    const st = turnToP2(s);
    const r = play(st, { type: "ATTACK", player: "P2", attacker: piccolo.uid, target: ryan.uid }, { type: "END_STEP", player: "P2" }, {
      type: "END_STEP",
      player: "P1",
    });
    expect(r.state.players.P1.drop.map((c) => c.uid)).not.toContain(ryan.uid);
    expect(r.state.players.P1.removed.map((c) => c.uid)).toContain(ryan.uid);
  });

  it("Son Gohan : -(jaune)(jaune)(jaune) dans le deck Z si l'adversaire a 5 cartes ou plus en mode Inertie", () => {
    const s = p2Main();
    const gohan = zCard(s, "P2", "BT28-081");
    for (const id of ["BT24-105", "BT24-106", "BT27-080", "BT27-076"]) give(s, "P2", id, "energy");
    zEnergy(s, "P2", 2);
    const cost = () => zPlayOptions(s, "P2", ctx).find((o) => o.uid === gohan.uid)?.payments[0]?.payment;
    expect(cost()).toEqual({ colors: { yellow: 3 }, generic: 1 });
    s.players.P1.leader.mode = "rest";
    for (let i = 0; i < 4; i++) give(s, "P1", "BT9-123", "energy", "rest");
    expect(cost()).toEqual({ colors: {}, generic: 1 });
  });
});

/** P1 au début de son 2e tour, en phase principale. */
function p1MainTurn2(): GameState {
  return play(p2Main(), { type: "END_MAIN_PHASE", player: "P2" }, { type: "CHARGE_ENERGY", player: "P1", uid: null }).state;
}
/** Fin du tour de P1 puis début de la phase principale de P2. */
function turnToP2(s: GameState): GameState {
  return play(s, { type: "END_MAIN_PHASE", player: "P1" }, { type: "CHARGE_ENERGY", player: "P2", uid: null }).state;
}

describe("Unisson Z : Cooler", () => {
  function setup(x: number) {
    const s = p2Main();
    s.players.P2.energyMarkers = 0;
    for (const id of ["P-223", "BT24-105", "BT24-106", "BT27-080"].slice(0, x)) give(s, "P2", id, "energy");
    zEnergy(s, "P2", 1);
    const cooler = zCard(s, "P2", "BT24-059");
    const r = play(s, playZ(s, cooler.uid, x));
    return { st: r.state, cooler, events: r.events };
  }

  it("18-2-1-3 : coût X — elle arrive avec autant de marqueurs que d'Énergies passées en mode Inertie", () => {
    const { st, cooler, events } = setup(3);
    expect(st.players.P2.unison).toHaveLength(1);
    expect(st.players.P2.unison[0]).toMatchObject({ uid: cooler.uid, markers: 3 });
    expect(events).toContainEqual({ type: "UNISON_PLAYED", player: "P2", uid: cooler.uid, cardId: "BT24-059", markers: 3 });
    expect(st.players.P2.energy.every((c) => c.mode === "rest")).toBe(true);
  });

  it("chaque valeur de X payable est proposée (X ≥ coût de couleur)", () => {
    const s = p2Main();
    s.players.P2.energyMarkers = 0;
    for (const id of ["P-223", "BT24-105", "BT24-106"]) give(s, "P2", id, "energy");
    zEnergy(s, "P2", 1);
    const cooler = zCard(s, "P2", "BT24-059");
    const xs = getLegalActions(s, "P2", ctx)
      .filter((a): a is Extract<Action, { type: "PLAY_Z" }> => a.type === "PLAY_Z" && a.uid === cooler.uid)
      .map((a) => a.x);
    expect(xs).toEqual([1, 2, 3]);
  });

  it("[+2] : +2 marqueurs, déclarer X : le coût d'une carte adverse augmente de X ; une seule Capacité de marqueur par tour", () => {
    const { st, cooler } = setup(2);
    const target = give(st, "P1", "BT24-105", "battle");
    const plus = getLegalActions(st, "P2", ctx).find(
      (a): a is Extract<Action, { type: "ACTIVATE" }> => a.type === "ACTIVATE" && a.uid === cooler.uid && a.index === 1 && a.x === 3,
    )!;
    let r = play(st, plus);
    expect(r.state.players.P2.unison[0]!.markers).toBe(4);
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [target.uid] });
    expect(r.events).toContainEqual({ type: "COST_MODIFIED", uids: [target.uid], amount: 3 });
    // 13-4-2 : plus aucune Capacité de marqueur ce tour (ni [+2], ni [-3]).
    expect(getLegalActions(r.state, "P2", ctx).some((a) => a.type === "ACTIVATE" && a.uid === cooler.uid)).toBe(false);
  });

  it("[-3] impossible avec seulement 2 marqueurs (13-4-1-3)", () => {
    const { st, cooler } = setup(2);
    expect(getLegalActions(st, "P2", ctx).some((a) => a.type === "ACTIVATE" && a.uid === cooler.uid && a.index === 2)).toBe(false);
  });

  it("Auto : quand vous jouez un <Freezer> jaune, Cooler gagne +10 000 pour le tour", () => {
    const { st, cooler } = setup(1);
    for (const id of ["BT24-105", "BT24-106", "BT27-080"]) give(st, "P2", id, "energy");
    const yellow = give(st, "P2", "BT24-105", "hand");
    const action = getLegalActions(st, "P2", ctx).find((a) => a.type === "PLAY_CARD" && a.uid === yellow.uid)!;
    let r = play(st, action);
    // Deux [Auto.] en même temps (celle de Freezer et celle de Cooler) : le joueur choisit l'ordre.
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_AUTO", player: "P2" });
    const options = (r.state.pending as { options: { id: number; label: string }[] }).options;
    r = play(r.state, { type: "CHOOSE_AUTO", player: "P2", id: options.find((o) => o.label.startsWith("Cooler"))!.id });
    r = play(r.state, { type: "CHOOSE_LIFE", player: "P2", indices: [] });
    expect(powerOf(r.state, { player: "P2", uid: cooler.uid }, ctx)).toBe(15000);
  });

  it("3-11-4 : une nouvelle Unisson remplace l'ancienne (une Unisson Z est retirée de la partie)", () => {
    const { st, cooler } = setup(1);
    const oolong = zCard(st, "P2", "BT25-141");
    for (const id of ["P-561", "BT14-082"]) give(st, "P2", id, "energy");
    zEnergy(st, "P2", 1);
    const r = play(st, playZ(st, oolong.uid, 2));
    expect(r.state.players.P2.unison.map((c) => c.uid)).toEqual([oolong.uid]);
    expect(r.state.players.P2.removed.map((c) => c.uid)).toContain(cooler.uid);
  });

  it("13-5 : attaquée, l'Unisson perd un marqueur (pas d'étape de Défense) ; à 0 elle quitte la zone", () => {
    const { st, cooler } = setup(2);
    st.players.P2.drop.push(...st.players.P2.hand.splice(0)); // P2 n'a aucun contre en main
    // Tour de P1 : il attaque Cooler avec son Leader (10 000 contre 5 000).
    let s = play(st, { type: "END_MAIN_PHASE", player: "P2" }, { type: "CHARGE_ENERGY", player: "P1", uid: null }).state;
    s = play(s, { type: "ATTACK", player: "P1", attacker: "P1-L", target: cooler.uid }, { type: "END_STEP", player: "P1" }).state;
    expect(s.pending).toEqual({ type: "MAIN", player: "P1" }); // pas d'étape de Défense
    expect(s.players.P2.unison[0]!.markers).toBe(1);
    // Une 2e attaque (Double Frappe : 2 marqueurs) l'envoie hors de la Zone Unisson.
    const second = give(s, "P1", "BT24-136", "battle");
    s = play(s, { type: "ATTACK", player: "P1", attacker: second.uid, target: cooler.uid }, { type: "END_STEP", player: "P1" }).state;
    expect(s.players.P2.unison).toHaveLength(0);
    expect(s.players.P2.removed.map((c) => c.uid)).toContain(cooler.uid);
  });

  it("l'Unisson peut attaquer (Oolong, Désir immédiat ne le peut pas)", () => {
    const { st, cooler } = setup(1);
    expect(getLegalActions(st, "P2", ctx).some((a) => a.type === "ATTACK" && a.attacker === cooler.uid)).toBe(true);
  });
});

describe("[Éveil Z] : Freezer, Pleine Puissance à 100%", () => {
  function awakened(): GameState {
    const s = p2Main();
    s.players.P2.leader.side = "back";
    give(s, "P2", "P-223", "energy"); // verte
    zEnergy(s, "P2", 2);
    return s;
  }
  const zAwaken = (s: GameState) => getLegalActions(s, "P2", ctx).find((a) => a.type === "Z_AWAKEN");

  it("impossible tant que le Leader n'est pas éveillé (condition « face arrière »)", () => {
    const s = awakened();
    s.players.P2.leader.side = "front";
    expect(zAwaken(s)).toBeUndefined();
  });

  it("phase principale : (vert) + 2 Énergies Z ; le Leader Z se pose sur le Leader (30 000)", () => {
    const s = awakened();
    const r = play(s, zAwaken(s)!);
    expect(r.state.players.P2.leader.z?.cardId).toBe("BT24-057");
    expect(powerOf(r.state, { player: "P2", uid: "P2-L" }, ctx)).toBe(30000);
    expect(r.state.players.P2.zEnergy).toHaveLength(0);
    expect(r.state.pending).toEqual({ type: "MAIN", player: "P2" });
  });

  it("pendant l'étape d'Attaque : le Leader Z garde le mode Inertie et frappe avec 30 000", () => {
    const s = awakened();
    let st = play(s, { type: "ATTACK", player: "P2", attacker: "P2-L", target: "P1-L" }).state;
    st = play(st, zAwaken(st)!).state;
    expect(st.players.P2.leader).toMatchObject({ mode: "rest", z: { cardId: "BT24-057" } });
    const r = play(st, { type: "END_STEP", player: "P2" }, { type: "END_STEP", player: "P1" });
    expect(r.events).toContainEqual({ type: "POWER_COMPARED", attacker: 30000, defender: 10000 });
  });

  it("attaqué : à la fin du combat, payer 2 Énergies Z, sinon le Leader Z est retiré (le Leader éveillé reste)", () => {
    // P1 a le Leader Z ; P2 l'attaque.
    const s = p2Main();
    s.players.P1.leader.side = "back";
    const z = s.players.P1.zDeck.find((c) => c.cardId === "BT24-057")!;
    s.players.P1.zDeck.splice(s.players.P1.zDeck.indexOf(z), 1);
    s.players.P1.leader.z = { uid: z.uid, cardId: z.cardId };
    zEnergy(s, "P1", 2);
    let r = play(s, { type: "ATTACK", player: "P2", attacker: "P2-L", target: "P1-L" }, { type: "END_STEP", player: "P2" }, {
      type: "END_STEP",
      player: "P1",
    });
    // 10 000 contre 30 000 : pas de dégâts ; puis l'[Auto.] de fin de combat demande à P1.
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_OPTION", player: "P1" });
    const keep = play(r.state, { type: "CHOOSE_OPTION", player: "P1", id: "yes" });
    expect(keep.state.players.P1.leader.z?.cardId).toBe("BT24-057");
    expect(keep.state.players.P1.zEnergy).toHaveLength(0);
    r = play(r.state, { type: "CHOOSE_OPTION", player: "P1", id: "no" });
    expect(r.state.players.P1.leader.z).toBeUndefined();
    expect(r.state.players.P1.removed.map((c) => c.uid)).toContain(z.uid);
    expect(powerOf(r.state, { player: "P1", uid: "P1-L" }, ctx)).toBe(15000);
    expect(r.state.pending).toEqual({ type: "MAIN", player: "P2" });
  });

  it("Boost d'Esprit 1 : retirer un marqueur de son Unisson, piocher, relever un <Freezer> vert", () => {
    const s = awakened();
    let st = play(s, zAwaken(s)!).state;
    // Une Unisson avec 2 marqueurs, et un Freezer vert en mode Inertie.
    const cooler = zCard(st, "P2", "BT24-059");
    st.players.P2.zDeck.splice(st.players.P2.zDeck.indexOf(cooler), 1);
    st.players.P2.unison.push({ ...cooler, faceUp: true, markers: 2 });
    const freezer = give(st, "P2", "BT10-075", "battle", "rest");
    const boost = getLegalActions(st, "P2", ctx).find(
      (a): a is Extract<Action, { type: "ACTIVATE" }> => a.type === "ACTIVATE" && a.uid === "P2-L",
    );
    expect(boost).toBeDefined();
    const hand = st.players.P2.hand.length;
    st = play(st, boost!).state;
    expect(st.players.P2.unison[0]!.markers).toBe(1);
    expect(st.players.P2.hand).toHaveLength(hand + 1);
    st = play(st, { type: "CHOOSE_CARDS", player: "P2", uids: [freezer.uid] }).state;
    expect(st.players.P2.battle.find((c) => c.uid === freezer.uid)!.mode).toBe("active");
  });
});

describe("Extra Z : Météore gigantesque de Destruction", () => {
  function placed(): { s: GameState; meteor: { uid: string } } {
    const s = p2Main();
    give(s, "P2", "P-223", "energy");
    zEnergy(s, "P2", 1);
    const meteor = zCard(s, "P2", "BT22-060");
    return { s: play(s, playZ(s, meteor.uid)).state, meteor };
  }

  it("est placée dans la Zone de Combat ; ce n'est pas une carte de Combat (elle n'attaque pas, ne peut pas être visée)", () => {
    const { s, meteor } = placed();
    expect(s.players.P2.battle.map((c) => c.uid)).toEqual([meteor.uid]);
    expect(getLegalActions(s, "P2", ctx).some((a) => a.type === "ATTACK" && a.attacker === meteor.uid)).toBe(false);
  });

  it("Activation : Combat — se retire de la partie pour donner +10 000 pour le combat", () => {
    const { s, meteor } = placed();
    let st = play(s, { type: "ATTACK", player: "P2", attacker: "P2-L", target: "P1-L" }).state;
    const act = getLegalActions(st, "P2", ctx).find(
      (a): a is Extract<Action, { type: "ACTIVATE" }> => a.type === "ACTIVATE" && a.uid === meteor.uid && a.index === 0,
    )!;
    st = play(st, act).state;
    expect(st.players.P2.removed.map((c) => c.uid)).toContain(meteor.uid);
    st = play(st, { type: "CHOOSE_CARDS", player: "P2", uids: ["P2-L"] }).state;
    const r = play(st, { type: "END_STEP", player: "P2" }, { type: "END_STEP", player: "P1" });
    expect(r.events).toContainEqual({ type: "POWER_COMPARED", attacker: 20000, defender: 10000 });
  });
});

describe("Robustesse : parties au hasard avec le deck Z", () => {
  it("tous les coups proposés sont acceptés (30 parties)", () => {
    let zPlays = 0;
    for (let seed = 500; seed < 530; seed++) {
      let s = p2Main(seed);
      let x = seed;
      const pick = (n: number) => ((x = (x * 1103515245 + 12345) % 2147483648), x % n);
      for (let move = 0; move < 600 && !s.result; move++) {
        const legal = getLegalActions(s, s.pending!.player, ctx).filter((a) => a.type !== "CONCEDE");
        const special = legal.filter((a) => a.type === "PLAY_Z" || a.type === "Z_AWAKEN");
        const action = special.length > 0 && pick(2) === 0 ? special[pick(special.length)]! : legal[pick(legal.length)]!;
        if (action.type === "PLAY_Z" || action.type === "Z_AWAKEN") zPlays++;
        const r = applyAction(s, action, ctx);
        if (!r.ok) throw new Error(`seed ${seed}, coup ${move} : ${JSON.stringify(action)} → ${r.error}`);
        s = r.state;
      }
    }
    expect(zPlays).toBeGreaterThan(10);
  });
});
