// Deck Gogeta GT (cards/gogeta.json) : nouvelles mécaniques, testées carte par carte.
import { describe, expect, it } from "vitest";
import gogetaFile from "../cards/gogeta.json";
import {
  applyAction,
  buildCardDatabase,
  createGame,
  getLegalActions,
  parseCardFile,
  type Action,
  type CardInstance,
  type GameContext,
  type GameEvent,
  type GameState,
  type PlayerId,
} from "../src/engine";
import { powerOf } from "../src/engine/rules/battle";
import { freezer } from "./helpers";

const gogeta = parseCardFile(gogetaFile);
const ctx: GameContext = { cards: buildCardDatabase([freezer.cards, gogeta.cards]) };

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

/** Partie Gogeta (P1) contre Gogeta (P2), au début de la phase principale du 2e tour de P1. */
function p1Main(): GameState {
  const created = createGame({ decks: { P1: gogeta.deck!, P2: gogeta.deck! }, seed: 7, counterPrompt: { P1: "only_if_playable", P2: "only_if_playable" } }, ctx.cards);
  if (!created.ok) throw new Error(created.errors.join());
  const s = created.state;
  return play(
    s,
    { type: "CHOOSE_FIRST_PLAYER", player: s.pending!.player, first: "P1" },
    { type: "MULLIGAN", player: "P1", redraw: false },
    { type: "MULLIGAN", player: "P2", redraw: false },
    { type: "CHARGE_ENERGY", player: "P1", uid: null },
    { type: "END_MAIN_PHASE", player: "P1" },
    { type: "CHARGE_ENERGY", player: "P2", uid: null },
    { type: "END_MAIN_PHASE", player: "P2" },
    { type: "CHARGE_ENERGY", player: "P1", uid: null },
  ).state;
}

/** Déplace un exemplaire d'une carte (deck, Vie, main ou deck Z) vers une zone. */
function give(s: GameState, player: PlayerId, cardId: string, zone: "hand" | "energy" | "battle" | "drop" | "unison", mode: "active" | "rest" = "active"): CardInstance {
  const p = s.players[player];
  for (const from of ["deck", "life", "hand", "zDeck", "drop"] as const) {
    if (from === zone) continue;
    const i = p[from].findIndex((c) => c.cardId === cardId);
    if (i < 0) continue;
    const card = p[from].splice(i, 1)[0]!;
    card.mode = mode;
    card.faceUp = zone !== "hand";
    p[zone].push(card);
    return card;
  }
  throw new Error(`plus de ${cardId} pour ${player}`);
}

/** Donne N Énergies vertes (Goku SS4 Devenir le Plus Fort, coût 5 vert). */
function energies(s: GameState, player: PlayerId, n: number): void {
  const p = s.players[player];
  for (let i = 0; i < n; i++) {
    const card = p.deck.find((c) => ctx.cards.get(c.cardId)?.colors.length === 1 && ctx.cards.get(c.cardId)?.colors[0] === "green")!;
    p.deck.splice(p.deck.indexOf(card), 1);
    card.faceUp = true;
    card.mode = "active";
    p.energy.push(card);
  }
}

const find = (s: GameState, pred: (a: Action) => boolean): Action => {
  const a = getLegalActions(s, s.pending!.player, ctx).find(pred);
  if (!a) throw new Error("coup non proposé");
  return a;
};
const pickFirst = (s: GameState) => {
  const p = s.pending as { type: string; player: PlayerId; options: string[]; min: number };
  return { type: "CHOOSE_CARDS" as const, player: p.player, uids: p.options.slice(0, Math.max(1, p.min)) };
};

describe("Fichier de cartes Gogeta", () => {
  it("se charge sans erreur, et le deck est valide (54 cartes + 10 Z)", () => {
    expect(gogeta.errors).toEqual([]);
    const main = Object.values(gogeta.deck!.main).reduce((a, b) => a + b, 0);
    const z = Object.values(gogeta.deck!.zDeck).reduce((a, b) => a + b, 0);
    expect([main, z]).toEqual([54, 10]);
  });
});

