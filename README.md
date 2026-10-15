# Simulateur Dragon Ball Super Card Game Masters

## Organisation

| Dossier | Rôle |
|---|---|
| `src/engine/` | Le moteur de règles : uniquement de la logique, aucune interface |
| `src/ui/` | L'interface de test dans le navigateur (deux joueurs sur le même écran) |
| `cards/` | Les cartes et les decks, en JSON |

## Jouer une partie de test

1. Dans un terminal ouvert dans ce dossier : `npm.cmd run dev`
2. Ouvrir l'adresse affichée (http://localhost:5173) dans le navigateur.
3. Pour arrêter le site : `Ctrl + C` dans le terminal.

Si vous trouvez un bug, notez la « graine » affichée en haut et ce que vous avez fait juste avant.
| `tests/` | Les tests automatiques |

Les règles suivent le manuel officiel ; chaque règle codée cite son numéro (ex. `// 8-4-6`).

## Commandes (à taper dans un terminal ouvert dans ce dossier)

Sous Windows PowerShell, si `npm` affiche « l'exécution de scripts est désactivée sur ce système »,
tape `npm.cmd` à la place de `npm` (ex. `npm.cmd test`). Le résultat est le même.

| Commande | Effet |
|---|---|
| `npm install` | Installe les outils (une seule fois, ou après une mise à jour de `package.json`) |
| `npm test` | Lance tous les tests automatiques |
| `npm run test:watch` | Relance les tests à chaque modification |
| `npm run dev` | Lance le site en local (adresse affichée dans le terminal) |
| `npm run typecheck` | Vérifie le code TypeScript sans le lancer |
