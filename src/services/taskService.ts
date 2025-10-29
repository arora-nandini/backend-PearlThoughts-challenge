import { v4 as uuidv4 } from 'uuid';
import { Task } from '../types';
import { Database } from '../db/database';
import {SyncService} from './syncService';

export class TaskService {
  private syncService:SyncService;

  constructor(private db: Database) {
    //avoiding dependency prob..
    this.syncService = new SyncService(db, this);
  }

  async createTask(taskData: Partial<Task>): Promise<Task> {

    const id=uuidv4();
    const now=new Date();
    
    const newTask:Task={
      id,
      title: taskData.title || 'Untitled Task',
      description: taskData.description || '',
      completed: false,
      created_at: now,
      updated_at: now,
      is_deleted: false,
      sync_status: 'pending',
    };
    
    const sql=`
    INSERT INTO tasks(
     id,title,description,completed,created_at,updated_at,
     is_deleted,sync_status )VALUES(?,?,?,?,?,?,?,?)
    `;
    await this.db.run(sql,[
      newTask.id,
      newTask.title,
      newTask.description,
      newTask.completed?1:0,
      newTask.created_at.toISOString(),
      newTask.updated_at.toISOString(),
      newTask.is_deleted ? 1 : 0,
      newTask.sync_status,
    ]);

//syncing
await this.syncService.addToSyncQueue(
  newTask.id,
'create',
 newTask
 );

    return newTask;
    }




  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
   
    const existing=await this.getTask(id);
   if(!existing)return null;
    
    const updatedTask:Task={
      ...existing,
      ...updates,
      updated_at:new Date(),
      sync_status:'pending',
    };
   
    const sql=`
    UPDATE tasks
      SET title = ?, description = ?, completed = ?, updated_at = ?, is_deleted = ?, sync_status = ?
      WHERE id = ?
    `;
   
    await this.db.run(sql,[
      updatedTask.title,
      updatedTask.description,
      updatedTask.completed?1:0,
      updatedTask.updated_at.toISOString(),
      updatedTask.is_deleted?1:0,
      updatedTask.sync_status,
      id,
    ]);
   //add to sync queue
   await this.syncService.addToSyncQueue(
    updatedTask.id,     
    'update', 
  updates 
   )
    return updatedTask;
  }

  
  async deleteTask(id: string): Promise<boolean> {
    const task=await this.getTask(id);
    if(!task)return false;

    const now=new Date();
    const sql=`
   UPDATE tasks
      SET is_deleted = 1, updated_at = ?, sync_status = 'pending'
      WHERE id = ?
    `;
   await this.db.run(sql,[now.toISOString(),id]);
   
    await this.syncService.addToSyncQueue(
      id, 'delete', { id }
     );

   return true;
  }

  async getTask(id: string): Promise<Task | null> {
  const sql=`SELECT * FROM tasks WHERE id=?`;
  const row=await this.db.get(sql,[id]);
  if(!row || row.is_deleted)return null;  
  
  return this.mapRowToTask(row);
  }

  async getAllTasks(): Promise<Task[]> {
   const sql=`SELECT * FROM tasks WHERE is_deleted=0`;
   const rows=await this.db.all(sql);
   return rows.map((r)=>this.mapRowToTask(r));
    
  }

  async getTasksNeedingSync(): Promise<Task[]> {
     const sql = `SELECT * FROM tasks WHERE sync_status IN ('pending', 'error')`;
    const rows = await this.db.all(sql);
    return rows.map((r) => this.mapRowToTask(r));
  }


//helper created  to map DB row->Task
private mapRowToTask(row:any):Task{
return{
 id: row.id,
      title: row.title,
      description: row.description,
      completed: !!row.completed,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      is_deleted: !!row.is_deleted,
      sync_status: row.sync_status,
      server_id: row.server_id || undefined,
      last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : undefined,


}

}

}