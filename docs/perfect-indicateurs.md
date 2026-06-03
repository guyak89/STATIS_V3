# Perfect - Indicateurs Metier

Ce document centralise les regles metier confirmees pour la base `BASE_INTERCO` exploitee par l'application Perfect.

Il sert a :

- documenter les definitions fonctionnelles des indicateurs
- identifier les tables et jointures valides
- conserver les regles de calcul confirmees par le metier
- eviter les approximations dans le tableau de bord

## Conventions

- Base : `BASE_INTERCO`
- Instance : `localhost\\SQL2022`
- Date d'arret operationnelle :
  `MAX(JOURNEE.DATE_JOUR)`
- Mode historique :
  si l'utilisateur coche `Historique`, la date saisie devient la date d'arret de tous les indicateurs, a condition qu'elle ne soit pas posterieure a `MAX(JOURNEE.DATE_JOUR)`
- Periode de flux mensuelle :
  premier jour du mois de la date d'arret

### Mode historique dans STATIS

Le mode historique est transporte dans l'URL avec le parametre :

```text
asOfDate=AAAA-MM-JJ
```

Toutes les routes SQL qui calculent une situation a date utilisent alors :

```sql
DECLARE @OpenDate date = CAST((SELECT MAX(DATE_JOUR) FROM JOURNEE) AS date);
DECLARE @AsOfDate date = ISNULL(@RequestedAsOfDate, @OpenDate);
IF @AsOfDate > @OpenDate
  THROW 51000, 'La date historique ne peut pas etre posterieure a la date d''ouverture de la base.', 1;
```

Les indicateurs mensuels prennent le mois de `@AsOfDate`, les indicateurs journaliers prennent exactement `@AsOfDate`, et les pages de detail propagent le meme parametre pour rester reconciliables avec l'accueil.

## Etats de pret

Source metier confirmee :

- `SO` = souffrant
- `DC` = sain
- `PE` = en perte
- `SD` = solde

Interpretation actuelle :

- Les credits en encours incluent les dossiers avec `ETAT_PRET IN ('SO', 'DC')`
- Tout dossier dont `DATE_SOLDE` est strictement anterieure a la date d'arret doit etre exclu
- Les dossiers `SD` sont aussi inclus si `DATE_SOLDE` est strictement posterieure a la date d'arret
- Les credits `PE` sont inclus uniquement si la date de transfert en perte est strictement posterieure a la date d'arret
- La date de transfert en perte se lit dans `DECLAS_HIST.DATE_DECLAS_HIST` sur la ligne `COD_TYP_OPERAT = 'TRPE'`
- Les dossiers dont la situation active la plus recente dans `DECLAS_HIST` est `TRPE` sont exclus de l'encours credit standard, meme si `PRETS.ETAT_PRET` reste `DC` ou `SO`

## Noyau credit

### Tables principales

- `PRETS` : contrat de pret
- `DEMPRET` : demande de pret / parametres metier
- `DECAIS` : decaissement
- `ADHERENT` : porteur du credit
- `OBJET_FIN` : reference objet de financement
- `REMBOURS` : remboursements effectifs
- `TABAMOR` : echeancier / controle de coherence des echeances
- `JOURNEE` : date d'ouverture / date d'arret operationnelle
- `AGENCE` : referentiel agences

### Jointures confirmees

```sql
PRETS.NUM_DOSSIER = DECAIS.NUM_DOSSIER
DEMPRET.REF_DEMANDE = PRETS.REF_DEMANDE
OBJET_FIN.COD_OBJET_FIN = DEMPRET.COD_OBJET_FIN
ADHERENT.COD_ADH = DEMPRET.COD_ADH
```

### Identification de l'agence par dossier

Regle confirmee :

- le code agence est porte par le prefixe du `NUM_DOSSIER`
- exemple :
  `A01PRT...` = agence `A01`
- le code agence est egalement present dans `AGENCE.COD_AGENCE`

Utilisation courante :

```sql
LEFT(PRETS.NUM_DOSSIER, 3)
```

## Encours credit

### Definition metier

L'encours credit doit etre calcule a la derniere date d'ouverture de la base, soit :

```sql
MAX(JOURNEE.DATE_JOUR)
```

Seuls les credits en encours sont retenus selon la regle mixte :

```sql
(
    PRETS.ETAT_PRET IN ('SO', 'DC')
    AND (PRETS.DATE_SOLDE IS NULL OR PRETS.DATE_SOLDE > @AsOfDate)
)
OR (PRETS.ETAT_PRET = 'SD' AND PRETS.DATE_SOLDE > @AsOfDate)
OR (
    PRETS.ETAT_PRET = 'PE'
    AND EXISTS (
        SELECT 1
        FROM DECLAS_HIST dhPe
        WHERE dhPe.NUM_DOSSIER = PRETS.NUM_DOSSIER
          AND dhPe.COD_TYP_OPERAT = 'TRPE'
          AND dhPe.DATE_DECLAS_HIST > @AsOfDate
    )
)
```

### Regle de calcul

Encours par dossier :

```sql
MONTANT_PRET - SOMME(CAPITAL_REMB jusqu'a la date d'arret)
```

avec :

- `MONTANT_PRET` issu de `PRETS`
- `CAPITAL_REMB` issu de `REMBOURS`
- remboursements retenus uniquement si `REMBOURS.DATE_REMB <= date d'arret`
- controle de coherence des echeances via `TABAMOR`
- le dossier doit avoir un decaissement dont `DECAIS.DATE_DECAIS <= date d'arret`
- tout dossier decaisse apres la date d'arret doit etre exclu de la situation
- les dossiers `PE` doivent etre retenus si leur ligne de transfert en perte `DECLAS_HIST.COD_TYP_OPERAT = 'TRPE'` porte une `DATE_DECLAS_HIST` posterieure a la date d'arret
- le dossier doit etre exclu si sa situation active la plus recente dans `DECLAS_HIST` a la date d'arret est `TRPE`

### Requete source fournie

```sql
SELECT
    REMBOURS.NUM_DOSSIER AS NUM_DOSSIER,
    SUM(REMBOURS.CAPITAL_REMB) AS la_somme_CAPITAL_REMB,
    SUM(REMBOURS.COMMISSION_REMB) AS la_somme_COMMISSION_REMB,
    SUM(REMBOURS.EPG_REMB) AS la_somme_EPG_REMB,
    SUM(REMBOURS.PENALITE_REMB) AS la_somme_PENALITE_REMB,
    SUM(REMBOURS.INTERET_REMB) AS la_somme_INTERET_REMB,
    MAX(REMBOURS.DATE_REMB) AS le_maximum_DATE_REMB,
    MAX(REMBOURS.DATE_ECHEANCE) AS le_maximum_DATE_ECHEANCE
FROM REMBOURS
WHERE REMBOURS.DATE_REMB <= '20260331'
  AND REMBOURS.DATE_ECHEANCE IN (
      SELECT DATE_ECHEANCE
      FROM TABAMOR
      WHERE NUM_DOSSIER = REMBOURS.NUM_DOSSIER
  )
GROUP BY REMBOURS.NUM_DOSSIER
```

### Requete de travail normalisee

```sql
DECLARE @AsOfDate date = (
    SELECT MAX(DATE_JOUR)
    FROM JOURNEE
);

WITH Remboursements AS (
    SELECT
        rb.NUM_DOSSIER,
        SUM(ISNULL(rb.CAPITAL_REMB, 0)) AS capital_rembourse
    FROM REMBOURS rb
    WHERE rb.DATE_REMB <= @AsOfDate
    GROUP BY rb.NUM_DOSSIER
),
DeclassementRanked AS (
    SELECT
        dh.NUM_DOSSIER,
        dh.COD_TYP_OPERAT,
        ROW_NUMBER() OVER (
            PARTITION BY dh.NUM_DOSSIER
            ORDER BY dh.DATE_DECLAS_HIST DESC, dh.NUM_TRANS DESC
        ) AS rn
    FROM DECLAS_HIST dh
    WHERE dh.DATE_DECLAS_HIST <= @AsOfDate
      AND (dh.DATE_FIN IS NULL OR dh.DATE_FIN > @AsOfDate)
),
LossLoans AS (
    SELECT
        dr.NUM_DOSSIER
    FROM DeclassementRanked dr
    WHERE dr.rn = 1
      AND dr.COD_TYP_OPERAT = 'TRPE'
)
SELECT
    p.NUM_DOSSIER,
    LEFT(p.NUM_DOSSIER, 3) AS COD_AGENCE,
    p.MONTANT_PRET,
    ISNULL(r.capital_rembourse, 0) AS CAPITAL_REMBOURSE,
    CASE
        WHEN p.MONTANT_PRET - ISNULL(r.capital_rembourse, 0) < 0 THEN 0
        ELSE p.MONTANT_PRET - ISNULL(r.capital_rembourse, 0)
    END AS ENCOURS_CREDIT
FROM PRETS p
LEFT JOIN Remboursements r
    ON r.NUM_DOSSIER = p.NUM_DOSSIER
WHERE (
        (
            p.ETAT_PRET IN ('SO', 'DC')
            AND (p.DATE_SOLDE IS NULL OR p.DATE_SOLDE > @AsOfDate)
        )
        OR (p.ETAT_PRET = 'SD' AND p.DATE_SOLDE > @AsOfDate)
        OR (
            p.ETAT_PRET = 'PE'
            AND EXISTS (
                SELECT 1
                FROM DECLAS_HIST dhPe
                WHERE dhPe.NUM_DOSSIER = p.NUM_DOSSIER
                  AND dhPe.COD_TYP_OPERAT = 'TRPE'
                  AND dhPe.DATE_DECLAS_HIST > @AsOfDate
            )
        )
      )
  AND p.NUM_DOSSIER LIKE '%PRT%'
  AND EXISTS (
      SELECT 1
      FROM DECAIS dc
      WHERE dc.NUM_DOSSIER = p.NUM_DOSSIER
        AND dc.DATE_DECAIS <= @AsOfDate
  )
  AND NOT EXISTS (
      SELECT 1
      FROM LossLoans ll
      WHERE ll.NUM_DOSSIER = p.NUM_DOSSIER
  )
```

