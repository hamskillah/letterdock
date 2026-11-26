import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { deliver, parseNext, migrateLegacyStorage } from './jobs.js';

export interface Job<T = any> {
  id: string;
  workspace_id: string;
  job_type: string;
  payload: T;
  attempts: number;
  max_attempts: number;
  created_at: Date;
}

export type JobHandler<T = any> = (job: Job<T>, signal: AbortSignal) => Promise<void>;

export class WorkerPool {
  private concurrency: number;
  private running = false;
  private workers: Promise<void>[] = [];
  private abortController = new AbortController();
  private handlers = new Map<string, JobHandler>();
  private wakeResolvers: Array<() => void> = [];

  constructor(options: { concurrency?: number } = {}) {
    const envConcurrency = Number(process.env.WORKER_CONCURRENCY || 4);
    this.concurrency = options.concurrency ?? (Number.isSafeInteger(envConcurrency) && envConcurrency > 0 ? envConcurrency : 4);

    // Register built-in default handlers
    this.registerHandler('parse_email', async () => {
      await parseNext();
    });

    this.registerHandler('deliver_webhook', async () => {
      await deliver();
    });

    this.registerHandler('migrate_storage', async (job) => {
      const limit = typeof job.payload?.limit === 'number' ? job.payload.limit : 25;
      await migrateLegacyStorage(limit);
    });
  }

  public registerHandler<T = any>(jobType: string, handler: JobHandler<T>) {
    this.handlers.set(jobType, handler);
  }

  public wake() {
    while (this.wakeResolvers.length > 0) {
      const resolve = this.wakeResolvers.shift();
      resolve?.();
    }
  }