describe("Unisson du deck principal : Pan, Adorable Soutien", () => {
  it("13-2 : se joue pour X (au moins 2), arrive avec X marqueurs ; regarde 5 cartes", () => {
    const s = p1Main();
    energies(s, "P1", 4);
    const pan = give(s, "P1", "BT31-043", "hand");
    const xs = getLegalActions(s, "P1", ctx).flatMap((a) => (a.type === "PLAY_CARD" && a.uid === pan.uid ? [a.x] : []));
    expect(xs).toEqual([2, 3, 4]);
    const r = play(s, find(s, (a) => a.type === "PLAY_CARD" && a.uid === pan.uid && a.x === 3));
    expect(r.state.players.P1.unison).toMatchObject([{ uid: pan.uid, markers: 3 }]);
    expect(r.state.players.P1.energy.filter((e) => e.mode === "rest")).toHaveLength(3);
    expect(r.events).toContainEqual(expect.objectContaining({ type: "DECK_LOOKED", player: "P1", count: 5 }));
  });

  it("à 0 marqueur, elle va dans la Dispersion (ce n'est pas une carte Z)", () => {
    const s = p1Main();
    energies(s, "P1", 2);
    const pan = give(s, "P1", "BT31-043", "hand");
    let r = play(s, find(s, (a) => a.type === "PLAY_CARD" && a.uid === pan.uid && a.x === 2));
    while (r.state.pending?.type === "CHOOSE_CARDS") r = play(r.state, { type: "CHOOSE_CARDS", player: "P1", uids: [] });
    // [-X] avec X = 2 : tous ses marqueurs.
    give(r.state, "P2", "BT31-043", "unison").markers = 5;
    r = play(r.state, find(r.state, (a) => a.type === "ACTIVATE" && a.uid === pan.uid && a.x === 2));
    while (r.state.pending?.type === "CHOOSE_CARDS") r = play(r.state, pickFirst(r.state));
    expect(r.state.players.P1.unison).toHaveLength(0);
    expect(r.state.players.P1.drop.map((c) => c.uid)).toContain(pan.uid);
  });
});

describe("Union-Fusion : Gogeta SS4, la Lumière qui Protège l'Univers", () => {
  function setup() {
    const s = p1Main();
    energies(s, "P1", 4);
    const gog = give(s, "P1", "BT31-052", "hand");
    const goku = give(s, "P1", "BT31-044", "hand");
    const vegeta = give(s, "P1", "BT31-049", "hand");
    return { s, gog, goku, vegeta };
  }

  it("22-13-4 : Goku et Vegeta (même puissance) vont dans la Dispersion, on paie (vert)(vert)(1) et on pioche", () => {
    const { s, gog, goku, vegeta } = setup();
    const hand = s.players.P1.hand.length;
    const r = play(s, find(s, (a) => a.type === "UNION_FUSION" && a.uid === gog.uid && a.materials.includes(goku.uid) && a.materials.includes(vegeta.uid)));
    expect(r.state.players.P1.battle.map((c) => c.uid)).toContain(gog.uid);
    expect(r.state.players.P1.drop.map((c) => c.uid)).toEqual(expect.arrayContaining([goku.uid, vegeta.uid]));
    expect(r.state.players.P1.hand).toHaveLength(hand - 3 + 1);
    expect(r.state.players.P1.energy.filter((e) => e.mode === "rest")).toHaveLength(3);
    expect(r.events).toContainEqual(expect.objectContaining({ type: "UNION_ACTIVATED", cardId: "BT31-052" }));
  });

  it("impossible sans les deux personnages en main", () => {
    const { s, goku } = setup();
    s.players.P1.hand = s.players.P1.hand.filter((c) => c.uid !== goku.uid && ctx.cards.get(c.cardId)?.character[0] !== "Son Goku (GT)");
    expect(getLegalActions(s, "P1", ctx).some((a) => a.type === "UNION_FUSION")).toBe(false);
  });

  it("Leader de côté dos : « quand vous activez une Capacité Union, piochez une carte »", () => {
    const { s, gog } = setup();
    s.players.P1.leader.side = "back";
    const hand = s.players.P1.hand.length;
    const r = play(s, find(s, (a) => a.type === "UNION_FUSION" && a.uid === gog.uid));
    expect(r.state.players.P1.hand).toHaveLength(hand - 3 + 1 + 1);
  });

  it("Pan qui quitte la Zone Unisson réduit de (1) le prochain coût d'Union", () => {
    const { s, gog } = setup();
    s.nextDiscounts.push({ player: "P1", on: "union", filter: { zone: "hand", character: "Gogeta (GT)", colors_any: ["green"] }, colors: {}, generic: 1, untilTurn: s.turnNumber });
    const r = play(s, find(s, (a) => a.type === "UNION_FUSION" && a.uid === gog.uid));
    expect(r.state.players.P1.energy.filter((e) => e.mode === "rest")).toHaveLength(2);
    expect(r.state.nextDiscounts).toHaveLength(0);
  });
});

