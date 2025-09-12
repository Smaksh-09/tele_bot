const cron = require('node-cron');
const Account = require('../models/Account');
const AppState = require('../models/AppState');
const TargetUser = require('../models/TargetUser');
const telegramService = require('./telegramService');

const MESSAGES_PER_HOUR = 50;

// This schedule runs at minute 0 of every hour.
cron.schedule('0 * * * *', async () => {
    console.log(`[Scheduler] Waking up for the top of the hour job.`);

    // Step 1: Find out which account we need to use.
    let state = await AppState.findOne({ singletonKey: 'main' });
    if (!state) {
        // If this is the very first run, create the state document.
        console.log('[Scheduler] First run detected. Initializing AppState.');
        state = await new AppState().save();
    }

    const totalAccounts = await Account.countDocuments();
    if (totalAccounts === 0) {
        console.log('[Scheduler] No accounts found in the database. Sleeping until next hour.');
        return;
    }

    const accountIndexToUse = state.nextAccountIndex;
    const account = await Account.findOne({ accountIndex: accountIndexToUse });

    if (!account) {
        console.error(`[Scheduler] CRITICAL ERROR: Account with index ${accountIndexToUse} not found in database.`);
        // As a fallback, reset the index to 0 to prevent getting stuck.
        state.nextAccountIndex = 0;
        await state.save();
        return;
    }

    console.log(`[Scheduler] Selected Account #${accountIndexToUse} (${account.phone}) for this hour.`);

    // Step 2: Check the account's status using the resilient retry logic.
    const statusResult = await telegramService.checkSpamStatus(account);
    account.status = statusResult.status;
    account.statusMessage = statusResult.message;
    account.lastStatusCheck = new Date();

    // Step 3: If the account is healthy, proceed to send messages.
    if (account.status === 'limited') {
        console.log(`[Scheduler] Account ${account.phone} is limited after checks. Skipping message sending for this hour. Final status: ${account.statusMessage}`);
    } else {
        // Fetch a list of 50 users to message.
        // Note: For a real-world scenario, you'd want to track who has been messaged already.
        // This simple `find().limit()` is for demonstration.
        const targets = await TargetUser.find().limit(MESSAGES_PER_HOUR);

        if (targets.length === 0) {
            console.log('[Scheduler] No target users found in the database. Nothing to send.');
        } else {
            console.log(`[Scheduler] Account ${account.phone} is healthy. Starting to send ${targets.length} messages.`);
            const delayBetweenMessages = 3600 / MESSAGES_PER_HOUR * 1000; // Evenly space messages over one hour.

            for (const target of targets) {
                const result = await telegramService.sendMessage(account, target.username);

                // If a message fails with a PeerFloodError, stop immediately for this account.
                if (!result.success && result.errorType === 'limited') {
                    console.warn(`[Scheduler] Hit PeerFloodError while messaging with ${account.phone}. Stopping sends for this hour.`);
                    account.status = 'limited';
                    account.statusMessage = 'Stopped due to PEER_FLOOD error.';
                    break; // Exit the for loop
                }

                await new Promise(resolve => setTimeout(resolve, delayBetweenMessages));
            }
        }
    }

    // Step 4: Save the account's final status and schedule the next account.
    await account.save();

    state.nextAccountIndex = (accountIndexToUse + 1) % totalAccounts; // The magic line for rotation
    await state.save();

    console.log(`[Scheduler] Job finished for account #${accountIndexToUse}. Next account index is now #${state.nextAccountIndex}.`);
});
