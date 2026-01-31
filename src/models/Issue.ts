import mongoose, { Schema, Document, Types } from 'mongoose';
import type { IAnalysisResult, InputType } from './AnalysisQuery.js';

/**
 * Matched PR reference stored with the issue
 */
export interface IMatchedPR {
    prId: Types.ObjectId | null;
    prNumber: number;
    prUrl: string;
    title: string;
    description?: string;
    confidence: number;
    isFixing: boolean;
    suggestedChanges?: string;
    implementationSteps?: string;
}

/**
 * Issue interface for tracking user-submitted issues
 */
export interface IIssue extends Document {
    issueId: string;                  // UUID for external reference
    userId?: string;                  // Optional user identifier
    email?: string;                   // Optional email for notifications
    title: string;                    // Issue title/summary
    description: string;              // Full issue description
    inputType: InputType;             // Type of input (error, stack_trace, etc.)
    status: 'pending' | 'analyzing' | 'resolved' | 'unresolved' | 'needs_attention';
    matchedPRs: IMatchedPR[];         // PRs that may fix this issue
    analysisResult?: IAnalysisResult; // Full analysis from LLM
    embedding: number[];              // Vector embedding for similarity search
    notificationSent: boolean;        // Whether user was notified
    createdAt: Date;
    updatedAt: Date;
    resolvedAt?: Date;
}

const MatchedPRSchema = new Schema<IMatchedPR>({
    prId: { type: Schema.Types.ObjectId, ref: 'GitHubPR', required: false },
    prNumber: { type: Number, required: true },
    prUrl: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String },
    confidence: { type: Number, required: true, min: 0, max: 1 },
    isFixing: { type: Boolean, default: false },
    suggestedChanges: { type: String },
    implementationSteps: { type: String },
});

const IssueSchema = new Schema<IIssue>(
    {
        issueId: { 
            type: String, 
            required: true, 
            unique: true,
            index: true,
        },
        userId: { type: String, index: true },
        email: { type: String },
        title: { type: String, required: true },
        description: { type: String, required: true },
        inputType: { 
            type: String, 
            enum: ['error', 'stack_trace', 'jira_ticket', 'github_issue', 'description'],
            default: 'description',
        },
        status: {
            type: String,
            enum: ['pending', 'analyzing', 'resolved', 'unresolved', 'needs_attention'],
            default: 'pending',
            index: true,
        },
        matchedPRs: { type: [MatchedPRSchema], default: [] },
        analysisResult: { type: Schema.Types.Mixed },
        embedding: { type: [Number], default: [] },
        notificationSent: { type: Boolean, default: false },
        resolvedAt: { type: Date },
    },
    {
        timestamps: true,
    }
);

// Text index for full-text search on title and description
IssueSchema.index({ title: 'text', description: 'text' });

// Compound index for user's issues by status
IssueSchema.index({ userId: 1, status: 1, createdAt: -1 });

export const Issue = mongoose.model<IIssue>('Issue', IssueSchema);
