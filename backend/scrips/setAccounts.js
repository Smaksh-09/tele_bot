require('dotenv').config();
const { TelegramClient } = require('gramjs');
const { StringSession } = require('gramjs/sessions');
const input = require('input');
const mongoose = require('mongoose');

// Import your Mongoose models
const TelegramAccount = require('../models/TelegramAccount');
const AppState = require('../models/AppState');

const MONGODB_URI = process.env.MONGODB_URI;

// Helper function to parse accounts from .env file
function getAccountsFromEnv() {
    const accounts = [];
    let i = 1;
    while (process.env[`PHONE_${i}`]) {
        if (!process.env[`API_ID_${i}`] || !process.env[`API_HASH_${i}`]) {
            console.warn(`[WARN] Account ${i} is missing API_ID or API_HASH in .env file. Skipping.`);
            i++;
            continue;
        }
        accounts.push({
            phone: process.env[`PHONE_${i}`],
            apiId: process.env[`API_ID_${i}`],
            apiHash: process.env[`API_HASH_${i}`],
        });
        i++;
    }
    return accounts;
}


async function generateAndSaveSessions() {
    if (!MONGODB_URI) {
        throw new Error('MONGODB_URI environment variable is not set.');
    }

    await mongoose.connect(MONGODB_URI);
    console.log('Successfully connected to MongoDB.');

    const envAccounts = getAccountsFromEnv();
    if (envAccounts.length === 0) {
        console.log('No accounts found in .env file. Please check your .env configuration.');
        await mongoose.disconnect();
        return;
    }

    console.log(`Found ${envAccounts.length} account(s) in the .env file.`);

    let successfulAccounts = 0;
    for (let i = 0; i < envAccounts.length; i++) {
        const { phone, apiId, apiHash } = envAccounts[i];
        console.log(`\n--- Processing Account ${i + 1}/${envAccounts.length}: ${phone} ---`);

        // Check if account with session already exists
        const existingAccount = await TelegramAccount.findOne({ phone: phone });
        if (existingAccount && existingAccount.sessionString) {
            console.log(`Account ${phone} already has a session string in the database. Skipping.`);
            continue;
        }

        const session = new StringSession(''); // Start with an empty session
        const client = new TelegramClient(session, parseInt(apiId), apiHash, {
            connectionRetries: 5,
        });

        try {
            await client.start({
                phoneNumber: phone,
                password: async () => await input.text('Please enter your 2FA password: '),
                phoneCode: async () => await input.text('Please enter the code you received: '),
                onError: (err) => console.log(err),
            });

            const sessionString = client.session.save();
            console.log('Login successful! Session string generated.');

            // Upsert the account data into the database
            // 'upsert' creates the document if it doesn't exist
            await TelegramAccount.findOneAndUpdate(
                { phone: phone },
                {
                    accountIndex: i, // Assign index based on .env order
                    phone,
                    apiId,
                    apiHash,
                    sessionString: sessionString,
                    status: 'healthy'
                },
                { upsert: true, new: true }
            );

            console.log(`Successfully saved account ${phone} to the database.`);
            successfulAccounts++;

        } catch (error) {
            console.error(`Failed to process account ${phone}. Error:`, error.message);
        } finally {
            // Ensure client is disconnected
            if(client.connected){
                await client.disconnect();
            }
        }
    }

    // After setting up accounts, initialize the AppState
    if (successfulAccounts > 0) {
        await AppState.findOneAndUpdate(
            { singletonKey: 'main' },
            { nextAccountIndex: 0 },
            { upsert: true }
        );
        console.log('\nApplication state initialized. Bot is ready to start with account index 0.');
    }


    await mongoose.disconnect();
    console.log('\nSetup complete. Disconnected from MongoDB.');
}

generateAndSaveSessions().catch(console.error);