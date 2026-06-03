# Documentation — Skill `traitement-bic-crb`

> Skill Claude Cowork — Correction des erreurs BCEAO pour la remontée mensuelle BIC-CRB des SFD / IMF de la zone UEMOA.

---

## Table des matières

1. [Vue d'ensemble](#1-vue-densemble)
2. [Déclenchement du skill](#2-déclenchement-du-skill)
3. [Fichiers d'entrée](#3-fichiers-dentrée)
4. [Architecture du pipeline BIC-CRB](#4-architecture-du-pipeline-bic-crb)
5. [Workflow standard](#5-workflow-standard)
6. [Catalogue des codes d'erreur](#6-catalogue-des-codes-derreur)
7. [Règles de format BCEAO](#7-règles-de-format-bceao)
8. [Templates SQL](#8-templates-sql)
9. [Pièges fréquents](#9-pièges-fréquents)
10. [Calendrier opérationnel](#10-calendrier-opérationnel)
11. [Livrables produits](#11-livrables-produits)
12. [Évolution du skill](#12-évolution-du-skill)

---

## 1. Vue d'ensemble

Le skill `traitement-bic-crb` assiste les équipes IT et DAF des SFD et IMF de la zone **UEMOA** pour corriger les erreurs générées par la plateforme BCEAO lors de la remontée mensuelle au **BIC (Bureau d'Information sur le Crédit) / CRB (Centrale des Risques des Banques)**.

Il couvre l'ensemble de la chaîne de traitement : analyse du fichier de rejets BCEAO, localisation de la couche fautive dans le pipeline de transformation, réécriture des requêtes BTM en T-SQL, validation sur cas concrets, et production des livrables (fichiers `.sql` corrigés + rapport `.docx`).

**Périmètre géographique** : Bénin · Burkina Faso · Côte d'Ivoire · Guinée-Bissau · Mali · Niger · Sénégal · Togo (dont URCLEC-TG, mutuelles, coopératives).

---

## 2. Déclenchement du skill

Ce skill se déclenche automatiquement dès que l'une des mentions suivantes apparaît dans la conversation :

| Catégorie | Mots-clés |
|---|---|
| Organismes / dispositifs | `BCEAO`, `BIC`, `CRB`, `Centrale des Risques` |
| Fichiers | `ERRORS_`, `ERRORS_INSTITUTION_AAAAMM_vN.xlsx`, `rapport de rejets` |
| Requêtes | `BTM`, `BtmExtract`, `ContractData`, `Individual` |
| Champs BCEAO | `NUM_PIECE`, `NationalID`, `IDDocumentNumber`, `Passport` |
| Codes erreur | `CUST089`, `CUST090`, `SBR26`, `SBR27`, `SBR133`, `VALID01`, `VALID14` |
| Concepts métier | `taux d'intérêt BCEAO`, `taux d'usure`, `taux effectif de crédit`, `RealEndDate` |

---

## 3. Fichiers d'entrée

### 3.1 Les 7 fichiers idéaux

Pour un diagnostic complet, le skill s'appuie idéalement sur 7 fichiers :

| # | Fichier | Format | Rôle |
|---|---|---|---|
| 1 | **ContractData** | Excel / CSV | Résultat XLSX final côté contrats soumis à la BCEAO (couche 3) |
| 2 | **Individual** | Excel / CSV | Résultat XLSX final côté personnes soumis à la BCEAO (couche 3) |
| 3 | **ERRORS_BCEAO** | Excel | Fichier de retour BCEAO : liste des erreurs et codes (`ERRORS_INST_AAAAMM_vN.xlsx`) |
| 4 | **BTM_REQ_CONTRATS** | SQL / texte | Requête de transformation BTM pour les contrats |
| 5 | **BTM_REQ_INDIVIDU** | SQL / texte | Requête de transformation BTM pour les individus |
| 6 | **Résultat BTM_REQ_CONTRATS** | Excel / CSV | Sortie de la requête contrats avant transmission BCEAO |
| 7 | **Résultat BTM_REQ_INDIVIDU** | Excel / CSV | Sortie de la requête individus avant transmission BCEAO |

### 3.2 Politique en cas de fichiers manquants

**Le skill ne bloque pas.** Il démarre l'analyse avec ce qui est disponible et indique au début de la réponse ce qui manque et son impact sur la confiance du diagnostic :

> *« J'ai (ContractData, Individual, ERRORS_BCEAO, BTM_REQ_INDIVIDU). Il me manque BTM_REQ_CONTRATS et les résultats d'exécution (6)(7). Je vais quand même attaquer le diagnostic. Mes recommandations sur la partie contrats seront basées sur les patterns connus URCLEC-TG plutôt que sur la requête réelle — quand vous pourrez me la fournir, je l'adapterai précisément. »*

### 3.3 Mode dégradé par fichier absent

| Fichier manquant | Conséquence | Mode dégradé |
|---|---|---|
| (3) ERRORS_BCEAO | Impossible de savoir quoi corriger | Demander une capture d'écran ou la liste des codes en clair ; faire une revue préventive des requêtes BTM |
| (1) ou (2) | Pas de vue sur le rendu final | S'appuyer sur (6)(7) et la spec BCEAO pour reconstituer le diagnostic |
| (4) ou (5) | Pas de requête à corriger | Proposer un squelette générique depuis `templates/` à fusionner avec la requête réelle |
| (6) ou (7) | Impossible d'isoler couche extraction vs couche BTM | Formuler une hypothèse explicite ; recommander de fournir le fichier |
| (1)+(6) ou (2)+(7) | Aucune visibilité sur la donnée du domaine | Travailler uniquement sur (4)/(5) et la spec ; signaler que les corrections sont théoriques |

---

## 4. Architecture du pipeline BIC-CRB

Le pipeline comprend **3 couches distinctes**. Identifier la bonne couche est la première étape avant toute correction.

### Couche 1 — CBS (source)

Base opérationnelle de l'institution, alimentée par les guichets et agents de crédit. Non modifiable dans le cadre d'une correction de remontée sans validation métier.

**Tables principales (URCLEC-TG) :**

| Table | Contenu |
|---|---|
| `ADHERENT` | Données socio-démographiques des membres |
| `INDIVIDU` | Identité détaillée, pièce d'identité, adresse |
| `PRETS` | Contrats de crédit actifs et clos |
| `DEMPRET` | Demandes de prêt |
| `TABAMOR` | Tables d'amortissement |

### Couche 2 — BtmExtract (intermédiaire / staging)

Base de staging alimentée par des requêtes SQL d'extraction depuis le CBS. C'est ici que se font les mappings (lookups, normalisations de libellés, nettoyage de base).

**Schéma** : `[BtmExtract].[SUPERADMIN]`

| Table | Rôle | Clé logique |
|---|---|---|
| `Individual` | 1 ligne par (ContractCode, CustumerCode) | ContractCode + CustumerCode |
| `ContractData` | 1 ligne par (ContractCode, ConsentCode) | ContractCode + ConsentCode |

**Correction à cette couche** : pertinente pour les erreurs VALID14 (lookups non mappés) ou VALID01 (champ non extrait depuis le CBS).

### Couche 3 — BTM (transformation finale)

Requêtes SQL qui lisent `BtmExtract.*` et produisent les deux fichiers `.xlsx` transmis à la BCEAO.

| Requête | Sortie BCEAO |
|---|---|
| `requete_transformation_BTM.txt` (Individual) | Fichier individus |
| `transformation BTM CONTRATS.txt` (ContractData) | Fichier contrats |

**Correction à cette couche** : endroit naturel pour résoudre la plupart des rejets BCEAO (CUST089, CUST090, SBR26, SBR27, SBR133). Les règles sont déterministes et reproductibles chaque mois.

### Flux de données

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

### Arbre de décision — Où corriger ?

| Type d'erreur | Couche à corriger |
|---|---|
| Format, pattern, reformulation (tirets, majuscules, décimales) | **Couche 3** — BTM final |
| Lookup non reconnu (code pays, statut marital, type de contrat) | **Couche 2** — extraction, pour corriger le mapping |
| Champ obligatoire vide | **Couche 1** pour la complétude + fallback temporaire en couche 2 ou 3 |
| Incohérence croisée (ContractCode orphelin) | Vérifier l'ordre d'exécution des deux extractions (Individual avant ContractData) |

---

## 5. Workflow standard

Une fois les 7 fichiers disponibles, le workflow se déroule en 5 étapes :

### Étape 1 — Synthèse des erreurs

Depuis le fichier ERRORS (3), produire un tableau par code d'erreur : nombre, pourcentage, cause racine probable.

> ⚠️ Ne pas attaquer les rejets un par un avant cette vue d'ensemble — les erreurs BCEAO arrivent en grappes liées à un même défaut de transformation.

### Étape 2 — Localisation de la couche fautive

Pour chaque code dominant, croiser (3) avec (1)(2) et (6)(7) :

- Défaut déjà présent dans (6)(7) → corriger en couche BTM (4)(5)
- (6)(7) propres mais (1)(2) pollués → vérifier l'export et la mise en forme XLSX
- (6)(7) fautifs et donnée correcte dans CBS → corriger les requêtes BTM (4)(5)
- Donnée mauvaise dès l'extraction CBS → remonter en couche 2 ou 1

### Étape 3 — Réécriture des requêtes BTM

Appliquer les patterns des templates aux requêtes (4)(5) et produire des versions corrigées auto-documentées. **Privilégier les classifications via CTE (déterministes) plutôt que les UPDATE manuels (ponctuels, à refaire chaque mois).**

### Étape 4 — Vérification sur cas concrets

Prendre 2 ou 3 ContractCode représentatifs depuis (3), simuler l'application de la nouvelle requête sur la donnée d'entrée correspondante dans (6)(7), confirmer que le défaut disparaît.

### Étape 5 — Production des livrables

- Fichiers `.sql` corrigés (à déposer dans le dossier Documents)
- Rapport synthétique `.docx` : causes racines, corrections, cas testés, recommandations long terme

---

## 6. Catalogue des codes d'erreur

### CUST089 — Pattern NationalID invalide

**Signification** : la valeur dans `IdentificationNumbersNationalID` ne respecte pas le pattern attendu pour la nationalité déclarée.

**Pattern Togo** : `\d{4}-\d{3}-\d{4}` (11 chiffres structurés, ex : `0053-730-8061`)

**Causes racines fréquentes :**
- Numéro de permis ou matricule interne routé par erreur dans NationalID
- CNI avec 10 chiffres au lieu de 11 (numéro tronqué côté CBS)
- Reformattage SUBSTRING incorrect : positions `(1,4)(5,3)(7,4)` au lieu de `(1,4)(5,3)(8,4)` → overlap produisant `0103-008-8859`

**Remède** : classifier NUM_PIECE dans une CTE (CNI / Passport / IDDoc) et ne peupler NationalID que si la classification retourne CNI. Voir template `btm-individual-corrige.sql`.

---

### CUST090 — Pattern Passport invalide

**Signification** : la valeur dans `IdentificationNumbersPassportNumber` ne respecte pas le pattern passeport du pays émetteur.

**Pattern Togo (ancien modèle)** : `(EB|ES|ED|ER)\d{6}` (ex : `EB112866`)

**Causes racines :**
- Espaces internes (`EB 485842`)
- Lettres en minuscules (`eb485842`)
- Préfixe non reconnu (nouveaux modèles numérisés — à signaler à la BCEAO)

**Remède** : normaliser via `UPPER(REPLACE(np, ' ', ''))` avant contrôle, puis matcher strictement sur les 4 préfixes acceptés.

---

### SBR26 — RealEndDate obligatoire

**Signification** : pour un contrat à phase `Closed`, `RealEndDate` doit être renseignée.

**Cause racine** : contrat marqué clos côté CBS sans date de clôture effective.

**Remède** : dans la requête BTM ContractData, forcer une date cohérente (`startdate + contractlifetime`) pour les contrats clos sans `realenddate`, ou remonter en amont pour qu'un agent CBS complète la donnée.

---

### SBR27 — RealEndDate incohérente

**Signification** : la date est soit dans le futur (> snapshot), soit antérieure à la startdate, soit hors fenêtre autorisée.

**Remède URCLEC-TG** — UPDATE préventif ramenant les dates futures à la fin du mois précédent :

```sql
UPDATE [BtmExtract].[SUPERADMIN].ContractData
   SET RealEndDate = CAST(DATEADD(DAY, -1, DATEADD(MONTH, DATEDIFF(MONTH, 0, GETDATE()), 0)) AS DATE)
 WHERE RealEndDate <> 'NULL'
   AND RealEndDate > CAST(DATEADD(DAY, -1, DATEADD(MONTH, DATEDIFF(MONTH, 0, GETDATE()), 0)) AS DATE)
   AND RealEndDate < CAST(DATEADD(MONTH, DATEDIFF(MONTH, 5, GETDATE()), 5) AS DATE);
```

---

### VALID01 — Champ obligatoire manquant

**Signification** : un champ marqué mandatory dans la spec BCEAO 2.0 est vide ou NULL.

**Champs typiquement concernés** : `Gender`, `DateOfBirth`, `Nationality`, `placeofbirth`, `MobilePhone`, `ContractStatus`, `StartDate`

**Remède (URCLEC-TG)** :
- Supprimer les individus avec les 4 champs critiques à NULL
- Appliquer des fallbacks déterministes pour les champs non critiques :
  - `placeofbirth` → `'SOKODE'`
  - `MobilePhone` → `'+22825500068'`

---

### VALID14 — Valeur de lookup non reconnue

**Signification** : valeur transmise dans un champ `*lookup` qui n'appartient pas à la liste autorisée BCEAO.

**Exemples** : `Celibataire` au lieu de `Single`, `Togolais` au lieu de `TG`, champ vide au lieu de `Other`

**Remède** : mapper exhaustivement les valeurs CBS vers les lookups BCEAO dans la requête d'extraction intermédiaire (couche 2), pas dans le BTM final.

---

### SBR133 — Dépendances IDDocument manquantes

**Signification** : `IDDocumentNumber` renseigné sans ses 4 compagnons obligatoires.

**Dépendances requises** : `IssueDate`, `ExpirationDate`, `IssuerCountry`, `IssueAuthority`

**Remède** : dans la CTE de classification, dès qu'on route une valeur vers IDDocumentNumber (ou Passport ou NationalID), peupler systématiquement les 4 champs de dépendance :
- `IssueDate` → `C_StartDate`
- `ExpirationDate` → `COALESCE(C_RealEndDate, C_StartDate)`
- `IssuerCountry` → `'TG'`
- `IssueAuthority` → `'TG'`

---

### Codes à investiguer au cas par cas

| Code | Domaine | Règle Togo |
|---|---|---|
| `CUST01x` | MobilePhone / FixedLine | Pattern `+228\d{8}` |
| `CUST02x` | Codes ISO pays | `Nationality` attend `TG`, pas `Togolaise` |
| `SBR11x–13x` | Cohérence croisée contrats/individus | Vérifier l'ordre d'exécution et les clauses de filtrage |

---

## 7. Règles de format BCEAO

### Identifiants individuels

#### NationalID (Togo)

| Propriété | Valeur |
|---|---|
| Pattern | `\d{4}-\d{3}-\d{4}` |
| Longueur | 11 chiffres purs + 2 tirets |
| Exemple valide | `0053-730-8061` |
| Reformattage T-SQL | `SUBSTRING(np_clean,1,4) + '-' + SUBSTRING(np_clean,5,3) + '-' + SUBSTRING(np_clean,8,4)` |

Dépendances obligatoires : `NationalIDIssueDate`, `NationalIDExpirationDate`, `NationalIDIssuerCountrylookup = 'TG'`

#### Passport (Togo, ancien modèle)

| Propriété | Valeur |
|---|---|
| Pattern | `(EB\|ES\|ED\|ER)\d{6}` |
| Longueur totale | 8 caractères |
| Exemple valide | `EB112866` |
| Normalisation | `UPPER(REPLACE(np, ' ', ''))` avant contrôle |

#### IDDocumentNumber (tout le reste)

Usage : permis de conduire, carte consulaire, matricule interne, carte d'électeur, pièce étrangère.

**Fallback absolu** : si `NUM_PIECE` est vide/null → utiliser `CustomerCode` pour garantir un identifiant non vide.

Dépendances obligatoires (SBR133) : `IDDOCUMENTISSUEDATE`, `IDDOCUMENTEXPIRATIONDATE`, `iddocumentissuercountrylookup = 'TG'`, `IDDocumentIssueAuthority = 'TG'`

---

### Taux (contrats)

#### InterestRate

| Règle | Valeur |
|---|---|
| Format | `decimal(6,3)` — max 3 décimales |
| Unité | Pourcentage (12.5 = 12,5 %, pas 0.125) |
| Plafond SFD (URCLEC-TG) | 24 % |
| Plafond banques | 15 % |
| Plancher métier URCLEC-TG | Si taux < 1 → forcer à `2` |
| Non convertible | Forcer à `2` |

#### EffectiveCreditRate

Même format qu'`InterestRate`, avec la contrainte supplémentaire : `EffectiveCreditRate >= InterestRate`.

En pratique URCLEC-TG : initialisé à la même valeur qu'`InterestRate` (après protection).

---

### Dates

| Champ | Règle |
|---|---|
| Format général | `YYYY-MM-DD` (10 caractères) |
| `StartDate` | Obligatoire, ne peut pas être futur par rapport au snapshot |
| `RealEndDate` | Renseignée uniquement si `PhaseOfContract = 'Closed'`, doit être ≥ StartDate, ≤ snapshot du mois |
| `DateOfBirth` | Doit donner un âge entre 18 et 99 ans |

---

### Téléphones

| Champ | Pattern Togo | Fallback URCLEC-TG |
|---|---|---|
| `MobilePhone` | `+228\d{8}` | `+22825500068` |
| `FixedLine` | `+228\d{8}` | `+22825500068` |

---

### Montants

- Séparateur décimal : **point** (`.`), jamais la virgule
- `OutstandingAmount` et `PastDueAmount` : prendre `ABS()`
- Si `ContractStatus IN ('SettledOnTime', 'SettledInAdvance')` → tous les montants dus à `0`

---

### Lookups fréquents

| Champ | Valeurs BCEAO acceptées |
|---|---|
| `residencylookup` | `TG`, `BJ`, `BF`, `CI`, `GW`, `ML`, `NE`, `SN` |
| `maritalstatuslookup` | `Single`, `Married`, `Divorced`, `Widowed`, `Other` |
| `gender` | `Male`, `Female` |
| `phaseofcontractlookup` | `InProgress`, `Closed`, `Defaulted` |
| `typeofcontractlookup` | `Loan`, `Overdraft`, `Leasing`, `CreditCard`, … |
| `methodofpaymentlookup` | `CurrentAccount`, `Cash`, `Check` |
| `professionalcategorylookup` | `UnclassifiableWorkers`, `Employees`, `Executives`, … |

> Quand une valeur source n'a pas de correspondance évidente : utiliser `Other` (disponible sur la plupart des lookups).

---

## 8. Templates SQL

### `btm-individual-corrige.sql`

Squelette BTM Individual avec classification automatique de NUM_PIECE via CTE.

**Logique de classification :**

```
np_clean (nettoyé : ni espace, ni point, ni tiret)
    ├── LEN = 11 ET que des chiffres  →  CNI
    │       └─ NationalID = SUBSTRING(np,1,4)+'-'+SUBSTRING(np,5,3)+'-'+SUBSTRING(np,8,4)
    │
    ├── LEN = 8 ET préfixe IN (EB,ES,ED,ER) ET 6 chiffres  →  PASSPORT
    │       └─ PassportNumber = UPPER(np_clean)
    │
    ├── np_clean vide / NULL / 'NULL'  →  IDDOC_FALLBACK
    │       └─ IDDocumentNumber = CustomerCode
    │
    └── tout le reste  →  IDDOC
            └─ IDDocumentNumber = np_clean
```

Dans tous les cas, les **4 dépendances** sont peuplées :
- IssueDate → `C_StartDate`
- ExpirationDate → `COALESCE(C_RealEndDate, C_StartDate)`
- IssuerCountry → `'TG'`
- IssueAuthority → `'TG'`

---

### `btm-contractdata-corrige.sql`

Squelette BTM ContractData avec garde-fous sur les taux et les dates.

**Protections InterestRate / EffectiveCreditRate :**

```sql
CASE
  WHEN TRY_CONVERT(decimal(6,3), REPLACE([InterestRate],',','.')) IS NULL THEN '2'
  WHEN TRY_CONVERT(decimal(6,3), REPLACE([InterestRate],',','.')) < 1    THEN '2'
  WHEN TRY_CONVERT(decimal(6,3), REPLACE([InterestRate],',','.')) > 24   THEN '24'
  ELSE CAST(TRY_CONVERT(decimal(6,3), REPLACE([InterestRate],',','.')) AS varchar(10))
END AS interestrate
```

**Autres protections incluses :**
- Déduplication sur `(ContractCode, ConsentCode)` via ROW_NUMBER
- Suppression des individus avec `Gender, DateOfBirth, placeofbirth, Nationality` tous à NULL
- Correction des `RealEndDate` futures (ramènes à la fin du mois précédent)
- `RealEndDate` uniquement transmise si `PhaseOfContract = 'Closed'`
- `OutstandingAmount` et `PastDueAmount` mis à `0` si contrat soldé
- Filtre final : exclure les contrats dont l'individu associé manque de champs critiques ou dont l'âge est hors plage 18–99 ans

---

## 9. Pièges fréquents

| # | Piège | Explication | Solution |
|---|---|---|---|
| 1 | **Dashes dans NUM_PIECE** | `LEN('0103-008-859')` = 12, pas 11 | Nettoyer **espaces + points + tirets** avant `LEN()` : `REPLACE(REPLACE(REPLACE(np,' ',''),'.',''),'-','')` |
| 2 | **Substring overlap CNI** | Positions `(1,4)(5,3)(7,4)` → `SUBSTRING(np,7,4)` recoupe sur le caractère 7 au lieu du 8 | Utiliser `(1,4)(5,3)**(8,4)**` |
| 3 | **Guard numérique insuffisant** | `LEN(x) = 11` seul laisse passer `ABC-DEF-GHIJ` | Combiner avec `NOT LIKE '%[^0-9]%'` |
| 4 | **Passeport en minuscules** | `eb485842` ne matche pas `(EB\|ES\|ED\|ER)` | Normaliser via `UPPER(REPLACE(x,' ',''))` avant contrôle |
| 5 | **IDDocument orphelin** | `IDDocumentNumber` renseigné sans ses 4 dépendances → SBR133 | Dans la CTE, peupler systématiquement les 4 dépendances dès qu'un type est attribué |
| 6 | **Virgule décimale** | `TRY_CONVERT(decimal, '12,5')` → NULL | Remplacer la virgule par un point avant la conversion : `REPLACE(x,',','.')` |

---

## 10. Calendrier opérationnel

| Étape | Moment |
|---|---|
| Snapshot de fin de mois M | J-1 du mois M+1 (ex. arrêté au 31/03/2026 pour mars 2026) |
| Extractions CBS → BtmExtract | Début de mois M+1, jour 1 |
| Transformations BTM + génération XLSX | Jours 2–3 de M+1 |
| 1ère soumission BCEAO | Jours 3–4 de M+1 |
| Réception fichier ERRORS, correction v2 | Jours 5–6 de M+1 |

> La fenêtre entre v1 et v2 est courte : **privilégier les corrections automatisées** (modifications des requêtes BTM) pour tenir le délai et ne pas refaire le même travail le mois suivant.

---

## 11. Livrables produits

À l'issue d'une session de correction, le skill produit :

| Livrable | Format | Contenu |
|---|---|---|
| Requête Individual corrigée | `.sql` | BTM Individual avec CTE de classification NUM_PIECE |
| Requête ContractData corrigée | `.sql` | BTM ContractData avec garde-fous taux et dates |
| Rapport de correction | `.docx` | Synthèse des erreurs, causes racines, corrections appliquées, cas testés, recommandations long terme |

---

## 12. Évolution du skill

Le skill est organisé pour être maintenu facilement :

```
traitement-bic-crb/
├── SKILL.md                          # Vue d'ensemble (stable)
├── references/
│   ├── codes-erreurs-bceao.md        # Catalogue CUST/SBR/VALID — à enrichir à chaque vague
│   ├── regles-format-bceao.md        # Patterns, plafonds, lookups
│   └── architecture-pipeline.md     # Les 3 couches en détail
└── templates/
    ├── btm-individual-corrige.sql    # Squelette Individual prêt à l'emploi
    └── btm-contractdata-corrige.sql  # Squelette ContractData prêt à l'emploi
```

**Règle d'évolution** : à chaque nouveau code d'erreur, nouvelle règle BCEAO ou nouveau plafond :
1. Documenter dans `references/codes-erreurs-bceao.md` (signification, cause racine observée, remède appliqué)
2. Mettre à jour `references/regles-format-bceao.md` si la règle de format change
3. Mettre à jour les templates si la correction doit être intégrée au squelette standard
4. **Ne pas modifier `SKILL.md`** sauf pour une évolution structurelle du workflow

---

*Document généré depuis les sources du skill `traitement-bic-crb` — URCLEC-TG / Zone UEMOA.*
