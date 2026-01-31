import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

const PORT = parseInt(env.PORT, 10);

async function main() {
    try {
        // Connect to MongoDB
        await connectDatabase();

        // Create Express app
        const app = createApp();

        // Start server
        const server = app.listen(PORT, () => {
            logger.info(`🚀 Server running on http://localhost:${PORT}`);
            logger.info(`📊 Environment: ${env.NODE_ENV}`);
            logger.info(`🔗 Frontend URL: ${env.FRONTEND_URL}`);
        });

        // Graceful shutdown
        const shutdown = async (signal: string) => {
            logger.info(`${signal} received. Shutting down gracefully...`);

            server.close(async () => {
                logger.info('HTTP server closed');
                await disconnectDatabase();
                process.exit(0);
            });

            // Force shutdown after 10 seconds
            setTimeout(() => {
                logger.error('Could not close connections in time, forcefully shutting down');
                process.exit(1);
            }, 10000);
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));

    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
}

main();
