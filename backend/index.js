require('dotenv').config();
const mongoose = require('mongoose');

// Initialize the scheduler, which will start the cron job.
require('./services/scheduler');

async function main() {
    if (!process.env.MONGODB_URI) {
        throw new Error('MONGODB_URI environment variable is not set.');
    }

    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Successfully connected to MongoDB.');
        console.log('Telegram Sender Service is running. Scheduler is active.');
    } catch (error) {
        console.error('Failed to connect to MongoDB:', error);
        process.exit(1);
    }
}

main();
