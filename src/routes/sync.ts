import { Router, Request, Response } from 'express';
import { SyncService } from '../services/syncService';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';

export function createSyncRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);

  // Trigger manual sync
  router.post('/sync', async (_req: Request, res: Response) => {
    try {
      const isOnline = await syncService.checkConnectivity();
      if (!isOnline) {
        return res.status(503).json({ error: 'Server not reachable. Try again later.' });
      }

      const result = await syncService.sync();

      return res.json({
        success: result.success,
        synced_items: result.synced_items,
        failed_items: result.failed_items,
        errors: result.errors,
      });
    } catch (error: any) {
      console.error('Sync error:', error);
      return res.status(500).json({ error: 'Sync failed', details: error.message });
    }
  });

  // Check sync status
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const pendingTasks = await taskService.getTasksNeedingSync();
      const pendingCount = pendingTasks.length;

      const rows = await db.all('SELECT MAX(last_synced_at) as last_sync FROM tasks');
      const lastSync = rows[0]?.last_sync || null;
      const isOnline = await syncService.checkConnectivity();

      return res.json({
        pending: pendingCount,
        last_synced_at: lastSync,
        online: isOnline,
        status: isOnline
          ? pendingCount > 0
            ? 'sync_pending'
            : 'up_to_date'
          : 'offline',
      });
    } catch (error: any) {
      console.error('Status check error:', error);
      return res.status(500).json({ error: 'Failed to fetch sync status', details: error.message });
    }
  });

  // Batch sync endpoint (for server-side)
  router.post('/batch', async (req: Request, res: Response) => {
    try {
      const { items, client_timestamp } = req.body;

      if (!items || !Array.isArray(items)) {
        return res.status(400).json({ error: 'Invalid batch request: items missing or invalid' });
      }
console.log('Client timestamp:', client_timestamp);

      const response = {
        processed_items: items.map((item: any) => ({
          client_id: item.id,
          server_id: `srv-${item.task_id || Math.random().toString(36).slice(2)}`,
          status: 'success',
        })),
        server_timestamp: new Date(),
      };

      return res.json(response);
    } catch (error: any) {
      console.error('Batch sync error:', error);
      return res.status(500).json({ error: 'Batch processing failed', details: error.message });
    }
  });

  // Health check endpoint
  router.get('/health', async (_req: Request, res: Response) => {
    return res.json({ status: 'ok', timestamp: new Date() });
  });

  return router;
}
