const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const fs = require('fs');
const path = require('path');
const defaultAppUrl = 'https://totembound.com';
const defaultLogoUrl = 'https://totembound.com/tb-logo-180.png';
const defaultEmailFrom = 'no-reply@totembound.com';

// SES client (lazy-loaded, only used on Lambda)
let sesClient = null;
function getSesClient() {
  if (!sesClient) {
    sesClient = new SESClient({ region: process.env.AWS_REGION || 'us-east-1' });
  }
  return sesClient;
}

// RFC 2606 / RFC 6761 reserved non-routable domains — never attempt real delivery.
// Prevents SES MessageRejected errors from CI/synthetic accounts (e.g. testplayer1@example.com).
const NON_ROUTABLE_EMAIL_PATTERN = /@(example\.(com|net|org)|[^@]+\.(test|invalid|localhost|local))$/i;
function isNonRoutableEmail(address) {
  return typeof address === 'string' && NON_ROUTABLE_EMAIL_PATTERN.test(address);
}

// Nodemailer transport (lazy-loaded, only used locally)
let localTransport = null;
function getLocalTransport() {
  if (!localTransport) {
    const nodemailer = require('nodemailer');
    localTransport = nodemailer.createTransport({
      host: 'localhost',
      port: 1025,
      ignoreTLS: true,
    });
  }
  return localTransport;
}

/**
 * Load main email template and combine with content template
 * @param {string} contentTemplateName - Name of the content template file
 * @param {object} replacements - Key-value pairs for replacements
 * @returns {string} - Processed HTML template
 */
const loadTemplate = (contentTemplateName, replacements) => {
  try {
    const allReplacements = {
      appUrl: process.env.APP_URL || defaultAppUrl,
      logoUrl: process.env.LOGO_URL || defaultLogoUrl,
      currentYear: new Date().getFullYear().toString(),
      brandName: process.env.BRAND_NAME || 'TotemBound',
      ...replacements
    };

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
    return `
            <h1>${replacements.subject || 'TotemBound Notification'}</h1>
            <p>${replacements.message || 'Thank you for using TotemBound.'}</p>
            <p>Happy gaming!</p>
            `;
  }
};

/**
 * Dual-mode email sender: nodemailer (local) or SES (Lambda)
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} htmlContent - HTML body
 * @param {string} textContent - Plain text body
 * @returns {Promise} - Send result
 */
async function sendEmail(to, subject, htmlContent, textContent) {
  const from = process.env.EMAIL_FROM || defaultEmailFrom;

  if (process.env.IS_LOCAL === 'true') {
    // Local: send via nodemailer → MailHog (SMTP :1025)
    try {
      const transport = getLocalTransport();
      const result = await transport.sendMail({
        from,
        to,
        subject,
        html: htmlContent,
        text: textContent,
      });
      console.log(`[Email-Local] Sent "${subject}" to ${to}, messageId: ${result.messageId}`);
      return result;
    }
    catch (error) {
      console.error('[Email-Local] Error sending "%s" to %s:', subject, to, error);
      throw error;
    }
  }

  // Lambda: send via SES — but short-circuit non-routable test addresses
  // (SES sandbox would reject these anyway; skipping avoids log noise + quota waste)
  if (isNonRoutableEmail(to)) {
    console.log(`[Email-Skip] Non-routable test address, skipping SES send of "${subject}" to ${to}`);
    return { skipped: true, reason: 'non-routable', to };
  }

  const params = {
    Source: from,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject },
      Body: {
        Html: { Data: htmlContent },
        Text: { Data: textContent },
      },
    },
  };

  try {
    const command = new SendEmailCommand(params);
    const result = await getSesClient().send(command);
    console.log(`[Email-SES] Sent "${subject}" to ${to}, messageId: ${result.MessageId}`);
    return result;
  }
  catch (error) {
    console.error('[Email-SES] Error sending "%s" to %s:', subject, to, error);
    throw error;
  }
}

/**
 * Send email verification code
 */
exports.sendVerificationEmail = async (email, displayName, code) => {
  const subject = 'TotemBound - Verify Your Email';

  const htmlContent = loadTemplate('verify-email', {
    subject,
    displayName,
    code,
  });

  const textContent = `Hi ${displayName}, your TotemBound verification code is: ${code}. Enter this code on the verification page to activate your account.`;

  try {
    return await sendEmail(email, subject, htmlContent, textContent);
  }
  catch (error) {
    // Don't throw - signup should succeed even if email fails
    console.error('Error sending verification email to %s:', email, error);
    return null;
  }
};

/**
 * Send password reset code email
 */
exports.sendPasswordResetEmail = async (email, displayName, code) => {
  const subject = 'TotemBound - Reset Your Password';

  const htmlContent = loadTemplate('reset-password', {
    subject,
    displayName,
    code,
  });

  const textContent = `Hi ${displayName}, your TotemBound password reset code is: ${code}. Enter this code on the reset page along with your new password. This code expires in 1 hour. If you didn't request this, ignore this email.`;

  try {
    return await sendEmail(email, subject, htmlContent, textContent);
  }
  catch (error) {
    console.error('Error sending password reset email to %s:', email, error);
    return null;
  }
};

/**
 * Send welcome email to new Web2 user
 */
