import { Request, Response } from 'express';
import { GitHubPR, GitHubCommit, JiraTicket, AnalysisQuery, Issue } from '../models/index.js';
import { checkDatabaseHealth, getConnectionStatus } from '../config/database.js';
import { env } from '../config/env.js';

/**
 * GET /api/health
 * Health check endpoint with database connectivity test
 */
export async function healthCheck(_req: Request, res: Response) {
    const dbHealth = await checkDatabaseHealth();
    const connStatus = getConnectionStatus();
    
    const isHealthy = dbHealth.connected;
    const statusCode = isHealthy ? 200 : 503;

    res.status(statusCode).json({
        status: isHealthy ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        environment: env.NODE_ENV,
        database: {
            connected: dbHealth.connected,
            latencyMs: dbHealth.latencyMs,
            readyState: connStatus.readyState,
            poolSize: connStatus.poolSize,
        },
        uptime: process.uptime(),
    });
}

/**
 * GET /api/stats
 * Get database statistics
 */
export async function getStats(_req: Request, res: Response) {
    try {
        const [prCount, commitCount, ticketCount, queryCount, issueStats] = await Promise.all([
            GitHubPR.countDocuments(),
            GitHubCommit.countDocuments(),
            JiraTicket.countDocuments(),
            AnalysisQuery.countDocuments(),
            Promise.all([
                Issue.countDocuments(),
                Issue.countDocuments({ status: 'resolved' }),
                Issue.countDocuments({ status: 'unresolved' }),
                Issue.countDocuments({ status: 'pending' }),
            ]),
        ]);

        res.json({
            success: true,
            data: {
                pullRequests: prCount,
                commits: commitCount,
                tickets: ticketCount,
                analysisQueries: queryCount,
                issues: {
                    total: issueStats[0],
                    resolved: issueStats[1],
                    unresolved: issueStats[2],
                    pending: issueStats[3],
                },
            },
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to fetch statistics',
        });
    }
}

