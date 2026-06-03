export const CREDIT_LOSS_TRANSFER_CTE = `
CreditLossTransfers AS (
  SELECT
    LEFT(dh.NUM_DOSSIER, 3) COLLATE DATABASE_DEFAULT AS agencyCode,
    dh.NUM_DOSSIER COLLATE DATABASE_DEFAULT AS numDossier,
    dh.NUM_TRANS COLLATE DATABASE_DEFAULT AS lossTransferNumber,
    CAST(dh.DATE_DECLAS_HIST AS datetime) AS lossTransferDate,
    CAST(dh.DATE_FIN AS datetime) AS lossEndDate,
    CAST(ISNULL(dh.ENCOURS, 0) AS money) AS grossOutstanding,
    CAST(ISNULL(dh.MONTANT_CAUTION, 0) AS money) AS cautionAmount,
    CAST(ISNULL(dh.MONTANT_EPG, 0) AS money) AS epgAmount,
    CAST(
      ISNULL(dh.ENCOURS, 0)
      - ISNULL(dh.MONTANT_CAUTION, 0)
      - ISNULL(dh.MONTANT_EPG, 0)
      AS money
    ) AS transferredAmount
  FROM DECLAS_HIST dh
  WHERE dh.COD_TYP_OPERAT = 'TRPE'
    AND dh.DATE_DECLAS_HIST >= @MonthStart
    AND dh.DATE_DECLAS_HIST < DATEADD(DAY, 1, @AsOfDate)
    AND dh.NUM_DOSSIER LIKE '%PRT%'
)`;