  private waitIdle(ms = 500): Promise<void> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const onWake = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      this.wakeResolvers.push(onWake);
      timer = setTimeout(() => {
        const idx = this.wakeResolvers.indexOf(onWake);
        if (idx !== -1) this.wakeResolvers.splice(idx, 1);
        resolve();
      }, ms);
    });
  }

  public async enqueue<T = any>(
    jobType: string,
    payload: T,
    options: { workspaceId?: string; maxAttempts?: number; delaySec?: number } = {}
  ): Promise<string> {
    const { rows: [row] } = await db.query(`
      INSERT INTO job_queue (workspace_id, job_type, payload, max_attempts, next_attempt)
      VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
      RETURNING id
    `, [
      options.workspaceId || 'default',
      jobType,
      JSON.stringify(payload ?? {}),
      options.maxAttempts ?? 5,
      options.delaySec ?? 0
    ]);
    this.wake();
    return row.id;
  }

  public async leaseJob(workerId: string): Promise<Job | null> {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows: [job] } = await client.query(`
        UPDATE job_queue
        SET status = 'processing',
            locked_until = now() + interval '30 seconds',
            locked_by = $1,
            attempts = attempts + 1,
            updated_at = now()
        WHERE id = (
          SELECT id FROM job_queue
          WHERE (status = 'pending' AND next_attempt <= now())
             OR (status = 'processing' AND locked_until < now())
          ORDER BY next_attempt ASC, created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, workspace_id, job_type, payload, attempts, max_attempts, created_at
      `, [workerId]);
      await client.query('COMMIT');
      return job ? (job as Job) : null;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async heartbeat(jobId: string, workerId: string): Promise<boolean> {
    const res = await db.query(`
      UPDATE job_queue
      SET locked_until = now() + interval '30 seconds',
          updated_at = now()
      WHERE id = $1 AND locked_by = $2 AND status = 'processing'
    `, [jobId, workerId]);
    return Boolean(res.rowCount && res.rowCount > 0);
  }

  public async completeJob(jobId: string, workerId: string): Promise<boolean> {
    const res = await db.query(`
      UPDATE job_queue
      SET status = 'completed',
          locked_until = NULL,
          locked_by = NULL,
          updated_at = now()
      WHERE id = $1 AND locked_by = $2 AND status = 'processing'
    `, [jobId, workerId]);
    return Boolean(res.rowCount && res.rowCount > 0);
  }

  public async failJob(job: Job, workerId: string, error: unknown): Promise<void> {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (job.attempts >= job.max_attempts) {
      await db.query(`
        UPDATE job_queue
        SET status = 'dead_letter',
            locked_until = NULL,
            locked_by = NULL,
            last_error = $2,
            updated_at = now()
        WHERE id = $1 AND locked_by = $3 AND status = 'processing'
      `, [job.id, errMsg, workerId]);
    } else {
      // Exponential backoff with random jitter: (2^attempts * 5s) + random(0, 3s), capped at 1h
      const backoffSec = Math.min(3600, Math.floor(Math.pow(2, Math.min(job.attempts, 8)) * 5 + Math.random() * 3));
      await db.query(`
        UPDATE job_queue
        SET status = 'pending',
            locked_until = NULL,
            locked_by = NULL,
            next_attempt = now() + make_interval(secs => $2),
            last_error = $3,
            updated_at = now()
        WHERE id = $1 AND locked_by = $4 AND status = 'processing'
      `, [job.id, backoffSec, errMsg, workerId]);
    }
  }

  private async runWorker(workerIndex: number): Promise<void> {
    const workerId = 'worker-' + workerIndex + '-' + randomUUID().slice(0, 8);
    let idleDelay = 500;

    while (this.running) {
      let didWork = false;

      // 1. Check generic job_queue with SKIP LOCKED
      try {
        const job = await this.leaseJob(workerId);
        if (job) {
          didWork = true;
          const handler = this.handlers.get(job.job_type);
          if (handler) {
            let heartbeatTimer: NodeJS.Timeout | null = null;
            try {
              // Periodic lease extension every 10s for long-running operations
              heartbeatTimer = setInterval(async () => {
                try {
                  const renewed = await this.heartbeat(job.id, workerId);
                  if (!renewed) {
                    console.warn('[' + workerId + '] Lease lost during execution for job: ' + job.id);
                  }
                } catch (hbErr) {
                  console.error('[' + workerId + '] Heartbeat error for job: ' + job.id, hbErr);
                }
              }, 10000);

              await handler(job, this.abortController.signal);
              await this.completeJob(job.id, workerId);
            } catch (err) {
              await this.failJob(job, workerId, err);
            } finally {
              if (heartbeatTimer) clearInterval(heartbeatTimer);
            }
          } else {
            await this.failJob(job, workerId, new Error('No handler registered for job type: ' + job.job_type));
          }
        }
      } catch (err) {
        console.error('[' + workerId + '] Error leasing job:', err);
      }

      // 2. Concurrently deliver pending webhooks via SKIP LOCKED
      try {
        const webhookDelivered = await deliver();
        if (webhookDelivered) {
          didWork = true;
        }
      } catch (err) {
        console.error('[' + workerId + '] Webhook delivery error:', err);
      }

      // 3. Concurrently parse pending MIME messages via SKIP LOCKED
      try {
        const emailParsed = await parseNext();
        if (emailParsed) {
          didWork = true;
        }
      } catch (err) {
        console.error('[' + workerId + '] Email parsing error:', err);
      }

      if (didWork) {
        idleDelay = 500;
        continue;
      }

      // Dynamic backoff for idle workers, immediately interrupted by wake()
      await this.waitIdle(idleDelay);
      idleDelay = Math.min(idleDelay + 250, 1500);
    }
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();

    for (let i = 0; i < this.concurrency; i++) {
      this.workers.push(this.runWorker(i));
    }
  }

  public async stop(timeoutMs = 5000): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abortController.abort();
    this.wake();

    const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs));
    await Promise.race([Promise.allSettled(this.workers), timeout]);
    this.workers = [];
  }

  public getConcurrency(): number {
    return this.concurrency;
  }

  public isRunning(): boolean {
    return this.running;
  }
}

export const workerPool = new WorkerPool();
