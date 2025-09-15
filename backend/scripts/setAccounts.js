require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');
const mongoose = require('mongoose');

// Import your Mongoose models
const TelegramAccount = require('../models/Account');
const AppState = require('../models/AppState');

const MONGODB_URI = process.env.MONGODB_URI;

// Helper function to parse accounts from .env file
function getAccountsFromEnv() {
    // First, try to parse ACCOUNTS_JSON format
    if (process.env.ACCOUNTS_JSON) {
        try {
            const accountsJson = JSON.parse(process.env.ACCOUNTS_JSON);
            if (Array.isArray(accountsJson)) {
                console.log(`Found ${accountsJson.length} account(s) in ACCOUNTS_JSON format.`);
                return accountsJson.map(account => ({
                    phone: account.phone,
                    apiId: account.apiId.toString(),
                    apiHash: account.apiHash
                }));
            }
        } catch (error) {
            console.error('Error parsing ACCOUNTS_JSON:', error.message);
            console.log('Falling back to individual PHONE_X, API_ID_X, API_HASH_X format...');
        }
    }

    // Fallback to individual environment variables format
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
    
    if (accounts.length > 0) {
        console.log(`Found ${accounts.length} account(s) in individual PHONE_X/API_ID_X format.`);
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
        
        // This is the most important part - wrap everything in try...catch for each account
        try {
            console.log(`\n--------------------------------------------------`);
            console.log(`[Setup] Processing Account ${i + 1}/${envAccounts.length}: ${phone}`);

            // Check if account with session already exists
            const existingAccount = await TelegramAccount.findOne({ phone: phone });
            if (existingAccount && existingAccount.sessionString) {
                console.log(`[Setup] Account ${phone} already has a session string in the database. Skipping.`);
                continue; // This skips to the next account in the loop
            }

            console.log(`[Setup] New account found. Starting interactive login for ${phone}.`);
            console.log(`[Setup] IMPORTANT: Please be ready to enter the code within ~60 seconds to avoid a timeout.`);
            
            const session = new StringSession(''); // Start with an empty session
            const client = new TelegramClient(session, parseInt(apiId), apiHash, {
                connectionRetries: 3, // Reduced from 5 to 3 for faster failure detection
            });

            await client.start({
                phoneNumber: phone,
                password: async () => await input.text('? Please enter your 2FA password: '),
                phoneCode: async () => await input.text('? Please enter the code you received: '),
                onError: (err) => console.error('[Telegram Error]', err),
            });

            const sessionString = client.session.save();
            console.log('[Setup] Login successful! Session string generated.');

            // Ensure client is disconnected before saving to database
            if(client.connected){
                await client.disconnect();
            }

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

            console.log(`[Setup] SUCCESS! Account ${phone} has been authenticated and saved to the database.`);
            successfulAccounts++;

        } catch (error) {
            // If any error (including timeout) happens for one account, we catch it here.
            console.error(`[Setup] FAILED to set up account ${phone}. Error: ${error.message}`);
            console.error(`[Setup] This could be due to a timeout or incorrect credentials. Moving to the next account...`);
            // The catch block prevents the script from crashing, and the for loop will continue.
            
            // Still try to disconnect the client if it exists
            try {
                if (typeof client !== 'undefined' && client.connected) {
                    await client.disconnect();
                }
            } catch (disconnectError) {
                console.error(`[Setup] Failed to disconnect client for ${phone}:`, disconnectError.message);
            }
        }
    }

    // After setting up accounts, initialize the AppState
    console.log(`\n--------------------------------------------------`);
    if (successfulAccounts > 0) {
        await AppState.findOneAndUpdate(
            { singletonKey: 'main' },
            { nextAccountIndex: 0 },
            { upsert: true }
        );
        console.log(`[Setup] Application state initialized. Bot is ready to start with account index 0.`);
        console.log(`[Setup] Successfully processed ${successfulAccounts}/${envAccounts.length} accounts.`);
    } else {
        console.log(`[Setup] WARNING: No accounts were successfully processed. Please check your credentials and try again.`);
    }

    await mongoose.disconnect();
    console.log('[Setup] Setup complete. Disconnected from MongoDB.');
}

// Enhanced error handling for the main function
generateAndSaveSessions().catch(error => {
    console.error('[Setup] CRITICAL: An unexpected error occurred in the main function:', error);
    process.exit(1);
});