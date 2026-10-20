// Petits outils d'affichage partagés par la partie et les menus.

import type { CardDefinition, CardFace, CardView, VisibleCard } from "../engine";
import { COLOR_NAMES } from "./labels";

export const esc = (text: string): string =>
  text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export const isVisible = (c: CardView): c is VisibleCard => "uid" in c;

export const KEYWORD_NAMES: Record<string, string> = {
  blocker: "Bloqueur",
  critical: "Coup Critique",
  double_strike: "Double Frappe",
  triple_strike: "Triple Frappe",
  quadruple_strike: "Quadruple Frappe",
  dual_attack: "Réplique",
  tri_attack: "Tri-offensive",
  energy_exhaust: "Fuite d'énergie",
  unique: "Unique",
  ultimate: "Ultimate",
  super_combo: "Super Combo",
  deflect: "Déflexion",
  successor: "Successeur",
  over_realm: "Espace-temps",
  union_absorb: "Union-Absorption",
  barrier: "Barrière",
};

export const TYPE_NAMES: Record<string, string> = {
  leader: "Leader",
  battle: "Combat",
  extra: "Extra",
  unison: "Unisson",
  z_leader: "Leader Z",
  z_battle: "Combat Z",
  z_extra: "Extra Z",
  z_unison: "Unisson Z",
};

export const colorDots = (colors: readonly string[]): string =>
  colors.map((c) => `<span class="dot dot-${c}" title="${COLOR_NAMES[c] ?? c}"></span>`).join("");

export function costText(def: CardDefinition): string {
  if (!def.cost) return "";
  const orbs = Object.entries(def.cost.specified)
    .map(([c, n]) => `${n} ${COLOR_NAMES[c] ?? c}`)
    .join(" + ");
  return `Coût ${def.cost.total}${orbs ? ` (${orbs})` : ""}`;
}

/** Nom lisible d'un mot-clé (avec sa valeur, ex. « Espace-temps 3 »). */
export const keywordLabel = (k: { id: string; value?: number }): string =>
  `${KEYWORD_NAMES[k.id] ?? k.id}${k.value !== undefined ? ` ${k.value}` : ""}`;

/** Fiche complète d'une carte (toutes ses faces pour un Leader), en HTML. */
export function cardSheet(def: CardDefinition): string {
  const face = (f: CardFace, title?: string) => {
    const texts = f.abilities.map((a) => String(a["text"] ?? "")).filter(Boolean);
    const keywords = f.keywords.map(keywordLabel);
    return `${title ? `<div class="sheet-face">${esc(title)}</div>` : ""}
      <div class="card-name">${colorDots(f.colors)} ${esc(f.name)}</div>
      <div class="card-line">${[
        f.power !== undefined ? `<b>${f.power}</b> de puissance` : "",
        f.character.length ? `&lt;${esc(f.character.join(", "))}&gt;` : "",
        f.traits.length ? `«${esc(f.traits.join(" / "))}»` : "",
        f.era ? esc(f.era) : "",
      ]
        .filter(Boolean)
        .join(" · ")}</div>
      ${keywords.length ? `<div class="card-line kw">${esc(keywords.join(", "))}</div>` : ""}
      ${texts.map((x) => `<div class="ability">${esc(x)}</div>`).join("")}`;
  };
  const head = `<div class="card-line"><span class="type-tag">${esc(TYPE_NAMES[def.type] ?? def.type)}</span> ${esc(def.id)}${
    def.cost ? ` · ${esc(costText(def))}` : ""
  }${def.zCost !== undefined ? ` · Coût Z ${def.zCost}` : ""}${def.combo ? ` · Combo +${def.combo.power} (coût ${def.combo.cost})` : ""}</div>`;
  if (def.type === "leader" && def.front && def.back) {
    return `${head}${face(def.front, "Recto")}${face(def.back, "Verso (éveillé)")}`;
  }
  return `${head}${face(def)}`;
}
