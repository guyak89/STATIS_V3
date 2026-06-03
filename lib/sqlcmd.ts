import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const server = process.env.SQL_SERVER ?? "localhost\\SQL2022";
const database = process.env.SQL_DATABASE ?? "BASE_INTERCO";
const sqlcmdPath =
  process.env.SQLCMD_PATH ?? "C:\\Program Files\\Microsoft SQL Server\\100\\Tools\\Binn\\SQLCMD.EXE";

export async function runSqlJsonQuery<T>(query: string): Promise<T> {
  const { stdout, stderr } = await execFileAsync(
    sqlcmdPath,
    [
      "-S",
      server,
      "-d",
      database,
      "-E",
      "-Q",
      query,
      "-h",
      "-1",
      "-w",
      "65535",
      "-y",
      "0",
      "-Y",
      "0",
    ],
    {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  );

  if (stderr?.trim()) {
    throw new Error(stderr.trim());
  }

  const normalized = stdout
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("");

  if (!normalized) {
    throw new Error("La requete SQL n'a retourne aucun JSON.");
  }

  return JSON.parse(normalized) as T;
}
