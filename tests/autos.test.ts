import { describe, expect, it } from "vitest";
import {
  applyAction,
  buildCardDatabase,
  getLegalActions,
  parseCardFile,
  type Action,
  type GameContext,
  type GameEvent,
  type GameState,
  type PlayerId,
} from "../src/engine";
import { powerOf } from "../src/engine/rules/battle";
import { ctx, db, expectRefused, freezer, give, p2Main, play } from "./helpers";

// Tous ces tests se passent pendant le premier tour de P2 (il peut attaquer).

/** Donne `n` Énergies vert-jaune (Anilaza) en mode Action. */
function energies(s: GameState, player: PlayerId, n: number): void {
  const ids = ["BT9-123", "BT9-123", "BT9-123", "BT9-123", "BT24-105", "BT24-106", "P-561", "BT27-080", "BT24-134", "BT24-136"];
  for (let i = 0; i < n; i++) give(s, player, ids[i]!, "energy");
}

/** Joue une carte de la main avec le paiement suggéré par le moteur. */
function playCard(s: GameState, uid: string, c: GameContext = ctx): { state: GameState; events: GameEvent[] } {
  const action = getLegalActions(s, s.turnPlayer, c).find((a) => a.type === "PLAY_CARD" && a.uid === uid);
  if (!action) throw new Error(`impossible de jouer ${uid}`);
  const r = applyAction(s, action, c);
  if (!r.ok) throw new Error(r.error);
  return { state: r.state, events: r.events };
}

