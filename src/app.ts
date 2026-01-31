import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import routes from './routes/index.js';
import { errorHandler, notFoundHandler, apiLimiter, requestIdMiddleware, requestIdHeader } from './middlewares/index.js';
import { logger } from './utils/logger.js';

/**
 * Create and configure Express application
 */
export function createApp() {
    const app = express();

    // Request ID tracking (first middleware)
    app.use(requestIdMiddleware);
    app.use(requestIdHeader);

    // Security middleware
    app.use(helmet());

    // CORS configuration
    const allowedOrigins = [
        env.FRONTEND_URL,
        "https://code-companion-backend-842944963608.asia-southeast1.run.app/",
        'http://localhost:8080',
        'http://127.0.0.1:8080',
        'http://localhost:3000',
    ].filter(Boolean);

    app.use(cors({
        origin: (origin, callback) => {
            // Allow requests with no origin (like mobile apps or curl)
            if (!origin) return callback(null, true);
            if (allowedOrigins.includes(origin)) {
                return callback(null, true);
            }
            // In development, allow all origins
            if (env.NODE_ENV === 'development') {
                return callback(null, true);
            }
            return callback(new Error('Not allowed by CORS'));
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'x-hub-signature-256', 'x-github-event', 'x-github-delivery', 'x-request-id'],
    }));

    // Request logging with request ID
    app.use(morgan(':method :url :status :res[content-length] - :response-time ms [:req[x-request-id]]', {
        stream: {
            write: (message: string) => logger.info(message.trim()),
        },
    }));

    // Body parsing
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Rate limiting
    app.use('/api', apiLimiter);

    // API routes
    app.use('/api', routes);

    // Root endpoint
    app.get('/', (_req, res) => {
        res.json({
            name: 'Code Companion API',
            version: '1.0.0',
            description: 'AI-powered code companion for bug resolution using RAG',
            endpoints: {
                health: '/api/health',
                stats: '/api/stats',
                analyze: 'POST /api/analyze',
                issues: {
                    submit: 'POST /api/issues',
                    get: 'GET /api/issues/:issueId',
                    list: 'GET /api/issues',
                    stats: 'GET /api/issues/stats',
                },
                github: {
                    webhook: 'POST /api/github/webhook',
                    ingest: 'POST /api/github/ingest',
                },
            },
        });
    });

    // 404 handler
    app.use(notFoundHandler);

    // Error handler
    app.use(errorHandler);

    return app;
}
