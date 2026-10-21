// Sons et animations de la partie, déclenchés par les événements du moteur.
//
// Les sons viennent de audio.ts (synthétisés, sans fichier). Les animations sont des classes CSS
// posées sur les cartes juste après l'affichage (la page est redessinée à chaque coup).
//
// Aucune règle du jeu ici : uniquement de l'affichage.

import type { GameEvent, PlayerId } from "../engine";
import { playSound, type SoundName } from "./audio";

export interface FxSettings {
  animations: boolean;
}

let settings: FxSettings = { animations: true };
export const setFxSettings = (s: FxSettings): void => {
  settings = s;
};

// ---------------------------------------------------------------------------
// Animations et sons d'un lot d'événements
// ---------------------------------------------------------------------------

/** Position des cartes AVANT le nouvel affichage (pour animer celles qui disparaissent). */
export function snapshotRects(): Map<string, DOMRect> {
  const rects = new Map<string, DOMRect>();
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(".board [data-card]"))) {
    const uid = el.dataset["card"];
    if (uid && !rects.has(uid)) rects.set(uid, el.getBoundingClientRect());
  }
  return rects;
}

const cardEl = (uid: string): HTMLElement | null => document.querySelector<HTMLElement>(`.board [data-card="${CSS.escape(uid)}"]`);

function addClass(el: Element | null, cls: string, ms = 900): void {
  if (!el) return;
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth; // relance l'animation
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

/** Élément flottant (texte, fantôme de carte...) au-dessus de la page, retiré après l'animation. */
function floating(html: string, cls: string, rect: DOMRect | { left: number; top: number; width: number; height: number }, ms = 1100): void {
  const el = document.createElement("div");
  el.className = `fx-float ${cls}`;
  el.innerHTML = html;
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.top}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

/** Flèche d'attaque entre deux cartes. */
function arrow(from: string, to: string): void {
  const a = cardEl(from)?.getBoundingClientRect();
  const b = cardEl(to)?.getBoundingClientRect();
  if (!a || !b) return;
  const x1 = a.left + a.width / 2;
  const y1 = a.top + a.height / 2;
  const x2 = b.left + b.width / 2;
  const y2 = b.top + b.height / 2;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "fx-arrow");
  svg.setAttribute("width", String(window.innerWidth));
  svg.setAttribute("height", String(window.innerHeight));
  svg.innerHTML = `<defs><marker id="fx-head" markerWidth="10" markerHeight="10" refX="6" refY="5" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#e5484d"/></marker></defs>
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#e5484d" stroke-width="5" stroke-linecap="round" marker-end="url(#fx-head)"/>`;
  document.body.append(svg);
  setTimeout(() => svg.remove(), 1300);
}

/** Bandeau au centre de l'écran (début de tour, fin de partie). */
function banner(text: string, cls = ""): void {
  const el = document.createElement("div");
  el.className = `fx-banner ${cls}`;
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 1600);
}

/**
 * Joue les sons et animations d'un lot d'événements, juste après l'affichage.
 * `me` : joueur de cet écran (pour savoir si les dégâts / la victoire sont les siens).
 */
export function runEffects(events: GameEvent[], before: Map<string, DOMRect>, names: (p: PlayerId) => string, me: PlayerId | null): void {
  if (events.length === 0) return;
  const anim = settings.animations && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sounds = new Set<SoundName>();
  for (const e of events) {
    switch (e.type) {
      case "CARD_PLAYED":
      case "CARD_PLAYED_BY_SKILL":
      case "TOKEN_CREATED":
      case "UNISON_PLAYED":
      case "EXTRA_Z_PLACED":
        sounds.add("play");
        if (anim) addClass(cardEl(e.uid), "fx-enter", 700);
        break;
      case "ENERGY_CHARGED":
        sounds.add("charge");
        if (anim) addClass(cardEl(e.uid), "fx-enter", 700);
        break;
      case "CARDS_DRAWN":
        sounds.add("draw");
        break;
      case "ATTACK_DECLARED":
        sounds.add("attack");
        if (anim) {
          arrow(e.attacker, e.target);
          addClass(cardEl(e.attacker), "fx-lunge", 600);
          addClass(cardEl(e.target), "fx-targeted", 1200);
        }
        break;
      case "BLOCKER_DECLARED":
        sounds.add("counter");
        if (anim) addClass(cardEl(e.uid), "fx-glow", 900);
        break;
      case "DAMAGE_DEALT":
        sounds.add("hit");
        if (anim) {
          const leader = cardEl(`${e.player}-L`);
          addClass(leader, "fx-shake", 600);
          addClass(leader?.closest(".player") ?? null, "fx-damage", 700);
          const r = leader?.getBoundingClientRect();
          if (r) floating(`-${e.amount}`, "fx-number fx-red", r);
        }
        break;
      case "CARD_KO":
      case "CARD_REMOVED": {
        sounds.add("ko");
        const r = before.get(e.uid);
        if (anim && r) floating("KO", "fx-ghost", r, 900);
        break;
      }
      case "COUNTER_DECLARED":
        sounds.add("counter");
        if (anim) banner(`Contre ! (${names(e.player)})`, "fx-counter");
        break;
      case "ATTACK_NEGATED":
        if (anim) banner("Attaque annulée", "fx-counter");
        break;
      case "COMBO":
        sounds.add("combo");
        if (anim) addClass(cardEl(e.uid), "fx-glow", 900);
        break;
      case "POWER_MODIFIED": {
        sounds.add("power");
        const r = cardEl(e.uid)?.getBoundingClientRect();
        if (anim && r) floating(`${e.amount > 0 ? "+" : ""}${e.amount / 1000}k`, `fx-number ${e.amount > 0 ? "fx-green" : "fx-red"}`, r);
        break;
      }
      case "CARDS_MODE_CHANGED":
        if (anim) for (const uid of e.uids) addClass(cardEl(uid), e.mode === "rest" ? "fx-to-rest" : "fx-to-active", 500);
        break;
      case "LEADER_FLIPPED":
      case "LEADER_Z":
        sounds.add("awaken");
        if (anim) {
          addClass(cardEl(`${e.player}-L`), "fx-flip", 900);
          banner(e.type === "LEADER_Z" ? "Éveil Z !" : "Éveil !", "fx-awaken");
        }
        break;
      case "UNION_ACTIVATED":
        sounds.add("awaken");
        if (anim) banner("Union-Fusion !", "fx-awaken");
        break;
      case "TURN_STARTED":
        sounds.add("turn");
        if (anim) banner(`Tour ${e.turnNumber} — ${names(e.player)}`);
        break;
      case "GAME_OVER": {
        const won = e.result.kind === "win" && (me === null || e.result.winner === me);
        sounds.add(won ? "win" : "lose");
        if (anim) banner(e.result.kind === "win" ? `Victoire de ${names(e.result.winner)} !` : "Match nul", "fx-end");
        break;
      }
    }
  }
  // Un même son n'est joué qu'une fois par coup (ex. plusieurs cartes piochées).
  let delay = 0;
  for (const s of sounds) {
    setTimeout(() => playSound(s), delay);
    delay += 70;
  }
}
