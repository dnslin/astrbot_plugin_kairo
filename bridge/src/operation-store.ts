import { DatabaseSync } from 'node:sqlite';
import type { SendOperationStore, SendOperationClaim, SendOperationClaimResult, SendOperationRecord, SendOperationUpdate } from '@kairo/driver';

/** 与 Driver 的内存 Store 保持相同语义；unknown 在重启后仍禁止再次触发发送。 */
export class SqliteSendOperationStore implements SendOperationStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS send_operations (operation_id TEXT PRIMARY KEY, record TEXT NOT NULL)');
  }

  async claim(input: SendOperationClaim): Promise<SendOperationClaimResult> {
    const operationId = input.operationId.trim();
    if (!operationId) throw new Error('operationId 不能为空');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.read(operationId);
      if (row) {
        const a = row.fingerprint, b = input.fingerprint;
        if (a.targetSessionId !== b.targetSessionId || a.messageType !== b.messageType || a.contentDigest !== b.contentDigest) throw new Error('operationId 的 fingerprint 不一致，拒绝复用');
        if (!(row.status === 'failed' && row.isPreTrigger === true)) {
          this.db.exec('COMMIT');
          return { claimed: false, operation: row };
        }
      }
      const operation: SendOperationRecord = {
        operationId, fingerprint: { ...input.fingerprint }, status: 'unknown',
        createdAt: row?.createdAt ?? Date.now(), updatedAt: Date.now(),
      };
      this.write(operation);
      this.db.exec('COMMIT');
      return { claimed: true, operation };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async get(operationId: string): Promise<SendOperationRecord | null> { return this.read(operationId.trim()); }

  async update(operationId: string, update: SendOperationUpdate): Promise<SendOperationRecord> {
    const existing = this.read(operationId.trim());
    if (!existing) throw new Error('未找到发送操作');
    const result: SendOperationRecord = {
      operationId: existing.operationId, fingerprint: existing.fingerprint,
      createdAt: existing.createdAt, updatedAt: Date.now(), ...update,
    };
    this.write(result);
    return result;
  }

  close(): void { this.db.close(); }

  private read(id: string): SendOperationRecord | null {
    const row = this.db.prepare('SELECT record FROM send_operations WHERE operation_id = ?').get(id);
    return row ? JSON.parse(String(row.record)) as SendOperationRecord : null;
  }

  private write(record: SendOperationRecord): void {
    this.db.prepare('INSERT OR REPLACE INTO send_operations(operation_id, record) VALUES (?, ?)').run(record.operationId, JSON.stringify(record));
  }
}
