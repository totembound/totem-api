const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const fs = require('fs');
const path = require('path');
const defaultAppUrl = 'https://totembound.com';
const defaultLogoUrl = 'https://totembound.com/tb-logo-180.png';
const defaultEmailFrom = 'no-reply@totembound.com';

// Initialize SES client
const sesClient = new SESClient({ 
  region: process.env.AWS_REGION || 'us-east-1' 
});

/**
 * Load main email template and combine with content template
 * @param {string} contentTemplateName - Name of the content template file
 * @param {object} replacements - Key-value pairs for replacements
 * @returns {string} - Processed HTML template
 */
const loadTemplate = (contentTemplateName, replacements) => {
  try {
    // Add some default replacements
    const allReplacements = {
      appUrl: process.env.APP_URL || defaultAppUrl,
      logoUrl: process.env.LOGO_URL || defaultLogoUrl,
      currentYear: new Date().getFullYear().toString(),
      brandName: process.env.BRAND_NAME || 'TotemBound',
      ...replacements
    };
    
    // In production, templates are bundled with the Lambda
    const mainTemplatePath = path.join(__dirname, 'templates', 'main.html');
    const contentTemplatePath = path.join(__dirname, 'templates', `${contentTemplateName}.html`);
    
    let mainTemplate = fs.readFileSync(mainTemplatePath, 'utf8');
    let contentTemplate = fs.readFileSync(contentTemplatePath, 'utf8');
    
    // Replace placeholders in content template
    Object.entries(allReplacements).forEach(([key, value]) => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      contentTemplate = contentTemplate.replace(regex, value);
    });
    
    // Add content to main template
    allReplacements.content = contentTemplate;
    
    // Replace placeholders in main template
    Object.entries(allReplacements).forEach(([key, value]) => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      mainTemplate = mainTemplate.replace(regex, value);
    });

    return mainTemplate;
  }
  catch (error) {
    console.error(`Error loading template ${contentTemplateName}:`, error);

    // Fallback to basic template
    return `
            <h1>${replacements.subject || 'TotemBound Notification'}</h1>
            <p>${replacements.message || 'Thank you for using TotemBound.'}</p>
            <p>${replacements.apiKey ? `Your API key: <strong>${replacements.apiKey}</strong>` : ''}</p>
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
  const subject = 'Welcome to TotemBound - Your API Key';

  // Load and process template
  const htmlContent = loadTemplate('welcome', {
    subject,
    apiKey,
    date: new Date().toLocaleDateString(),
  });

  const params = {
    Source: process.env.EMAIL_FROM || defaultEmailFrom,
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
          Data: `Welcome to TotemBound! Thank you for signing up. Here is your API key: ${apiKey}. You can add this key in your user settings to enable gasless transactions.`
        }
      }
    }
  };

  try {
    const command = new SendEmailCommand(params);
    const result = await sesClient.send(command);
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

  const upgradeText = isUpgrade
    ? 'Your account has been successfully upgraded to Premium tier.'
    : 'Welcome to TotemBound Premium!';
  
  const welcomeMessage = isUpgrade
    ? 'Your account has been successfully upgraded to Premium tier. Thank you for your subscription!'
    : 'Thank you for subscribing to our premium service. We\'re excited to have you join our Premium members!';

  const htmlContent = loadTemplate('premium', {
    subject,
    apiKey,
    upgradeText,
    welcomeMessage
  });

  const params = {
    Source: process.env.EMAIL_FROM || defaultEmailFrom,
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
    const command = new SendEmailCommand(params);
    const result = await sesClient.send(command);
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
  const subject = 'Your TotemBound Premium Subscription Has Ended';

  const htmlContent = loadTemplate('downgrade', {
    subject,
    apiKey
  });

  const params = {
    Source: process.env.EMAIL_FROM || defaultEmailFrom,
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
          Data: `Your Premium subscription has ended. Your TotemBound account has been reverted to the Free tier. Here is your new Free tier API key: ${apiKey}. Please update your API key in the user settings to continue using gasless transactions.`
        }
      }
    }
  };

  try {
    const command = new SendEmailCommand(params);
    const result = await sesClient.send(command);;
    console.log(`Downgrade email sent to ${email}, messageId: ${result.MessageId}`);
    return result;
  }
  catch (error) {
    console.error(`Error sending downgrade email to ${email}:`, error);
    throw error;
  }
};

/**
 * Send subscription canceled notification email
 * @param {string} email - Recipient email address
 * @param {string} expirationDate - End Date of subscription 
 * @returns {Promise} - SES send email response
 */
exports.sendSubscriptionCanceledEmail = async (email, expirationDate) => {
  const subject = 'Your TotemBound Premium Subscription Has Been Canceled';

  // Format the date nicely
  const formattedDate = expirationDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const htmlContent = loadTemplate('subscription-canceled', {
    subject,
    formattedDate
  });

  const params = {
    Source: process.env.EMAIL_FROM || defaultEmailFrom,
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
          Data: `Your Premium Subscription has been canceled. Your Premium subscription will remain active until: ${formattedDate}. After this date, your account will be automatically downgraded to the Free tier.`
        }
      }
    }
  };

  try {
    const command = new SendEmailCommand(params);
    const result = await sesClient.send(command);;
    console.log(`Canceled email sent to ${email}, messageId: ${result.MessageId}`);
    return result;
  }
  catch (error) {
    console.error(`Error sending cancel email to ${email}:`, error);
    throw error;
  }
};

/**
 * Send subscription reactivated notification email
 * @param {string} email - Recipient email address
 * @param {string} renewalDate - Renewal Date of subscription 
 * @returns {Promise} - SES send email response
 */
exports.sendSubscriptionReactivatedEmail = async (email, renewalDate) => {
  const subject = 'Your TotemBound Premium Subscription Has Been Reactivated';

  // Format the date nicely
  const formattedDate = renewalDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const htmlContent = loadTemplate('subscription-reactivated', {
    subject,
    formattedDate
  });

  const params = {
    Source: process.env.EMAIL_FROM || defaultEmailFrom,
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
          Data: `Your Premium Subscription has been reactivated. Your Premium subscription will continue to renew on: ${formattedDate}. Welcome back to Premium! We're thrilled to have you continue as a valued member of the TotemBound community.`
        }
      }
    }
  };

  try {
    const command = new SendEmailCommand(params);
    const result = await sesClient.send(command);;
    console.log(`Renewed email sent to ${email}, messageId: ${result.MessageId}`);
    return result;
  }
  catch (error) {
    console.error(`Error sending renew email to ${email}:`, error);
    throw error;
  }
};
