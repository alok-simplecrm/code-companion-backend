import mongoose, { Schema, Document } from 'mongoose';

export type AnalysisStatus = 'fixed' | 'not_fixed' | 'partially_fixed' | 'unknown';
export type InputType = 'error' | 'stack_trace' | 'jira_ticket' | 'github_issue' | 'description';

export interface IAnalysisResult {
    status: AnalysisStatus;
    confidence: number;
    summary: string;
    rootCause: string;
    explanation: string;
    diffAnalysis?: string;
    bestPractices?: string[];
    relatedPRs: Array<{
        prNumber: number;
        title: string;
        author: string;
        url: string;
        mergedAt?: string;
        relevanceScore: number;
        filesImpacted: string[];
        whyRelevant?: string;
    }>;
    relatedCommits: Array<{
        sha: string;
        message: string;
        author: string;
        url: string;
        committedAt: string;
        filesChanged: string[];
    }>;
    relatedTickets: Array<{
        key: string;
        title: string;
        status: string;
        priority: string;
        url: string;
    }>;
    filesImpacted: Array<{
        path: string;
        module: string;
        changeType: 'modified' | 'added' | 'deleted';
        linesChanged: number;
    }>;
    fixSuggestion?: {
        title: string;
        description: string;
        steps: string[];
        codeExample?: string;
    };
}

export interface IAnalysisQuery extends Document {
    inputText: string;
    inputType: InputType;
    embedding: number[];
    result: IAnalysisResult;
    createdAt: Date;
}

const AnalysisQuerySchema = new Schema<IAnalysisQuery>(
    {
        inputText: { type: String, required: true },
        inputType: {
            type: String,
            required: true,
            enum: ['error', 'stack_trace', 'jira_ticket', 'github_issue', 'description']
        },
        embedding: { type: [Number], default: [] },
        result: { type: Schema.Types.Mixed, required: true },
    },
    {
        timestamps: { createdAt: true, updatedAt: false },
    }
);

// Index for recent queries
AnalysisQuerySchema.index({ createdAt: -1 });

export const AnalysisQuery = mongoose.model<IAnalysisQuery>('AnalysisQuery', AnalysisQuerySchema);
