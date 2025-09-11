const cron = require('node-cron');
const Account = require('../models/TelegramAccount');
const AppState = require('../models/AppState');
const telegramService = require('./telegramService');

const TOTAL_ACCOUNTS = 20;
const MESSAGES_PER_HOUR = 50;
const TARGET_USER_LIST = [...] // Array of 50+ usernames to message

// Schedule to run at the beginning of every hour.
cron.schedule('0 * * * *', async () => {
    console.log(`[Scheduler] Waking up for the top of the hour job.`);

    // 1. Get the current state to know which account to use
    let state = await AppState.findOne({ singletonKey: 'main' });
    if (!state) state = await new AppState().save(); // Create if it doesn't exist

    const accountIndexToUse = state.nextAccountIndex;
    const account = await Account.findOne({ accountIndex: accountIndexToUse });

    if (!account) {
        console.error(`[Scheduler] Critical Error: Account with index ${accountIndexToUse} not found.`);
        return;
    }
    console.log(`[Scheduler] Selected Account #${accountIndexToUse} (${account.phone})`);

    // 2. Proactively check status with @SpamInfoBot
    const statusResult = await telegramService.checkSpamStatus(account);
    account.status = statusResult.status;
    account.statusMessage = statusResult.message;
    account.lastStatusCheck = new Date();

    if (account.status === 'limited') {
        console.log(`[Scheduler] Account ${account.phone} is limited. Skipping sending for this hour. Message: ${account.statusMessage}`);
    } else {
        console.log(`[Scheduler] Account ${account.phone} is healthy. Starting to send ${MESSAGES_PER_HOUR} messages.`);
        // 3. Send 50 messages with delays
        const delay = 3600 / MESSAGES_PER_HOUR * 1000; // ~72 seconds between messages
        for (let i = 0; i < MESSAGES_PER_HOUR; i++) {
            const targetUser = TARGET_USER_LIST[i % TARGET_USER_LIST.length];
            const result = await telegramService.sendMessage(account, targetUser);

            if (!result.success && result.errorType === 'limited') {
                console.log(`[Scheduler] Hit PeerFloodError with ${account.phone}. Stopping sends for this hour.`);
                account.status = 'limited';
                break; // Exit the loop
            }

            // Wait before sending the next message
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    await account.save();

    // 4. Update the state for the next hour's run
    state.nextAccountIndex = (accountIndexToUse + 1) % TOTAL_ACCOUNTS;
    await state.save();
    console.log(`[Scheduler] Job finished. Next account to be used is #${state.nextAccountIndex}.`);
});
