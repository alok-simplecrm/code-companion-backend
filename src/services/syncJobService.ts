import { v4 as uuidv4 } from 'uuid';
import { syncRepoPRs } from './githubService.js';
import { logger } from '../utils/logger.js';
import { AllowedRepo } from '../models/index.js';
import { syncEventEmitter } from './syncEventEmitter.js';

export interface SyncJob {
    id: string;
    owner: string;
    repo: string;
    limit: number;
    status: 'pending' | 'running' | 'completed' | 'failed';
    progress: {
        processed: number;
        updated: number;
        skipped: number;
        errors: string[];
    };
    message?: string;
    startedAt: Date;
    completedAt?: Date;
}

// In-memory job store (for simplicity - could be moved to Redis/DB for persistence)
const syncJobs = new Map<string, SyncJob>();

// Clean up old jobs after 1 hour
const JOB_RETENTION_MS = 60 * 60 * 1000;

function cleanupOldJobs() {
    const now = Date.now();
    for (const [id, job] of syncJobs.entries()) {
        if (job.completedAt && now - job.completedAt.getTime() > JOB_RETENTION_MS) {
            syncJobs.delete(id);
        }
    }
}

// Run cleanup every 10 minutes
setInterval(cleanupOldJobs, 10 * 60 * 1000);

/**
 * Start a background sync job
 */
export function startSyncJob(owner: string, repo: string, limit: number = 0): SyncJob {
    const jobId = uuidv4();
    
    const job: SyncJob = {
        id: jobId,
        owner,
        repo,
        limit,
        status: 'pending',
        progress: {
            processed: 0,
            updated: 0,
            skipped: 0,
            errors: [],
        },
        startedAt: new Date(),
    };
    
    syncJobs.set(jobId, job);
    
    // Start sync in background
    runSyncInBackground(job);
    
    return job;
}

/**
 * Get sync job status
 */
export function getSyncJob(jobId: string): SyncJob | undefined {
    return syncJobs.get(jobId);
}

/**
 * Get all active sync jobs
 */
export function getActiveSyncJobs(): SyncJob[] {
    return Array.from(syncJobs.values()).filter(
        job => job.status === 'pending' || job.status === 'running'
    );
}

/**
 * Get recent sync jobs (last 10)
 */
export function getRecentSyncJobs(): SyncJob[] {
    return Array.from(syncJobs.values())
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .slice(0, 10);
}

/**
 * Run sync in background
 */
async function runSyncInBackground(job: SyncJob): Promise<void> {
    job.status = 'running';
    logger.info(`[SyncJob ${job.id}] Starting sync for ${job.owner}/${job.repo}`);
    
    // Emit job started event
    syncEventEmitter.emitJobStarted(job.id, {
        id: job.id,
        owner: job.owner,
        repo: job.repo,
        status: job.status,
        progress: job.progress,
        startedAt: job.startedAt,
    });
    
    try {
        const result = await syncRepoPRs(job.owner, job.repo, job.limit);
        
        job.progress = {
            processed: result.processed,
            updated: result.updated,
            skipped: result.skipped,
            errors: result.errors,
        };
        job.message = result.message;
        job.status = 'completed';
        job.completedAt = new Date();
        
        // Emit job completed event
        syncEventEmitter.emitJobCompleted(job.id, {
            id: job.id,
            owner: job.owner,
            repo: job.repo,
            status: job.status,
            progress: job.progress,
            message: job.message,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
        });
        
        // Update the allowed repo's lastSyncedAt and prCount
        try {
            await AllowedRepo.findOneAndUpdate(
                { repoOwner: job.owner, repoName: job.repo },
                { 
                    lastSyncedAt: new Date(),
                    $inc: { prCount: result.processed },
                }
            );
        } catch (err) {
            logger.warn(`[SyncJob ${job.id}] Failed to update AllowedRepo:`, err);
        }
        
        logger.info(`[SyncJob ${job.id}] Completed: ${result.processed} processed, ${result.skipped} skipped`);
    } catch (error) {
        job.status = 'failed';
        job.completedAt = new Date();
        job.message = error instanceof Error ? error.message : 'Sync failed';
        job.progress.errors.push(job.message);
        
        // Emit job failed event
        syncEventEmitter.emitJobFailed(job.id, {
            id: job.id,
            owner: job.owner,
            repo: job.repo,
            status: job.status,
            progress: job.progress,
            message: job.message,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
        });
        
        logger.error(`[SyncJob ${job.id}] Failed:`, error);
    }
}
