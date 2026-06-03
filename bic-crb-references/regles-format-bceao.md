# Règles de format BCEAO — CBS_Data_Structures 2.0

Extraits consolidés du référentiel officiel BCEAO (onglets Client, Contrat, Identification).

## Identifiants individuels

### NationalID (Togo)

- **Pattern** : `\d{4}-\d{3}-\d{4}`
- **Longueur** : 11 chiffres purs, 2 tirets de séparation.
- **Exemple valide** : `0053-730-8061`
- **Dépendances obligatoires** :
  - `IdentificationNumbersNationalIDIssueDate` (date d'émission)
  - `IdentificationNumbersNationalIDExpirationDate`
  - `IdentificationNumbersNationalIDIssuerCountrylookup` = `TG`
- **Reformattage T-SQL** depuis une chaîne nettoyée `np_clean` de 11 chiffres :
  ```sql
  SUBSTRING(np_clean,1,4) + '-' + SUBSTRING(np_clean,5,3) + '-' + SUBSTRING(np_clean,8,4)
  ```

### Passport (Togo, ancien modèle)

- **Pattern** : `(EB|ES|ED|ER)\d{6}`
- **Longueur totale** : 8 caractères.
- **Exemple valide** : `EB112866`
- **Normalisation** : `UPPER(REPLACE(np, ' ', ''))` avant contrôle.
- **Dépendances obligatoires** : mêmes que NationalID mais avec suffixe `Passport`.

### IDDocumentNumber (tout le reste)

- **Pattern** : libre, alphanumérique.
- **Usage** : permis de conduire, carte consulaire, matricule interne, pièce étrangère, carte d'électeur…
- **Fallback absolu** : si NUM_PIECE vide/null, utiliser `CustomerCode` pour garantir un identifiant non vide (règle SBR interne URCLEC-TG).
- **Dépendances obligatoires (SBR133)** :
  - `IdentificationNumbersIDDOCUMENTISSUEDATE`
  - `IdentificationNumbersIDDOCUMENTEXPIRATIONDATE`
  - `identificationnumbersiddocumentissuercountrylookup` = `TG`
  - `IdentificationNumbersIDDocumentIssueAuthority` = `TG`

## Taux (contrats)

### InterestRate

- **Format** : `Decimal` avec **max 3 décimales**.
- **Unité** : pourcentage (12.5 = 12,5 %, pas 0.125).
- **Règles métier BCEAO** :
  - Positif ou nul.
  - ≤ 15 % pour banques et établissements financiers.
  - ≤ 24 % pour SFD (taux d'usure applicable à URCLEC-TG).
- **Règle URCLEC-TG appliquée** : si taux source < 1 → forcer à `2`.
- **Valeurs rejetées** :
  - `0.0001` : 4 décimales, format invalide.
  - `-1` : négatif interdit.
  - `30` : dépasse le plafond SFD.

### EffectiveCreditRate

- Même format que InterestRate.
- **Contrainte additionnelle** : `EffectiveCreditRate >= InterestRate`.
- En pratique URCLEC-TG : on l'initialise à la même valeur que InterestRate (après protection). Cela respecte la règle ≥ mais n'est pas réaliste métier (le taux effectif devrait inclure frais/assurances).

## Dates

- **Format attendu** : `YYYY-MM-DD` (10 caractères).
- **StartDate** : obligatoire, ne peut pas être futur par rapport au snapshot.
- **RealEndDate** :
  - Renseignée uniquement si `PhaseOfContract = 'Closed'`.
  - Doit être ≥ StartDate.
  - Ne peut pas dépasser le snapshot du mois.
- **DateOfBirth** : doit donner un âge entre 18 et 99 ans.

## Téléphones

- **MobilePhone** : pattern `+228\d{8}` pour le Togo.
- **FixedLine** : même pattern.
- **Fallback URCLEC-TG** : `+22825500068` si non conforme.

## Montants

- **Séparateur décimal** : point (`.`), jamais la virgule.
- **Valeurs négatives** : prendre `ABS()` pour OutstandingAmount et PastDueAmount.
- **Cohérence PastDue** : si `ContractStatus IN ('SettledOnTime','SettledInAdvance')` → tous les montants dus à 0.

## Lookups fréquents

| Champ | Valeurs BCEAO acceptées |
|---|---|
| `residencylookup` | `TG`, `BJ`, `BF`, `CI`, `GW`, `ML`, `NE`, `SN` |
| `maritalstatuslookup` | `Single`, `Married`, `Divorced`, `Widowed`, `Other` |
| `gender` | `Male`, `Female` |
| `phaseofcontractlookup` | `InProgress`, `Closed`, `Defaulted` |
| `typeofcontractlookup` | `Loan`, `Overdraft`, `Leasing`, `CreditCard`… |
| `methodofpaymentlookup` | `CurrentAccount`, `Cash`, `Check` |
| `professionalcategorylookup` | `UnclassifiableWorkers`, `Employees`, `Executives`… |

Quand une valeur source n'a pas de correspondance évidente, utiliser `Other` (disponible sur la plupart des lookups).