### Cas confirme avec Perfect au 31/03/2026

Les dossiers suivants apparaissent dans le rapport Perfect bien qu'ils soient `SD`, car leur
`DATE_SOLDE` est posterieure au `31/03/2026` :

- `A01PRT202500099` avec `DATE_SOLDE = 2026-04-07`
- `A01PRT202500113` avec `DATE_SOLDE = 2026-04-07`
- `A01PRT202500184` avec `DATE_SOLDE = 2026-04-01`

Le dossier suivant doit etre exclu de l'encours credit standard bien qu'il soit encore `DC`
dans `PRETS`, car sa situation active dans `DECLAS_HIST` est deja `TRPE` au `31/03/2026` :

- `A02PRT201600418` avec `COD_TYP_OPERAT = TRPE`, `DATE_DECLAS_HIST = 2019-06-28`, `DATE_FIN = NULL`, `ENCOURS = 70 000.00`

Le dossier suivant montre une autre regle necessaire pour coller a Perfect :

- `A05PRT201200174` doit etre exclu car `DATE_SOLDE = 2016-12-30`, donc anterieure au `31/03/2026`, meme si `ETAT_PRET = DC`

### Resultat constate pendant verification

Au moment du test :

- date d'arret detectee : `2026-04-09`
- encours credit calcule : `1 909 970 696 XOF`

## PAR 1J, PAR 30J et PAR 90J

### Definition fonctionnelle

Les indicateurs de qualite du portefeuille mesurent la part de l'encours credit exposee au retard.

Un dossier entre dans le PAR d'un seuil donne lorsque le capital echeancier exigible a ce seuil est superieur au capital deja rembourse a la date d'arret.

Les trois indicateurs affiches sont :

- `PAR a 1J` : encours des dossiers ayant au moins une echeance en retard d'au moins 1 jour
- `PAR a 30J` : encours des dossiers ayant au moins une echeance en retard d'au moins 30 jours
- `PAR a 90J` : encours des dossiers ayant au moins une echeance en retard d'au moins 90 jours

Le taux PAR est toujours calcule ainsi :

```sql
PAR_SEUIL = ENCOURS_A_RISQUE_SEUIL / ENCOURS_CREDIT_TOTAL
```

Le montant affiche sur la carte PAR n'est pas le montant impaye. C'est l'encours credit total des dossiers qualifies comme a risque pour le seuil.

### Date d'arret

La date d'arret est la derniere date d'ouverture de la base :

```sql
@AsOfDate = MAX(JOURNEE.DATE_JOUR)
```

Les seuils sont interpretes ainsi :

```sql
PAR 1J  : TABAMOR.DATE_ECHEANCE <  @AsOfDate
PAR 30J : TABAMOR.DATE_ECHEANCE <= DATEADD(DAY, -30, @AsOfDate)
PAR 90J : TABAMOR.DATE_ECHEANCE <= DATEADD(DAY, -90, @AsOfDate)
```

Cette lecture signifie qu'une echeance du jour meme de la date d'arret n'est pas en retard.

### Population retenue

Le denominateur des PAR est strictement le meme que l'encours credit valide :

- dossiers dont `ENCOURS_CREDIT > 0`
- dossiers `PRETS.ETAT_PRET IN ('SO', 'DC')` avec `DATE_SOLDE IS NULL OR DATE_SOLDE > @AsOfDate`
- dossiers `PRETS.ETAT_PRET = 'SD'` retenus seulement si `DATE_SOLDE > @AsOfDate`
- dossiers `PRETS.ETAT_PRET = 'PE'` retenus si leur transfert en perte `DECLAS_HIST.COD_TYP_OPERAT = 'TRPE'` a une `DATE_DECLAS_HIST > @AsOfDate`
- dossiers exclus si leur derniere situation active dans `DECLAS_HIST` a la date d'arret est `TRPE`
- dossiers retenus seulement s'ils ont un decaissement `DECAIS.DATE_DECAIS <= @AsOfDate`
- dossiers limites aux numeros de dossier credit `NUM_DOSSIER LIKE '%PRT%'`

L'encours par dossier est :

```sql
ENCOURS_CREDIT = MAX(PRETS.MONTANT_PRET - SUM(REMBOURS.CAPITAL_REMB), 0)
```

avec `REMBOURS.DATE_REMB <= @AsOfDate`.

Regle confirmee par rapprochement avec Perfect sur `MUTUELLE PLUS` au `31/12/2025` :

- le solde encours utilise tous les remboursements capital saisis jusqu'a la date d'arret
- il ne faut pas imposer `REMBOURS.DATE_ECHEANCE = TABAMOR.DATE_ECHEANCE` pour calculer l'encours
- certains remboursements sont rattaches a une date d'echeance legerement differente de l'echeancier, mais Perfect les prend quand meme dans le solde
- exemple confirme : `A08PRT202400214`, ou le filtre strict par `TABAMOR` creait un ecart de `175 215`

### Regle de qualification d'un dossier a risque

Pour chaque dossier de la population encours, on calcule :

```sql
capital_echu_seuil = SUM(TABAMOR.CAPITAL selon le seuil)
capital_rembourse  = SUM(REMBOURS.CAPITAL_REMB jusqu'a @AsOfDate)
```

Le dossier est classe a risque pour le seuil si :

```sql
capital_echu_seuil > capital_rembourse
```

Si cette condition est vraie, le numerateur PAR prend tout l'encours restant du dossier :

```sql
ENCOURS_A_RISQUE_SEUIL += ENCOURS_CREDIT_DOSSIER
```

Si la condition est fausse, le dossier reste dans le denominateur mais ne contribue pas au numerateur.

### Nombre de jours de retard

Le nombre de jours de retard affiche dans les details n'est pas calcule depuis la premiere echeance echue globale.

Perfect retient la premiere echeance individuellement non couverte :

```sql
TABAMOR.CAPITAL > SUM(REMBOURS.CAPITAL_REMB sur la meme DATE_ECHEANCE)
```

mais uniquement pour les dossiers deja qualifies a risque par la regle globale :

```sql
SUM(TABAMOR.CAPITAL echeancier selon le seuil)
> SUM(REMBOURS.CAPITAL_REMB jusqu'a @AsOfDate)
```

Cette distinction est importante :

- le solde encours et la qualification PAR utilisent tous les remboursements capital jusqu'a la date d'arret
- le nombre de jours de retard utilise la premiere echeance dont le capital individuel reste sous-paye

Cas confirme :

- `A08PRT202400214` au `31/12/2025`
- encours Perfect apres correction : `135 945`
- jours de retard Perfect : `117`
- la correction donne une comparaison parfaite avec le rapport Perfect `PAR 1J PLUS 31 12 2025.xls` : `137/137` dossiers, encours total `62 034 969`, ecart `0`

### Formules consolidees