describe("[Auto.] « Quand cette carte est jouée »", () => {
  it("Freezer, Départ de l'Invasion : rajouter une carte de Vie en main, puis passer une carte adverse en mode Inertie", () => {
    const s = p2Main();
    energies(s, "P2", 3);
    const target = give(s, "P1", "BT24-136", "battle", "active");
    const freezer = give(s, "P2", "BT24-105", "hand");
    const handBefore = s.players.P2.hand.length;

    let r = playCard(s, freezer.uid);
    expect(r.events).toContainEqual({ type: "AUTO_TRIGGERED", player: "P2", uid: freezer.uid, cardId: "BT24-105" });
    // 1) « jusqu'à une carte de vos points de vie » : choix de position, à l'aveugle.
    expect(r.state.pending).toEqual({
      type: "CHOOSE_LIFE",
      player: "P2",
      min: 0,
      max: 1,
      prompt: "Rajoutez à votre main jusqu'à 1 carte(s) de vos points de vie",
    });
    r = play(r.state, { type: "CHOOSE_LIFE", player: "P2", indices: [4] });
    expect(r.state.players.P2.life).toHaveLength(7);
    expect(r.state.players.P2.hand).toHaveLength(handBefore); // -1 (Freezer joué) +1 (Vie)
    expect(r.events).toContainEqual({ type: "LIFE_TO_HAND", player: "P2", indices: [4], cardIds: [null] });
    // 2) « jusqu'à une carte de Combat adverse » en mode Inertie.
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P2", min: 0, max: 1, options: [target.uid] });
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [target.uid] });
    expect(r.state.players.P1.battle[0]!.mode).toBe("rest");
    expect(r.state.pending).toEqual({ type: "MAIN", player: "P2" });
  });

  it("rajouter une carte de Vie n'est pas un dégât, et « jusqu'à » permet de n'en prendre aucune", () => {
    const s = p2Main();
    energies(s, "P2", 3);
    const freezer = give(s, "P2", "BT24-105", "hand");
    const r = play(playCard(s, freezer.uid).state, { type: "CHOOSE_LIFE", player: "P2", indices: [] });
    expect(r.state.players.P2.life).toHaveLength(8);
    expect(r.events.some((e) => e.type === "DAMAGE_DEALT")).toBe(false);
    // Pas de carte adverse : la 2e partie ne demande rien (5-2-6).
    expect(r.state.pending).toEqual({ type: "MAIN", player: "P2" });
  });

  it("Overdrive : « votre adversaire ne peut pas attaquer à moins de... » jusqu'à la fin de son tour", () => {
    const s = p2Main();
    for (const id of ["BT9-123", "BT9-123", "BT9-123", "BT9-123", "BT24-105", "BT24-106", "P-561", "BT27-080", "BT24-134", "BT24-136"]) {
      give(s, "P2", id, "energy");
    }
    const overdrive = give(s, "P2", "BT24-133", "hand");
    const r = playCard(s, overdrive.uid);
    expect(r.events).not.toContainEqual(expect.objectContaining({ type: "NOT_IMPLEMENTED" }));
    expect(r.state.attackTaxes).toEqual([{ player: "P1", rule: "rest_one_active_card_per_attack", untilTurn: r.state.turnNumber + 1 }]);
    expect(r.state.pending).toEqual({ type: "MAIN", player: "P2" });
  });

  it("Second Changement de Forme : pioche + 10 000 de puissance pour tout le tour (3 Énergies ou plus)", () => {
    const s = p2Main();
    energies(s, "P2", 6);
    const freezer = give(s, "P2", "BT24-136", "hand");
    const handBefore = s.players.P2.hand.length;
    const r = playCard(s, freezer.uid);
    expect(r.state.players.P2.hand).toHaveLength(handBefore); // -1 +1 pioche
    expect(powerOf(r.state, { player: "P2", uid: freezer.uid }, ctx)).toBe(30000);
    expect(r.events).toContainEqual({ type: "POWER_MODIFIED", uid: freezer.uid, amount: 10000, until: "turn" });
    // Au tour suivant, le bonus a disparu.
    const next = play(r.state, { type: "END_MAIN_PHASE", player: "P2" }).state;
    expect(powerOf(next, { player: "P2", uid: freezer.uid }, ctx)).toBe(20000);
  });

  it("[Limite 1] : le deuxième Second Changement de Forme du tour ne déclenche plus son effet", () => {
    const s = p2Main();
    energies(s, "P2", 6);
    const first = give(s, "P2", "BT24-136", "hand");
    const second = give(s, "P2", "BT24-136", "hand");
    const after = playCard(s, first.uid).state;
    // 6 nouvelles Énergies pour payer le deuxième (2 vertes, 2 jaunes au moins).
    for (const id of ["BT24-133", "BT27-136", "BT24-134", "BT27-080", "BT24-106", "BT24-105"]) give(after, "P2", id, "energy");
    const r = playCard(after, second.uid);
    expect(r.events).toContainEqual(expect.objectContaining({ type: "AUTO_CANCELLED", cardId: "BT24-136" }));
    expect(powerOf(r.state, { player: "P2", uid: second.uid }, ctx)).toBe(20000);
  });

  it("Méchant charismatique : mettre KO une carte adverse de coût 7 ou moins (pas l'Overdrive à 10)", () => {
    const s = p2Main();
    energies(s, "P2", 5);
    const piccolo = give(s, "P1", "P-561", "battle"); // coût 4
    give(s, "P1", "BT24-133", "battle"); // coût 10
    const freezer = give(s, "P2", "BT10-075", "hand");
    let r = playCard(s, freezer.uid);
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", options: [piccolo.uid], min: 0, max: 1 });
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [piccolo.uid] });
    expect(r.state.players.P1.drop.map((c) => c.uid)).toContain(piccolo.uid);
    expect(r.state.players.P1.battle).toHaveLength(1);
  });
});

