const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const TargetUser = require('../models/TargetUser');

dotenv.config();

// --- Configuration ---
const CSV_FILE_PATH = path.resolve(__dirname, '../users.csv');
const USERNAME_COLUMN_HEADER = 'username'; // Case-sensitive header for the username column in your CSV

async function importUsers() {
    console.log('--- Starting User Import Script ---');

    // 1. Connect to MongoDB
    if (!process.env.MONGODB_URI) {
        console.error('Error: MONGODB_URI is not set in your .env file.');
        process.exit(1);
    }
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Successfully connected to MongoDB.');
    } catch (error) {
        console.error('Failed to connect to MongoDB:', error);
        process.exit(1);
    }

    // 2. Read and Parse the CSV file
    if (!fs.existsSync(CSV_FILE_PATH)) {
        console.error(`Error: The file users.csv was not found in the project root.`);
        console.error(`Please create a 'users.csv' file and place it next to your index.js.`);
        await mongoose.disconnect();
        process.exit(1);
    }

    const parser = fs.createReadStream(CSV_FILE_PATH).pipe(parse({
        columns: true, // Treat the first row as headers
        skip_empty_lines: true
    }));

    let successfulImports = 0;
    let duplicateSkips = 0;
    
    console.log('Reading CSV and importing users...');
    
    // 3. Process each row from the CSV
    for await (const row of parser) {
        const username = row[USERNAME_COLUMN_HEADER];
        if (!username) {
            console.warn(`Skipping row because username is missing or header is incorrect. Expected header: '${USERNAME_COLUMN_HEADER}'`, row);
            continue;
        }

        try {
            // Check if user already exists
            const existingUser = await TargetUser.findOne({ username: username.trim() });
            if (existingUser) {
                duplicateSkips++;
            } else {
                // Create and save the new user
                const user = new TargetUser({ username: username.trim() });
                await user.save();
                successfulImports++;
            }
        } catch (error) {
            console.error(`Failed to import user '${username}':`, error);
        }
    }

    console.log('\n--- Import Complete ---');
    console.log(`Successfully imported: ${successfulImports} new users.`);
    console.log(`Skipped (duplicates): ${duplicateSkips} users.`);

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
}

// Install dependency 'csv-parse' by running: npm install csv-parse
importUsers();
