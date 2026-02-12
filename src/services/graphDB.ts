import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger.js';
import { CodebaseNode } from '../models/index.js';

/**
 * Service to build and query a basic codebase knowledge graph
 * Focuses on file-to-file relationships using MongoDB for persistence
 */
export class CodebaseGraph {
    async buildGraph(root: string) {
        logger.info(`Building codebase knowledge graph from ${root}...`);
        
        // We'll scan and collect updates in a local batch to minimize DB roundtrips
        const nodes: { file: string; imports: string[] }[] = [];
        await this.scanDir(root, root, nodes);

        // Perform bulk upsert
        if (nodes.length > 0) {
            const operations = nodes.map(node => ({
                updateOne: {
                    filter: { file: node.file },
                    update: { 
                        $set: { 
                            imports: node.imports,
                            lastScannedAt: new Date()
                        } 
                    },
                    upsert: true
                }
            }));

            await CodebaseNode.bulkWrite(operations);
        }

        logger.info(`Knowledge graph persistent storage updated with ${nodes.length} files.`);
    }

    private async scanDir(dir: string, root: string, nodes: { file: string; imports: string[] }[]) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(root, fullPath);

            if (entry.isDirectory()) {
                if (['node_modules', '.git', 'dist', 'build'].includes(entry.name)) continue;
                await this.scanDir(fullPath, root, nodes);
            } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
                const imports = await this.extractImports(fullPath);
                nodes.push({ file: relativePath, imports });
            }
        }
    }

    private async extractImports(filePath: string): Promise<string[]> {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const importRegex = /from ['"](.+?)['"]/g;
            const matches = [...content.matchAll(importRegex)];
            return matches.map(m => m[1]);
        } catch (e) {
            return [];
        }
    }

    async getRelatedFiles(file: string): Promise<string[]> {
        const node = await CodebaseNode.findOne({ file });
        return node?.imports || [];
    }

    async getDependents(file: string): Promise<string[]> {
        // Files that import this file (loose check for substring or exact match depending on import style)
        const nodes = await CodebaseNode.find({ 
            imports: { $regex: file.replace(/(\.ts|\.js|\.tsx|\.jsx)$/, '') }
        });
        return nodes.map(n => n.file);
    }
}

export const codebaseGraph = new CodebaseGraph();
