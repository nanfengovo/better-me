import { HarvestJournalError, type JournalStorage, type JournalTable, type JournalTransaction } from "./harvest-journal-store";

const DATABASE = "better-me-atlas-harvest-v1";
const TABLES: JournalTable[] = ["runs", "batches", "providers"];

export async function harvestConnectionScope(endpoint: string, token: string): Promise<string> {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new HarvestJournalError("unsupported", "采集恢复只支持有效的本机岗位服务地址。"); }
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !token.trim() || token.length > 4096 || /[\r\n\0]/.test(token)) {
    throw new HarvestJournalError("unsupported", "采集恢复需要已授权的本机根地址与有效令牌。");
  }
  if (!globalThis.crypto?.subtle) throw new HarvestJournalError("unsupported", "当前浏览器无法安全隔离采集记录，请使用支持 Web Crypto 的安全页面。");
  // Match service-client's actual Authorization identity, not the raw text field.
  const material = JSON.stringify(["better-me-atlas-harvest-v1", url.origin, `Bearer ${token.trim()}`]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

function adapt(database: IDBDatabase): JournalStorage {
  let closed = false;
  const close = () => { if (closed) return; closed = true; database.close(); };
  database.onversionchange = close;
  return {
    close,
    transaction<T>(mode: "readonly" | "readwrite", work: (tx: JournalTransaction) => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new HarvestJournalError("closed", "采集记录连接已关闭，请重新打开后恢复。"));
      return new Promise((resolve, reject) => {
        let transaction: IDBTransaction;
        try { transaction = database.transaction(TABLES, mode); } catch { reject(new HarvestJournalError("storage", "浏览器无法打开采集记录事务。")); return; }
        let value: T;
        let completedWork = false;
        let failure: unknown;
        const store = (table: JournalTable) => transaction.objectStore(table);
        const adapter: JournalTransaction = {
          get: (table, id) => request(store(table).get(id)),
          list: (table, filter) => request(filter ? store(table).index(filter.index).getAll(filter.value) : store(table).getAll()),
          put: async (table, row) => { await request(store(table).put(row)); },
          delete: async (table, id) => { await request(store(table).delete(id)); },
        };
        // A successful request is not a durable write. Only oncomplete resolves
        // the operation, so quota/abort errors cannot acknowledge partial work.
        transaction.oncomplete = () => completedWork ? resolve(value) : reject(new HarvestJournalError("storage", "采集事务提前结束，记录未获确认。"));
        transaction.onabort = () => reject(failure ?? transaction.error ?? new HarvestJournalError("storage", "采集记录事务已取消，记录未获确认。"));
        void work(adapter).then(result => { value = result; completedWork = true; }, error => {
          failure = error;
          try { transaction.abort(); } catch { reject(error); }
        });
      });
    },
  };
}

export async function openJournalStorage(): Promise<JournalStorage> {
  if (!globalThis.indexedDB) throw new HarvestJournalError("unsupported", "当前浏览器无法使用 IndexedDB，不能安全保存与恢复采集；未开始采集。 ");
  return new Promise((resolve, reject) => {
    let opening: IDBOpenDBRequest;
    try { opening = indexedDB.open(DATABASE, 1); } catch {
      reject(new HarvestJournalError("storage", "浏览器拒绝打开采集记录，请检查存储权限与空间；未开始采集。")); return;
    }
    let settled = false;
    const fail = (message: string) => { if (settled) return; settled = true; reject(new HarvestJournalError("storage", message)); };
    opening.onupgradeneeded = event => {
      if (settled || event.oldVersion !== 0) { opening.transaction?.abort(); return; }
      const database = opening.result;
      database.createObjectStore("runs", { keyPath: "id" }).createIndex("scope", "scope", { unique: false });
      database.createObjectStore("batches", { keyPath: "id" }).createIndex("runId", "runId", { unique: false });
      database.createObjectStore("providers", { keyPath: "id" }).createIndex("runId", "runId", { unique: false });
    };
    opening.onerror = () => fail(opening.error?.name === "VersionError"
      ? "采集记录来自更新版本，不能使用当前版本恢复；原记录未改动。"
      : "无法打开浏览器采集记录，请检查存储权限与空间；未开始采集。");
    opening.onblocked = () => fail("采集记录被另一页面的旧连接占用，请先结束该页面的采集再重试；原记录未改动。");
    opening.onsuccess = () => {
      const database = opening.result;
      if (settled) { database.close(); return; }
      try {
        if (database.version !== 1 || database.objectStoreNames.length !== TABLES.length || TABLES.some(table => !database.objectStoreNames.contains(table))) throw new Error();
        const transaction = database.transaction(TABLES, "readonly");
        for (const table of TABLES) {
          const objectStore = transaction.objectStore(table);
          const index = table === "runs" ? "scope" : "runId";
          if (objectStore.keyPath !== "id" || objectStore.autoIncrement || objectStore.indexNames.length !== 1
            || !objectStore.indexNames.contains(index) || objectStore.index(index).keyPath !== index || objectStore.index(index).unique) throw new Error();
        }
      } catch {
        database.close(); fail("采集记录结构损坏或版本不受支持，未开始网络操作；原记录未改动。"); return;
      }
      settled = true;
      resolve(adapt(database));
    };
  });
}
