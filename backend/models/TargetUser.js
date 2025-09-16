const mongoose = require('mongoose');

const targetUserSchema = new mongoose.Schema({
    username: { 
        type: String, 
        required: true, 
        unique: true,
        trim: true 
    },
    imported: { 
        type: Date, 
        default: Date.now 
    },
    lastMessageSent: { 
        type: Date 
    },
    messageCount: { 
        type: Number, 
        default: 0 
    },
    status: {
        type: String,
        enum: ['active', 'messaged', 'blocked', 'invalid', 'invalid_username'],
        default: 'active'
    }
});

module.exports = mongoose.model('TargetUser', targetUserSchema);
