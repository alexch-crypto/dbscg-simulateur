# Données des cartes — deck Freezer (DBS Masters)

Ce dossier contient `cartes-freezer.json` : les 31 cartes différentes du deck (Leader, Main Deck, Side Deck, Deck Z), avec leurs statistiques, leur texte français et leurs effets **déjà découpés en instructions** pour le moteur.

Le manuel de règles officiel (v4.00 EN / v3.02 FR) fait foi. Les numéros de règles cités ci-dessous viennent de ce manuel.

## Message pour Claude Code

Ce fichier est la cible finale du moteur. Ne l'implémente pas d'un coup :

1. **Étape actuelle (règles de base)** : utilise seulement `power`, `cost`, `combo`, `colors`, `type`. Ignore `abilities` et tous les mots-clés sauf `blocker`.
2. **Étape mots-clés** : implémente les mots-clés de la liste ci-dessous, dans l'ordre.
3. **Étape effets** : implémente le vocabulaire d'actions (`do`) un par un, en commençant par les plus fréquents : `draw`, `ko`, `set_rest`, `set_active`, `power_mod`, `life_to_hand`, `play_self`, `opponent_discards`, `negate_attack`, `negate_skills`.
4. **Étape Deck Z** : Énergie Z, Leader Z (Éveil Z), Unissons Z (marqueurs), cartes de Combat Z, Extra Z.

Le format est une proposition : tu peux l'adapter au moteur, mais garde le champ `text` (texte officiel) sur chaque capacité, il sert de référence et d'affichage.

Les champs commençant par `?` et les listes `a_verifier` sont des points que le joueur doit confirmer.

## Structure d'une carte

| Champ | Sens |
|---|---|
| `id` | Numéro de carte (ex. `BT24-056`) |
| `type` | `leader`, `battle`, `extra`, `z_leader`, `z_battle`, `z_extra`, `z_unison` |
| `deck_zone` | absent = deck principal, sinon `side` ou `z_deck` |
| `colors` | `green`, `yellow`, `red`, `blue`, `black`, `white` |
| `cost.total` / `cost.specified` | Coût total et orbes de couleur obligatoires (règles 1-2, 5-3). `X` = coût choisi (Unissons) |
| `z_cost` | Coût d'Énergie Z (règle 1-4) |
| `power`, `combo.cost`, `combo.power` | Puissance, coût et puissance de Combo |
| `character`, `traits`, `era` | Nom de personnage `<…>`, Origines `«…»`, Ère |
| `front` / `back` | Pour le Leader : les deux faces |
| `keywords` | Mots-clés sans texte propre |
| `abilities` | Liste des capacités (voir ci-dessous) |
| `same_as` | Capacité identique à celle d'une autre carte (`ability_index` = position, `face` pour le Leader) |

## Structure d'une capacité

| Champ | Sens |
|---|---|
| `kind` | `activate`, `auto`, `permanent`, `counter`, `awaken`, `z_awaken`, `successor`, `union_absorb` |
| `timing` | Pour `activate` : `main`, `battle`, `main_battle` (règle 1-5-4) |
| `counter_on` | Pour `counter` : `play`, `attack` (règle 22-10-3) |
| `trigger` | Pour `auto` : l'événement déclencheur |
| `condition` | Liste de vérifications, toutes requises |
| `cost` | Coût de Capacité, payé avant la résolution (règle 1-6, 5-8) |
| `marker_cost` | Coût en marqueurs `[+X]` / `[-X]` des Unissons (règle 13-4) |
| `limits` | `once_per_turn` (règle 22-11) ou `limit: N` partagé entre exemplaires (règle 22-44) |
| `effect` | Liste d'actions, résolues dans l'ordre (règle 0-2-3) |
| `pays_energy_cost_of_card` | Un Contre qui joue la carte paie son coût d'énergie normal |
| `activates_from` | Zone d'activation hors Zone de Combat (`drop`, `combo`) |

### Cibles (`target`)

`{ "owner": "self" | "opponent" | "any", "zone": "battle" | "unison" | "leader" | "energy" | "combo" | "drop", "up_to": N | "count": N, "filter": {…}, "ignore_barrier": true }`

- `up_to` : 0 à N cibles au choix (règle 5-2-4). `count` : autant que possible jusqu'à N (5-2-3).
- `save_as` / `"chosen"` : réutiliser la carte choisie dans une action suivante.
- Sans `ignore_barrier`, une carte adverse avec Barrière ne peut pas être choisie (22-16).

### Durées

`turn`, `battle`, `until_end_of_opponent_turn`, `opponent_next_charge_phase`, `opponent_next_turn`, `your_next_turn`.

## Mots-clés (ordre d'implémentation conseillé)

