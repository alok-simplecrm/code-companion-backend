import fs from 'fs/promises';
import path from 'path';
import { ProjectProfile } from '../models/index.js';
import { logger } from '../utils/logger.js';
import { codebaseGraph } from './graphDB.js';

/**
 * Service to scan and build a profile of the codebase architecture
 */
export async function updateProjectProfile() {
    logger.info('Updating Project Profile...');
    
    // In a multi-repo environment, we might handle multiple profiles, 
    // but for this implementation we focus on the current workspace context.
    const projectName = 'Code Companion';
    const backendRoot = process.cwd();
    const frontendRoot = path.join(backendRoot, '../code-companion-ai');

    try {
        await codebaseGraph.buildGraph(backendRoot);
        const techStack = await scanTechStack(backendRoot, frontendRoot);
        const directoryStructure = await scanDirectoryStructure(backendRoot, frontendRoot);
        const architectureOverview = generateArchitectureOverview(techStack, directoryStructure);

        const profile = await ProjectProfile.findOneAndUpdate(
            { projectName },
            {
                projectName,
                techStack,
                directoryStructure,
                architectureOverview,
                lastScannedAt: new Date(),
            },
            { upsert: true, new: true }
        );

        logger.info(`Project Profile updated for ${projectName}`);
        return profile;
    } catch (error) {
        logger.error('Failed to update project profile:', error);
        throw error;
    }
}

async function scanTechStack(backendRoot: string, frontendRoot: string) {
    const backendPkg = JSON.parse(await fs.readFile(path.join(backendRoot, 'package.json'), 'utf8'));
    let frontendPkg = {};
    try {
        frontendPkg = JSON.parse(await fs.readFile(path.join(frontendRoot, 'package.json'), 'utf8'));
    } catch (e) {
        logger.warn('Frontend package.json not found during tech stack scan');
    }

    const getAllDeps = (pkg: any) => [
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.devDependencies || {}),
    ];

    const backendDeps = getAllDeps(backendPkg);
    const frontendDeps = getAllDeps(frontendPkg);

    return {
        backend: backendDeps.filter(d => ['express', 'mongoose', 'typescript', 'google-generative-ai'].includes(d) || d.includes('langchain')),
        frontend: frontendDeps.filter(d => ['react', 'vite', 'tailwind', 'lucide-react', 'shadcn'].includes(d) || d.includes('@shadcn')),
        database: ['MongoDB (Mongoose)'],
        infra: backendDeps.includes('docker') ? ['Docker'] : [],
    };
}

async function scanDirectoryStructure(backendRoot: string, frontendRoot: string) {
    const structure = new Map<string, string>();
    
    // Heuristic mapping for backend
    structure.set('backend/src/services', 'Core business logic and external integrations (GitHub, LLM)');
    structure.set('backend/src/models', 'Database schemas and type definitions');
    structure.set('backend/src/controllers', 'Request handling and API logic');
    structure.set('backend/src/routes', 'API endpoint definitions');

    // Heuristic mapping for frontend
    structure.set('frontend/src/components', 'UI components and layout blocks');
    structure.set('frontend/src/hooks', 'React custom hooks for data fetching and state');
    structure.set('frontend/src/lib', 'Shared utilities and API client');

    return structure;
}

function generateArchitectureOverview(techStack: any, structure: any) {
    return `This project is a Code Companion AI designed to analyze repository history (PRs, Commits, Tickets) using RAG. 
The backend is built with ${techStack.backend.join(', ')} and uses MongoDB for persistence. 
The frontend is a modern React application powered by ${techStack.frontend.join(', ')}. 
The system integrates with GitHub for real-time webhooks and uses the Gemini API for intelligence.`;
}

export async function getProjectContext() {
    const profile = await ProjectProfile.findOne({ projectName: 'Code Companion' });
    if (!profile) return 'Project architecture context unavailable.';
    
    const stack = `
- Backend: ${profile.techStack.backend.join(', ')}
- Frontend: ${profile.techStack.frontend.join(', ')}
- Database: ${profile.techStack.database.join(', ')}`;

    const structure = Array.from(profile.directoryStructure.entries())
        .map(([key, val]) => `- ${key}: ${val}`)
        .join('\n');

    return `
## Project Architecture Context:
${profile.architectureOverview}

### Technology Stack:
${stack}

### Directory Structure & Modules:
${structure}
`;
}
