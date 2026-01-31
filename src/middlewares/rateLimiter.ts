import rateLimit from 'express-rate-limit';
import { logger } from '../utils/logger.js';

/**
 * General API rate limiter
 */
export const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    message: {
        success: false,
        error: 'Too many requests, please try again later.',
    },
    handler: (req, res, _next, options) => {
        logger.warn(`Rate limit exceeded for IP: ${req.ip}`);
        res.status(429).json(options.message);
    },
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * Stricter rate limiter for analysis endpoint
 */
export const analysisLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 20, // 20 analysis requests per minute
    message: {
        success: false,
        error: 'Too many analysis requests, please try again later.',
    },
    handler: (req, res, _next, options) => {
        logger.warn(`Analysis rate limit exceeded for IP: ${req.ip}`);
        res.status(429).json(options.message);
    },
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * Webhook rate limiter (higher limit for GitHub)
 */
export const webhookLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 200, // 200 webhook events per minute
    message: {
        success: false,
        error: 'Too many webhook events.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});