```sql
PAR_1J_MONTANT =
    SUM(ENCOURS_CREDIT_DOSSIER)
    pour les dossiers ou SUM(TABAMOR.CAPITAL avec DATE_ECHEANCE < @AsOfDate)
    > SUM(REMBOURS.CAPITAL_REMB jusqu'a @AsOfDate)

PAR_30J_MONTANT =
    SUM(ENCOURS_CREDIT_DOSSIER)
    pour les dossiers ou SUM(TABAMOR.CAPITAL avec DATE_ECHEANCE <= DATEADD(DAY, -30, @AsOfDate))
    > SUM(REMBOURS.CAPITAL_REMB jusqu'a @AsOfDate)

PAR_90J_MONTANT =
    SUM(ENCOURS_CREDIT_DOSSIER)
    pour les dossiers ou SUM(TABAMOR.CAPITAL avec DATE_ECHEANCE <= DATEADD(DAY, -90, @AsOfDate))
    > SUM(REMBOURS.CAPITAL_REMB jusqu'a @AsOfDate)

PAR_1J_TAUX  = 100 * PAR_1J_MONTANT  / ENCOURS_CREDIT_TOTAL
PAR_30J_TAUX = 100 * PAR_30J_MONTANT / ENCOURS_CREDIT_TOTAL
PAR_90J_TAUX = 100 * PAR_90J_MONTANT / ENCOURS_CREDIT_TOTAL
```

Si l'encours credit total est nul, le taux est `0`.

### Repartition par agence

La page detail par agence utilise exactement la meme population et la meme regle de qualification.

Le rattachement agence est fait par :

```sql
LEFT(PRETS.NUM_DOSSIER, 3)
```

La somme des montants PAR par agence doit etre egale au montant PAR consolide affiche sur la page d'accueil.

### Distinction avec l'indicateur Impayes

Les PAR mesurent un portefeuille a risque :

- numerateur = encours total des dossiers en retard selon le seuil
- denominateur = encours credit total valide

L'indicateur `Impayes` mesure un montant exigible non rembourse :

- numerateur = capital echu non rembourse
- pas une division par l'encours total

Un meme dossier peut donc contribuer a un PAR avec tout son encours restant, alors que son impaye ne porte que sur la partie echue non remboursee.

## Requete utile de cartographie credit + adherent

Cette requete fournit une vue detaillee des dossiers de pret, des adherents et des caracteristiques du financement :

```sql
SELECT DISTINCT
    PRETS.NUM_DOSSIER,
    PRETS.MONTANT_PRET,
    DEMPRET.COD_ADH,
    DEMPRET.COD_GEST,
    DEMPRET.COD_OBJET_FIN,
    PRETS.COD_SRCEFIN,
    DEMPRET.TX_INTERET,
    DEMPRET.COD_PRDT_CRD,
    DEMPRET.PERI_REMB,
    DEMPRET.NBRE_ECHEANCE,
    DEMPRET.NBRE_BENEF,
    PRETS.DATE_EFFET,
    PRETS.DERNIERE_ECHE,
    DEMPRET.REF_DEMANDE,
    PRETS.CPTE_PRET,
    DEMPRET.NBRE_ECHE_DIFFERE,
    ADHERENT.COD_TYPEADH,
    PRETS.ETAT_PRET,
    ADHERENT.DATE_NAISS,
    ADHERENT.CODE_ZONE1,
    ADHERENT.NUM_MANUEL,
    ADHERENT.NOM_PRENOM,
    PRETS.NUMERO_CONTRAT,
    ADHERENT.TEL,
    DEMPRET.DUREE_GRACE,
    PRETS.CPTE_HORSBIL,
    DEMPRET.MOTIF_NEGOS,
    ADHERENT.COD_AUTRE_STATUT AS EMPLOYE,
    ADHERENT.COD_AUTRE_CATEGORIE AS CATEGORIE,
    PRETS.DATE_SOLDE,
    PRETS.CODE_DEVISE,
    PRETS.ATTRIB_DUREE,
    ADHERENT.NUM_CEL,
    PRETS.MTT_CAUTION_INDIV,
    PRETS.MTT_CAUTION_GPE,
    ADHERENT.NUM_CARTE_BANCAIRE
FROM PRETS
JOIN DECAIS
    ON PRETS.NUM_DOSSIER = DECAIS.NUM_DOSSIER
JOIN DEMPRET
    ON DEMPRET.REF_DEMANDE = PRETS.REF_DEMANDE
JOIN OBJET_FIN
    ON OBJET_FIN.COD_OBJET_FIN = DEMPRET.COD_OBJET_FIN
JOIN ADHERENT
    ON ADHERENT.COD_ADH = DEMPRET.COD_ADH
WHERE PRETS.NUM_DOSSIER LIKE '%PRT%'
```

## Volume de collecte tontine

### Definition metier

Le volume de collecte tontine est un indicateur de flux mensuel.

La periode retenue est le mois de la date d'arret operationnelle :

```sql
@AsOfDate = MAX(JOURNEE.DATE_JOUR)
@MonthStart = DATEFROMPARTS(YEAR(@AsOfDate), MONTH(@AsOfDate), 1)
```

Les operations retenues sont celles validees entre le debut du mois et la date d'arret incluse :

```sql
T_OPERATION.DATE_VALIDATION >= @MonthStart
AND T_OPERATION.DATE_VALIDATION < DATEADD(DAY, 1, @AsOfDate)
```

### Tables et champs

- `T_OPERATION` : operations tontine
- `T_OPERATION.MONTANT_OP` : montant collecte
- `T_OPERATION.TYPE_OP` : type d'operation
- `T_OPERATION.DATE_VALIDATION` : date de prise en compte
- `T_OPERATION.NUM_CMPTE` : compte tontine concerne
- `T_OPERATION.CODE_COLLECT` : agent collecteur de l'operation
- `COMPTES.NUM_CPTE` : compte de rattachement
- `COMPTES.COD_AGENCE` : agence / mutuelle de rattachement
- `T_COLLECTEUR.CODE_COLLECT` : referentiel agent collecteur
- `T_COLLECTEUR.NOM` et `T_COLLECTEUR.PRENOM` : nom et prenoms de l'agent collecteur

### Regle de calcul

Volume consolide :

```sql
SUM(
    CASE
        WHEN T_OPERATION.TYPE_OP = 'A' THEN -T_OPERATION.MONTANT_OP
        ELSE T_OPERATION.MONTANT_OP
    END
)
```

avec :

- `T_OPERATION.TYPE_OP = 'D'` : depot sur le compte du membre, montant positif
- `T_OPERATION.TYPE_OP = 'C'` : commission percue sur le membre, montant positif
- `T_OPERATION.TYPE_OP = 'A'` : annulation, montant a deduire
- uniquement les operations dont `DATE_VALIDATION` est dans le mois de la date d'arret,
  avec borne haute exclusive `DATEADD(DAY, 1, @AsOfDate)` pour inclure toute la journee
- rattachement agence via `T_OPERATION.NUM_CMPTE = COMPTES.NUM_CPTE`
- dispatch par agent collecteur via `T_OPERATION.CODE_COLLECT = T_COLLECTEUR.CODE_COLLECT`
- ne pas utiliser `TOP 1 ORDER BY T_OPERATION.ID_OP DESC` pour savoir si le mois contient
  des operations : `ID_OP` n'est pas une preuve fiable de derniere `DATE_VALIDATION`
- logique compatible avec un acces base en lecture seule : `SELECT`, jointures et agregats,
  sans table temporaire et sans ecriture dans la base Perfect

### Requete de travail normalisee

```sql
DECLARE @AsOfDate date = (
    SELECT MAX(DATE_JOUR)
    FROM JOURNEE
);
DECLARE @MonthStart date = DATEFROMPARTS(YEAR(@AsOfDate), MONTH(@AsOfDate), 1);

SELECT
    a.COD_AGENCE,
    a.RAISON_SOCIAL,
    COUNT_BIG(op.ID_OP) AS NOMBRE_OPERATIONS,
    SUM(CAST(
        CASE
            WHEN op.TYPE_OP = 'A' THEN -ISNULL(op.MONTANT_OP, 0)
            ELSE ISNULL(op.MONTANT_OP, 0)
        END AS MONEY
    )) AS VOLUME_COLLECTE_TONTINE
FROM AGENCE a
LEFT JOIN COMPTES c
    ON c.COD_AGENCE = a.COD_AGENCE
LEFT JOIN T_OPERATION op
    ON op.NUM_CMPTE = c.NUM_CPTE
   AND op.TYPE_OP IN ('D', 'C', 'A')
   AND op.DATE_VALIDATION >= @MonthStart
   AND op.DATE_VALIDATION < DATEADD(DAY, 1, @AsOfDate)
GROUP BY a.COD_AGENCE, a.RAISON_SOCIAL
ORDER BY VOLUME_COLLECTE_TONTINE DESC;
```

## Decaissements

### Regle de travail actuelle

Les decaissements sont un indicateur de flux mensuel, borne sur le mois de la date
d'arret operationnelle :

```sql
@AsOfDate = MAX(JOURNEE.DATE_JOUR)
@MonthStart = DATEFROMPARTS(YEAR(@AsOfDate), MONTH(@AsOfDate), 1)
```

Les operations retenues sont les lignes de `DECAIS` dont :

