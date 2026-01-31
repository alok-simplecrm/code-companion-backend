import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { env } from './env.js';

// Connection retry configuration
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5000;

// MongoDB connection options optimized for production
const connectionOptions: mongoose.ConnectOptions = {
    maxPoolSize: 10,               // Maximum number of connections in the pool
    minPoolSize: 2,                // Minimum number of connections
    serverSelectionTimeoutMS: 5000, // Timeout for server selection
    socketTimeoutMS: 45000,        // Socket timeout
    family: 4,                     // Use IPv4
};

let isConnected = false;
let retryCount = 0;

/**
 * Connect to MongoDB with retry logic
 */
export async function connectDatabase(): Promise<void> {
    if (isConnected) {
        logger.debug('Already connected to MongoDB');
        return;
    }

    try {
        await mongoose.connect(env.MONGODB_URI, connectionOptions);
        isConnected = true;
        retryCount = 0;
        logger.info('✅ Connected to MongoDB successfully');

        // Connection event handlers
        mongoose.connection.on('error', (error) => {
            logger.error('MongoDB connection error:', error);
            isConnected = false;
        });

        mongoose.connection.on('disconnected', () => {
            logger.warn('MongoDB disconnected');
            isConnected = false;
            if (retryCount < MAX_RETRIES) {
                scheduleReconnect();
            }
        });

        mongoose.connection.on('reconnected', () => {
            logger.info('MongoDB reconnected');
            isConnected = true;
            retryCount = 0;
        });

    } catch (error) {
        logger.error(`Failed to connect to MongoDB (attempt ${retryCount + 1}/${MAX_RETRIES}):`, error);
        
        if (retryCount < MAX_RETRIES) {
            retryCount++;
            logger.info(`Retrying connection in ${RETRY_DELAY_MS / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            return connectDatabase();
        }
        
        logger.error('Max retry attempts reached. Exiting...');
        process.exit(1);
    }
}

/**
 * Schedule a reconnection attempt
 */
function scheduleReconnect(): void {
    retryCount++;
    logger.info(`Scheduling reconnection attempt ${retryCount}/${MAX_RETRIES} in ${RETRY_DELAY_MS / 1000}s`);
    setTimeout(() => {
        connectDatabase().catch(err => {
            logger.error('Reconnection failed:', err);
        });
    }, RETRY_DELAY_MS);
}

/**
 * Gracefully disconnect from MongoDB
 */
export async function disconnectDatabase(): Promise<void> {
    if (!isConnected) {
        logger.debug('Not connected to MongoDB');
        return;
    }

    try {
        await mongoose.disconnect();
        isConnected = false;
        logger.info('Disconnected from MongoDB gracefully');
    } catch (error) {
        logger.error('Error disconnecting from MongoDB:', error);
        throw error;
    }
}

/**
 * Check if database is connected and healthy
 */
export async function checkDatabaseHealth(): Promise<{ connected: boolean; latencyMs?: number }> {
    if (!isConnected || mongoose.connection.readyState !== 1) {
        return { connected: false };
    }

    try {
        const startTime = Date.now();
        await mongoose.connection.db?.admin().ping();
        const latencyMs = Date.now() - startTime;
        return { connected: true, latencyMs };
    } catch (error) {
        logger.error('Database health check failed:', error);
        return { connected: false };
    }
}

/**
 * Get current connection status
 */
export function getConnectionStatus(): { 
    isConnected: boolean; 
    readyState: number; 
    poolSize: number;
} {
    return {
        isConnected,
        readyState: mongoose.connection.readyState,
        poolSize: connectionOptions.maxPoolSize || 10,
    };
}
