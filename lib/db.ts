import sql from "mssql";
import {
  buildMssqlConfig,
  getSqlSettings,
  sqlSettingsSignature,
} from "@/lib/sql-settings";

const g = global as typeof globalThis & {
  _sqlPool?: InstanceType<typeof sql.ConnectionPool>;
  _sqlConnecting?: Promise<InstanceType<typeof sql.ConnectionPool>>;
  _sqlSignature?: string;
  _sqlConnectingSignature?: string;
};

export async function resetSqlPool(): Promise<void> {
  g._sqlConnecting = undefined;
  g._sqlConnectingSignature = undefined;
  g._sqlSignature = undefined;

  if (g._sqlPool) {
    try { await g._sqlPool.close(); } catch { /* ignore */ }
    g._sqlPool = undefined;
  }
}

export async function getPool(): Promise<InstanceType<typeof sql.ConnectionPool>> {
  const settings = getSqlSettings();
  const signature = sqlSettingsSignature(settings);

  if (g._sqlConnecting && g._sqlConnectingSignature === signature) {
    return g._sqlConnecting;
  }

  if (g._sqlPool?.connected && g._sqlSignature === signature) {
    return g._sqlPool;
  }

  if (g._sqlPool) {
    try { await g._sqlPool.close(); } catch { /* ignore */ }
    g._sqlPool = undefined;
  }

  g._sqlConnectingSignature = signature;
  g._sqlConnecting = new sql.ConnectionPool(buildMssqlConfig(settings))
    .connect()
    .then((pool: InstanceType<typeof sql.ConnectionPool>) => {
      g._sqlPool = pool;
      g._sqlSignature = signature;
      g._sqlConnecting = undefined;
      g._sqlConnectingSignature = undefined;
      pool.on("error", (err: unknown) => {
        console.error("[db] Pool error:", err);
        g._sqlPool = undefined;
        g._sqlSignature = undefined;
      });
      return pool;
    })
    .catch((err: unknown) => {
      g._sqlConnecting = undefined;
      g._sqlConnectingSignature = undefined;
      throw err;
    });

  return g._sqlConnecting;
}
