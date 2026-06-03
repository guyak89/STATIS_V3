export const CREDIT_LOSS_STOCK_CTE = `
LossStockRanked AS (
  SELECT
    LEFT(dh.NUM_DOSSIER, 3) COLLATE DATABASE_DEFAULT AS agencyCode,
    dh.NUM_DOSSIER COLLATE DATABASE_DEFAULT AS numDossier,
    dh.NUM_TRANS COLLATE DATABASE_DEFAULT AS lossTransferNumber,
    CAST(dh.DATE_DECLAS_HIST AS datetime) AS lossTransferDate,
    CAST(dh.DATE_FIN AS datetime) AS lossEndDate,
    CAST(
      ISNULL(dh.ENCOURS, 0)
      - ISNULL(dh.MONTANT_CAUTION, 0)
      - ISNULL(dh.MONTANT_EPG, 0)
      AS money
    ) AS initialLossOutstanding,
    ROW_NUMBER() OVER (
      PARTITION BY dh.NUM_DOSSIER
      ORDER BY dh.DATE_DECLAS_HIST DESC, dh.NUM_TRANS DESC
    ) AS rn
  FROM DECLAS_HIST dh
  WHERE dh.COD_TYP_OPERAT = 'TRPE'
    AND dh.DATE_DECLAS_HIST < DATEADD(DAY, 1, @AsOfDate)
    AND (dh.DATE_FIN IS NULL OR dh.DATE_FIN > @AsOfDate)
    AND dh.NUM_DOSSIER LIKE '%PRT%'
),
LossStockActive AS (
  SELECT *
  FROM LossStockRanked
  WHERE rn = 1
),
LossStockRecoveries AS (
  SELECT
    lsa.numDossier,
    SUM(CAST(ISNULL(cp.MONTANT, 0) AS money)) AS recoveredAmount,
    COUNT_BIG(cp.NUM_TRANS) AS recoveryCount
  FROM LossStockActive lsa
  LEFT JOIN CREDIT_PERTE cp
    ON cp.NUM_DOSSIER COLLATE DATABASE_DEFAULT = lsa.numDossier COLLATE DATABASE_DEFAULT
   AND COALESCE(cp.DATE_VALIDATION, cp.DATE_OPERATION) >= CAST(lsa.lossTransferDate AS date)
   AND COALESCE(cp.DATE_VALIDATION, cp.DATE_OPERATION) < DATEADD(DAY, 1, @AsOfDate)
  GROUP BY lsa.numDossier
),
CreditLossStock AS (
  SELECT
    lsa.agencyCode,
    lsa.numDossier,
    lsa.lossTransferNumber,
    lsa.lossTransferDate,
    lsa.lossEndDate,
    lsa.initialLossOutstanding,
    ISNULL(lsr.recoveredAmount, 0) AS recoveredAmount,
    ISNULL(lsr.recoveryCount, 0) AS recoveryCount,
    CASE
      WHEN lsa.initialLossOutstanding - ISNULL(lsr.recoveredAmount, 0) < 0 THEN 0
      ELSE lsa.initialLossOutstanding - ISNULL(lsr.recoveredAmount, 0)
    END AS stockAmount
  FROM LossStockActive lsa
  LEFT JOIN LossStockRecoveries lsr
    ON lsr.numDossier COLLATE DATABASE_DEFAULT = lsa.numDossier COLLATE DATABASE_DEFAULT
)`;
