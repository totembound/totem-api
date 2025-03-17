const AWS = require('aws-sdk');
const SES = new AWS.SES({ region: process.env.AWS_REGION || 'us-east-1' });
const fs = require('fs');
const path = require('path');

/**
 * Load email template and replace placeholders
 * @param {string} templateName - Name of the template file
 * @param {object} replacements - Key-value pairs for replacements
 * @returns {string} - Processed HTML template
 */
const loadTemplate = (templateName, replacements) => {
  try {
    // In production, templates are bundled with the Lambda
    const templatePath = path.join(__dirname, 'templates', `${templateName}.html`);
    let template = fs.readFileSync(templatePath, 'utf8');

    // Replace placeholders
    Object.entries(replacements).forEach(([key, value]) => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      template = template.replace(regex, value);
    });

    return template;
  }
  catch (error) {
    console.error(`Error loading template ${templateName}:`, error);

    // Fallback to basic template
    return `
            <h1>Welcome to TotemBound!</h1>
            <p>Thank you for signing up. Here is your API key:</p>
            <p><strong>${replacements.apiKey || '[API KEY]'}</strong></p>
            <p>You can add this key in your user settings to enable gasless transactions.</p>
            <p>Happy gaming!</p>
            `;
  }
};

/**
 * Send welcome email with API key
 * @param {string} email - Recipient email address
 * @param {string} apiKey - Generated API key
 * @returns {Promise} - SES send email response
 */
exports.sendWelcomeEmail = async (email, apiKey) => {
  // Load and process template
  const htmlContent = loadTemplate('welcome', {
    apiKey,
    date: new Date().toLocaleDateString(),
    appUrl: process.env.APP_URL || 'https://app.totembound.com'
  });

  const params = {
    Source: process.env.EMAIL_FROM || 'no-reply@totembound.com',
    Destination: {
      ToAddresses: [email]
    },
    Message: {
      Subject: {
        Data: 'Welcome to TotemBound - Your API Key'
      },
      Body: {
        Html: {
          Data: htmlContent
        },
        Text: {
          Data: `Welcome to TotemBound! Thank you for signing up. Here is your API key: ${apiKey}. You can add this key in your user settings to enable gasless transactions.`
        }
      }
    }
  };

  try {
    const result = await SES.sendEmail(params).promise();
    console.log(`Welcome email sent to ${email}, messageId: ${result.MessageId}`);
    return result;
  }
  catch (error) {
    console.error(`Error sending welcome email to ${email}:`, error);
    throw error;
  }
};

/**
 * Send premium welcome email with API key
 * @param {string} email - Recipient email address
 * @param {string} apiKey - Generated API key
 * @param {boolean} isUpgrade - Whether this is an upgrade from free tier
 * @returns {Promise} - SES send email response
 */
exports.sendPremiumEmail = async (email, apiKey, isUpgrade = false) => {
  const subject = isUpgrade
    ? 'Your TotemBound Account Has Been Upgraded to Premium!'
    : 'Welcome to TotemBound Premium!';

  const templateName = isUpgrade ? 'premium-upgrade' : 'premium-welcome';

  // Load and process template
  const htmlContent = loadTemplate(templateName, {
    apiKey,
    date: new Date().toLocaleDateString(),
    appUrl: process.env.APP_URL || 'https://app.totembound.com'
  });

  const params = {
    Source: process.env.EMAIL_FROM || 'no-reply@totembound.com',
    Destination: {
      ToAddresses: [email]
    },
    Message: {
      Subject: {
        Data: subject
      },
      Body: {
        Html: {
          Data: htmlContent
        },
        Text: {
          Data: `${isUpgrade ? 'Your account has been upgraded to Premium!' : 'Welcome to TotemBound Premium!'} Here is your Premium API key: ${apiKey}. Please update your API key in user settings to enjoy premium benefits.`
        }
      }
    }
  };

  try {
    const result = await SES.sendEmail(params).promise();
    console.log(`Premium email sent to ${email}, messageId: ${result.MessageId}`);
    return result;
  }
  catch (error) {
    console.error(`Error sending premium email to ${email}:`, error);
    throw error;
  }
};

/**
 * Send downgrade notification email
 * @param {string} email - Recipient email address
 * @param {string} apiKey - New API key for free tier
 * @returns {Promise} - SES send email response
 */
exports.sendDowngradeEmail = async (email, apiKey) => {
  // Load and process template
  const htmlContent = loadTemplate('downgrade', {
    apiKey,
    date: new Date().toLocaleDateString(),
    appUrl: process.env.APP_URL || 'https://app.totembound.com'
  });

  const params = {
    Source: process.env.EMAIL_FROM || 'no-reply@totembound.com',
    Destination: {
      ToAddresses: [email]
    },
    Message: {
      Subject: {
        Data: 'Your TotemBound Premium Subscription Has Ended'
      },
      Body: {
        Html: {
          Data: htmlContent
        },
        Text: {
          Data: `Your Premium subscription has ended. Your TotemBound account has been reverted to the Free tier. Here is your new Free tier API key: ${apiKey}. Please update your API key in the user settings to continue using gasless transactions.`
        }
      }
    }
  };

  try {
    const result = await SES.sendEmail(params).promise();
    console.log(`Downgrade email sent to ${email}, messageId: ${result.MessageId}`);
    return result;
  }
  catch (error) {
    console.error(`Error sending downgrade email to ${email}:`, error);
    throw error;
  }
};
