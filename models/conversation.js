const mongoose = require('mongoose');

const quoteSchema = new mongoose.Schema({
    source: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Source' // Reference to the Source model
    },
    content: String
});

const subpointSchema = new mongoose.Schema({
    content: String, // Content of the subpoint
    quote: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Quote' // Reference to the Quote model
    }
});

const paragraphSchema = new mongoose.Schema({
    outline: {
        title: String,
        topic: String,
        subpoints: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Subpoint' // Reference to the Paragraph model
        }],
        conclusion: String
    },
    quotes: { type: Boolean, default: false },
    content: String
});

const conversationSchema = new mongoose.Schema({
    userId: mongoose.Schema.Types.ObjectId,  // Reference to the User
    content: [{
        role: String,
        message: String
    }],  // Array of messages or structured conversation data
    prewriting: { type: Boolean, default: true },
    topic: String,
    thesis: String,
    tone: String,
    sources: [{ type: mongoose.Schema.Types.ObjectId, ref: 'source' }],
    paragraphs: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Paragraph' // Reference to the Paragraph model
    }],  // Array of paragraphs
    createdAt: { type: Date, default: Date.now }
});

const Conversation = mongoose.model('Conversation', conversationSchema);
const Quote = mongoose.model('Quote', quoteSchema);
const Paragraph = mongoose.model('Paragraph', paragraphSchema);
const Subpoint = mongoose.model('Subpoint', subpointSchema);

module.exports = { Conversation, Quote, Paragraph, Subpoint };