describe("[Auto.] pendant l'attaque : contre, puis autos, puis blocage", () => {
  /** P2 avec son Leader éveillé (face arrière : « Quand cette carte attaque, piochez une carte »). */
  function awakened(): GameState {
    const s = p2Main();
    s.players.P2.leader.side = "back";
    return s;
  }

  it("le Leader Freezer éveillé pioche quand il attaque", () => {
    const s = awakened();
    const handBefore = s.players.P2.hand.length;
    const r = play(s, { type: "ATTACK", player: "P2", attacker: "P2-L", target: "P1-L" });
    expect(r.state.players.P2.hand).toHaveLength(handBefore + 1);
    expect(r.state.pending).toEqual({ type: "OFFENSE", player: "P2" });
  });

  it("le défenseur décide de bloquer APRÈS la pioche de l'attaquant", () => {
    const s = awakened();
    give(s, "P1", "P-223", "battle"); // Zarbon, Bloqueur
    const r = play(s, { type: "ATTACK", player: "P2", attacker: "P2-L", target: "P1-L" });
    const types = r.events.map((e) => e.type);
    expect(types).toEqual(["ATTACK_DECLARED", "AUTO_TRIGGERED", "COUNTER_WINDOW_OPENED", "COUNTER_WINDOW_CLOSED", "CARDS_DRAWN"]);
    expect(r.state.pending).toEqual({ type: "BLOCKER", player: "P1" });
  });

  it("Transformation effroyable : passe une carte adverse en mode Inertie ; pas « Saiyan » => rien de plus", () => {
    const s = p2Main();
    const freezer = give(s, "P2", "BT27-076", "battle");
    const target = give(s, "P1", "BT24-105", "battle", "active");
    let r = play(s, { type: "ATTACK", player: "P2", attacker: freezer.uid, target: "P1-L" });
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", options: [target.uid] });
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [target.uid] });
    expect(r.state.players.P1.battle[0]!.mode).toBe("rest");
    expect(r.state.players.P2.battle[0]!.mode).toBe("rest"); // l'attaquante ne se relève pas
    expect(r.state.pending).toEqual({ type: "OFFENSE", player: "P2" });
  });

  it("Transformation effroyable contre un « Saiyan » : il est mis KO et l'attaquante repasse en mode Action", () => {
    const s = p2Main();
    const freezer = give(s, "P2", "BT27-076", "battle");
    const paragus = give(s, "P1", "SD8-04", "battle", "active"); // « Saiyan »
    let r = play(s, { type: "ATTACK", player: "P2", attacker: freezer.uid, target: "P1-L" });
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [paragus.uid] });
    expect(r.state.players.P1.drop.map((c) => c.uid)).toContain(paragus.uid);
    expect(r.state.players.P2.battle[0]!.mode).toBe("active");
  });
});

describe("[Auto.] « Quand cette carte quitte la Zone de Combat / est mise KO »", () => {
  it("Zarbon (P-223) mis KO en combat : son [Auto.] se résout depuis la Dispersion si l'adversaire a 5 cartes ou plus", () => {
    const s = p2Main();
    const zarbon = give(s, "P1", "P-223", "battle", "rest");
    expect(s.players.P2.hand.length).toBeGreaterThanOrEqual(5);
    const r = play(s, { type: "ATTACK", player: "P2", attacker: "P2-L", target: zarbon.uid }, { type: "END_STEP", player: "P2" }, { type: "END_STEP", player: "P1" });
    expect(r.state.players.P1.drop.map((c) => c.uid)).toContain(zarbon.uid);
    expect(r.events).toContainEqual({ type: "AUTO_TRIGGERED", player: "P1", uid: zarbon.uid, cardId: "P-223" });
    // « votre adversaire choisit une carte de sa main et la défausse » : c'est P2 qui choisit.
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P2", min: 1, max: 1 });
    const chosen = (r.state.pending as { options: string[] }).options[0]!;
    const after = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [chosen] });
    expect(after.state.players.P2.drop.map((c) => c.uid)).toContain(chosen);
    expect(after.state.battle).toBeNull();
  });

  it("si l'adversaire a moins de 5 cartes, la condition n'est pas remplie", () => {
    const s = p2Main();
    const zarbon = give(s, "P1", "P-223", "battle", "rest");
    s.players.P2.drop.push(...s.players.P2.hand.splice(0));
    const r = play(s, { type: "ATTACK", player: "P2", attacker: "P2-L", target: zarbon.uid }, { type: "END_STEP", player: "P2" }, { type: "END_STEP", player: "P1" });
    expect(r.events).toContainEqual(expect.objectContaining({ type: "AUTO_CANCELLED", cardId: "P-223", reason: "condition non remplie" }));
  });
});

