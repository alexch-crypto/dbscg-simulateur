import { describe, expect, it } from "vitest";
import {
  applyAction,
  buildCardDatabase,
  getLegalActions,
  getPlayerView,
  parseCardFile,
  type Action,
  type GameContext,
  type GameEvent,
  type GameState,
  type PlayerId,
} from "../src/engine";
import { hasKeyword } from "../src/engine/rules/keywords";
import { ctx, expectRefused, freezer, give, p2Main, play } from "./helpers";

// Tous ces tests se passent pendant le premier tour de P2.

const ENERGY_IDS = ["BT9-123", "BT9-123", "BT9-123", "BT9-123", "BT24-105", "BT24-106", "P-561", "BT27-080", "BT24-134", "BT24-136"];
function energies(s: GameState, player: PlayerId, n: number): void {
  for (let i = 0; i < n; i++) give(s, player, ENERGY_IDS[i]!, "energy");
}

function playCard(s: GameState, uid: string, c: GameContext = ctx): { state: GameState; events: GameEvent[] } {
  const action = getLegalActions(s, s.turnPlayer, c).find((a) => a.type === "PLAY_CARD" && a.uid === uid);
  if (!action) throw new Error(`impossible de jouer ${uid}`);
  const r = applyAction(s, action, c);
  if (!r.ok) throw new Error(r.error);
  return { state: r.state, events: r.events };
}

/** Coup ACTIVATE proposé par le moteur pour une carte (ou undefined). */
function activation(s: GameState, uid: string, player: PlayerId = "P2", c: GameContext = ctx) {
  return getLegalActions(s, player, c).find((a): a is Extract<Action, { type: "ACTIVATE" }> => a.type === "ACTIVATE" && a.uid === uid);
}

describe("[Activation : Principale] du Leader Freezer", () => {
  it("coût : une carte de Vie en main ; effet : regarder 5 cartes, prendre jusqu'à un <Freezer> vert ou jaune, mélanger", () => {
    const s = p2Main();
    const action = activation(s, "P2-L");
    expect(action).toBeDefined();
    let r = play(s, action!);
    expect(r.events).toContainEqual(expect.objectContaining({ type: "ABILITY_ACTIVATED", player: "P2", uid: "P2-L", index: 0 }));
    // 1) Coût : choisir une carte de Vie (à l'aveugle), obligatoire.
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_LIFE", player: "P2", min: 1, max: 1 });
    r = play(r.state, { type: "CHOOSE_LIFE", player: "P2", indices: [0] });
    expect(r.state.players.P2.life).toHaveLength(7);
    // 2) Effet : P2 voit les 5 cartes du dessus ; seules celles « <Freezer> vert ou jaune » sont choisissables.
    const pending = r.state.pending as Extract<GameState["pending"], { type: "CHOOSE_CARDS" }>;
    expect(pending.type).toBe("CHOOSE_CARDS");
    expect(pending.looked).toHaveLength(5);
    expect(pending.looked!.map((c) => c.uid)).toEqual(r.state.players.P2.deck.slice(0, 5).map((c) => c.uid));
    for (const uid of pending.options) {
      const card = pending.looked!.find((c) => c.uid === uid)!;
      expect(freezer.cards.find((d) => d.id === card.cardId)!.character).toContain("Freezer");
    }
    // L'adversaire ne voit ni les cartes regardées ni les options.
    const p1view = getPlayerView(r.state, "P1").pending as Record<string, unknown>;
    expect(p1view["looked"]).toBeUndefined();
    expect(p1view["options"]).toEqual([]);
    // 3) On prend la première option (si il y en a), puis le deck est mélangé.
    const take = pending.options.slice(0, 1);
    const before = r.state.players.P2.hand.length;
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: take });
    expect(r.state.players.P2.hand).toHaveLength(before + take.length);
    expect(r.events).toContainEqual({ type: "DECK_SHUFFLED", player: "P2" });
    expect(r.state.pending).toEqual({ type: "MAIN", player: "P2" });
    // [Une fois par tour] : plus proposée.
    expect(activation(r.state, "P2-L")).toBeUndefined();
  });

  it("la carte prise est révélée aux deux joueurs (« rajoutez à votre main ... » avec révélation)", () => {
    // On place un <Freezer> jaune sur le dessus du deck pour être sûr d'avoir une option.
    const s = p2Main();
    const deck = s.players.P2.deck;
    const i = deck.findIndex((c) => c.cardId === "BT24-105");
    deck.unshift(deck.splice(i, 1)[0]!);
    const target = deck[0]!.uid;
    let r = play(s, activation(s, "P2-L")!, { type: "CHOOSE_LIFE", player: "P2", indices: [0] });
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [target] });
    expect(r.events).toContainEqual({ type: "CARDS_TO_HAND", player: "P2", from: "deck", cardIds: ["BT24-105"] });
  });

  it("pas proposée pendant le tour adverse ni hors de la phase principale", () => {
    const s = p2Main();
    expect(activation(s, "P1-L", "P1")).toBeUndefined();
    const offense = play(s, { type: "ATTACK", player: "P2", attacker: "P2-L", target: "P1-L" }).state;
    expect(activation(offense, "P2-L")).toBeUndefined(); // [Activation : Principale] seulement
  });
});