describe("Barrière (22-16)", () => {
  it("une carte adverse avec Barrière ne peut pas être choisie, sauf « en ignorant Barrière »", () => {
    const s = p1Main();
    energies(s, "P1", 8);
    const shield = give(s, "P2", "BT31-052", "battle"); // Barrière
    const plain = give(s, "P2", "BT31-046", "battle");
    // Vegeta SS4, Vaillant en Rouge : KO d'une carte de coût 5 ou moins (Barrière respectée).
    const vegeta = give(s, "P1", "BT31-050", "hand");
    let r = play(s, find(s, (a) => a.type === "PLAY_CARD" && a.uid === vegeta.uid));
    expect((r.state.pending as { options: string[] }).options).toEqual([plain.uid]);
    // Big Bang Kamehameha : toutes les cartes adverses, en ignorant Barrière.
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P1", uids: [] });
    const bb = give(r.state, "P1", "BT31-053", "hand");
    r = play(r.state, find(r.state, (a) => a.type === "ACTIVATE" && a.uid === bb.uid));
    expect(r.state.players.P2.battle.map((c) => c.uid)).not.toContain(shield.uid);
    expect(r.state.players.P1.drop.map((c) => c.uid)).toContain(bb.uid);
  });
});

describe("« Si cette carte a été jouée depuis une Dispersion » et « à la fin du tour »", () => {
  it("La Puissance du Guerrier Ultime joue un Goku depuis la Dispersion, qui redresse une carte verte", () => {
    const s = p1Main();
    s.players.P1.leader.side = "back"; // Gogeta (GT) vert
    energies(s, "P1", 3);
    const tired = give(s, "P1", "BT31-046", "battle", "rest");
    const goku = give(s, "P1", "BT31-044", "drop");
    const extra = give(s, "P1", "BT31-054", "hand");
    let r = play(s, find(s, (a) => a.type === "ACTIVATE" && a.uid === extra.uid));
    if (r.state.pending?.type === "CHOOSE_CARDS") r = play(r.state, { type: "CHOOSE_CARDS", player: "P1", uids: [goku.uid] });
    expect(r.state.players.P1.battle.map((c) => c.uid)).toContain(goku.uid);
    expect(r.state.playedFrom[goku.uid]).toBe("drop");
    // « choisissez jusqu'à une de vos cartes vertes et passez-la en mode Action ».
    if (r.state.pending?.type === "CHOOSE_CARDS") r = play(r.state, { type: "CHOOSE_CARDS", player: "P1", uids: [tired.uid] });
    expect(r.state.players.P1.battle.find((c) => c.uid === tired.uid)!.mode).toBe("active");
  });

  it("Devenir le Plus Fort : coût -4 avec Gogeta au dos, en Inertie, puis retour en main à la fin du tour", () => {
    const s = p1Main();
    s.players.P1.leader.side = "back";
    energies(s, "P1", 1);
    const goku = give(s, "P1", "BT31-046", "hand");
    let r = play(s, find(s, (a) => a.type === "PLAY_CARD" && a.uid === goku.uid));
    while (r.state.pending?.type === "CHOOSE_CARDS") r = play(r.state, { type: "CHOOSE_CARDS", player: "P1", uids: [] });
    expect(r.state.players.P1.battle.find((c) => c.uid === goku.uid)!.mode).toBe("rest");
    r = play(r.state, { type: "END_MAIN_PHASE", player: "P1" });
    expect(r.state.players.P1.hand.map((c) => c.uid)).toContain(goku.uid);
  });
});

