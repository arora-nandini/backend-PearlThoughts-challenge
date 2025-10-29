import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { TaskService } from '../services/taskService';
import { SyncService } from '../services/syncService';
import { Task } from '../types';
import { Database } from '../db/database';

export function createTaskRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);

  /** -------------------- CREATE TASK -------------------- **/
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const { title, description = '', completed = false } = req.body;

      if (!title) {
        res.status(400).json({ error: 'Title is required' });
        return;
      }

      const now = new Date();

      const newTask: Task = {
        id: uuidv4(),
        title,
        description,
        completed,
        created_at: now,
        updated_at: now,
        is_deleted: false,
        sync_status: 'pending',
      };

      await taskService.createTask(newTask);
      await syncService.addToSyncQueue(newTask.id, 'create', newTask);

      res.status(201).json(newTask);
      return;
    } catch (error: any) {
      console.error('Create task error:', error);
      res.status(500).json({ error: 'Failed to create task', details: error.message });
      return;
    }
  });

  /** -------------------- GET ALL TASKS -------------------- **/
  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      const tasks = await taskService.getAllTasks();
      res.json(tasks);
      return;
    } catch (error) {
      console.error('Error fetching tasks:', error);
      res.status(500).json({ error: 'Failed to fetch tasks' });
      return;
    }
  });

  /** -------------------- GET SINGLE TASK -------------------- **/
  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const task = await taskService.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      res.json(task);
      return;
    } catch (error) {
      console.error('Error fetching task:', error);
      res.status(500).json({ error: 'Failed to fetch task' });
      return;
    }
  });

  /** -------------------- UPDATE TASK -------------------- **/
  router.put('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const { title, description, completed } = req.body;
      const existing = await taskService.getTask(req.params.id);

      if (!existing) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      const updates: Partial<Task> = {
        title: title ?? existing.title,
        description: description ?? existing.description,
        completed: completed ?? existing.completed,
        updated_at: new Date(),
        sync_status: 'pending',
      };

      const updatedTask = await taskService.updateTask(req.params.id, updates);
      await syncService.addToSyncQueue(req.params.id, 'update', updates);

      res.json(updatedTask);
      return;
    } catch (error: any) {
      console.error('Update task error:', error);
      res.status(500).json({ error: 'Failed to update task', details: error.message });
      return;
    }
  });

  /** -------------------- DELETE TASK -------------------- **/
  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const existing = await taskService.getTask(req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      const now = new Date();
      const updates: Partial<Task> = {
        is_deleted: true,
        updated_at: now,
        sync_status: 'pending',
      };

      await taskService.updateTask(req.params.id, updates);
      await syncService.addToSyncQueue(req.params.id, 'delete', updates);

      res.json({ success: true });
      return;
    } catch (error: any) {
      console.error('Delete task error:', error);
      res.status(500).json({ error: 'Failed to delete task', details: error.message });
      return;
    }
  });

  // ✅ Explicitly return the router
  return router;
}