describe("[Activation : Principale] « jouez cette carte depuis votre main »", () => {
  it("Freezer, Départ de l'Invasion (BT24-105) : (jaune) + Leader <Freezer> vert + Énergie verte et jaune => piochez puis jouez-la", () => {
    const s = p2Main();
    give(s, "P2", "P-223", "energy"); // verte
    const yellow = give(s, "P2", "BT24-106", "energy"); // jaune
    const freezerCard = give(s, "P2", "BT24-105", "hand");
    const action = activation(s, freezerCard.uid);
    expect(action).toMatchObject({ index: 1, payment: { energy: [yellow.uid], markers: 0 } });
    const handBefore = s.players.P2.hand.length;
    const r = play(s, action!);
    expect(r.events).toContainEqual(expect.objectContaining({ type: "CARD_PLAYED_BY_SKILL", uid: freezerCard.uid, from: "hand" }));
    expect(r.state.players.P2.battle.map((c) => c.uid)).toContain(freezerCard.uid);
    expect(r.state.players.P2.hand).toHaveLength(handBefore); // +1 pioche -1 carte jouée
    // « Quand cette carte est jouée » se déclenche aussi (5-5-3 / 9-6-9-4).
    expect(r.events).toContainEqual(expect.objectContaining({ type: "AUTO_TRIGGERED", uid: freezerCard.uid }));
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_LIFE" });
  });

  it("[Limite 1] partagée entre les exemplaires du même numéro", () => {
    const s = p2Main();
    give(s, "P2", "P-223", "energy");
    give(s, "P2", "BT24-106", "energy");
    give(s, "P2", "BT27-080", "energy");
    const a = give(s, "P2", "BT24-105", "hand");
    const b = give(s, "P2", "BT24-105", "hand");
    let r = play(s, activation(s, a.uid)!, { type: "CHOOSE_LIFE", player: "P2", indices: [] });
    expect(r.state.pending).toEqual({ type: "MAIN", player: "P2" });
    expect(activation(r.state, b.uid)).toBeUndefined();
  });

  it("condition non remplie (pas d'Énergie verte) : pas proposée", () => {
    const s = p2Main();
    give(s, "P2", "BT24-106", "energy"); // jaune seulement
    const freezerCard = give(s, "P2", "BT24-105", "hand");
    expect(activation(s, freezerCard.uid)).toBeUndefined();
    expectRefused(s, { type: "ACTIVATE", player: "P2", uid: freezerCard.uid, index: 1, payment: { energy: [], markers: 0 } }, "9-4");
  });

  it("Zarbon (P-223) depuis la Dispersion : (vert) + défausser une carte verte => jouez-le", () => {
    const s = p2Main();
    const zarbon = give(s, "P2", "P-223", "hand");
    s.players.P2.drop.push(s.players.P2.hand.splice(s.players.P2.hand.indexOf(zarbon), 1)[0]!);
    give(s, "P2", "P-561", "energy"); // verte
    const green = give(s, "P2", "BT10-075", "hand"); // carte verte à défausser
    const action = activation(s, zarbon.uid);
    expect(action).toBeDefined();
    let r = play(s, action!);
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P2", min: 1, max: 1 });
    expect((r.state.pending as { options: string[] }).options).toContain(green.uid);
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [green.uid] });
    expect(r.state.players.P2.drop.map((c) => c.uid)).toContain(green.uid);
    expect(r.state.players.P2.battle.map((c) => c.uid)).toContain(zarbon.uid);
    expect(r.events).toContainEqual(expect.objectContaining({ type: "CARD_PLAYED_BY_SKILL", from: "drop" }));
  });
});

