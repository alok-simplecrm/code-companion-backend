import mongoose, { Schema, Document } from 'mongoose';

export interface IJiraTicket extends Document {
    ticketKey: string;
    title: string;
    description?: string;
    status: string;
    priority?: string;
    assignee?: string;
    ticketUrl: string;
    relatedPrIds: mongoose.Types.ObjectId[];
    embedding: number[];
    createdAt: Date;
    updatedAt: Date;
}

const JiraTicketSchema = new Schema<IJiraTicket>(
    {
        ticketKey: { type: String, required: true, unique: true },
        title: { type: String, required: true },
        description: { type: String },
        status: { type: String, required: true },
        priority: { type: String },
        assignee: { type: String },
        ticketUrl: { type: String, required: true },
        relatedPrIds: [{ type: Schema.Types.ObjectId, ref: 'GitHubPR' }],
        embedding: { type: [Number], default: [] },
    },
    {
        timestamps: true,
    }
);

// Text index for full-text search
JiraTicketSchema.index({ title: 'text', description: 'text' });

export const JiraTicket = mongoose.model<IJiraTicket>('JiraTicket', JiraTicketSchema);
