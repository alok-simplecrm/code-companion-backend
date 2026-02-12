import mongoose, { Schema, Document } from 'mongoose';

export interface IMessage {
    role: 'user' | 'model';
    content: string;
    timestamp: Date;
    metadata?: Record<string, any>;
}

export interface IConversation extends Document {
    conversationId: string;
    messages: IMessage[];
    metadata: {
        repoUrl?: string;
        projectContext?: string;
    };
    lastActivityAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

const ConversationSchema = new Schema<IConversation>(
    {
        conversationId: { type: String, required: true, unique: true, index: true },
        messages: [
            {
                role: { type: String, enum: ['user', 'model'], required: true },
                content: { type: String, required: true },
                timestamp: { type: Date, default: Date.now },
                metadata: { type: Schema.Types.Mixed },
            },
        ],
        metadata: {
            repoUrl: { type: String },
            projectContext: { type: String },
        },
        lastActivityAt: { type: Date, default: Date.now },
    },
    {
        timestamps: true,
    }
);

export const Conversation = mongoose.model<IConversation>('Conversation', ConversationSchema);