exports.sendNewUserWelcomeEmail = async (email, displayName, starterTotem) => {
  const subject = `Welcome to TotemBound, ${displayName}!`;

  const appUrl = process.env.APP_URL || defaultAppUrl;

  let finalHtml;
  let finalTextContent;

  if (starterTotem) {
    const speciesNames = {
      0: 'Goose', 1: 'Otter', 2: 'Wolf', 3: 'Falcon', 4: 'Beaver',
      5: 'Deer', 6: 'Woodpecker', 7: 'Turtle', 8: 'Bear', 9: 'Raven',
      10: 'Snake', 11: 'Owl'
    };

    const totemSpecies = speciesNames[starterTotem.speciesId] || 'Spirit Animal';
    const totemLabel = starterTotem.nickname || totemSpecies;

    finalHtml = loadTemplate('welcome-new-user', {
      subject,
      displayName,
      totemName: totemLabel,
      giftHeading: 'Your First Companion',
      giftDescription: `A ${totemSpecies} is waiting for you!`,
      ctaUrl: `${appUrl}/totems`,
      ctaText: 'Meet Your Totem',
    });
    finalTextContent = `Welcome to TotemBound, ${displayName}! Your first companion, a ${totemSpecies} named "${totemLabel}", is waiting for you. You've also received 2,000 Essence to start your adventure. Visit ${appUrl}/totems to meet your new Totem!`;
  }
  else {
    finalHtml = loadTemplate('welcome-new-user', {
      subject,
      displayName,
      totemName: 'Uncommon Totem Box',
      giftHeading: 'Your Starter Gift',
      giftDescription: 'Pick your species and claim your first companion!',
      ctaUrl: `${appUrl}/rewards`,
      ctaText: 'Claim Your Totem',
    });
    finalTextContent = `Welcome to TotemBound, ${displayName}! You've received an Uncommon Totem Box and 2,000 Essence to start your adventure. Visit ${appUrl}/rewards to open your loot and choose your first companion!`;
  }

  try {
    return await sendEmail(email, subject, finalHtml, finalTextContent);
  }
  catch (error) {
    // Don't throw - signup should succeed even if email fails
    return null;
  }
};

// Display name for tier (handles "vip" → "VIP", "premium" → "Premium")
function tierDisplayName(tier) {
  if (tier === 'vip') return 'VIP';
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/**
 * Send subscription canceled notification email
 */
exports.sendSubscriptionCanceledEmail = async (email, expirationDate, tier = 'premium') => {
  const displayTier = tierDisplayName(tier);
  const subject = `Your TotemBound ${displayTier} Subscription Has Been Canceled`;

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

  const textContent = `Your ${displayTier} Subscription has been canceled. Your ${displayTier} subscription will remain active until: ${formattedDate}. After this date, your account will be automatically downgraded to the Free tier. You can reactivate anytime from your account settings.`;

  try {
    return await sendEmail(email, subject, htmlContent, textContent);
  }
  catch (error) {
    console.error(`Error sending cancel email to ${email}:`, error);
    return null;
  }
};

/**
 * Send subscription reactivated notification email
 */
exports.sendSubscriptionReactivatedEmail = async (email, renewalDate, tier = 'premium') => {
  const displayTier = tierDisplayName(tier);
  const subject = `Your TotemBound ${displayTier} Subscription Has Been Reactivated`;

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

  const textContent = `Your ${displayTier} Subscription has been reactivated. Your ${displayTier} subscription will continue to renew on: ${formattedDate}. Welcome back to ${displayTier}! Enjoy monthly Essence & Gems bonuses, exclusive premium totems, daily reward multiplier, and early access to new content.`;

  try {
    return await sendEmail(email, subject, htmlContent, textContent);
  }
  catch (error) {
    console.error(`Error sending reactivation email to ${email}:`, error);
    return null;
  }
};

/**
 * Send gem purchase receipt email
 */
exports.sendGemPurchaseReceiptEmail = async (email, packageName, gemsAdded, newBalance) => {
  const subject = `TotemBound - Gem Purchase Receipt: ${packageName}`;

  const htmlContent = loadTemplate('gem-purchase-receipt', {
    subject,
    packageName,
    gemsAdded: gemsAdded.toString(),
    newBalance: newBalance.toString(),
  });

  const textContent = `Gem Purchase Receipt - You purchased the ${packageName} pack! ${gemsAdded} Gems have been added to your account. Your new Gem balance is ${newBalance}. Visit the shop to spend your Gems!`;

  try {
    return await sendEmail(email, subject, htmlContent, textContent);
  }
  catch (error) {
    console.error(`Error sending gem receipt email to ${email}:`, error);
    return null;
  }
};

/**
 * Send subscription confirmed email (after successful checkout)
 */
exports.sendSubscriptionConfirmedEmail = async (email, tier, nextBillingDate) => {
  const tierName = tierDisplayName(tier);
  const subject = `Welcome to TotemBound ${tierName}!`;

  const BONUS = { premium: { essence: 500, gems: 100 }, vip: { essence: 1500, gems: 500 } };
  const bonus = BONUS[tier] || BONUS.premium;

  const formattedDate = nextBillingDate
    ? new Date(nextBillingDate).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    : 'your next billing date';

  const htmlContent = loadTemplate('subscription-confirmed', {
    subject,
    tierName,
    essenceBonus: bonus.essence.toString(),
    gemsBonus: bonus.gems.toString(),
    nextBillingDate: formattedDate,
  });

  const textContent = `Welcome to TotemBound ${tierName}! Your subscription is now active. Monthly bonus: ${bonus.essence} Essence + ${bonus.gems} Gems. Next billing date: ${formattedDate}. Visit your account settings to manage your subscription.`;

  try {
    return await sendEmail(email, subject, htmlContent, textContent);
  }
  catch (error) {
    console.error(`Error sending subscription confirmed email to ${email}:`, error);
    return null;
  }
};