describe("« ne peut pas passer en mode Action » (Autorité oppressive, BT24-106)", () => {
  it("la carte adverse en mode Inertie ne se relève pas pendant la Recharge suivante, puis se relève normalement", () => {
    let s = p2Main();
    energies(s, "P2", 3);
    const target = give(s, "P1", "BT24-105", "battle", "rest");
    const freezerCard = give(s, "P2", "BT24-106", "hand");
    let r = playCard(s, freezerCard.uid);
    r = play(r.state, { type: "CHOOSE_LIFE", player: "P2", indices: [] });
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", options: [target.uid] });
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [target.uid] });
    expect(r.events).toContainEqual({ type: "CARDS_LOCKED", uids: [target.uid] });
    // Tour de P1 : la carte reste en mode Inertie.
    s = play(r.state, { type: "END_MAIN_PHASE", player: "P2" }).state;
    expect(s.players.P1.battle.find((c) => c.uid === target.uid)!.mode).toBe("rest");
    // Tour de P2 puis tour suivant de P1 : elle se relève.
    s = play(s, { type: "CHARGE_ENERGY", player: "P1", uid: null }, { type: "END_MAIN_PHASE", player: "P1" }).state;
    s = play(s, { type: "CHARGE_ENERGY", player: "P2", uid: null }, { type: "END_MAIN_PHASE", player: "P2" }).state;
    expect(s.players.P1.battle.find((c) => c.uid === target.uid)!.mode).toBe("active");
  });
});

describe("Annuler des Capacités", () => {
  it("Phase de Transformation finale (BT24-134) : annule les Capacités d'une carte adverse — Zarbon perd [Bloqueur]", () => {
    const s = p2Main();
    energies(s, "P2", 10);
    const zarbon = give(s, "P1", "P-223", "battle");
    const freezerCard = give(s, "P2", "BT24-134", "hand");
    let r = playCard(s, freezerCard.uid);
    // pioche, (marqueurs d'Unisson : aucune), puis choisir la carte dont les Capacités sont annulées.
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", options: [zarbon.uid] });
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [zarbon.uid] });
    expect(r.events).toContainEqual({ type: "SKILLS_NEGATED", uids: [zarbon.uid] });
    expect(hasKeyword(r.state, { player: "P1", uid: zarbon.uid }, "blocker", ctx.cards)).toBe(false);
    // Le Leader attaque : Zarbon ne peut pas bloquer.
    const atk = play(r.state, { type: "ATTACK", player: "P2", attacker: "P2-L", target: "P1-L" });
    expect(atk.state.pending).toEqual({ type: "OFFENSE", player: "P2" });
    // Au tour suivant, l'annulation est terminée.
    const next = play(r.state, { type: "END_MAIN_PHASE", player: "P2" }).state;
    expect(hasKeyword(next, { player: "P1", uid: zarbon.uid }, "blocker", ctx.cards)).toBe(true);
  });

  it("une carte dont les Capacités sont annulées ne déclenche pas son [Auto.] quand elle est mise KO (9-6-9-2)", () => {
    const s = p2Main();
    const zarbon = give(s, "P1", "P-223", "battle", "rest");
    s.effects.push({ uid: zarbon.uid, kind: "negate_all", untilTurn: s.turnNumber });
    const r = play(s, { type: "ATTACK", player: "P2", attacker: "P2-L", target: zarbon.uid }, { type: "END_STEP", player: "P2" }, { type: "END_STEP", player: "P1" });
    expect(r.events.some((e) => e.type === "AUTO_TRIGGERED")).toBe(false);
  });

  it("Zarbon, Accompagnateur (BT27-080) : annule UNE Capacité-clef choisie d'une carte adverse", () => {
    const s = p2Main();
    energies(s, "P2", 6);
    const target = give(s, "P1", "BT24-134", "battle"); // Fuite d'énergie, Déflexion, Coup Critique, Réplique, Successeur
    const zarbon = give(s, "P2", "BT27-080", "hand");
    let r = playCard(s, zarbon.uid);
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [target.uid] });
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_OPTION", player: "P2" });
    r = play(r.state, { type: "CHOOSE_OPTION", player: "P2", id: "critical" });
    expect(r.events).toContainEqual({ type: "KEYWORD_NEGATED", uid: target.uid, keyword: "critical" });
    expect(hasKeyword(r.state, { player: "P1", uid: target.uid }, "critical", ctx.cards)).toBe(false);
    expect(hasKeyword(r.state, { player: "P1", uid: target.uid }, "dual_attack", ctx.cards)).toBe(true);
    // 2e partie : réduction du prochain Successeur d'un <Freezer> de la main.
    expect(r.events).toContainEqual({ type: "SUCCESSOR_DISCOUNT", player: "P2" });
    expect(r.state.successorDiscounts).toHaveLength(1);
  });
});