```sql
DECAIS.DATE_DECAIS >= @MonthStart
AND DECAIS.DATE_DECAIS <= @AsOfDate
```

Le rattachement agence est fait par le prefixe du dossier :

```sql
LEFT(DECAIS.NUM_DOSSIER, 3)
```

### Dispatch detail agence

Pour une agence donnee, le detail est fourni selon deux axes :

- par produit de credit via `DECAIS.NUM_DOSSIER = PRETS.NUM_DOSSIER`, puis `PRETS.REF_DEMANDE = DEMPRET.REF_DEMANDE`, puis `DEMPRET.COD_PRDT_CRD = PRDT_CRD.COD_PRDT_CRD`
- par gestionnaire via `DEMPRET.COD_GEST = GESTIONNAIRE.COD_GEST`

Les libelles affiches viennent de :

- `PRDT_CRD.NOM_PRDT_CRD`
- `GESTIONNAIRE.NOM` et `GESTIONNAIRE.PRENOM`

### Detail nominatif par produit ou gestionnaire

Quand l'utilisateur clique sur un produit de credit ou un gestionnaire dans le
detail d'une mutuelle, l'application affiche la liste nominative des dossiers
decaisses sur la meme periode.

La population reste `DECAIS`, filtree par :

```sql
LEFT(DECAIS.NUM_DOSSIER, 3) = @AgencyCode
DECAIS.DATE_DECAIS >= @MonthStart
DECAIS.DATE_DECAIS <= @AsOfDate
```

Le filtre de ligne cliquee est :

```sql
-- clic produit
DEMPRET.COD_PRDT_CRD = @Code

-- clic gestionnaire
DEMPRET.COD_GEST = @Code
```

Les informations nominatives sont recuperees par :

```sql
DECAIS.NUM_DOSSIER = PRETS.NUM_DOSSIER
PRETS.REF_DEMANDE = DEMPRET.REF_DEMANDE
DEMPRET.COD_ADH = ADHERENT.COD_ADH
```

La liste est regroupee par dossier. Si un dossier a plusieurs lignes de
decaissement dans la periode, le montant affiche est :

```sql
SUM(DECAIS.MONTANT_DECAIS)
```

La somme des montants des dossiers doit etre egale au montant de la ligne
produit ou gestionnaire cliquee.

## Souscriptions Tontine

### Definition metier

L'indicateur compte les nouvelles lignes de souscription tontine sur le mois de la
date d'arret operationnelle :

```sql
@AsOfDate = MAX(JOURNEE.DATE_JOUR)
@MonthStart = DATEFROMPARTS(YEAR(@AsOfDate), MONTH(@AsOfDate), 1)
```

Les souscriptions retenues sont les lignes de `T_ADHERENT` dont :

```sql
T_ADHERENT.DATE_INSCRIPT_ADHE >= @MonthStart
AND T_ADHERENT.DATE_INSCRIPT_ADHE <= @AsOfDate
```

Le rattachement agence se fait directement sur la table tontine :

```sql
T_ADHERENT.CODE_AGENCE
```

### Dispatch detail agence

Pour une agence donnee, la repartition par agent collecteur utilise :

- `T_ADHERENT.CODE_COLLECT_ADHE = T_COLLECTEUR.CODE_COLLECT`
- libelle agent : `T_COLLECTEUR.NOM` et `T_COLLECTEUR.PRENOM`
- comptage : `COUNT_BIG(*)` des lignes `T_ADHERENT` retenues sur la periode

## Impayes

### Regle de travail actuelle

L'indicateur impayes mesure le capital arrive a echeance et non encore rembourse
avant la date d'arret.

La date d'arret est :

```sql
@AsOfDate = MAX(JOURNEE.DATE_JOUR)
```

Le montant par dossier est :

```sql
MAX(
    SUM(TABAMOR.CAPITAL avec DATE_ECHEANCE < @AsOfDate)
  - SUM(REMBOURS.CAPITAL_REMB avec DATE_REMB <= @AsOfDate),
    0
)
```

Regle confirmee par rapprochement avec le rapport Perfect
`E_Balance_Age_Portef.xls` pour A12 au `04/05/2026` :

- une echeance dont `TABAMOR.DATE_ECHEANCE = @AsOfDate` n'est pas retenue comme impayee
- le rapport Perfect retient donc strictement `TABAMOR.DATE_ECHEANCE < @AsOfDate`
- avec cette borne stricte, A12 donne `46` dossiers et `10 598 820 XOF`, sans ecart dossier, montant ou jours de retard avec Perfect

Les remboursements sont agreges par dossier depuis `REMBOURS` sans filtre sur
`DATE_ECHEANCE`, conformement a la requete source fournie pour A12 au
`31/01/2026`.

### Dossiers retenus

Les dossiers retenus sont ceux dont :

- `PRETS.COD_SRCEFIN NOT IN ('02','07')`
- agence = `LEFT(PRETS.NUM_DOSSIER, 3)`
- `PRETS.ETAT_PRET IN ('DC','SO')` et aucun declassement `DECLAS_HIST.COD_TYP_OPERAT = 'TRPE'`
- ou `PRETS.ETAT_PRET = 'SD'` avec `PRETS.DATE_SOLDE > @AsOfDate`
- ou `PRETS.ETAT_PRET = 'PE'` avec la date de declassement `TRPE` posterieure a `@AsOfDate`

### Optimisation SQL

La requete source Perfect utilise plusieurs sous-requetes correlees par dossier.
Dans le dashboard, la version normalisee pre-agrege les tables suivantes en CTE :

- `TABAMOR` pour le capital echu strictement avant la date d'arret
- `REMBOURS` pour le capital rembourse
- `DECLAS_HIST` pour les dossiers transferes en perte

Cette optimisation evite de recalculer les memes sommes pour chaque dossier.

## Recouvrement de credit

### Regle de travail actuelle

Le recouvrement de credit est un indicateur de flux mensuel base sur la table
`CREDIT_PERTE`. Cette source a ete confirmee par le metier : les lignes de
`CREDIT_PERTE` portent les recouvrements.

La periode retenue est le mois de la date d'arret operationnelle :

```sql
@AsOfDate = MAX(JOURNEE.DATE_JOUR)
@MonthStart = DATEFROMPARTS(YEAR(@AsOfDate), MONTH(@AsOfDate), 1)
```

Les lignes retenues sont celles dont :

```sql
CREDIT_PERTE.DATE_OPERATION >= @MonthStart
AND CREDIT_PERTE.DATE_OPERATION <= @AsOfDate
```

Le montant de l'indicateur utilise :

```sql
SUM(CREDIT_PERTE.MONTANT)
```

Le rattachement agence se fait par le prefixe du dossier :

```sql
LEFT(CREDIT_PERTE.NUM_DOSSIER, 3)
```

### Dispatch detail agence

Quand l'utilisateur clique sur une mutuelle depuis le detail `Recouvrement`,
la repartition est presentee par produit de credit.

Le lien produit utilise :

```sql
CREDIT_PERTE.NUM_DOSSIER = PRETS.NUM_DOSSIER
PRETS.REF_DEMANDE = DEMPRET.REF_DEMANDE
DEMPRET.COD_PRDT_CRD = PRDT_CRD.COD_PRDT_CRD
```

Le montant par produit est :

```sql
SUM(CREDIT_PERTE.MONTANT)
```

Les lignes de `CREDIT_PERTE` dont le dossier ne permet pas de retrouver un
produit de credit doivent etre conservees dans une ligne fonctionnelle
`Produit non identifie`, afin que la somme du detail reste egale au montant
recouvrement de la mutuelle.

### Detail nominatif par produit

Quand l'utilisateur clique sur un produit de credit dans le detail d'une
mutuelle, l'application affiche la liste nominative des dossiers recouvres sur
la meme periode.

La source reste `CREDIT_PERTE`. Les lignes sont regroupees par dossier :

```sql
GROUP BY CREDIT_PERTE.NUM_DOSSIER
```

Le montant affiche par dossier est :

```sql
SUM(CREDIT_PERTE.MONTANT)
```

Les informations nominatives sont recuperees par :

```sql
CREDIT_PERTE.NUM_DOSSIER = PRETS.NUM_DOSSIER
PRETS.REF_DEMANDE = DEMPRET.REF_DEMANDE
DEMPRET.COD_ADH = ADHERENT.COD_ADH
```

Le detail conserve aussi le nombre d'operations de recouvrement, la premiere
date d'operation, la derniere date d'operation, le mode de paiement, l'utilisateur
et la caisse quand ces champs sont renseignes dans `CREDIT_PERTE`.

Champs disponibles mais non integres dans le montant principal tant que la regle
metier n'est pas confirmee :

- `CREDIT_PERTE.COMMISSION`
- `CREDIT_PERTE.COMMISSION_CHEQUE`

