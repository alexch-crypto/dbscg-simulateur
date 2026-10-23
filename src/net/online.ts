// Logique du jeu en ligne, indépendante du réseau (testable sans connexion).
//
// Modèle « hôte arbitre » : l'hôte (P1) garde l'état complet et fait tourner le moteur.
// L'invité (P2) n'a jamais l'état complet : il reçoit seulement SA vue (getPlayerView) et la
// liste de SES coups autorisés. Il envoie ses coups à l'hôte, qui les vérifie avec le moteur.
// Plus tard, un serveur arbitre pourra remplacer l'hôte en réutilisant exactement cette logique.

import {
  applyAction,
  createGame,
  getLegalActions,
  getPlayerView,
  newRecord,
  type Action,
  type CounterPrompt,
  type DeckList,
  type GameContext,
  type GameEvent,
  type GameRecord,
  type GameState,
  type PlayerId,
  type PlayerView,
} from "../engine";

export const PROTOCOL_VERSION = 4;
export const HOST: PlayerId = "P1";
export const GUEST: PlayerId = "P2";

/** Messages de l'invité vers l'hôte. */
export type GuestMessage =
  | { t: "hello"; version: number; deck: DeckList; counterPrompt: CounterPrompt; name?: string; playmat?: string }
  | { t: "action"; action: Action };

/** Messages de l'hôte vers l'invité. */
export type HostMessage =
  | { t: "update"; you: PlayerId; view: PlayerView; actions: Action[]; events: GameEvent[]; names?: Record<PlayerId, string> }
  | { t: "error"; message: string }
  /** Tapis de jeu de l'hôte (image), envoyé une fois à la connexion. */
  | { t: "playmat"; data: string };

/** Ce dont l'interface a besoin pour afficher la partie d'un joueur. */
export interface Snapshot {
  view: PlayerView;
  actions: Action[];
}

/** Côté hôte : arbitre de la partie. */
export class OnlineHost {
  state: GameState | null = null;
  record: GameRecord | null = null;
  /** Pseudos des joueurs (vide = pas de pseudo). */
  names: Record<PlayerId, string> = { P1: "", P2: "" };
  /** Tapis de jeu (image « data: »), vide = tapis par défaut. L'interface vérifie l'image. */
  playmats: Record<PlayerId, string> = { P1: "", P2: "" };

  constructor(
    private readonly ctx: GameContext,
    private readonly hostDeck: DeckList,
    private readonly hostPrompt: CounterPrompt,
    /** Envoi d'un message à l'invité. */
    private readonly send: (msg: HostMessage) => void,
    /** Prévenir l'interface de l'hôte (nouveaux événements à afficher). */
    private readonly onChange: (events: GameEvent[]) => void,
    /** Graine du hasard (tirée au hasard par défaut ; fixée dans les tests). */
    private readonly seed: number = Math.floor(Math.random() * 2 ** 31),
  ) {}

  snapshot(player: PlayerId): Snapshot | null {
    if (!this.state) return null;
    return { view: getPlayerView(this.state, player, this.ctx), actions: getLegalActions(this.state, player, this.ctx) };
  }

  private sendUpdate(events: GameEvent[]): void {
    const snap = this.snapshot(GUEST);
    if (snap) this.send({ t: "update", you: GUEST, ...snap, events, names: { ...this.names } });
  }

  /** Un message de l'invité arrive. */
  receive(raw: unknown): void {
    const msg = raw as GuestMessage | null;
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "hello") {
      if (typeof msg.name === "string") this.names[GUEST] = msg.name.slice(0, 20);
      if (typeof msg.playmat === "string") this.playmats[GUEST] = msg.playmat;
      // Le tapis de l'hôte est envoyé à chaque (re)connexion de l'invité.
      if (this.playmats[HOST]) this.send({ t: "playmat", data: this.playmats[HOST] });
      if (msg.version !== PROTOCOL_VERSION) {
        this.send({ t: "error", message: "version du simulateur différente : rechargez la page des deux côtés" });
        return;
      }
      if (this.state) {
        // Reconnexion de l'invité : on lui renvoie simplement l'état actuel.
        this.sendUpdate([]);
        return;
      }
      const decks = { [HOST]: this.hostDeck, [GUEST]: msg.deck } as Record<PlayerId, DeckList>;
      const counterPrompt = { [HOST]: this.hostPrompt, [GUEST]: msg.counterPrompt } as Record<PlayerId, CounterPrompt>;
      const created = createGame({ decks, seed: this.seed, counterPrompt }, this.ctx.cards);
      if (!created.ok) {
        this.send({ t: "error", message: `deck invalide : ${created.errors.join(" ; ")}` });
        return;
      }
      this.state = created.state;
      this.record = newRecord(this.seed, decks, counterPrompt);
      this.sendUpdate(created.events);
      this.onChange(created.events);
      return;
    }
    if (msg.t === "action") {
      // L'invité ne peut jouer que pour lui-même.
      if (!msg.action || msg.action.player !== GUEST) {
        this.send({ t: "error", message: "coup refusé : vous ne pouvez jouer que vos propres coups" });
        return;
      }
      const error = this.apply(msg.action);
      if (error) this.send({ t: "error", message: `coup refusé : ${error}` });
    }
  }

  /** Coup joué par l'hôte lui-même. Renvoie un message d'erreur, ou null. */
  actLocal(action: Action): string | null {
    if (action.player !== HOST) return "vous ne pouvez jouer que vos propres coups";
    return this.apply(action);
  }

  private apply(action: Action): string | null {
    if (!this.state) return "la partie n'a pas commencé";
    const r = applyAction(this.state, action, this.ctx);
    if (!r.ok) return r.error;
    this.state = r.state;
    this.record!.actions.push(action);
    this.sendUpdate(r.events);
    this.onChange(r.events);
    return null;
  }
}

/** Côté invité : il n'a que sa vue et ses coups autorisés. */
export class OnlineGuest {
  snapshot: Snapshot | null = null;
  you: PlayerId = GUEST;
  lastError = "";
  names: Record<PlayerId, string> = { P1: "", P2: "" };
  playmats: Record<PlayerId, string> = { P1: "", P2: "" };

  constructor(
    private readonly send: (msg: GuestMessage) => void,
    private readonly onChange: (events: GameEvent[]) => void,
  ) {}

  hello(deck: DeckList, counterPrompt: CounterPrompt, name = "", playmat = ""): void {
    this.playmats[GUEST] = playmat;
    this.send({ t: "hello", version: PROTOCOL_VERSION, deck, counterPrompt, ...(name ? { name } : {}), ...(playmat ? { playmat } : {}) });
  }

  act(action: Action): void {
    this.lastError = "";
    this.send({ t: "action", action });
  }

  receive(raw: unknown): void {
    const msg = raw as HostMessage | null;
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "update") {
      this.you = msg.you;
      this.snapshot = { view: msg.view, actions: msg.actions };
      if (msg.names) this.names = { ...msg.names };
      this.lastError = "";
      this.onChange(msg.events);
    } else if (msg.t === "playmat") {
      if (typeof msg.data === "string") this.playmats[HOST] = msg.data;
      this.onChange([]);
    } else if (msg.t === "error") {
      this.lastError = msg.message;
      this.onChange([]);
    }
  }
}