describe("Défausser", () => {
  it("Cell Xeno (5 Énergies ou plus) : défausse à l'aveugle jusqu'à 3 cartes adverses, acquiert Quadruple Frappe et Réplique", () => {
    const s = p2Main();
    energies(s, "P2", 10);
    for (const id of ["BT27-136", "BT24-133"]) give(s, "P2", id, "energy");
    const cell = give(s, "P2", "BT9-137", "hand");
    const opponentHand = s.players.P1.hand.length;
    let r = playCard(s, cell.uid);
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_BLIND", player: "P2", owner: "P1", min: 0, max: 3 });
    const discarded = [0, 2, 4].map((i) => r.state.players.P1.hand[i]!.cardId);
    r = play(r.state, { type: "CHOOSE_BLIND", player: "P2", indices: [4, 0, 2] });
    expect(r.state.players.P1.hand).toHaveLength(opponentHand - 3);
    expect(r.events).toContainEqual({ type: "CARDS_DISCARDED", player: "P1", cardIds: discarded });
    expect(hasKeyword(r.state, { player: "P2", uid: cell.uid }, "quadruple_strike", ctx.cards)).toBe(true);
    expect(hasKeyword(r.state, { player: "P2", uid: cell.uid }, "dual_attack", ctx.cards)).toBe(true);
  });

  it("à l'aveugle : le joueur qui choisit ne voit pas la main adverse dans sa vue", () => {
    const s = p2Main();
    energies(s, "P2", 10);
    for (const id of ["BT27-136", "BT24-133"]) give(s, "P2", id, "energy");
    const r = playCard(s, give(s, "P2", "BT9-137", "hand").uid);
    expect(getPlayerView(r.state, "P2").players.P1.hand.every((c) => "hidden" in c)).toBe(true);
  });
});

