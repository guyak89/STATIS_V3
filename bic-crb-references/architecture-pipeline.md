# Architecture du pipeline BIC-CRB URCLEC-TG

Le pipeline compte **3 couches bien distinctes**. Toujours identifier la bonne couche avant de proposer une correction.

## Couche 1 — CBS (source)

Base opérationnelle de l'institution, alimentée par les guichets et les agents de crédit. Non modifiable dans le cadre d'une correction de remontée BCEAO sans validation métier.

**Tables principales URCLEC-TG** :

| Table CBS | Contenu |
|---|---|
| `ADHERENT` | Données socio-démographiques des membres |
| `INDIVIDU` | Identité détaillée, pièce, adresse |
| `PRETS` | Contrats de crédit actifs et clos |
| `DEMPRET` | Demandes de prêt |
| `TABAMOR` | Tables d'amortissement |

## Couche 2 — BtmExtract (intermédiaire)

Base de staging alimentée par des requêtes SQL d'extraction depuis le CBS. C'est ici que se font la majorité des mappings (lookups, normalisations de libellés, nettoyage de base).

**Schéma** : `[BtmExtract].[SUPERADMIN]`

**Tables principales** :

| Table BtmExtract | Rôle | Clé logique |
|---|---|---|
| `Individual` | 1 ligne par (ContractCode, CustumerCode) | ContractCode + CustumerCode |
| `ContractData` | 1 ligne par (ContractCode, ConsentCode) | ContractCode + ConsentCode |

**Requêtes d'alimentation typiques** :
- `Individual.txt` : lit ADHERENT + INDIVIDU + PRETS, mappe Gender/MaritalStatus, construit NUM_PIECE avec fallback.
- `NT1 CONSENTIS NOUVEAU 2026.txt` : lit PRETS + DEMPRET + TABAMOR, mappe PhaseOfContract/ContractStatus, calcule les montants.

**Correction à cette couche** : pertinente pour les erreurs VALID14 (lookups non mappés) ou VALID01 (champ non extrait depuis le CBS). Pas pour les erreurs de format.

## Couche 3 — BTM (transformation finale)

Requêtes SQL qui lisent `BtmExtract.*` et produisent les deux fichiers `.xlsx` transmis à la BCEAO :

| Requête | Sortie BCEAO |
|---|---|
| `requete_transformation_BTM.txt` (Individual) | Fichier individus |
| `transformation BTM CONTRATS.txt` (ContractData) | Fichier contrats |

**Correction à cette couche** : endroit naturel pour résoudre la plupart des rejets BCEAO (CUST089, CUST090, SBR26, SBR27, SBR133). Les règles sont déterministes et déclaratives, donc reproductibles chaque mois.

## Flux de données

```
CBS (ADHERENT, INDIVIDU, PRETS, …)
        │
        ▼  (extractions SQL — Couche 2)
BtmExtract.SUPERADMIN.Individual
BtmExtract.SUPERADMIN.ContractData
        │
        ▼  (transformations BTM — Couche 3)
Fichier XLSX Individual  ────┐
Fichier XLSX Contract    ────┼───►  Soumission BCEAO BIC-CRB
                              │
                              ▼
                    ERRORS_URCLEC-TG_YYYYMM_vN.xlsx
                    (retour de contrôle)
```

## Où corriger une erreur — arbre de décision

1. **L'erreur concerne un format, un pattern, une reformulation (tirets, majuscules, décimales)** → Couche 3 (BTM final).
2. **L'erreur concerne un lookup non reconnu (code pays, statut marital, type de contrat)** → Couche 2 (extraction) pour corriger le mapping.
3. **L'erreur concerne un champ obligatoire vide** → remonter à la Couche 1 pour complétude, avec fallback temporaire en Couche 2 ou 3 pour débloquer la soumission courante.
4. **L'erreur concerne une incohérence croisée (ex. ContractCode orphelin)** → investiguer l'ordre d'exécution des deux extractions (Individual avant ContractData) et les clauses de filtrage.

## Calendrier opérationnel

- **Fin de mois M** : snapshot à J-1 du mois M+1 (ex. pour mars 2026 → arrêté le 31/03/2026).
- **Début de mois M+1** : exécution des extractions CBS → BtmExtract.
- **Jour 2-3 M+1** : exécution des transformations BTM, génération des deux XLSX.
- **Jour 3-4 M+1** : première soumission BCEAO.
- **Jour 5-6 M+1** : réception du fichier ERRORS, correction, nouvelle soumission v2.

Entre la v1 et la v2, la fenêtre est courte : privilégier les corrections automatisées (modifications des requêtes BTM) pour tenir le délai et ne pas refaire le même travail le mois suivant.
