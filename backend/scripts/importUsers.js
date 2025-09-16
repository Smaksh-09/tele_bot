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

    const usersToInsert = [];
    
    console.log('Reading all users from CSV file into memory...');
    
    // 3. Process each row from the CSV and collect users for bulk insert
    for await (const row of parser) {
        const username = row[USERNAME_COLUMN_HEADER];
        if (!username) {
            console.warn(`Skipping row because username is missing or header is incorrect. Expected header: '${USERNAME_COLUMN_HEADER}'`, row);
            continue;
        }

        // Add user to bulk insert array instead of saving individually
        usersToInsert.push({ username: username.trim() });
    }

    console.log(`Finished reading. Found ${usersToInsert.length} users to import.`);

    let successfulImports = 0;
    let duplicateSkips = 0;

    if (usersToInsert.length > 0) {
        try {
            console.log('Starting bulk import into MongoDB. This may take a moment...');
            
            // Use insertMany() for fast bulk operations
            // 'ordered: false' allows MongoDB to insert all valid users and skip duplicates
            // without stopping the entire operation
            const result = await TargetUser.insertMany(usersToInsert, { ordered: false });
            
            successfulImports = result.length;
            duplicateSkips = usersToInsert.length - result.length;
            
            console.log('SUCCESS! Bulk import complete.');
        } catch (error) {
            // Handle bulk insert errors
            if (error.code === 11000) {
                // Duplicate key error - extract successful inserts from error details
                const insertedCount = error.result ? error.result.insertedCount : 0;
                successfulImports = insertedCount;
                duplicateSkips = usersToInsert.length - insertedCount;
                console.log('Import finished, but some users were duplicates and were skipped (which is normal).');
            } else {
                console.error('An error occurred during the bulk import:', error);
                // If we have writeErrors, count successful inserts
                if (error.writeErrors) {
                    successfulImports = usersToInsert.length - error.writeErrors.length;
                    duplicateSkips = error.writeErrors.length;
                }
            }
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