describe("« Vous pouvez... Si vous le faites... » (20-16)", () => {
  const testCards = parseCardFile({
    cards: [
      {
        id: "TEST-OPT",
        type: "battle",
        name: "Optionnel",
        colors: ["green"],
        cost: { total: 0, specified: {} },
        power: 5000,
        combo: { cost: 0, power: 5000 },
        abilities: [
          {
            kind: "auto",
            trigger: { event: "played", who: "this" },
            effect: [
              { do: "optional", cost: [{ do: "discard", count: 1, filter: { colors_any: ["green"] } }], then: [{ do: "draw", count: 2 }] },
            ],
            text: "Vous pouvez défausser une carte verte. Si vous le faites, piochez deux cartes.",
          },
        ],
      },
    ],
  });
  const testCtx: GameContext = { cards: buildCardDatabase([freezer.cards, testCards.cards]) };
  const withTestCard = () => {
    const s = p2Main();
    const card = { uid: "P2-OPT", cardId: "TEST-OPT", owner: "P2" as const, mode: "active" as const, faceUp: false };
    s.players.P2.hand.push(card);
    return s;
  };
  const act = (s: GameState, a: Action): { state: GameState; events: GameEvent[] } => {
    const r = applyAction(s, a, testCtx);
    if (!r.ok) throw new Error(r.error);
    return { state: r.state, events: r.events };
  };

  it("oui : on paie (défausser une carte verte), puis on pioche deux cartes", () => {
    const s = withTestCard();
    const green = give(s, "P2", "P-223", "hand");
    let r = playCard(s, "P2-OPT", testCtx);
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_OPTION", options: [{ id: "yes" }, { id: "no" }] });
    const handBefore = r.state.players.P2.hand.length;
    r = act(r.state, { type: "CHOOSE_OPTION", player: "P2", id: "yes" });
    r = act(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [green.uid] });
    expect(r.state.players.P2.hand).toHaveLength(handBefore - 1 + 2);
    expect(r.state.pending).toEqual({ type: "MAIN", player: "P2" });
  });

  it("non : rien ne se passe", () => {
    const s = withTestCard();
    give(s, "P2", "P-223", "hand");
    let r = playCard(s, "P2-OPT", testCtx);
    const handBefore = r.state.players.P2.hand.length;
    r = act(r.state, { type: "CHOOSE_OPTION", player: "P2", id: "no" });
    expect(r.state.players.P2.hand).toHaveLength(handBefore);
  });

  it("sans carte verte en main, la question n'est même pas posée", () => {
    const s = withTestCard();
    s.players.P2.drop.push(...s.players.P2.hand.filter((c) => c.uid !== "P2-OPT").splice(0));
    s.players.P2.hand = s.players.P2.hand.filter((c) => c.uid === "P2-OPT");
    const r = playCard(s, "P2-OPT", testCtx);
    expect(r.state.pending).toEqual({ type: "MAIN", player: "P2" });
  });
});

describe("Robustesse : parties au hasard avec toutes les nouvelles capacités", () => {
  it("tous les coups proposés sont acceptés et aucune carte ne disparaît (40 parties)", () => {
    const allCards = (s: GameState, p: PlayerId) => {
      const z = s.players[p];
      // Deck principal (53) + deck Z (9), où qu'elles soient (le Leader Z est posé sur le Leader).
      return [...z.deck, ...z.hand, ...z.life, ...z.energy, ...z.battle, ...z.combo, ...z.drop, ...z.zEnergy, ...z.warp, ...z.removed, ...z.zDeck, ...z.unison, ...(z.leader.z ? [z.leader.z] : [])];
    };
    for (let seed = 200; seed < 240; seed++) {
      let s = play(p2Main(seed), { type: "END_MAIN_PHASE", player: "P2" }).state;
      let x = seed;
      const pick = (n: number) => ((x = (x * 1103515245 + 12345) % 2147483648), x % n);
      for (let move = 0; move < 500 && !s.result; move++) {
        const legal = getLegalActions(s, s.pending!.player, ctx).filter((a) => a.type !== "CONCEDE");
        expect(legal.length, `aucun coup (${JSON.stringify(s.pending)})`).toBeGreaterThan(0);
        const action = legal[pick(legal.length)]!;
        const r = applyAction(s, action, ctx);
        if (!r.ok) throw new Error(`seed ${seed}, coup ${move} : ${JSON.stringify(action)} → ${r.error}`);
        s = r.state;
        for (const p of ["P1", "P2"] as const) expect(allCards(s, p)).toHaveLength(62);
      }
    }
  });
});