## Stock de credit en perte

### Regle de travail actuelle

Le stock de credit en perte est un indicateur de stock a date. Il mesure le
solde restant des credits transferes en perte a la date d'arret Perfect.

La date d'arret est :

```sql
@AsOfDate = CAST((SELECT MAX(DATE_JOUR) FROM JOURNEE) AS date)
```

En historique, l'indicateur doit etre recalcule a la date demandee et ne doit
pas utiliser un cumul global non borne.

### Population

La source du stock initial est `DECLAS_HIST`, sur les lignes de transfert en
perte :

```sql
DECLAS_HIST.COD_TYP_OPERAT = 'TRPE'
DECLAS_HIST.DATE_DECLAS_HIST < DATEADD(DAY, 1, @AsOfDate)
DECLAS_HIST.DATE_FIN IS NULL OR DECLAS_HIST.DATE_FIN > @AsOfDate
```

Quand plusieurs lignes `TRPE` existent pour un meme dossier, la ligne retenue
est la plus recente active a la date d'arret :

```sql
ROW_NUMBER() OVER (
  PARTITION BY DECLAS_HIST.NUM_DOSSIER
  ORDER BY DECLAS_HIST.DATE_DECLAS_HIST DESC, DECLAS_HIST.NUM_TRANS DESC
) = 1
```

Le rattachement agence se fait par le prefixe du dossier :

```sql
LEFT(DECLAS_HIST.NUM_DOSSIER, 3)
```

### Formule

Le stock initial en perte par dossier est :

```sql
ENCOURS_PERTE_INITIAL =
  DECLAS_HIST.ENCOURS
  - DECLAS_HIST.MONTANT_CAUTION
  - DECLAS_HIST.MONTANT_EPG
```

Les recouvrements cumules sont lus dans `CREDIT_PERTE`, source confirmee des
recouvrements :

```sql
CREDIT_PERTE.NUM_DOSSIER = DECLAS_HIST.NUM_DOSSIER
COALESCE(CREDIT_PERTE.DATE_VALIDATION, CREDIT_PERTE.DATE_OPERATION)
  >= CAST(DECLAS_HIST.DATE_DECLAS_HIST AS date)
COALESCE(CREDIT_PERTE.DATE_VALIDATION, CREDIT_PERTE.DATE_OPERATION)
  < DATEADD(DAY, 1, @AsOfDate)
```

Le stock net par dossier est :

```sql
STOCK_PERTE_DOSSIER =
  MAX(ENCOURS_PERTE_INITIAL - SUM(CREDIT_PERTE.MONTANT), 0)
```

Le stock consolide est la somme des `STOCK_PERTE_DOSSIER`.

### Dispatch detail agence

Quand l'utilisateur clique sur une mutuelle depuis le detail `Stock credit en
perte`, la repartition est presentee par produit de credit.

Le lien produit utilise :

```sql
DECLAS_HIST.NUM_DOSSIER = PRETS.NUM_DOSSIER
PRETS.REF_DEMANDE = DEMPRET.REF_DEMANDE
DEMPRET.COD_PRDT_CRD = PRDT_CRD.COD_PRDT_CRD
```

Le montant par produit est :

```sql
SUM(STOCK_PERTE_DOSSIER)
```

Le detail conserve aussi le stock initial en perte et les recouvrements deduits
afin que la lecture reste reconciliable :

```sql
SUM(ENCOURS_PERTE_INITIAL)
SUM(CREDIT_PERTE.MONTANT)
SUM(STOCK_PERTE_DOSSIER)
```

Les dossiers dont le produit de credit ne peut pas etre retrouve sont conserves
dans une ligne fonctionnelle `Produit non identifie`, afin que la somme du
detail produit reste egale au stock en perte de la mutuelle.

### Detail nominatif par produit

Quand l'utilisateur clique sur un produit de credit dans le detail d'une
mutuelle, l'application affiche la liste nominative des credits en perte actifs
pour la meme date d'arret.

La population reste celle du stock en perte :

```sql
CreditLossStock
WHERE agencyCode = @AgencyCode
AND productCode = @ProductCode
```

Les informations nominatives sont recuperees par :

```sql
CreditLossStock.numDossier = PRETS.NUM_DOSSIER
PRETS.REF_DEMANDE = DEMPRET.REF_DEMANDE
DEMPRET.COD_ADH = ADHERENT.COD_ADH
```

Le detail affiche par dossier :

- `NUM_DOSSIER`
- nom et code adherent
- telephone si disponible
- numero et date de transfert en perte `DECLAS_HIST.NUM_TRANS` /
  `DECLAS_HIST.DATE_DECLAS_HIST`
- stock initial en perte
- recouvrements deduits
- stock net restant

La somme du stock net des dossiers doit etre egale au montant du produit clique.

Comme les autres indicateurs, l'agence faitiere definie dans la base SQLite
locale est exclue par defaut tant que l'option Integrer les donnees faitiere
n'est pas cochee.

## Volume de credit transfere en perte

### Regle de travail actuelle

Le volume de credit transfere en perte est un indicateur de flux mensuel. Il
mesure les credits transferes en perte pendant le mois de la date d'arret
Perfect.

La source confirmee est `DECLAS_HIST`, sur les lignes :

```sql
DECLAS_HIST.COD_TYP_OPERAT = 'TRPE'
```

La periode retenue est :

```sql
@AsOfDate = CAST((SELECT MAX(DATE_JOUR) FROM JOURNEE) AS date)
@MonthStart = DATEFROMPARTS(YEAR(@AsOfDate), MONTH(@AsOfDate), 1)

DECLAS_HIST.DATE_DECLAS_HIST >= @MonthStart
DECLAS_HIST.DATE_DECLAS_HIST < DATEADD(DAY, 1, @AsOfDate)
```

Comme il s'agit d'un flux historique, `DECLAS_HIST.DATE_FIN` ne doit pas etre
utilisee pour exclure une ligne transferee dans la periode. Un dossier transfere
en perte pendant le mois reste dans le flux du mois, meme s'il est solde ou
recouvre ensuite.

### Formule

Le montant transfere en perte par dossier est le meme socle que le stock initial
en perte, sans deduction des recouvrements :

```sql
MONTANT_TRANSFERE_PERTE =
  DECLAS_HIST.ENCOURS
  - DECLAS_HIST.MONTANT_CAUTION
  - DECLAS_HIST.MONTANT_EPG
