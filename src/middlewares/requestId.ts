import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

// Extend Express Request type to include requestId
declare global {
    namespace Express {
        interface Request {
            requestId?: string;
        }
    }
}

/**
 * Add unique request ID to each request for debugging and logging
 */
export function requestIdMiddleware(req: Request, _res: Response, next: NextFunction) {
    // Check if request already has an ID (from load balancer or proxy)
    req.requestId = (req.headers['x-request-id'] as string) || uuidv4();
    next();
}

/**
 * Add request ID to response headers
 */
export function requestIdHeader(req: Request, res: Response, next: NextFunction) {
    if (req.requestId) {
        res.setHeader('x-request-id', req.requestId);
    }
    next();
}
