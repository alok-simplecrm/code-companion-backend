import { EventEmitter } from 'events';

// Singleton event emitter for sync job events
class SyncEventEmitter extends EventEmitter {
    private static instance: SyncEventEmitter;

    private constructor() {
        super();
        // Increase max listeners to handle multiple SSE connections
        this.setMaxListeners(100);
    }

    public static getInstance(): SyncEventEmitter {
        if (!SyncEventEmitter.instance) {
            SyncEventEmitter.instance = new SyncEventEmitter();
        }
        return SyncEventEmitter.instance;
    }

    // Emit job started event
    emitJobStarted(jobId: string, data: any): void {
        this.emit(`job:${jobId}`, { type: 'started', ...data });
    }

    // Emit job progress event
    emitJobProgress(jobId: string, data: any): void {
        this.emit(`job:${jobId}`, { type: 'progress', ...data });
    }

    // Emit job completed event
    emitJobCompleted(jobId: string, data: any): void {
        this.emit(`job:${jobId}`, { type: 'completed', ...data });
    }

    // Emit job failed event
    emitJobFailed(jobId: string, data: any): void {
        this.emit(`job:${jobId}`, { type: 'failed', ...data });
    }
}

export const syncEventEmitter = SyncEventEmitter.getInstance();