```

Le montant consolide est :

```sql
SUM(MONTANT_TRANSFERE_PERTE)
```

Le nombre de dossiers est :

```sql
COUNT(DISTINCT DECLAS_HIST.NUM_DOSSIER)
```

Le rattachement agence se fait par le prefixe du dossier :

```sql
LEFT(DECLAS_HIST.NUM_DOSSIER, 3)
```

`CREDIT_PERTE` ne doit pas etre utilise pour cet indicateur, car cette table
porte les recouvrements.

### Dispatch detail agence

Quand l'utilisateur clique sur une mutuelle depuis le detail `Transfere en
Perte`, la repartition est presentee par produit de credit.

Le lien produit utilise :

```sql
DECLAS_HIST.NUM_DOSSIER = PRETS.NUM_DOSSIER
PRETS.REF_DEMANDE = DEMPRET.REF_DEMANDE
DEMPRET.COD_PRDT_CRD = PRDT_CRD.COD_PRDT_CRD
```

Le montant par produit est :

```sql
SUM(MONTANT_TRANSFERE_PERTE)
```

Les dossiers dont le produit de credit ne peut pas etre retrouve sont conserves
dans une ligne fonctionnelle `Produit non identifie`, afin que la somme du
detail produit reste egale au montant transfere en perte de la mutuelle.

### Detail nominatif par produit

Quand l'utilisateur clique sur un produit de credit, l'application affiche la
liste nominative des dossiers transferes en perte pour la meme mutuelle et la
meme periode.

Les informations nominatives sont recuperees par :

```sql
DECLAS_HIST.NUM_DOSSIER = PRETS.NUM_DOSSIER
PRETS.REF_DEMANDE = DEMPRET.REF_DEMANDE
DEMPRET.COD_ADH = ADHERENT.COD_ADH
```

Le detail affiche par dossier :

- `NUM_DOSSIER`
- nom et code adherent
- telephone si disponible
- numero et date du transfert en perte `DECLAS_HIST.NUM_TRANS` /
  `DECLAS_HIST.DATE_DECLAS_HIST`
- encours brut
- caution
- EPG
- montant transfere net

La somme des montants transferes des dossiers doit etre egale au montant du
produit clique.

Comme les autres indicateurs, l'agence faitiere definie dans la base SQLite
locale est exclue par defaut tant que l'option Integrer les donnees faitiere
n'est pas cochee.

## Encours epargne

### Definition metier

L'indicateur `Encours epargne` mesure le solde des comptes d'epargne non clotures
a la date d'arret Perfect.

La date d'arret est :

```sql
@AsOfDate = CAST((SELECT MAX(DATE_JOUR) FROM JOURNEE) AS date)
```

### Population des comptes

La population est l'union des comptes suivants :

- epargne a vue et epargne de garantie : `COMPTES_EPG`
- depot a terme : `COMPTES_DAT`
- epargne tontine : `T_COMPTES`
- versements collecteur tontine : `COMPTES` avec `CPTE_GAL = '251214'`

Dans le detail par agence, tous les produits `COMPTES_DAT` sont regroupes en une
seule ligne fonctionnelle `Depots a terme`, au lieu d'etre presentes par code
`COD_PRDT_DAT`.

Les comptes clotures sont exclus de l'encours. Pour une situation a date, la
condition retenue est :

```sql
DATE_CLOTURE IS NULL OR DATE_CLOTURE > @AsOfDate
```

Pour `T_COMPTES`, `ETAT_CLOTURE` est egalement controle :

```sql
ETAT_CLOTURE IS NULL OR ETAT_CLOTURE = 0 OR DATE_CLOTURE > @AsOfDate
```

### Rattachement agence

Pour les comptes Perfect classiques :

```sql
COMPTES_EPG.NUM_CPTE = COMPTES.NUM_CPTE
COMPTES_DAT.NUM_CPTE = COMPTES.NUM_CPTE
COMPTES.COD_AGENCE = AGENCE.COD_AGENCE
```

Pour les comptes tontine :

```sql
T_COMPTES.NUM_CMPTE = HDPM.NUM_CPTE
T_COMPTES.CODE_AGENCE = AGENCE.COD_AGENCE
```

Pour les comptes de versement collecteur tontine :

```sql
COMPTES.CPTE_GAL = '251214'
COMPTES.NUM_CPTE = HDPM.NUM_CPTE
COMPTES.COD_AGENCE = AGENCE.COD_AGENCE
```

Note schema confirmee : pour les comptes tontine, `T_COMPTES.NUM_CMPTE` est la
cle qui matche `HDPM.NUM_CPTE`; `T_COMPTES.NUM_CPTE_EPG` ne doit pas etre utilise
pour le calcul de solde.

### Formule

Le solde de chaque compte est calcule depuis `HDPM`, sans tenir compte des reports :

```sql
HDPM.DATE_OPERATION < DATEADD(DAY, 1, @AsOfDate)
ISNULL(HDPM.COD_TYP_OPERAT, '') <> 'REPR'
```

Formule du solde :

```sql
SOLDE_COMPTE =
  SUM(CASE
    WHEN HDPM.SENS_OPERATION = 'C' THEN HDPM.MONTANT_TRANS
    WHEN HDPM.SENS_OPERATION = 'D' THEN -HDPM.MONTANT_TRANS
    ELSE 0
  END)
```

L'encours epargne consolide est la somme des `SOLDE_COMPTE` de tous les comptes
eligibles.

### Evolution mensuelle par agence

Lorsque l'on clique sur une agence, la page de detail affiche aussi l'evolution
de l'encours epargne sur l'exercice courant.

Pour chaque mois de l'exercice, le point du graphique correspond a la situation
de fin de mois. Pour le mois courant, la date retenue est la date d'arret Perfect
si le mois n'est pas termine :

```sql
DATE_POINT = MIN(EOMONTH(mois), @AsOfDate)
```

La population et la formule de solde sont identiques a celles de l'encours
epargne principal, mais le test de cloture est applique a chaque `DATE_POINT` :

```sql
DATE_CLOTURE IS NULL OR DATE_CLOTURE > DATE_POINT
```

Comme les autres indicateurs, l'agence faitiere definie dans la base SQLite
locale est exclue par defaut tant que l'option `Integrer les donnees faitiere`
n'est pas cochee.

## Resultat

### Definition metier

L'indicateur `Resultat` mesure le resultat de l'exercice en cours, depuis le
1er janvier de l'annee de la journee Perfect jusqu'a la date d'arret.

La date d'arret et le debut d'exercice sont :

```sql
@AsOfDate = CAST((SELECT MAX(DATE_JOUR) FROM JOURNEE) AS date)
@ExerciseStart = DATEFROMPARTS(YEAR(@AsOfDate), 1, 1)
```

### Source et rattachement agence

La source confirmee est `HDPM`.

Le rattachement par mutuelle se fait par le compte :

```sql
HDPM.NUM_CPTE = COMPTES.NUM_CPTE
COMPTES.COD_AGENCE = AGENCE.COD_AGENCE
```

Les lignes retenues sont uniquement les operations de l'exercice sur les comptes
de charges et produits :

```sql
HDPM.DATE_OPERATION >= @ExerciseStart
HDPM.DATE_OPERATION < DATEADD(DAY, 1, @AsOfDate)
HDPM.NUM_CPTE LIKE '7%' OR HDPM.NUM_CPTE LIKE '6%'
```

### Formule

La formule confirmee est :

```sql
RESULTAT =
  CREDIT CLASSE 7 - DEBIT CLASSE 7
+ CREDIT CLASSE 6 - DEBIT CLASSE 6
```

Dans `HDPM`, le sens de l'operation est porte par `SENS_OPERATION` :

```sql
CASE
  WHEN HDPM.SENS_OPERATION = 'C' THEN HDPM.MONTANT_TRANS
  WHEN HDPM.SENS_OPERATION = 'D' THEN -HDPM.MONTANT_TRANS
  ELSE 0
END
```

Comme les autres indicateurs, l'agence faitiere definie dans la base SQLite
locale est exclue par defaut tant que l'option `Integrer les donnees faitiere`
n'est pas cochee.

### Detail agence par plan comptable

Depuis le detail par agence de l'indicateur `Resultat`, un clic sur une mutuelle
ouvre une arborescence comptable de l'exercice :

- niveau 1 : `Produits` et `Charges`
- niveau 2 : comptes generaux du plan comptable
- niveau 3 : comptes mouvementes de la mutuelle

Le rattachement au plan comptable utilise :

```sql
COMPTES.CPTE_GAL = PLANCPTE.CPTE_GAL
```

Les champs affiches sont :

- numero de compte general : `PLANCPTE.CPTE_GAL`
- libelle de compte general : `PLANCPTE.LIB_CPTE_GAL`
- numero de compte mouvemente : `COMPTES.NUM_CPTE`
- libelle de compte mouvemente : `COMPTES.INTITULE_CPTE`
- solde : somme signee des mouvements `HDPM` de l'exercice selon la formule du resultat

La somme des soldes de tous les comptes affiches doit etre egale au resultat de
la mutuelle sur la page detail. La somme des mutuelles reste egale au resultat
consolide de la page d'accueil, sous reserve du meme parametrage d'exclusion de
l'agence faitiere.

### Grand livre d'un compte de resultat

Depuis l'arborescence du resultat d'une mutuelle, un clic sur un compte
mouvemente `COMPTES.NUM_CPTE` ouvre le grand livre de ce compte.

La periode par defaut est :

```sql
@StartDate = DATEFROMPARTS(YEAR(@AsOfDate), 1, 1)
@EndDate = @AsOfDate
```

L'utilisateur peut saisir manuellement une date de debut et une date de fin.
Dans ce cas, le report est recalcule a la borne inferieure :

```sql
REPORT_AVANT_PERIODE =
  SUM(CASE
    WHEN HDPM.SENS_OPERATION = 'C' THEN HDPM.MONTANT_TRANS
    WHEN HDPM.SENS_OPERATION = 'D' THEN -HDPM.MONTANT_TRANS
    ELSE 0
  END)
  WHERE HDPM.NUM_CPTE = @AccountNumber
    AND HDPM.DATE_OPERATION < @StartDate
