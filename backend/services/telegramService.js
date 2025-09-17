const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const template = require('../config/template');

// --- Configuration for the Spam Check ---
const MAX_SPAM_CHECK_RETRIES = 5;
const SPAM_CHECK_RETRY_DELAY_MS = 10000; // 10 seconds between retries

/**
 * Checks the account's spam status by interacting with @SpamInfoBot.
 * It will retry up to 5 times if the account is initially reported as restricted.
 * @param {object} account - The Mongoose document for the Telegram account.
 * @returns {Promise<{status: 'healthy' | 'limited', message: string}>} The final status.
 */
async function checkSpamStatus(account) {
    const session = new StringSession(account.sessionString);
    const client = new TelegramClient(session, parseInt(account.apiId), account.apiHash, {
        connectionRetries: 3,
        timeout: 30000,
        retryDelay: 1000
    });
    
    let lastKnownBotReply = "No reply received from SpamInfoBot.";

    try {
        await client.connect();

        for (let attempt = 1; attempt <= MAX_SPAM_CHECK_RETRIES; attempt++) {
            console.log(`[Spam Check] Account ${account.phone}: Attempt ${attempt}/${MAX_SPAM_CHECK_RETRIES}...`);
            await client.sendMessage('SpamBot', { message: '/start' });

            // Wait a few seconds for the bot to reply
            await new Promise(resolve => setTimeout(resolve, 5000));

            const history = await client.getMessages('SpamBot', { limit: 1 });
            const botReply = history[0]?.message;
            lastKnownBotReply = botReply || lastKnownBotReply;

            // We consider an account restricted if the reply contains these keywords.
            // Telegram's positive messages can vary, so checking for negative ones is more reliable.
            const isRestricted = botReply && (botReply.toLowerCase().includes('restricted') || botReply.toLowerCase().includes('limited') || botReply.toLowerCase().includes('sorry'));

            if (!isRestricted) {
                // SUCCESS: The account is not restricted.
                console.log(`[Spam Check] Account ${account.phone} is healthy. Reply: "${botReply}"`);
                return { status: 'healthy', message: botReply }; // Exit the function immediately with a good status.
            }

            // If we're here, the account is currently restricted.
            console.log(`[Spam Check] Account ${account.phone} is restricted. Reply: "${botReply}"`);

            // If this was the last attempt, we don't need to wait again.
            if (attempt < MAX_SPAM_CHECK_RETRIES) {
                console.log(`[Spam Check] Waiting for ${SPAM_CHECK_RETRY_DELAY_MS / 1000}s before retrying...`);
                await new Promise(resolve => setTimeout(resolve, SPAM_CHECK_RETRY_DELAY_MS));
            }
        }

        // FAILURE: If the loop completes, it means all retry attempts failed.
        console.log(`[Spam Check] Account ${account.phone} remains restricted after ${MAX_SPAM_CHECK_RETRIES} attempts.`);
        return { status: 'limited', message: lastKnownBotReply };

    } catch (error) {
        console.error(`[Spam Check] Critical error during spam check for ${account.phone}:`, error);
        return { status: 'limited', message: `Error: ${error.message}` };
    } finally {
        if (client.connected) {
            await client.disconnect();
        }
    }
}


/**
 * Creates a Telegram client for an account.
 * @param {object} account - The Mongoose document for the Telegram account.
 * @returns {TelegramClient} The created client.
 */
function createClient(account) {
    const session = new StringSession(account.sessionString);
    return new TelegramClient(session, parseInt(account.apiId), account.apiHash, {
        connectionRetries: 3,
        timeout: 30000,
        retryDelay: 1000
    });
}

/**
 * Sends a single message to a target user using an existing client.
 * @param {TelegramClient} client - The connected Telegram client.
 * @param {string} targetUsername - The username of the recipient.
 * @returns {Promise<{success: boolean, errorType?: 'limited' | 'invalid_username' | 'generic'}>}
 */
async function sendMessage(client, targetUsername) {
    console.log(`[TelegramService] Starting sendMessage to ${targetUsername}`);
    
    if (!client) {
        console.error(`[TelegramService] ERROR: No client provided`);
        return { success: false, errorType: 'generic' };
    }
    
    if (!client.connected) {
        console.error(`[TelegramService] ERROR: Client is not connected`);
        return { success: false, errorType: 'generic' };
    }
    
    const message = template[Math.floor(Math.random() * template.length)];
    console.log(`[TelegramService] Selected message template: "${message.substring(0, 50)}..."`);
    console.log(`[TelegramService] Target username: "${targetUsername}"`);

    try {
        console.log(`[TelegramService] Sending message to ${targetUsername}...`);
        await client.sendMessage(targetUsername, { message });
        console.log(`[TelegramService] SUCCESS: Message sent to ${targetUsername}`);
        return { success: true };
    } catch (error) {
        console.error(`[TelegramService] FAILED to send message to ${targetUsername}:`);
        console.error(`[TelegramService] Error name: ${error.constructor.name}`);
        console.error(`[TelegramService] Error message: ${error.message}`);
        console.error(`[TelegramService] Error code: ${error.code}`);
        console.error(`[TelegramService] Error details:`, error);
        
        if (error.constructor.name === 'FloodWaitError' || error.errorMessage === 'PEER_FLOOD') {
            console.log(`[TelegramService] Detected flood/rate limit error`);
            return { success: false, errorType: 'limited' };
        }
        if (error.errorMessage && (error.errorMessage.includes('USERNAME_INVALID') || error.errorMessage.includes('USER_ID_INVALID'))) {
            console.log(`[TelegramService] Detected invalid username error`);
            return { success: false, errorType: 'invalid_username' };
        }
        console.log(`[TelegramService] Treating as generic error`);
        return { success: false, errorType: 'generic' };
    }
}

module.exports = { checkSpamStatus, sendMessage, createClient };
