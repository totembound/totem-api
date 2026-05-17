#!/usr/bin/env node
/**
 * Add Gems to a User
 *
 * Utility script to add Gems to a user for testing the shop.
 *
 * Usage:
 *   node scripts/add-gems.js <userId> <amount>
 *   node scripts/add-gems.js <email> <amount>
 *
 * Examples:
 *   node scripts/add-gems.js usr_abc123 500
 *   node scripts/add-gems.js test@example.com 1000
 */

require('dotenv').config({ path: '.env.local' });

const { addGems, getUser, getUserByEmail } = require('../src/common/db-client');

async function main() {
  const [,, userIdOrEmail, amountStr] = process.argv;

  if (!userIdOrEmail || !amountStr) {
    console.log('');
    console.log('Usage: node scripts/add-gems.js <userId|email> <amount>');
    console.log('');
    console.log('Examples:');
    console.log('  node scripts/add-gems.js usr_abc123 500');
    console.log('  node scripts/add-gems.js test@example.com 1000');
    console.log('');
    process.exit(1);
  }

  const amount = parseInt(amountStr, 10);
  if (isNaN(amount) || amount <= 0) {
    console.error('Error: Amount must be a positive number');
    process.exit(1);
  }

  console.log('');
  console.log('Adding Gems...');
  console.log('==============');

  try {
    // Determine if input is email or userId
    let userId = userIdOrEmail;
    let user;

    if (userIdOrEmail.includes('@')) {
      // It's an email - look up the user
      console.log(`Looking up user by email: ${userIdOrEmail}`);
      user = await getUserByEmail(userIdOrEmail);
      if (!user) {
        console.error(`Error: No user found with email '${userIdOrEmail}'`);
        process.exit(1);
      }
      userId = user.id;
      console.log(`Found user: ${user.displayName || user.id}`);
    }
    else {
      // It's a userId
      user = await getUser(userId);
      if (!user) {
        console.error(`Error: No user found with ID '${userId}'`);
        process.exit(1);
      }
      console.log(`Found user: ${user.displayName || user.email || userId}`);
    }

    const currentGems = user.currencies?.gems || 0;
    console.log(`Current Gems: ${currentGems}`);

    // Add the gems
    const result = await addGems(userId, amount, {
      type: 'admin_credit',
      ref: 'testing_add_gems'
    });

    if (!result.success) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }

    console.log(`Added: +${amount} Gems`);
    console.log(`New Balance: ${result.newBalance} Gems`);
    console.log('');
    console.log('Success!');
    console.log('');
  }
  catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