```

Les lignes du grand livre sont limitees a la periode :

```sql
HDPM.DATE_OPERATION >= @StartDate
HDPM.DATE_OPERATION < DATEADD(DAY, 1, @EndDate)
```

Les colonnes affichees viennent de `HDPM` :

- date operation : `DATE_OPERATION`
- numero de piece : `COALESCE(NUM_PIECE_MANUEL, NUM_PIECE, NUM_MVT)`
- libelle : `DESCRIPTION`
- debit : `MONTANT_TRANS` quand `SENS_OPERATION = 'D'`
- credit : `MONTANT_TRANS` quand `SENS_OPERATION = 'C'`
- solde : report + cumul signe des lignes de la periode

Pour rester coherent avec l'indicateur `Resultat`, le solde du grand livre des
comptes de classes 6 et 7 utilise la meme convention signee :

```sql
CREDIT - DEBIT
```

## Operations de caisse

### Definition metier

L'indicateur remplace l'ancien bloc `Agences / Mutuelles` sur la page d'accueil.
Il mesure les mouvements de caisse de la journee operationnelle uniquement, avec
une separation entre entrees et sorties.

La date retenue est :

```sql
@AsOfDate = MAX(JOURNEE.DATE_JOUR)
```

Contrairement aux indicateurs mensuels, il n'y a pas de `@MonthStart` : les lignes
sont limitees a la seule journee d'arret.

### Sources confirmees

Les sources sont combinees sans table temporaire et sans ecriture dans la base
Perfect :

- `OPERATION` : depots, retraits, depots tontine, retraits tontine, autres produits, autres charges
- `COMMISSION_CRD` : commissions sur credit
- `DEMPRET` : lien de `COMMISSION_CRD.REF_DEMANDE` vers l'adherent du dossier
- `TYPE_FRAIS_CRD` : libelle de la commission credit
- `PART_SOCIAL` : achats de parts sociales
- `VALEUR_PART` : valeur unitaire de la part sociale a la date de part
- `RUBINS` : adhesions
- `RUBINS_RUBADH` : montant des adhesions avec `COD_RUBADH = '01'`
- `RUBADH` : libelle de la rubrique d'adhesion
- `CAIS_AGENCE` : rattachement caisse vers agence
- `COMPTES` : libelle du compte pour les operations issues de `OPERATION`
- `ADHERENT` : nom et prenom de l'adherent quand le code adherent est disponible

Note schema : la table appelee oralement `RUBINS_RUBINS` correspond dans la base
a la table reelle `RUBINS_RUBADH`.

### Dates retenues

```sql
OPERATION.DATE_OPERATION >= @AsOfDate
AND OPERATION.DATE_OPERATION < DATEADD(DAY, 1, @AsOfDate)

COALESCE(COMMISSION_CRD.DATE_OPERATION, COMMISSION_CRD.DATE_VALIDATION) >= @AsOfDate
AND COALESCE(COMMISSION_CRD.DATE_OPERATION, COMMISSION_CRD.DATE_VALIDATION) < DATEADD(DAY, 1, @AsOfDate)
AND COMMISSION_CRD.COD_MODE_PAIE = 'ES'

COALESCE(PART_SOCIAL.DATE_PART_SOC, PART_SOCIAL.DATE_VALIDATION, PART_SOCIAL.DATE_PART) >= @AsOfDate
AND COALESCE(PART_SOCIAL.DATE_PART_SOC, PART_SOCIAL.DATE_VALIDATION, PART_SOCIAL.DATE_PART) < DATEADD(DAY, 1, @AsOfDate)
AND PART_SOCIAL.KP_CAIS_AGENCE IS NOT NULL
AND LTRIM(RTRIM(PART_SOCIAL.KP_CAIS_AGENCE)) <> ''

COALESCE(RUBINS.DATE_RUBINS, RUBINS.DATE_VALIDATION) >= @AsOfDate
AND COALESCE(RUBINS.DATE_RUBINS, RUBINS.DATE_VALIDATION) < DATEADD(DAY, 1, @AsOfDate)
```

### Formule d'accueil

```sql
ENTREES = SUM(montant des categories en direction IN)
SORTIES = SUM(montant des categories en direction OUT)
NOMBRE_OPERATIONS = COUNT_BIG(*)
MOUVEMENT_TOTAL = ENTREES + SORTIES
```

La page d'accueil affiche les entrees et sorties avec une fleche montante et une
fleche descendante. La page detail consolidee affiche les memes montants par agence
avec le nombre d'operations.

Sur la page `Types d'operations par caisse`, le mouvement total affiche en haut
n'est pas la somme des entrees et sorties. Il correspond au solde calcule :

```sql
SOLDE_CALCULE = DETAIL_CAIS.SOLDE_VEILLE + ENTREES - SORTIES
```

Le `SOLDE_VEILLE` est recupere dans `DETAIL_CAIS` sur la ligne de la journee et
de la caisse concernees :

```sql
DETAIL_CAIS.KP_JOURNEE = JOURNEE.KP_JOURNEE
DETAIL_CAIS.KP_CAIS_AGENCE = @CashDeskKey
CAST(JOURNEE.DATE_JOUR AS date) = @AsOfDate
JOURNEE.COD_AGENCE = @AgencyCode
```

### Navigation detail

La navigation confirmee est :

1. clic sur l'indicateur : repartition par agence
2. clic sur une agence : repartition par caisse via `CAIS_AGENCE.KP_CAIS_AGENCE`
3. clic sur une caisse : dispatch par type d'operation
4. clic sur un type : detail des lignes d'operations

Le detail ligne par ligne affiche notamment :

- libelle de l'operation
- numero de transaction
- numero de compte si disponible
- intitule du compte ou nom de l'adherent
- montant
- utilisateur
- description

### Dispatch par type d'operation

Lorsqu'on clique sur une caisse, la page detail affiche les categories suivantes :

- `depot` : lignes `OPERATION` dont `NUM_TRANS LIKE '%DEP%'` ou `NUM_TRANS LIKE '%ADH%'`, avec `NUM_CHEQUE` vide
- `depot-tontine` : lignes `OPERATION` dont `NUM_TRANS LIKE '%DEP%'`, avec `NUM_CHEQUE` non vide
- `retrait` : lignes `OPERATION` dont `NUM_TRANS LIKE '%RET%'`, avec `NUM_CHEQUE` vide
- `retrait-tontine` : lignes `OPERATION` dont `NUM_TRANS LIKE '%RET%'`, avec `NUM_CHEQUE` non vide
- `autres-produits` : lignes `OPERATION` dont `NUM_TRANS LIKE '%AOP%'`, hors `COD_TYP_OPERAT = 'MOD1'`
- `autres-charges` : lignes `OPERATION` dont `NUM_TRANS LIKE '%AOC%'`, hors `COD_TYP_OPERAT = 'MOR1'`
- `commissions-credit` : lignes `COMMISSION_CRD` payees en especes uniquement, donc `COD_MODE_PAIE = 'ES'`, avec libelle `TYPE_FRAIS_CRD.LIBELLE_TYPE_FCRD`
- `parts-sociales` : lignes `PART_SOCIAL` rattachees a une caisse uniquement, donc `KP_CAIS_AGENCE` non vide, montant = `NBRE_PART_SOC * VALEUR_PART.VAL_PART`
- `adhesions` : lignes `RUBINS` jointes a `RUBINS_RUBADH` avec `COD_RUBADH = '01'`, montant = `RUBINS_RUBADH.MONTANT_PAYE`

Un `NUM_CHEQUE` vide signifie `NULL` ou chaine vide apres trim.

Les lignes `OPERATION` suivantes sont exclues des operations de caisse :

- `COD_TYP_OPERAT = 'MOR1'` sur les autres operations de charges, car il s'agit
  d'operations Bank to Wallet
- `COD_TYP_OPERAT = 'MOD1'` sur les autres operations de produits, car il s'agit
  d'operations Wallet to Bank

## Mobile Money

### Definition metier

L'indicateur `Mobile Money` mesure les operations wallet de la journee
operationnelle uniquement.

La date d'arret est :

```sql
@AsOfDate = MAX(JOURNEE.DATE_JOUR)
```

Il regroupe deux mouvements :

- depots : operations Wallet to Bank
- retraits : operations Bank to Wallet

### Source et classification

La source est `OPERATION`.

Les depots Wallet to Bank sont les lignes :

```sql
OPERATION.NUM_TRANS LIKE '%AOP%'
OPERATION.COD_TYP_OPERAT = 'MOD1'
```

Les retraits Bank to Wallet sont les lignes :

```sql
OPERATION.NUM_TRANS LIKE '%AOC%'
OPERATION.COD_TYP_OPERAT = 'MOR1'
```

La periode retenue est la journee operationnelle :

```sql
OPERATION.DATE_OPERATION >= @AsOfDate
OPERATION.DATE_OPERATION < DATEADD(DAY, 1, @AsOfDate)
```

### Formule

```sql
DEPOTS_MOBILE_MONEY =
  SUM(OPERATION.MONTANT)
  WHERE COD_TYP_OPERAT = 'MOD1'

RETRAITS_MOBILE_MONEY =
  SUM(OPERATION.MONTANT)
  WHERE COD_TYP_OPERAT = 'MOR1'

MOBILE_MONEY_TOTAL =
  DEPOTS_MOBILE_MONEY + RETRAITS_MOBILE_MONEY
```

Le rattachement agence suit les operations de caisse :

```sql
COALESCE(CAIS_AGENCE.COD_AGENCE, COMPTES.COD_AGENCE, LEFT(OPERATION.NUM_TRANS, 3))
```