describe("Leader et capacités diverses", () => {
  it("Auto. avec coût (« Défaussez une carte : ») : le joueur choisit de payer ou non", () => {
    const s = p1Main();
    s.players.P2.life.splice(0); // pas d'importance : on veut juste l'Auto.
    s.players.P2.life.push(...s.players.P2.deck.splice(0, 8));
    const r = play(s, find(s, (a) => a.type === "ATTACK" && a.attacker === "P1-L" && a.target === "P2-L"));
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_OPTION", player: "P1", options: [{ id: "yes" }, { id: "no" }] });
  });

  it("Polunga ne peut pas attaquer ; « Choisissez l'un » propose ses trois options", () => {
    const s = p1Main();
    const polunga = give(s, "P1", "BT24-140", "battle");
    expect(getLegalActions(s, "P1", ctx).some((a) => a.type === "ATTACK" && a.attacker === polunga.uid)).toBe(false);
    const r = play(s, find(s, (a) => a.type === "ACTIVATE" && a.uid === polunga.uid && a.index === 2));
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_OPTION" });
    expect((r.state.pending as { options: unknown[] }).options).toHaveLength(3);
  });

  it("Gogeta SS4, Guerrier ultime [-5] : inflige 1 dégât à l'adversaire, qui choisit sa carte de Vie", () => {
    const s = p1Main();
    const u = give(s, "P1", "BT31-145", "unison");
    u.markers = 5;
    const life = s.players.P2.life.length;
    let r = play(s, find(s, (a) => a.type === "ACTIVATE" && a.uid === u.uid && a.index === 2));
    expect(r.state.pending).toMatchObject({ type: "TAKE_DAMAGE", player: "P2", amount: 1 });
    r = play(r.state, { type: "TAKE_LIFE", player: "P2", indices: [0] });
    expect(r.state.players.P2.life).toHaveLength(life - 1);
    expect(r.state.players.P1.unison).toHaveLength(0); // 0 marqueur : elle quitte la Zone Unisson
    expect(r.state.pending).toEqual({ type: "MAIN", player: "P1" });
  });

  it("Piccolo [Lien 3] : +10000 avec trois cartes de Combat ou plus", () => {
    const s = p1Main();
    const piccolo = give(s, "P1", "BT27-048", "battle");
    expect(powerOf(s, { player: "P1", uid: piccolo.uid }, ctx)).toBe(10000);
    give(s, "P1", "BT31-046", "battle");
    give(s, "P1", "BT31-051", "battle");
    expect(powerOf(s, { player: "P1", uid: piccolo.uid }, ctx)).toBe(20000);
  });

  it("Broly SS3 : coût alternatif — une carte verte non Unique de la Zone de Combat + (vert) + 1 Énergie Z", () => {
    const s = p1Main();
    energies(s, "P1", 1);
    const z = s.players.P1.deck.splice(0, 1)[0]!;
    s.players.P1.zEnergy.push(z);
    const fodder = give(s, "P1", "BT31-046", "battle");
    const broly = s.players.P1.zDeck.find((c) => c.cardId === "BT22-058")!;
    const r = play(s, find(s, (a) => a.type === "PLAY_Z" && a.uid === broly.uid && a.sacrifice === fodder.uid));
    expect(r.state.players.P1.battle.map((c) => c.uid)).toContain(broly.uid);
    expect(r.state.players.P1.drop.map((c) => c.uid)).toEqual(expect.arrayContaining([fodder.uid, z.uid]));
  });

  it("[Limite 1] sur un Contre : un seul « La Puissance du Guerrier Ultime » par tour", () => {
    const s = p1Main();
    const a = give(s, "P2", "BT31-054", "hand");
    const b = give(s, "P2", "BT31-054", "hand");
    energies(s, "P2", 2);
    let r = play(s, find(s, (x) => x.type === "ATTACK" && x.attacker === "P1-L" && x.target === "P2-L"));
    if (r.state.pending?.type === "CHOOSE_OPTION") r = play(r.state, { type: "CHOOSE_OPTION", player: "P1", id: "no" });
    r = play(r.state, find(r.state, (x) => x.type === "DECLARE_COUNTER" && x.uid === a.uid));
    while (r.state.pending?.type === "COUNTER_WINDOW") r = play(r.state, { type: "PASS_COUNTER", player: r.state.pending.player });
    // Le Leader de P1 est en Inertie : on lui donne une autre attaque en le redressant.
    r.state.players.P1.leader.mode = "active";
    while (r.state.pending?.type !== "MAIN") r = play(r.state, getLegalActions(r.state, r.state.pending!.player, ctx).find((x) => x.type !== "CONCEDE")!);
    r = play(r.state, find(r.state, (x) => x.type === "ATTACK" && x.attacker === "P1-L" && x.target === "P2-L"));
    if (r.state.pending?.type === "CHOOSE_OPTION") r = play(r.state, { type: "CHOOSE_OPTION", player: "P1", id: "no" });
    const counters = getLegalActions(r.state, "P2", ctx).filter((x) => x.type === "DECLARE_COUNTER" && x.uid === b.uid);
    expect(counters).toHaveLength(0);
  });
});

describe("Audit : parties au hasard avec le deck Gogeta", () => {
  it("aucun effet « non géré », aucun coup refusé (60 parties, Gogeta contre Gogeta et contre Freezer)", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      const decks = seed % 2 ? { P1: gogeta.deck!, P2: gogeta.deck! } : { P1: gogeta.deck!, P2: freezer.deck! };
      const created = createGame({ decks, seed, counterPrompt: { P1: "only_if_playable", P2: "only_if_playable" } }, ctx.cards);
      if (!created.ok) throw new Error(created.errors.join());
      let s = created.state;
      let x = seed;
      const pick = (n: number) => ((x = (x * 1103515245 + 12345) % 2147483648), x % n);
      for (let move = 0; move < 900 && !s.result; move++) {
        let legal = getLegalActions(s, s.pending!.player, ctx).filter((a) => a.type !== "CONCEDE");
        const rich = legal.filter((a) => !["END_MAIN_PHASE", "END_STEP", "PASS_COUNTER"].includes(a.type));
        if (rich.length > 0 && pick(4) > 0) legal = rich;
        const action = legal[pick(legal.length)]!;
        const r = applyAction(s, action, ctx);
        if (!r.ok) throw new Error(`seed ${seed}, coup ${move} : ${JSON.stringify(action)} → ${r.error}`);
        for (const e of r.events) if (e.type === "NOT_IMPLEMENTED") seen.add(`${e.cardId} : ${e.what}`);
        s = r.state;
      }
    }
    expect([...seen]).toEqual([]);
  });
});
