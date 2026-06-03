export const TREASURY_CTE = `
TreasuryAccounts AS (
  SELECT DISTINCT
    CAST(ca.COD_AGENCE AS varchar(20)) COLLATE DATABASE_DEFAULT AS agencyCode,
    CAST(ca.NUM_CPTE AS varchar(22)) COLLATE DATABASE_DEFAULT AS accountNumber,
    CAST(c.INTITULE_CPTE AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS accountLabel,
    CAST('cash' AS varchar(20)) COLLATE DATABASE_DEFAULT AS treasuryType,
    CAST(N'Caisses' AS nvarchar(80)) COLLATE DATABASE_DEFAULT AS treasuryLabel
  FROM dbo.CAIS_AGENCE ca WITH (NOLOCK)
  JOIN dbo.COMPTES c WITH (NOLOCK)
    ON c.NUM_CPTE COLLATE DATABASE_DEFAULT = ca.NUM_CPTE COLLATE DATABASE_DEFAULT
  WHERE ca.NUM_CPTE IS NOT NULL
    AND NULLIF(LTRIM(RTRIM(ca.NUM_CPTE)), '') IS NOT NULL
    AND (c.DATE_CLOTURE IS NULL OR c.DATE_CLOTURE > @AsOfDate)

  UNION

  SELECT DISTINCT
    CAST(c.COD_AGENCE AS varchar(20)) COLLATE DATABASE_DEFAULT AS agencyCode,
    CAST(c.NUM_CPTE AS varchar(22)) COLLATE DATABASE_DEFAULT AS accountNumber,
    CAST(c.INTITULE_CPTE AS nvarchar(220)) COLLATE DATABASE_DEFAULT AS accountLabel,
    CAST('bank' AS varchar(20)) COLLATE DATABASE_DEFAULT AS treasuryType,
    CAST(N'Banques' AS nvarchar(80)) COLLATE DATABASE_DEFAULT AS treasuryLabel
  FROM dbo.COMPTES c WITH (NOLOCK)
  WHERE c.COD_AGENCE IS NOT NULL
    AND c.NUM_CPTE IS NOT NULL
    AND (
      c.CPTE_GAL LIKE '1111212%'
      OR c.CPTE_GAL LIKE '1131%'
      OR c.CPTE_GAL LIKE '1141%'
    )
    AND (c.DATE_CLOTURE IS NULL OR c.DATE_CLOTURE > @AsOfDate)
),
TreasuryBalances AS (
  SELECT
    ta.agencyCode,
    ta.accountNumber,
    ta.accountLabel,
    ta.treasuryType,
    ta.treasuryLabel,
    SUM(CAST(CASE
      WHEN h.SENS_OPERATION = 'D' THEN ISNULL(h.MONTANT_TRANS, 0)
      WHEN h.SENS_OPERATION = 'C' THEN -ISNULL(h.MONTANT_TRANS, 0)
      ELSE 0
    END AS money)) AS balance
  FROM TreasuryAccounts ta
  LEFT JOIN dbo.HDPM h WITH (NOLOCK)
    ON h.NUM_CPTE COLLATE DATABASE_DEFAULT = ta.accountNumber COLLATE DATABASE_DEFAULT
   AND h.DATE_OPERATION < DATEADD(DAY, 1, @AsOfDate)
   AND ISNULL(h.COD_TYP_OPERAT, '') <> 'REPR'
  GROUP BY
    ta.agencyCode,
    ta.accountNumber,
    ta.accountLabel,
    ta.treasuryType,
    ta.treasuryLabel
)`;