Comme les autres indicateurs, l'agence faitiere definie dans la base SQLite locale
est exclue par defaut tant que l'option `Integrer les donnees faitiere` n'est pas
cochee.

### Navigation detail

La navigation de l'indicateur est :

1. clic sur l'indicateur : repartition Mobile Money par agence
2. clic sur une agence : repartition en deux rubriques
   - `wallet-to-bank` : depots Wallet to Bank
   - `bank-to-wallet` : retraits Bank to Wallet
3. clic sur une rubrique : liste nominative des operations de la rubrique

La liste nominative affiche notamment :

- date et numero de transaction
- compte et intitule/client
- caisse si disponible
- utilisateur
- description
- montant

La somme des lignes d'une rubrique doit etre egale au montant de la rubrique
cliquee, et la somme des rubriques doit etre egale au total Mobile Money de
l'agence.

## Tresorerie

### Definition metier

L'indicateur `Tresorerie` mesure les avoirs disponibles aux caisses et dans les
banques a la date d'arret Perfect.

La date d'arret est :

```sql
@AsOfDate = CAST((SELECT MAX(DATE_JOUR) FROM JOURNEE) AS date)
```

### Population des comptes

Les avoirs aux caisses sont rattaches par les caisses parametrées :

```sql
CAIS_AGENCE.NUM_CPTE = COMPTES.NUM_CPTE
CAIS_AGENCE.COD_AGENCE = AGENCE.COD_AGENCE
```

Les comptes de caisse sont dedoubles par numero de compte afin d'eviter un
double comptage lorsqu'un meme compte est reference par plusieurs caisses.

Les avoirs en banque sont lus dans `COMPTES`, sur les comptes ouverts dont
`CPTE_GAL` correspond aux comptes bancaires observes dans le plan Perfect :

```sql
COMPTES.CPTE_GAL LIKE '1111212%'
OR COMPTES.CPTE_GAL LIKE '1131%'
OR COMPTES.CPTE_GAL LIKE '1141%'
```

Les comptes clotures a la date d'arret sont exclus :

```sql
COMPTES.DATE_CLOTURE IS NULL OR COMPTES.DATE_CLOTURE > @AsOfDate
```

### Formule

Le solde de chaque compte est calcule depuis `HDPM`, sans tenir compte des
reports :

```sql
HDPM.DATE_OPERATION < DATEADD(DAY, 1, @AsOfDate)
ISNULL(HDPM.COD_TYP_OPERAT, '') <> 'REPR'
```

Comme les comptes de tresorerie sont des comptes d'actif, le solde retenu est :

```sql
SOLDE_TRESORERIE_COMPTE =
  SUM(CASE
    WHEN HDPM.SENS_OPERATION = 'D' THEN HDPM.MONTANT_TRANS
    WHEN HDPM.SENS_OPERATION = 'C' THEN -HDPM.MONTANT_TRANS
    ELSE 0
  END)
```

L'indicateur consolide est :

```sql
TRESORERIE =
  SUM(SOLDE_TRESORERIE_COMPTE pour les comptes de caisse)
+ SUM(SOLDE_TRESORERIE_COMPTE pour les comptes de banque)
```

Le detail par agence affiche la meme population avec deux colonnes :

- `Caisses`
- `Banques`

Comme les autres indicateurs, l'agence faitiere definie dans la base SQLite locale
est exclue par defaut tant que l'option `Integrer les donnees faitiere` n'est pas
cochee.

### Formules specifiques

Commissions sur credit :

```sql
COMMISSION_CRD.REF_DEMANDE = DEMPRET.REF_DEMANDE
DEMPRET.COD_ADH = ADHERENT.COD_ADH
COMMISSION_CRD.COD_TYPE_FRAIS = TYPE_FRAIS_CRD.CODE_TYPE_FCRD
COMMISSION_CRD.COD_MODE_PAIE = 'ES'
MONTANT = COMMISSION_CRD.MONTANT
```

Parts sociales :

```sql
CAST(PART_SOCIAL.DATE_PART AS date) = CAST(VALEUR_PART.DATE_PART AS date)
PART_SOCIAL.KP_CAIS_AGENCE non vide
MONTANT = PART_SOCIAL.NBRE_PART_SOC * VALEUR_PART.VAL_PART
```

Adhesions :

```sql
RUBINS.NUM_TRANS = RUBINS_RUBADH.NUM_TRANS
RUBINS_RUBADH.COD_RUBADH = '01'
MONTANT = RUBINS_RUBADH.MONTANT_PAYE
```

### Parametrage faitiere

Comme les autres indicateurs, l'agence faitiere definie dans la base SQLite locale
est exclue par defaut tant que l'option `Integrer les donnees faitiere` n'est pas
cochee.

### Parametrage conso mutuelles

L'acces au parametrage general peut etre protege par un PIN administrateur local.
Ce PIN protege la page de parametrage et la creation, modification ou suppression
des profils de conso mutuelles.

Un profil de conso mutuelles contient :

- un nom de profil
- un PIN de profil
- une liste explicite de codes agences autorises

L'activation d'un profil se fait depuis l'interface d'accueil avec le PIN du
profil. Elle est stockee localement dans le navigateur/poste courant, sans
authentification utilisateur complete.

La desactivation d'un profil actif exige egalement le PIN du profil actif.

Quand un profil de conso mutuelles est actif :

- tous les indicateurs sont limites aux agences du profil actif
- l'option `Integrer les donnees faitiere` est forcee a non
- l'option `Integrer les donnees faitiere` est grisee dans l'interface
- les pages de detail agence refusent l'acces aux agences hors profil

Quand aucun profil de conso mutuelles n'est actif, le comportement historique est
conserve : l'agence faitiere reste exclue par defaut et peut etre incluse via
l'option `Integrer les donnees faitiere`.

Lorsque le PIN administrateur est configure, l'interface redemande le PIN a
chaque entree sur la page `Parametres`. Le deblocage sert uniquement a travailler
sur cette page pendant la session courante.

## Indicateurs en attente de formalisation metier

Les indicateurs suivants doivent encore etre confirmes avec leurs regles de calcul exactes :

- `Decaissements`

## Regle de maintenance

Toute nouvelle definition validee par le metier doit etre ajoutee ici avec :

- la definition fonctionnelle
- les tables utilisees
- les champs utilises
- les jointures
- la date d'arret / periode
- la formule
- les exceptions

## Procedure operationnelle - Deconnexion utilisateur Perfect

### Objectif

Forcer la deconnexion d'un utilisateur Perfect sur une agence donnee sans modifier ses habilitations.

### Tables concernees

- `UTILISATEUR` : referentiel utilisateur
- `UTIL_AGENCE` : etat de connexion par utilisateur et par agence
- `USER_TEMP` : etat temporaire de connexion
- `WS_SESSION` : sessions web eventuelles

### Identification utilisateur

Le login Perfect est porte par `UTILISATEUR.COD_UTIL`.

```sql
SELECT CODE_USER, COD_UTIL, NOM_UTIL
FROM UTILISATEUR
WHERE COD_UTIL = @Login;
```

`CODE_USER` permet ensuite de cibler l'utilisateur dans `UTIL_AGENCE` et `USER_TEMP`.

### Verification de l'etat de connexion

```sql
SELECT ID_UTIL, CODE_USER, COD_AGENCE, CONNECTE, ADR_IP_CONNECT, KP_CAIS_AGENCE
FROM UTIL_AGENCE
WHERE CODE_USER = @CodeUser
  AND COD_AGENCE = @CodAgence;

SELECT COD_UTIL, CODE_USER, COD_AGENCE, CONNECTE, ADR_IP_CONNECT, KP_CAIS_AGENCE
FROM USER_TEMP
WHERE CODE_USER = @CodeUser
  AND COD_AGENCE = @CodAgence;
```

### Deconnexion forcee

La deconnexion consiste a remettre `CONNECTE` a `0` et a vider `ADR_IP_CONNECT` pour l'agence cible.

```sql
BEGIN TRAN;

UPDATE UTIL_AGENCE
SET CONNECTE = 0,
    ADR_IP_CONNECT = ''
WHERE CODE_USER = @CodeUser
  AND COD_AGENCE = @CodAgence;

UPDATE USER_TEMP
SET CONNECTE = 0,
    ADR_IP_CONNECT = ''
WHERE CODE_USER = @CodeUser
  AND COD_AGENCE = @CodAgence;

COMMIT;
```

### Regle importante

Ne pas supprimer l'utilisateur et ne pas modifier ses habilitations. La procedure ne doit agir que sur l'etat de connexion de l'agence cible.

Cas confirme :

- utilisateur `guyak89`, `CODE_USER = 36`, agence `A01`
- champ actif trouve dans `UTIL_AGENCE`
- action appliquee : `CONNECTE = 0`, `ADR_IP_CONNECT = ''`