describe("[Auto.] « Quand vous faites une Combo avec cette carte »", () => {
  it("Paragus : pioche 2 cartes si Leader vert et 4 points de vie ou moins", () => {
    const s = p2Main();
    s.players.P2.hand.push(...s.players.P2.life.splice(4));
    const paragus = give(s, "P2", "SD8-04", "hand");
    let r = play(s, { type: "ATTACK", player: "P2", attacker: "P2-L", target: "P1-L" });
    const handBefore = r.state.players.P2.hand.length;
    r = play(r.state, { type: "COMBO", player: "P2", uid: paragus.uid, payment: { energy: [], markers: 0 } });
    expect(r.state.players.P2.hand).toHaveLength(handBefore - 1 + 2);
    // Puis : « choisissez une carte de votre main et transférez-la dans votre Dimension parallèle ».
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P2", min: 1, max: 1 });
    const chosen = r.state.players.P2.hand[0]!;
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [chosen.uid] });
    expect(r.state.players.P2.warp.map((c) => c.uid)).toEqual([chosen.uid]);
    expect(r.state.pending).toEqual({ type: "OFFENSE", player: "P2" }); // on revient à l'étape d'Attaque
  });

  it("Paragus avec 8 points de vie : rien ne se passe", () => {
    const s = p2Main();
    const paragus = give(s, "P2", "SD8-04", "hand");
    let r = play(s, { type: "ATTACK", player: "P2", attacker: "P2-L", target: "P1-L" });
    r = play(r.state, { type: "COMBO", player: "P2", uid: paragus.uid, payment: { energy: [], markers: 0 } });
    expect(r.events).toContainEqual(expect.objectContaining({ type: "AUTO_CANCELLED", cardId: "SD8-04" }));
  });
});

