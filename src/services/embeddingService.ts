import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const EMBEDDING_DIMENSION = 768; // Gemini embedding dimension

let genAI: GoogleGenerativeAI | null = null;

function getGenAI(): GoogleGenerativeAI {
    if (!genAI) {
        if (!env.GOOGLE_AI_API_KEY) {
            throw new Error('GOOGLE_AI_API_KEY is not configured');
        }
        genAI = new GoogleGenerativeAI(env.GOOGLE_AI_API_KEY);
    }
    return genAI;
}

/**
 * Generate embedding using Google's text-embedding model
 */
export async function generateEmbedding(text: string): Promise<number[]> {
    try {
        const ai = getGenAI();
        const model = ai.getGenerativeModel({ model: 'text-embedding-004' });

        // Truncate text to avoid token limits
        const truncatedText = text.substring(0, 8000);

        const result = await model.embedContent(truncatedText);
        const embedding = result.embedding.values;

        logger.debug(`Generated embedding with ${embedding.length} dimensions`);
        return embedding;
    } catch (error) {
        logger.warn('Failed to generate AI embedding, using fallback:', error);
        return generateDeterministicEmbedding(text);
    }
}

/**
 * Fallback deterministic embedding based on text hash
 * Used when AI API is unavailable
 */
export function generateDeterministicEmbedding(text: string): number[] {
    const embedding = new Array(EMBEDDING_DIMENSION).fill(0);
    const words = text.toLowerCase().split(/\s+/);

    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        for (let j = 0; j < word.length; j++) {
            const idx = (word.charCodeAt(j) * (i + 1) * (j + 1)) % EMBEDDING_DIMENSION;
            embedding[idx] += 0.1;
        }
    }

    // Normalize the embedding
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0)) || 1;
    return embedding.map(val => val / magnitude);
}

/**
 * Calculate cosine similarity between two embeddings
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
        throw new Error('Embeddings must have the same dimension');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Find similar documents by embedding
 */
export async function findSimilarByEmbedding<T extends { embedding: number[] }>(
    queryEmbedding: number[],
    documents: T[],
    threshold = 0.5,
    limit = 10
): Promise<Array<T & { similarity: number }>> {
    const results = documents
        .filter(doc => doc.embedding && doc.embedding.length > 0)
        .map(doc => ({
            ...doc,
            similarity: cosineSimilarity(queryEmbedding, doc.embedding),
        }))
        .filter(doc => doc.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);

    return results;
}
