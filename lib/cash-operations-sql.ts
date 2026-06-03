import { agencyScopeSql } from "@/lib/agency-profiles";

export const CASH_CATEGORIES_CTE = `
CashCategories AS (
  SELECT *
  FROM (VALUES
    ('depot', N'Depots', 'IN', 1),
    ('retrait', N'Retraits', 'OUT', 2),
    ('depot-tontine', N'Depots tontine', 'IN', 3),
    ('retrait-tontine', N'Retraits tontine', 'OUT', 4),
    ('adhesions', N'Adhesions', 'IN', 5),
    ('parts-sociales', N'Achat de parts sociales', 'IN', 6),
    ('commissions-credit', N'Commissions sur credit', 'IN', 7),
    ('autres-produits', N'Autres operations de produits', 'IN', 8),
    ('autres-charges',    N'Autres operations de charges',   'OUT', 9),
    ('transferts-emis',  N'Transferts emis entre caisses',  'OUT', 10),
    ('transferts-recus', N'Transferts recus entre caisses', 'IN',  11)
  ) AS v(categoryCode, categoryLabel, direction, sortOrder)
)`;

export const CASH_OPERATIONS_CTE = `
CashOperationsSource AS (
  SELECT
    CAST(COALESCE(ca.COD_AGENCE, compte.COD_AGENCE, CASE WHEN o.NUM_TRANS LIKE 'A[0-9][0-9]%' THEN LEFT(o.NUM_TRANS, 3) END) AS varchar(20)) COLLATE DATABASE_DEFAULT AS agencyCode,
    CAST(COALESCE(NULLIF(o.KP_CAIS_AGENCE, ''), 'SANS-CAISSE') AS varchar(40)) COLLATE DATABASE_DEFAULT AS cashDeskKey,
    CAST(COALESCE(NULLIF(ca.COD_CAIS, ''), 'N/A') AS varchar(20)) COLLATE DATABASE_DEFAULT AS cashDeskCode,
    CAST(CASE WHEN ca.COD_CAIS IS NULL THEN N'Caisse non rattachee' ELSE COALESCE(cais.LIB_CAIS, N'Caisse ' + ca.COD_CAIS) END AS nvarchar(120)) COLLATE DATABASE_DEFAULT AS cashDeskLabel,
    CAST(ca.NUM_CPTE AS varchar(22)) COLLATE DATABASE_DEFAULT AS cashDeskAccount,
    CAST('OPERATION' AS varchar(20)) COLLATE DATABASE_DEFAULT AS operationSource,
    CAST(o.NUM_TRANS AS varchar(80)) COLLATE DATABASE_DEFAULT AS operationId,
    CAST(o.NUM_TRANS AS varchar(80)) COLLATE DATABASE_DEFAULT AS operationNumber,
    CAST(o.BORDEREAU AS varchar(80)) COLLATE DATABASE_DEFAULT AS receiptNumber,
    CAST(o.COD_TYP_OPERAT AS varchar(30)) COLLATE DATABASE_DEFAULT AS operationCode,
    CAST(COALESCE(t.LIB_TYP_OPRAT, cat.categoryLabel, o.COD_TYP_OPERAT) AS nvarchar(160)) COLLATE DATABASE_DEFAULT AS operationLabel,
    CAST(cat.categoryCode AS varchar(40)) COLLATE DATABASE_DEFAULT AS categoryCode,
    CAST(cat.categoryLabel AS nvarchar(120)) COLLATE DATABASE_DEFAULT AS categoryLabel,
    CAST(cat.direction AS varchar(3)) COLLATE DATABASE_DEFAULT AS direction,
    CAST(ISNULL(o.MONTANT, 0) AS decimal(18, 2)) AS amount,
    CAST(o.DATE_OPERATION AS datetime) AS operationDate,
    CAST(o.NUM_CPTE AS varchar(22)) COLLATE DATABASE_DEFAULT AS accountNumber,
    CAST(compte.INTITULE_CPTE AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS accountLabel,
    CAST(NULL AS varchar(20)) COLLATE DATABASE_DEFAULT AS customerCode,
    CAST(compte.INTITULE_CPTE AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS customerName,
    CAST(o.COD_UTIL AS varchar(50)) COLLATE DATABASE_DEFAULT AS userCode,
    CAST(o.CODE_AGENT_TERRAIN AS varchar(20)) COLLATE DATABASE_DEFAULT AS collectorCode,
    CAST(NULL AS nvarchar(140)) COLLATE DATABASE_DEFAULT AS collectorName,
    CAST(COALESCE(o.DESCRIPTION, t.LIB_TYP_OPRAT, cat.categoryLabel, o.COD_TYP_OPERAT) AS nvarchar(320)) COLLATE DATABASE_DEFAULT AS description,
    CAST(o.NUM_CHEQUE AS varchar(80)) COLLATE DATABASE_DEFAULT AS chequeNumber,
    CAST(o.CODE_DEVISE AS varchar(10)) COLLATE DATABASE_DEFAULT AS currencyCode
  FROM dbo.OPERATION o WITH (NOLOCK)
  LEFT JOIN dbo.CAIS_AGENCE ca WITH (NOLOCK)
    ON ca.KP_CAIS_AGENCE = o.KP_CAIS_AGENCE
  LEFT JOIN dbo.CAISSE cais WITH (NOLOCK)
    ON cais.COD_CAIS COLLATE DATABASE_DEFAULT = ca.COD_CAIS COLLATE DATABASE_DEFAULT
  LEFT JOIN dbo.COMPTES compte WITH (NOLOCK)
    ON compte.NUM_CPTE COLLATE DATABASE_DEFAULT = o.NUM_CPTE COLLATE DATABASE_DEFAULT
  LEFT JOIN dbo.TYPE_OPERATION t WITH (NOLOCK)
    ON t.COD_TYP_OPERAT COLLATE DATABASE_DEFAULT = o.COD_TYP_OPERAT COLLATE DATABASE_DEFAULT
  CROSS APPLY (
    SELECT
      CASE
        WHEN (o.NUM_TRANS LIKE '%DEP%' OR o.NUM_TRANS LIKE '%ADH%')
          AND NULLIF(LTRIM(RTRIM(ISNULL(o.NUM_CHEQUE, ''))), '') IS NULL
          THEN 'depot'
        WHEN o.NUM_TRANS LIKE '%DEP%'
          AND NULLIF(LTRIM(RTRIM(ISNULL(o.NUM_CHEQUE, ''))), '') IS NOT NULL
          THEN 'depot-tontine'
        WHEN o.NUM_TRANS LIKE '%RET%'
          AND NULLIF(LTRIM(RTRIM(ISNULL(o.NUM_CHEQUE, ''))), '') IS NULL
          THEN 'retrait'
        WHEN o.NUM_TRANS LIKE '%RET%'
          AND NULLIF(LTRIM(RTRIM(ISNULL(o.NUM_CHEQUE, ''))), '') IS NOT NULL
          THEN 'retrait-tontine'
        WHEN o.NUM_TRANS LIKE '%AOP%' AND ISNULL(o.COD_TYP_OPERAT, '') <> 'MOD1' THEN 'autres-produits'
        WHEN o.NUM_TRANS LIKE '%AOC%' AND ISNULL(o.COD_TYP_OPERAT, '') <> 'MOR1' THEN 'autres-charges'
      END AS categoryCode
  ) ruleMatch
  CROSS APPLY (
    SELECT
      ruleMatch.categoryCode,
      CASE ruleMatch.categoryCode
        WHEN 'depot' THEN N'Depots'
        WHEN 'retrait' THEN N'Retraits'
        WHEN 'depot-tontine' THEN N'Depots tontine'
        WHEN 'retrait-tontine' THEN N'Retraits tontine'
        WHEN 'autres-produits' THEN N'Autres operations de produits'
        WHEN 'autres-charges' THEN N'Autres operations de charges'
      END AS categoryLabel,
      CASE
        WHEN ruleMatch.categoryCode IN ('depot', 'depot-tontine', 'autres-produits') THEN 'IN'
        WHEN ruleMatch.categoryCode IS NOT NULL THEN 'OUT'
      END AS direction
  ) cat
  WHERE o.DATE_OPERATION >= @AsOfDate
    AND o.DATE_OPERATION < DATEADD(DAY, 1, @AsOfDate)
    AND cat.categoryCode IS NOT NULL

  UNION ALL

  SELECT
    CAST(COALESCE(ca.COD_AGENCE, adh.COD_AGENCE, CASE WHEN cc.NUM_TRANS LIKE 'A[0-9][0-9]%' THEN LEFT(cc.NUM_TRANS, 3) END) AS varchar(20)) COLLATE DATABASE_DEFAULT AS agencyCode,
    CAST(COALESCE(NULLIF(cc.KP_CAIS_AGENCE, ''), 'SANS-CAISSE') AS varchar(40)) COLLATE DATABASE_DEFAULT AS cashDeskKey,
    CAST(COALESCE(NULLIF(ca.COD_CAIS, ''), 'N/A') AS varchar(20)) COLLATE DATABASE_DEFAULT AS cashDeskCode,
    CAST(CASE WHEN ca.COD_CAIS IS NULL THEN N'Caisse non rattachee' ELSE COALESCE(cais.LIB_CAIS, N'Caisse ' + ca.COD_CAIS) END AS nvarchar(120)) COLLATE DATABASE_DEFAULT AS cashDeskLabel,
    CAST(ca.NUM_CPTE AS varchar(22)) COLLATE DATABASE_DEFAULT AS cashDeskAccount,
    CAST('COMMISSION_CRD' AS varchar(20)) COLLATE DATABASE_DEFAULT AS operationSource,
    CAST(CONCAT(ISNULL(cc.NUM_TRANS, ''), ':', ISNULL(cc.COD_TYPE_FRAIS, ''), ':', ISNULL(CONVERT(varchar(40), cc.MONTANT), '')) AS varchar(80)) COLLATE DATABASE_DEFAULT AS operationId,
    CAST(cc.NUM_TRANS AS varchar(80)) COLLATE DATABASE_DEFAULT AS operationNumber,
    CAST(cc.BORDEREAU AS varchar(80)) COLLATE DATABASE_DEFAULT AS receiptNumber,
    CAST(cc.COD_TYPE_FRAIS AS varchar(30)) COLLATE DATABASE_DEFAULT AS operationCode,
    CAST(COALESCE(tf.LIBELLE_TYPE_FCRD, cc.COD_TYPE_FRAIS, N'Commission sur credit') AS nvarchar(160)) COLLATE DATABASE_DEFAULT AS operationLabel,
    CAST('commissions-credit' AS varchar(40)) COLLATE DATABASE_DEFAULT AS categoryCode,
    CAST(N'Commissions sur credit' AS nvarchar(120)) COLLATE DATABASE_DEFAULT AS categoryLabel,
    CAST('IN' AS varchar(3)) COLLATE DATABASE_DEFAULT AS direction,
    CAST(ISNULL(cc.MONTANT, 0) AS decimal(18, 2)) AS amount,
    CAST(COALESCE(cc.DATE_OPERATION, cc.DATE_VALIDATION) AS datetime) AS operationDate,
    CAST(cc.NUM_CPTE AS varchar(22)) COLLATE DATABASE_DEFAULT AS accountNumber,
    CAST(NULL AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS accountLabel,
    CAST(d.COD_ADH AS varchar(20)) COLLATE DATABASE_DEFAULT AS customerCode,
    CAST(adh.NOM_PRENOM AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS customerName,
    CAST(NULL AS varchar(50)) COLLATE DATABASE_DEFAULT AS userCode,
    CAST(cc.CODE_AGENT_TERRAIN AS varchar(20)) COLLATE DATABASE_DEFAULT AS collectorCode,
    CAST(NULL AS nvarchar(140)) COLLATE DATABASE_DEFAULT AS collectorName,
    CAST(COALESCE(tf.LIBELLE_TYPE_FCRD, cc.COD_TYPE_FRAIS, N'Commission sur credit') AS nvarchar(320)) COLLATE DATABASE_DEFAULT AS description,
    CAST(cc.NUM_CHEQUE AS varchar(80)) COLLATE DATABASE_DEFAULT AS chequeNumber,
    CAST(NULL AS varchar(10)) COLLATE DATABASE_DEFAULT AS currencyCode
  FROM dbo.COMMISSION_CRD cc WITH (NOLOCK)
  LEFT JOIN dbo.CAIS_AGENCE ca WITH (NOLOCK)
    ON ca.KP_CAIS_AGENCE = cc.KP_CAIS_AGENCE
  LEFT JOIN dbo.CAISSE cais WITH (NOLOCK)
    ON cais.COD_CAIS COLLATE DATABASE_DEFAULT = ca.COD_CAIS COLLATE DATABASE_DEFAULT
  LEFT JOIN dbo.DEMPRET d WITH (NOLOCK)
    ON d.REF_DEMANDE COLLATE DATABASE_DEFAULT = cc.REF_DEMANDE COLLATE DATABASE_DEFAULT
  LEFT JOIN dbo.ADHERENT adh WITH (NOLOCK)
    ON adh.COD_ADH COLLATE DATABASE_DEFAULT = d.COD_ADH COLLATE DATABASE_DEFAULT
  LEFT JOIN dbo.TYPE_FRAIS_CRD tf WITH (NOLOCK)
    ON tf.CODE_TYPE_FCRD COLLATE DATABASE_DEFAULT = cc.COD_TYPE_FRAIS COLLATE DATABASE_DEFAULT
  WHERE COALESCE(cc.DATE_OPERATION, cc.DATE_VALIDATION) >= @AsOfDate
    AND COALESCE(cc.DATE_OPERATION, cc.DATE_VALIDATION) < DATEADD(DAY, 1, @AsOfDate)
    AND LTRIM(RTRIM(ISNULL(cc.COD_MODE_PAIE, ''))) = 'ES'

  UNION ALL

  SELECT
    CAST(COALESCE(ca.COD_AGENCE, adh.COD_AGENCE, vp.COD_AGENCE, CASE WHEN ps.NUM_TRANS_PART_SOC LIKE 'A[0-9][0-9]%' THEN LEFT(ps.NUM_TRANS_PART_SOC, 3) END) AS varchar(20)) COLLATE DATABASE_DEFAULT AS agencyCode,
    CAST(COALESCE(NULLIF(ps.KP_CAIS_AGENCE, ''), 'SANS-CAISSE') AS varchar(40)) COLLATE DATABASE_DEFAULT AS cashDeskKey,
    CAST(COALESCE(NULLIF(ca.COD_CAIS, ''), 'N/A') AS varchar(20)) COLLATE DATABASE_DEFAULT AS cashDeskCode,
    CAST(CASE WHEN ca.COD_CAIS IS NULL THEN N'Caisse non rattachee' ELSE COALESCE(cais.LIB_CAIS, N'Caisse ' + ca.COD_CAIS) END AS nvarchar(120)) COLLATE DATABASE_DEFAULT AS cashDeskLabel,
    CAST(ca.NUM_CPTE AS varchar(22)) COLLATE DATABASE_DEFAULT AS cashDeskAccount,
    CAST('PART_SOCIAL' AS varchar(20)) COLLATE DATABASE_DEFAULT AS operationSource,
    CAST(ps.NUM_TRANS_PART_SOC AS varchar(80)) COLLATE DATABASE_DEFAULT AS operationId,
    CAST(ps.NUM_TRANS_PART_SOC AS varchar(80)) COLLATE DATABASE_DEFAULT AS operationNumber,
    CAST(ps.BORDEREAU AS varchar(80)) COLLATE DATABASE_DEFAULT AS receiptNumber,
    CAST(ps.TYPE_PART_SOC AS varchar(30)) COLLATE DATABASE_DEFAULT AS operationCode,
    CAST(N'Achat de parts sociales' AS nvarchar(160)) COLLATE DATABASE_DEFAULT AS operationLabel,
    CAST('parts-sociales' AS varchar(40)) COLLATE DATABASE_DEFAULT AS categoryCode,
    CAST(N'Achat de parts sociales' AS nvarchar(120)) COLLATE DATABASE_DEFAULT AS categoryLabel,
    CAST('IN' AS varchar(3)) COLLATE DATABASE_DEFAULT AS direction,
    CAST(ISNULL(ps.NBRE_PART_SOC, 0) * ISNULL(vp.VAL_PART, 0) AS decimal(18, 2)) AS amount,
    CAST(COALESCE(ps.DATE_PART_SOC, ps.DATE_VALIDATION, ps.DATE_PART) AS datetime) AS operationDate,
    CAST(ps.NUM_CPTE AS varchar(22)) COLLATE DATABASE_DEFAULT AS accountNumber,
    CAST(NULL AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS accountLabel,
    CAST(ps.COD_ADH AS varchar(20)) COLLATE DATABASE_DEFAULT AS customerCode,
    CAST(adh.NOM_PRENOM AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS customerName,
    CAST(NULL AS varchar(50)) COLLATE DATABASE_DEFAULT AS userCode,
    CAST(NULL AS varchar(20)) COLLATE DATABASE_DEFAULT AS collectorCode,
    CAST(NULL AS nvarchar(140)) COLLATE DATABASE_DEFAULT AS collectorName,
    CAST(CONCAT(N'Parts sociales: ', ISNULL(CONVERT(varchar(20), ps.NBRE_PART_SOC), '0'), N' x ', ISNULL(CONVERT(varchar(40), vp.VAL_PART), '0')) AS nvarchar(320)) COLLATE DATABASE_DEFAULT AS description,
    CAST(NULL AS varchar(80)) COLLATE DATABASE_DEFAULT AS chequeNumber,
    CAST(ps.CODE_DEVISE AS varchar(10)) COLLATE DATABASE_DEFAULT AS currencyCode
  FROM dbo.PART_SOCIAL ps WITH (NOLOCK)
  LEFT JOIN dbo.CAIS_AGENCE ca WITH (NOLOCK)
    ON ca.KP_CAIS_AGENCE = ps.KP_CAIS_AGENCE
  LEFT JOIN dbo.CAISSE cais WITH (NOLOCK)
    ON cais.COD_CAIS COLLATE DATABASE_DEFAULT = ca.COD_CAIS COLLATE DATABASE_DEFAULT
  LEFT JOIN dbo.ADHERENT adh WITH (NOLOCK)
    ON adh.COD_ADH COLLATE DATABASE_DEFAULT = ps.COD_ADH COLLATE DATABASE_DEFAULT
  OUTER APPLY (
    SELECT TOP (1)
      v.DATE_PART,
      v.VAL_PART,
      v.COD_AGENCE
    FROM dbo.VALEUR_PART v WITH (NOLOCK)
    WHERE CAST(v.DATE_PART AS date) = CAST(ps.DATE_PART AS date)
      AND (
        v.COD_AGENCE IS NULL
        OR v.COD_AGENCE COLLATE DATABASE_DEFAULT = COALESCE(ca.COD_AGENCE, adh.COD_AGENCE) COLLATE DATABASE_DEFAULT
      )
    ORDER BY CASE WHEN v.COD_AGENCE IS NULL THEN 1 ELSE 0 END
  ) vp
  WHERE COALESCE(ps.DATE_PART_SOC, ps.DATE_VALIDATION, ps.DATE_PART) >= @AsOfDate
    AND COALESCE(ps.DATE_PART_SOC, ps.DATE_VALIDATION, ps.DATE_PART) < DATEADD(DAY, 1, @AsOfDate)
    AND NULLIF(LTRIM(RTRIM(ISNULL(ps.KP_CAIS_AGENCE, ''))), '') IS NOT NULL

  UNION ALL

  SELECT
    CAST(COALESCE(ca.COD_AGENCE, adh.COD_AGENCE, CASE WHEN r.NUM_TRANS LIKE 'A[0-9][0-9]%' THEN LEFT(r.NUM_TRANS, 3) END) AS varchar(20)) COLLATE DATABASE_DEFAULT AS agencyCode,
    CAST(COALESCE(NULLIF(r.KP_CAIS_AGENCE, ''), 'SANS-CAISSE') AS varchar(40)) COLLATE DATABASE_DEFAULT AS cashDeskKey,
    CAST(COALESCE(NULLIF(ca.COD_CAIS, ''), 'N/A') AS varchar(20)) COLLATE DATABASE_DEFAULT AS cashDeskCode,
    CAST(CASE WHEN ca.COD_CAIS IS NULL THEN N'Caisse non rattachee' ELSE COALESCE(cais.LIB_CAIS, N'Caisse ' + ca.COD_CAIS) END AS nvarchar(120)) COLLATE DATABASE_DEFAULT AS cashDeskLabel,
    CAST(ca.NUM_CPTE AS varchar(22)) COLLATE DATABASE_DEFAULT AS cashDeskAccount,
    CAST('RUBINS' AS varchar(20)) COLLATE DATABASE_DEFAULT AS operationSource,
    CAST(CONCAT(r.NUM_TRANS, ':', rr.COD_RUBADH) AS varchar(80)) COLLATE DATABASE_DEFAULT AS operationId,
    CAST(r.NUM_TRANS AS varchar(80)) COLLATE DATABASE_DEFAULT AS operationNumber,
    CAST(r.BORDEREAU AS varchar(80)) COLLATE DATABASE_DEFAULT AS receiptNumber,
    CAST(rr.COD_RUBADH AS varchar(30)) COLLATE DATABASE_DEFAULT AS operationCode,
    CAST(COALESCE(ra.LIB_RUBADH, N'Adhesion') AS nvarchar(160)) COLLATE DATABASE_DEFAULT AS operationLabel,
    CAST('adhesions' AS varchar(40)) COLLATE DATABASE_DEFAULT AS categoryCode,
    CAST(N'Adhesions' AS nvarchar(120)) COLLATE DATABASE_DEFAULT AS categoryLabel,
    CAST('IN' AS varchar(3)) COLLATE DATABASE_DEFAULT AS direction,
    CAST(ISNULL(rr.MONTANT_PAYE, 0) AS decimal(18, 2)) AS amount,
    CAST(COALESCE(r.DATE_RUBINS, r.DATE_VALIDATION) AS datetime) AS operationDate,
    CAST(r.NUM_CPTE AS varchar(22)) COLLATE DATABASE_DEFAULT AS accountNumber,
    CAST(NULL AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS accountLabel,
    CAST(r.COD_ADH AS varchar(20)) COLLATE DATABASE_DEFAULT AS customerCode,
    CAST(adh.NOM_PRENOM AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS customerName,
    CAST(NULL AS varchar(50)) COLLATE DATABASE_DEFAULT AS userCode,
    CAST(NULL AS varchar(20)) COLLATE DATABASE_DEFAULT AS collectorCode,
    CAST(NULL AS nvarchar(140)) COLLATE DATABASE_DEFAULT AS collectorName,
    CAST(COALESCE(ra.LIB_RUBADH, N'Adhesion') AS nvarchar(320)) COLLATE DATABASE_DEFAULT AS description,
    CAST(NULL AS varchar(80)) COLLATE DATABASE_DEFAULT AS chequeNumber,
    CAST(rr.CODE_DEVISE AS varchar(10)) COLLATE DATABASE_DEFAULT AS currencyCode
  FROM dbo.RUBINS r WITH (NOLOCK)
  JOIN dbo.RUBINS_RUBADH rr WITH (NOLOCK)
    ON rr.NUM_TRANS COLLATE DATABASE_DEFAULT = r.NUM_TRANS COLLATE DATABASE_DEFAULT
   AND rr.COD_RUBADH = '01'
  LEFT JOIN dbo.RUBADH ra WITH (NOLOCK)
    ON ra.COD_RUBADH COLLATE DATABASE_DEFAULT = rr.COD_RUBADH COLLATE DATABASE_DEFAULT
  LEFT JOIN dbo.CAIS_AGENCE ca WITH (NOLOCK)
    ON ca.KP_CAIS_AGENCE = r.KP_CAIS_AGENCE
  LEFT JOIN dbo.CAISSE cais WITH (NOLOCK)
    ON cais.COD_CAIS COLLATE DATABASE_DEFAULT = ca.COD_CAIS COLLATE DATABASE_DEFAULT
  LEFT JOIN dbo.ADHERENT adh WITH (NOLOCK)
    ON adh.COD_ADH COLLATE DATABASE_DEFAULT = r.COD_ADH COLLATE DATABASE_DEFAULT
  WHERE COALESCE(r.DATE_RUBINS, r.DATE_VALIDATION) >= @AsOfDate
    AND COALESCE(r.DATE_RUBINS, r.DATE_VALIDATION) < DATEADD(DAY, 1, @AsOfDate)

  -- Transferts emis (caisse source)
  -- TRANS_CAIS stocke les caisses sous forme de KP_CAIS_AGENCE dans CAISSE_EMET / CAISSE_RECEPT.

  UNION ALL

  SELECT
    CAST(COALESCE(ca.COD_AGENCE, CASE WHEN tc.NUM_TRANS LIKE 'A[0-9][0-9]%' THEN LEFT(tc.NUM_TRANS, 3) END) AS varchar(20)) COLLATE DATABASE_DEFAULT AS agencyCode,
    CAST(COALESCE(NULLIF(tc.CAISSE_EMET, ''), 'SANS-CAISSE') AS varchar(40)) COLLATE DATABASE_DEFAULT AS cashDeskKey,
    CAST(COALESCE(NULLIF(ca.COD_CAIS, ''), 'N/A') AS varchar(20)) COLLATE DATABASE_DEFAULT AS cashDeskCode,
    CAST(CASE WHEN ca.COD_CAIS IS NULL THEN N'Caisse non rattachee' ELSE COALESCE(cais.LIB_CAIS, N'Caisse ' + ca.COD_CAIS) END AS nvarchar(120)) COLLATE DATABASE_DEFAULT AS cashDeskLabel,
    CAST(ca.NUM_CPTE AS varchar(22)) COLLATE DATABASE_DEFAULT AS cashDeskAccount,
    CAST('TRANS_CAIS' AS varchar(20)) COLLATE DATABASE_DEFAULT AS operationSource,
    CAST(CONCAT(tc.NUM_TRANS, ':EMIS') AS varchar(80)) COLLATE DATABASE_DEFAULT AS operationId,
    CAST(tc.NUM_TRANS AS varchar(80)) COLLATE DATABASE_DEFAULT AS operationNumber,
    CAST(NULL AS varchar(80)) COLLATE DATABASE_DEFAULT AS receiptNumber,
    CAST('TRANS_EMIS' AS varchar(30)) COLLATE DATABASE_DEFAULT AS operationCode,
    CAST(N'Transfert emis entre caisses' AS nvarchar(160)) COLLATE DATABASE_DEFAULT AS operationLabel,
    CAST('transferts-emis' AS varchar(40)) COLLATE DATABASE_DEFAULT AS categoryCode,
    CAST(N'Transferts emis entre caisses' AS nvarchar(120)) COLLATE DATABASE_DEFAULT AS categoryLabel,
    CAST('OUT' AS varchar(3)) COLLATE DATABASE_DEFAULT AS direction,
    CAST(ISNULL(tc.MONTANT, 0) AS decimal(18, 2)) AS amount,
    CAST(COALESCE(tc.DATE_TRANS, tc.DATE_VALIDATION) AS datetime) AS operationDate,
    CAST(NULL AS varchar(22)) COLLATE DATABASE_DEFAULT AS accountNumber,
    CAST(NULL AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS accountLabel,
    CAST(NULL AS varchar(20)) COLLATE DATABASE_DEFAULT AS customerCode,
    CAST(NULL AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS customerName,
    CAST(NULL AS varchar(50)) COLLATE DATABASE_DEFAULT AS userCode,
    CAST(NULL AS varchar(20)) COLLATE DATABASE_DEFAULT AS collectorCode,
    CAST(NULL AS nvarchar(140)) COLLATE DATABASE_DEFAULT AS collectorName,
    CAST(CONCAT(N'Transfert emis vers ', ISNULL(tc.CAISSE_RECEPT, N'')) AS nvarchar(320)) COLLATE DATABASE_DEFAULT AS description,
    CAST(NULL AS varchar(80)) COLLATE DATABASE_DEFAULT AS chequeNumber,
    CAST(tc.CODE_DEVISE AS varchar(10)) COLLATE DATABASE_DEFAULT AS currencyCode
  FROM dbo.TRANS_CAIS tc WITH (NOLOCK)
  LEFT JOIN dbo.CAIS_AGENCE ca WITH (NOLOCK)
    ON ca.KP_CAIS_AGENCE COLLATE DATABASE_DEFAULT = tc.CAISSE_EMET COLLATE DATABASE_DEFAULT
  LEFT JOIN dbo.CAISSE cais WITH (NOLOCK)
    ON cais.COD_CAIS COLLATE DATABASE_DEFAULT = ca.COD_CAIS COLLATE DATABASE_DEFAULT
  WHERE COALESCE(tc.DATE_TRANS, tc.DATE_VALIDATION) >= @AsOfDate
    AND COALESCE(tc.DATE_TRANS, tc.DATE_VALIDATION) < DATEADD(DAY, 1, @AsOfDate)
    AND NULLIF(LTRIM(RTRIM(ISNULL(tc.CAISSE_EMET, ''))), '') IS NOT NULL

  -- Transferts recus (caisse destination)

  UNION ALL

  SELECT
    CAST(COALESCE(ca_dest.COD_AGENCE, CASE WHEN tc.NUM_TRANS LIKE 'A[0-9][0-9]%' THEN LEFT(tc.NUM_TRANS, 3) END) AS varchar(20)) COLLATE DATABASE_DEFAULT AS agencyCode,
    CAST(COALESCE(NULLIF(tc.CAISSE_RECEPT, ''), 'SANS-CAISSE') AS varchar(40)) COLLATE DATABASE_DEFAULT AS cashDeskKey,
    CAST(COALESCE(NULLIF(ca_dest.COD_CAIS, ''), 'N/A') AS varchar(20)) COLLATE DATABASE_DEFAULT AS cashDeskCode,
    CAST(CASE WHEN ca_dest.COD_CAIS IS NULL THEN N'Caisse non rattachee' ELSE COALESCE(cais_dest.LIB_CAIS, N'Caisse ' + ca_dest.COD_CAIS) END AS nvarchar(120)) COLLATE DATABASE_DEFAULT AS cashDeskLabel,
    CAST(ca_dest.NUM_CPTE AS varchar(22)) COLLATE DATABASE_DEFAULT AS cashDeskAccount,
    CAST('TRANS_CAIS' AS varchar(20)) COLLATE DATABASE_DEFAULT AS operationSource,
    CAST(CONCAT(tc.NUM_TRANS, ':RECUS') AS varchar(80)) COLLATE DATABASE_DEFAULT AS operationId,
    CAST(tc.NUM_TRANS AS varchar(80)) COLLATE DATABASE_DEFAULT AS operationNumber,
    CAST(NULL AS varchar(80)) COLLATE DATABASE_DEFAULT AS receiptNumber,
    CAST('TRANS_RECUS' AS varchar(30)) COLLATE DATABASE_DEFAULT AS operationCode,
    CAST(N'Transfert recu entre caisses' AS nvarchar(160)) COLLATE DATABASE_DEFAULT AS operationLabel,
    CAST('transferts-recus' AS varchar(40)) COLLATE DATABASE_DEFAULT AS categoryCode,
    CAST(N'Transferts recus entre caisses' AS nvarchar(120)) COLLATE DATABASE_DEFAULT AS categoryLabel,
    CAST('IN' AS varchar(3)) COLLATE DATABASE_DEFAULT AS direction,
    CAST(ISNULL(tc.MONTANT, 0) AS decimal(18, 2)) AS amount,
    CAST(COALESCE(tc.DATE_TRANS, tc.DATE_VALIDATION) AS datetime) AS operationDate,
    CAST(NULL AS varchar(22)) COLLATE DATABASE_DEFAULT AS accountNumber,
    CAST(NULL AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS accountLabel,
    CAST(NULL AS varchar(20)) COLLATE DATABASE_DEFAULT AS customerCode,
    CAST(NULL AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS customerName,
    CAST(NULL AS varchar(50)) COLLATE DATABASE_DEFAULT AS userCode,
    CAST(NULL AS varchar(20)) COLLATE DATABASE_DEFAULT AS collectorCode,
    CAST(NULL AS nvarchar(140)) COLLATE DATABASE_DEFAULT AS collectorName,
    CAST(CONCAT(N'Transfert recu de ', ISNULL(tc.CAISSE_EMET, N'')) AS nvarchar(320)) COLLATE DATABASE_DEFAULT AS description,
    CAST(NULL AS varchar(80)) COLLATE DATABASE_DEFAULT AS chequeNumber,
    CAST(tc.CODE_DEVISE AS varchar(10)) COLLATE DATABASE_DEFAULT AS currencyCode
  FROM dbo.TRANS_CAIS tc WITH (NOLOCK)
  LEFT JOIN dbo.CAIS_AGENCE ca_dest WITH (NOLOCK)
    ON ca_dest.KP_CAIS_AGENCE COLLATE DATABASE_DEFAULT = tc.CAISSE_RECEPT COLLATE DATABASE_DEFAULT
  LEFT JOIN dbo.CAISSE cais_dest WITH (NOLOCK)
    ON cais_dest.COD_CAIS COLLATE DATABASE_DEFAULT = ca_dest.COD_CAIS COLLATE DATABASE_DEFAULT
  WHERE COALESCE(tc.DATE_TRANS, tc.DATE_VALIDATION) >= @AsOfDate
    AND COALESCE(tc.DATE_TRANS, tc.DATE_VALIDATION) < DATEADD(DAY, 1, @AsOfDate)
    AND NULLIF(LTRIM(RTRIM(ISNULL(tc.CAISSE_RECEPT, ''))), '') IS NOT NULL
),
CashOperations AS (
  SELECT *
  FROM CashOperationsSource
  WHERE agencyCode IS NOT NULL
    AND ${agencyScopeSql("agencyCode")}
)`;