describe("9-6-3 : ordre de résolution", () => {
  // Cartes de test : une carte avec DEUX [Auto.] « quand cette carte est jouée », et une carte
  // avec « quand cette carte est attaquée ».
  const testCards = parseCardFile({
    cards: [
      {
        id: "TEST-2AUTO",
        type: "battle",
        name: "Double Auto",
        colors: ["green"],
        cost: { total: 0, specified: {} },
        power: 5000,
        combo: { cost: 0, power: 5000 },
        abilities: [
          { kind: "auto", trigger: { event: "played", who: "this" }, effect: [{ do: "draw", count: 1 }], text: "A : piochez 1" },
          { kind: "auto", trigger: { event: "played", who: "this" }, effect: [{ do: "power_mod", target: "this", amount: 5000, duration: "turn" }], text: "B : +5000" },
        ],
      },
      {
        id: "TEST-ATTACKED",
        type: "battle",
        name: "Attaqué",
        colors: ["green"],
        cost: { total: 0, specified: {} },
        power: 5000,
        combo: { cost: 0, power: 5000 },
        abilities: [{ kind: "auto", trigger: { event: "attacked", who: "this" }, effect: [{ do: "draw", count: 1 }], text: "piochez 1" }],
      },
    ],
  });
  const testCtx: GameContext = { cards: buildCardDatabase([freezer.cards, testCards.cards]) };

  function withCard(s: GameState, player: PlayerId, cardId: string, zone: "hand" | "battle", mode: "active" | "rest" = "active") {
    const card = { uid: `${player}-T${s.players[player].hand.length}${zone}`, cardId, owner: player, mode, faceUp: zone !== "hand" };
    s.players[player][zone].push(card);
    return card;
  }

  it("deux [Auto.] du même joueur en même temps : il choisit l'ordre", () => {
    const s = p2Main();
    const card = withCard(s, "P2", "TEST-2AUTO", "hand");
    let r = playCard(s, card.uid, testCtx);
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_AUTO", player: "P2" });
    const options = (r.state.pending as Extract<GameState["pending"], { type: "CHOOSE_AUTO" }>).options;
    expect(options.map((o) => o.label)).toEqual(["Double Auto : A : piochez 1", "Double Auto : B : +5000"]);
    // On résout B d'abord : l'autre se résout ensuite automatiquement (il n'en reste qu'une).
    const step = applyAction(r.state, { type: "CHOOSE_AUTO", player: "P2", id: options[1]!.id }, testCtx);
    if (!step.ok) throw new Error(step.error);
    const types = step.events.map((e) => e.type);
    expect(types.indexOf("POWER_MODIFIED")).toBeLessThan(types.indexOf("CARDS_DRAWN"));
    expect(step.state.pending).toEqual({ type: "MAIN", player: "P2" });
  });

  it("le joueur actif résout ses [Auto.] avant celles du joueur non actif", () => {
    const s = p2Main();
    s.players.P2.leader.side = "back"; // pioche quand il attaque
    const target = withCard(s, "P1", "TEST-ATTACKED", "battle", "rest");
    const r = applyAction(s, { type: "ATTACK", player: "P2", attacker: "P2-L", target: target.uid }, testCtx);
    if (!r.ok) throw new Error(r.error);
    const draws = r.events.filter((e) => e.type === "CARDS_DRAWN").map((e) => (e as { player: PlayerId }).player);
    expect(draws).toEqual(["P2", "P1"]);
  });

  it("seul le joueur concerné peut choisir, et seulement une [Auto.] en attente", () => {
    const s = p2Main();
    const card = withCard(s, "P2", "TEST-2AUTO", "hand");
    const st = playCard(s, card.uid, testCtx).state;
    expect(applyAction(st, { type: "CHOOSE_AUTO", player: "P1", id: 1 }, testCtx)).toMatchObject({ ok: false });
    expect(applyAction(st, { type: "CHOOSE_AUTO", player: "P2", id: 999 }, testCtx)).toMatchObject({ ok: false });
  });
});

describe("Réponses aux choix d'effet", () => {
  it("CHOOSE_LIFE : refuse trop de cartes, une position invalide ou le mauvais joueur", () => {
    const s = p2Main();
    energies(s, "P2", 3);
    const freezer = give(s, "P2", "BT24-105", "hand");
    const st = playCard(s, freezer.uid).state;
    expectRefused(st, { type: "CHOOSE_LIFE", player: "P2", indices: [0, 1] }, "entre 0 et 1");
    expectRefused(st, { type: "CHOOSE_LIFE", player: "P2", indices: [9] }, "position de carte de Vie invalide");
    expectRefused(st, { type: "CHOOSE_LIFE", player: "P1", indices: [0] }, "c'est à P2");
    const action: Action = { type: "END_MAIN_PHASE", player: "P2" };
    expectRefused(st, action, "décision attendue : CHOOSE_LIFE");
  });

  it("les cartes de Vie restent secrètes pour l'adversaire quand elles vont en main", () => {
    const s = p2Main();
    energies(s, "P2", 3);
    const freezer = give(s, "P2", "BT24-105", "hand");
    const r = play(playCard(s, freezer.uid).state, { type: "CHOOSE_LIFE", player: "P2", indices: [0] });
    expect(JSON.stringify(r.events.filter((e) => e.type === "LIFE_TO_HAND"))).not.toMatch(/BT|P-|SD|EB/);
  });
});

it("la base de cartes de test ne casse pas le deck Freezer", () => {
  expect(db.get("BT24-105")).toBeDefined();
});
