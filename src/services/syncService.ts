import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import {
  Task,
  SyncQueueItem,
  SyncResult,
  BatchSyncRequest,
  BatchSyncResponse,
} from '../types';
import { Database } from '../db/database';
import { TaskService } from './taskService';

export class SyncService {
  private apiUrl: string;
  private batchSize: number;

  constructor(
    private db: Database,
    private taskService: TaskService,
    apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api'
  ) {
    this.apiUrl = apiUrl;
    this.batchSize = parseInt(process.env.SYNC_BATCH_SIZE || '10', 10);
  }

  /** -------------------- MAIN SYNC METHOD -------------------- **/
  async sync(): Promise<SyncResult> {
    try {
      const connectivity = await this.checkConnectivity();
      if (!connectivity) {
        throw new Error('Server not reachable');
      }

      const items = await this.db.all('SELECT * FROM sync_queue ORDER BY created_at ASC');
      if (!items.length) {
        return { success: true, synced_items: 0, failed_items: 0, errors: [] };
      }

      const queueItems: SyncQueueItem[] = items.map((r) => ({
        id: r.id,
        task_id: r.task_id,
        operation: r.operation,
        data: JSON.parse(r.data),
        created_at: new Date(r.created_at),
        retry_count: r.retry_count,
        error_message: r.error_message || undefined,
      }));

      const batches = [];
      for (let i = 0; i < queueItems.length; i += this.batchSize) {
        batches.push(queueItems.slice(i, i + this.batchSize));
      }

      let totalSynced = 0;
      let totalFailed = 0;
      const errors = [];

      for (const batch of batches) {
        try {
          const response = await this.processBatch(batch);
          for (const result of response.processed_items) {
            if (result.status === 'success') {
              await this.updateSyncStatus(result.client_id, 'synced', result.resolved_data);
              totalSynced++;
            } else if (result.status === 'conflict' && result.resolved_data) {
              const localTask = await this.taskService.getTask(result.client_id);
              if (localTask) {
                const resolved = await this.resolveConflict(localTask, result.resolved_data);
                await this.taskService.updateTask(localTask.id, resolved);
              }
              await this.updateSyncStatus(result.client_id, 'synced', result.resolved_data);
            } else if (result.status === 'error') {
              totalFailed++;
              errors.push({
                task_id: result.client_id,
                operation: 'unknown',
                error: result.error || 'Sync failed',
                timestamp: new Date(),
              });
              const failedItem = batch.find((b) => b.id === result.client_id);
              if (failedItem) await this.handleSyncError(failedItem, new Error(result.error || 'Sync error'));
            }
          }
        } catch (err: any) {
          console.error('Batch sync failed:', err);
          totalFailed += batch.length;
          for (const item of batch) {
            await this.handleSyncError(item, err);
          }
        }
      }

      return {
        success: totalFailed === 0,
        synced_items: totalSynced,
        failed_items: totalFailed,
        errors,
      };
    } catch (err: any) {
      console.error('Sync failed:', err);
      return {
        success: false,
        synced_items: 0,
        failed_items: 0,
        errors: [{ task_id: 'global', operation: 'sync', error: err.message, timestamp: new Date() }],
      };
    }
  }

  /** -------------------- ADD TO SYNC QUEUE -------------------- **/
  async addToSyncQueue(taskId: string, operation: 'create' | 'update' | 'delete', data: Partial<Task>): Promise<void> {
    const item: SyncQueueItem = {
      id: uuidv4(),
      task_id: taskId,
      operation,
      data,
      created_at: new Date(),
      retry_count: 0,
    };

    const sql = `
      INSERT INTO sync_queue (id, task_id, operation, data, created_at, retry_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    await this.db.run(sql, [
      item.id,
      item.task_id,
      item.operation,
      JSON.stringify(item.data),
      item.created_at.toISOString(),
      0,
    ]);
  }

  /** -------------------- PROCESS BATCH -------------------- **/
  private async processBatch(items: SyncQueueItem[]): Promise<BatchSyncResponse> {
    const request: BatchSyncRequest = {
      items,
      client_timestamp: new Date(),
    };

    const { data } = await axios.post<BatchSyncResponse>(`${this.apiUrl}/sync/batch`, request, {
      timeout: 8000,
    });

    return data;
  }

  /** -------------------- CONFLICT RESOLUTION -------------------- **/
  private async resolveConflict(localTask: Task, serverTask: Task): Promise<Task> {
    // last-write-wins
    const resolved = localTask.updated_at > serverTask.updated_at ? localTask : serverTask;
    console.log('Conflict resolved using last-write-wins for task:', localTask.id);
    return resolved;
  }

  /** -------------------- UPDATE SYNC STATUS -------------------- **/
  private async updateSyncStatus(taskId: string, status: 'synced' | 'error', serverData?: Partial<Task>): Promise<void> {
    const now = new Date().toISOString();
    const sql = `
      UPDATE tasks
      SET sync_status = ?, server_id = COALESCE(?, server_id), last_synced_at = ?
      WHERE id = ?
    `;
    await this.db.run(sql, [status, serverData?.server_id || null, now, taskId]);

    if (status === 'synced') {
      await this.db.run(`DELETE FROM sync_queue WHERE task_id = ?`, [taskId]);
    }
  }

  /** -------------------- HANDLE SYNC ERRORS -------------------- **/
  private async handleSyncError(item: SyncQueueItem, error: Error): Promise<void> {
    const sql = `
      UPDATE sync_queue
      SET retry_count = retry_count + 1, error_message = ?
      WHERE id = ?
    `;
    await this.db.run(sql, [error.message, item.id]);

    const updated = await this.db.get(`SELECT retry_count FROM sync_queue WHERE id = ?`, [item.id]);
    if (updated && updated.retry_count > 3) {
      console.error(`Item ${item.id} permanently failed after 3 retries`);
      await this.db.run(`DELETE FROM sync_queue WHERE id = ?`, [item.id]);
    }
  }

  /** -------------------- CONNECTIVITY CHECK -------------------- **/
  async checkConnectivity(): Promise<boolean> {
    try {
      await axios.get(`${this.apiUrl}/health`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}
