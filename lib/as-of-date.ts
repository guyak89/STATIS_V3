import sql from "mssql";

type MssqlRequest = ReturnType<InstanceType<typeof sql.ConnectionPool>["request"]>;

export const AS_OF_DATE_QUERY_PARAM = "asOfDate";

export const AS_OF_DATE_SQL = `
DECLARE @OpenDate date = CAST((SELECT MAX(DATE_JOUR) FROM JOURNEE) AS date);
DECLARE @AsOfDate date = ISNULL(@RequestedAsOfDate, @OpenDate);
IF @AsOfDate > @OpenDate
  THROW 51000, 'La date historique ne peut pas etre posterieure a la date d''ouverture de la base.', 1;
`;

export function parseAsOfDateParam(req: Request): string | null {
  const value = new URL(req.url).searchParams.get(AS_OF_DATE_QUERY_PARAM)?.trim();
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Format de date historique invalide. Utilisez AAAA-MM-JJ.");
  }
  return value;
}

export function addAsOfDateInput(request: MssqlRequest, asOfDate: string | null) {
  return request.input("RequestedAsOfDate", sql.Date, asOfDate);
}

export function asOfDateCachePart(asOfDate: string | null) {
  return asOfDate ? `history-${asOfDate}` : "current";
}