| JSON | Français | Règle | Effet résumé |
|---|---|---|---|
| `blocker` | Bloqueur | 22-4 | Passer en Inertie pour devenir la carte de défense |
| `double_strike` / `quadruple_strike` | Double/Quadruple Frappe | 22-7 | 2 / 4 dégâts au lieu de 1 |
| `critical` | Coup Critique | 22-6 | Les cartes de vie perdues vont en Dispersion au lieu de la main |
| `dual_attack` | Réplique | 22-8 | Repasse en mode Action après sa 1re attaque du tour |
| `energy_exhaust` | Fuite d'énergie | 22-31 | Posée en Énergie en mode Inertie |
| `unique` | Unique | 22-39 | Un seul exemplaire de ce nom en Zone de Combat |
| `deflect` | Déflexion | 22-20 | Non affectée par les Contre : Mise en jeu adverses |
| `super_combo` | Super Combo | 22-17 | Max 4 cartes Super Combo dans le deck |
| `ultimate` | Ultimate | 22-14 | 1 seule carte Ultimate par deck ; retirée de la partie au lieu d'aller en Dispersion |
| `successor` | Successeur | 22-38 | Jouer depuis la main en sacrifiant des cartes de Combat vertes/jaunes/vert-jaune dont la somme des coûts = coût d'origine de la carte, + le coût de Capacité |
| `over_realm` | Espace-temps X | 22-15 | Si X cartes ou plus en Dispersion : tout transférer en Dimension parallèle et jouer la carte ; elle part en Dimension parallèle à la fin du tour |
| `union_absorb` | Union-Absorption | 22-13-6 | Inutile avec ce Leader |

Mots-clés de coût : **Boost d'Esprit X** (`spirit_boost`, 22-43) = retirer X marqueurs de votre Unison.

## Vocabulaire des actions (`do`)

| Action | Sens |
|---|---|
| `draw` | Piocher `count` cartes |
| `life_to_hand` | Prendre des cartes de vie en main (`count` ou `up_to`). Ce ne sont **pas** des dégâts (1-13-2) |
| `look_top_deck` | Regarder N cartes, en prendre selon `pick`, puis `shuffle_deck` |
| `ko` | Mettre KO (Combat → Dispersion) |
| `set_rest` / `set_active` | Passer en mode Inertie / Action |
| `lock_active` | La carte ne peut pas repasser en Action pendant la durée |
| `power_mod` / `set_power` | Modifier / fixer la puissance |
| `negate_skills` / `negate_keyword` / `negate_one_keyword` | Annuler des capacités |
| `negate_attack` | Annuler l'attaque (passe en fin de combat, 8-1-6-1) |
| `play_self` | Jouer cette carte (depuis `from`, éventuellement chez l'adversaire `to`, en `mode`) |
| `create_token` | Créer un jeton (règle 19) |
| `combo_from` | Utiliser une carte pour une Combo depuis une autre zone que la main/Combat, sans payer le coût de Combo (5-7-3-1) |
| `discard` | Défausser de sa propre main |
| `opponent_discards` | L'adversaire choisit et défausse |
| `discard_from_opponent_hand` | Vous choisissez à l'aveugle dans la main adverse |
| `move_to_drop` / `move_to_deck_top` / `move_from_hand` / `move_under` / `move_self` | Déplacements de zone |
| `remove_from_game` | Retirer de la partie |
| `remove_markers` | Retirer des marqueurs d'une Unisson (0 marqueur → Dispersion, 21-9) |
| `modify_energy_cost` / `modify_combo_cost` | Modifier un coût |
| `declare_number` | Coût : déclarer un nombre X |
| `pay_energy` / `pay_energy_one_of` | Coût : passer des Énergies en Inertie (`specified` = orbes, `generic` = sans couleur) |
| `z_energy_to_drop` | Coût : placer des Énergies Z en Dispersion |
| `limit_opponent_attacks` / `opponent_attack_tax` | Restreindre les attaques adverses du tour |
| `optional` | « Vous pouvez… Si vous faites ainsi… » (20-16) |
| `if`, `if_previous_succeeded`, `delayed`, `replacement` | Logique conditionnelle, effets retardés (1-7-2-1-1), effets de remplacement (9-10) |
| `counter_without_energy_cost` / `counter_alt_cost` | Activer un Contre sans payer / en payant autrement |
| `successor_may_use_opponent_cards` / `next_successor_discount` | Modificateurs propres au Successeur |
| `self_restriction` | Interdiction qui s'applique à vous (coût ou effet) |
| `grant_keywords` / `grant_trait` / `cannot_attack` / `set_revealed` | Divers |

## Points à faire confirmer par le joueur

Chaque carte concernée a sa liste `a_verifier`. Les principaux :

- Le nombre d'orbes vert/jaune des cartes multicolores (BT24-133, BT24-134, BT24-136, BT27-136, BT9-137).
- BT24-133 et BT27-136 : « piochez deux cartes » / « piochez une carte » dans la ligne Successeur est-il un coût ?
- Couleurs de BT25-141 (Oolong, Désir immédiat) et BT29-107 (Pan, en Soutien).
- Textes traduits depuis l'anglais : BT10-088, BT9-137, EB1-037.
