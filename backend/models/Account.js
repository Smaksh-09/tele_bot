const mongoose = require('mongoose');

const accountSchema = new mongoose.Schema({
    accountIndex: { type: Number, required: true, unique: true }, // 0 to 19(total 20 accounts)
    phone: { type: String, required: true, unique: true },
    apiId: { type: String, required: true },
    apiHash: { type: String, required: true },
    sessionString: { type: String, required: true },
    status: {
        type: String,
        enum: ['healthy', 'limited', 'banned'],
        default: 'healthy'
    },
    lastStatusCheck: { type: Date },
    statusMessage: { type: String, default: '' } // To store the reply from SpamInfoBot
});

module.exports = mongoose.model('TelegramAccount', accountSchema);