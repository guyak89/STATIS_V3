# STATIS

Tableau de bord Next.js pour suivre en temps reel les indicateurs Perfect de la base SQL Server `BASE_INTERCO`.

## Prerequis

- Node.js 24+
- Acces SQL Server a la base `BASE_INTERCO`
- Parametres SQL renseignes via `.env.local` ou via l'ecran `Parametrage SQL`

## Demarrage

```bash
npm install
npm run dev
```

L'application est disponible sur `http://localhost:3000`.

## Configuration

Copier `.env.example` vers `.env.local`, puis renseigner au minimum le mot de passe SQL :

```bash
SQL_SERVER=localhost\SQL2022
SQL_DATABASE=BASE_INTERCO
SQL_USER=sa
SQL_PASSWORD=
SQL_ENCRYPT=false
SQL_TRUST_SERVER_CERTIFICATE=true
```

Les parametres saisis dans l'interface sont stockes localement dans `data/app-settings.sqlite`.
Ce fichier est ignore par Git pour ne pas publier les identifiants SQL.

## Indicateurs couverts

- Adhesions
- Encours credit
- Encours epargne
- PAR a 1J, 30J et 90J
- Resultat
- Collecte tontine
- Decaissements
- Impayes
- Credit en perte, transfert en perte et recouvrement
- Souscriptions tontine

## Verification

```bash
npm run lint
npm run build
```
