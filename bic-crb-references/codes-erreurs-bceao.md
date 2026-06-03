# Catalogue des codes d'erreur BCEAO — BIC-CRB

Catalogue construit à partir des rapports `ERRORS_URCLEC-TG_*.xlsx`. À enrichir à chaque nouvelle itération.

## CUST089 — Pattern NationalID invalide

**Signification** : la valeur transmise dans `IdentificationNumbersNationalID` ne respecte pas le pattern attendu pour la nationalité déclarée.

**Pattern Togo** : `\d{4}-\d{3}-\d{4}` (11 chiffres structurés).

**Causes racines fréquentes** :
- Numéro de permis ou matricule interne (ex. `010300859`) routé par erreur dans NationalID.
- CNI avec 10 chiffres au lieu de 11 (numéro tronqué côté CBS).
- Reformattage SUBSTRING incorrect (positions `(1,4)(5,3)(7,4)` → overlap) qui produit `0103-008-8859` ou `0103-008-859`.

**Remède déterministe** : classifier NUM_PIECE dans une CTE (CNI / Passport / IDDoc) et ne peupler NationalID que si la classification retourne CNI. Voir `templates/btm-individual-corrige.sql`.

## CUST090 — Pattern Passport invalide

**Signification** : valeur dans `IdentificationNumbersPassportNumber` ne respectant pas le pattern passeport du pays émetteur.

**Pattern Togo (ancien modèle)** : `(EB|ES|ED|ER)\d{6}`.

**Causes racines** : espaces internes (`EB 485842`), lettres en minuscules (`eb485842`), préfixe non reconnu (nouveaux modèles numérisés à signaler à la BCEAO).

**Remède** : normaliser via `UPPER(REPLACE(np, ' ', ''))` avant contrôle, puis matcher strictement sur les 4 préfixes acceptés.

## SBR26 — RealEndDate obligatoire

**Signification** : pour un contrat à phase `Closed`, `RealEndDate` doit être renseignée.

**Cause racine** : contrat marqué clos côté CBS sans date de clôture effective renseignée.

**Remède** : dans la requête BTM ContractData, forcer une date cohérente (startdate + contractlifetime) pour les closed sans realenddate ; ou remonter en amont pour qu'un agent CBS complète la donnée.

## SBR27 — RealEndDate incohérente

**Signification** : la date est soit dans le futur (> snapshot), soit antérieure à la startdate, soit hors fenêtre autorisée.

**Remède URCLEC-TG** : UPDATE préventif qui ramène les realenddate futures à la fin du mois précédent :

```sql
UPDATE [BtmExtract].[SUPERADMIN].ContractData
   SET RealEndDate = CAST(DATEADD(DAY, -1, DATEADD(MONTH, DATEDIFF(MONTH, 0, GETDATE()), 0)) AS DATE)
 WHERE RealEndDate <> 'NULL'
   AND RealEndDate > CAST(DATEADD(DAY, -1, DATEADD(MONTH, DATEDIFF(MONTH, 0, GETDATE()), 0)) AS DATE)
   AND RealEndDate < CAST(DATEADD(MONTH, DATEDIFF(MONTH, 5, GETDATE()), 5) AS DATE);
```

## VALID01 — Champ obligatoire manquant

**Signification** : un champ marqué mandatory dans la spec BCEAO 2.0 est vide ou NULL.

**Champs concernés typiquement** : Gender, DateOfBirth, Nationality, placeofbirth, MobilePhone, ContractStatus, StartDate.

**Remède** : suppression des individus avec 4 champs critiques null (règle URCLEC-TG) + fallbacks déterministes pour les champs non critiques (placeofbirth → 'SOKODE', MobilePhone → '+22825500068').

## VALID14 — Valeur de lookup non reconnue

**Signification** : valeur transmise dans un champ `*lookup` qui n'appartient pas à la liste autorisée BCEAO.

**Exemples** : `Celibataire` au lieu de `Single`, `Togolais` au lieu de `TG`, champ vide au lieu de `Other`.

**Remède** : mapper exhaustivement les valeurs CBS vers les lookups BCEAO dans la requête d'extraction intermédiaire (couche 2), pas dans le BTM final.

## SBR133 — Dépendances IDDocument manquantes

**Signification** : IDDocumentNumber renseigné sans ses 4 compagnons obligatoires (IssueDate, ExpirationDate, IssuerCountry, IssueAuthority).

**Remède** : dans la CTE de classification, dès qu'on route une valeur vers IDDocumentNumber ou Passport ou NationalID, peupler systématiquement les 4 champs de dépendance (fallback `C_StartDate` pour IssueDate, `C_RealEndDate` pour ExpirationDate, `TG` pour les deux champs géographiques).

## Codes à investiguer au cas par cas

- **CUST01x** : formats MobilePhone/FixedLine. Pattern Togo : `+228\d{8}`.
- **CUST02x** : codes ISO pays. Nationality attend `TG`, pas `Togolaise`.
- **SBR11x–13x** : règles de cohérence croisée entre contrats et individus (ContractCode orphelin, CustomerCode inconnu).

Quand un nouveau code apparaît : documenter ici (signification, cause racine observée, remède appliqué) avant de fermer le ticket.
