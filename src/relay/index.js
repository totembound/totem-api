const { ethers } = require('ethers');
const FORWARDER_ABI = require('../contracts/TotemTrustedForwarder.abi.json');
const { getParameter } = require('../common/params');
const { verifyApiKey } = require('../common/api-key');
const { 
  incrementUsageAndTransactions, 
  checkDailyLimit, 
  logDetailedTransaction
} = require('../common/db');

// Initialize provider and wallet outside the handler for connection reuse
let provider;
let wallet;
let forwarderContract;

// Load configuration (from environment variables)
const contractAddresses = {
  forwarder: process.env.FORWARDER_ADDRESS,
  game: process.env.GAME_ADDRESS,
  nft: process.env.NFT_ADDRESS,
  token: process.env.TOKEN_ADDRESS,
  rewards: process.env.REWARDS_ADDRESS,
  shop: process.env.SHOP_ADDRESS,
  expeditions: process.env.EXPEDITIONS_ADDRESS,
};

// Initialize provider function (called once on cold start)
async function initializeProvider() {
  try {
    const rpcURl = process.env.RPC_URL || (await getParameter(process.env.FORWARDER_RPC_URL_PARAM));
    console.log('Initializing provider with RPC URL:', rpcURl);

    // Get the private key from Parameter Store
    const privateKeyPath = process.env.FORWARDER_PRIVATE_KEY_PARAM;
    const privateKey = process.env.FORWARDER_PRIVATE_KEY || (await getParameter(privateKeyPath));

    provider = new ethers.JsonRpcProvider(rpcURl);
    wallet = new ethers.Wallet(privateKey, provider);
    forwarderContract = new ethers.Contract(contractAddresses.forwarder, FORWARDER_ABI, wallet);

    const balance = await wallet.provider.getBalance(wallet.address);
    console.log(`Relayer wallet balance: ${ethers.formatEther(balance)} POL`);

    if (ethers.formatEther(balance) < 0.1) {
      console.warn('WARNING: Relayer wallet balance is low. Please fund the wallet.');
    }

    return { provider, wallet, forwarderContract };
  } catch (error) {
    console.error('Failed to initialize provider:', error);
    throw error;
  }
}

/**
 * Create response with optional pre-computed usage status
 * @param {number} statusCode - HTTP status code
 * @param {object} body - Response body object
 * @param {object|null} user - User object (optional)
 * @param {object|null} usageStatus - Pre-computed usage status (optional)
 * @returns {Promise<object>} - Lambda response object
 */
async function createResponse(statusCode, body, user = null, usageStatus = null) {
  const headers = {
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key',
    'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
    'Content-Type': 'application/json'
  };

  // Add usage headers if we have a user
  if (user) {
    try {
      // Use pre-computed usage status if provided, otherwise compute it
      const usage = usageStatus || await checkDailyLimit(user.userId, user.tier);
      headers['X-Daily-Requests-Remaining'] = usage.remaining.toString();
      headers['X-Daily-Requests-Limit'] = usage.dailyLimit.toString();
      headers['X-Daily-Requests-Used'] = usage.currentUsage.toString();
      headers['X-User-Tier'] = user.tier;
      
      // Add rate limit headers for better client handling
      if (usage.exceeded) {
        headers['Retry-After'] = '86400'; // 24 hours in seconds
        headers['X-RateLimit-Reset'] = 'midnight UTC';
      }
    }
    catch (error) {
      console.error('Failed to get usage headers:', error);
      // Continue without usage headers if there's an error
    }
  }

  return {
    statusCode,
    headers,
    body: JSON.stringify(body)
  };
}

// Main Lambda handler
exports.handler = async (event, context) => {
  // Handle preflight OPTIONS request, gateway should mock
  if (event.httpMethod === 'OPTIONS') {
    const headers = {
      'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key',
      'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'public, max-age=86400',
      'Expires': new Date(Date.now() + 86400000).toUTCString()
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ message: 'CORS preflight response' })
    };
  }

  // Extract and verify API key
  const apiKey = event.headers['X-Api-Key'] || event.headers['x-api-key'];
  let user = null;
  let usageStatus = null;

  if (apiKey) {
    user = await verifyApiKey(apiKey);
    if (!user) {
      return await createResponse(401, { error: 'Invalid API key' });
    }

    // Check daily limit BEFORE processing request
    usageStatus = await checkDailyLimit(user.userId, user.tier);
    if (usageStatus.exceeded) {
      return await createResponse(429, { 
        error: 'Daily request limit exceeded',
        dailyLimit: usageStatus.dailyLimit,
        currentUsage: usageStatus.currentUsage,
        resetTime: 'midnight UTC'
      }, user, usageStatus);
    }
  }

  if (event.httpMethod === 'GET' && (event.resource === '/relay/quotas' || event.path === '/relay/quotas')) {
    if (!user) {
      return await createResponse(401, { error: 'API key required for quota information' });
    }

    // Return detailed quota information
    const quotaInfo = {
      userId: user.userId,
      email: user.email,
      tier: user.tier,
      quota: {
        dailyLimit: usageStatus.dailyLimit,
        currentUsage: usageStatus.currentUsage,
        remaining: usageStatus.remaining,
        exceeded: usageStatus.exceeded,
        resetTime: 'midnight UTC'
      },
      timestamp: new Date().toISOString()
    };

    return await createResponse(200, quotaInfo, user, usageStatus);
  }

  // Initialize provider if not already done
  if (!provider || !wallet || !forwarderContract) {
    try {
      const initialized = await initializeProvider();
      provider = initialized.provider;
      wallet = initialized.wallet;
      forwarderContract = initialized.forwarderContract;
    } catch (error) {
      return await createResponse(500, {
        error: 'Initialization failed',
        message: error.message
      }, user);
    }
  }

  // Parse request body
  let body;
  try {
    body = JSON.parse(event.body);
  } catch (error) {
    return await createResponse(400, {
      error: 'Invalid request body',
      message: 'Request body must be valid JSON'
    }, user);
  }

  try {
    const { contractType, functionName, request, signature } = body;

    // Validate request
    if (!request || !signature) {
      return await createResponse(400, { error: 'Missing request or signature' }, user, usageStatus);
    }

    // Validate target contract
    const targetAddress = contractAddresses[contractType];
    if (!targetAddress) {
      return await createResponse(400, { error: 'Invalid contract type' }, user, usageStatus);
    }

    if (request.to.toLowerCase() !== targetAddress.toLowerCase()) {
      return await createResponse(400, { 
        error: 'Request destination does not match specified contract' 
      }, user, usageStatus);
    }

    // Check gas price
    const feeData = await provider.getFeeData();
    const maxGasPrice = ethers.parseUnits(process.env.MAX_GAS_PRICE || '50', 'gwei');

    if (feeData.gasPrice > maxGasPrice) {
      return await createResponse(503, {
          error: 'Gas price too high',
          currentGasPrice: ethers.formatUnits(feeData.gasPrice, 'gwei'),
          maxGasPrice: ethers.formatUnits(maxGasPrice, 'gwei')
        }, user, usageStatus);
    }

    // Check wallet balance
    const balance = await wallet.provider.getBalance(wallet.address);
    const minBalance = ethers.parseEther(process.env.MIN_WALLET_BALANCE || '0.1');

    if (balance < minBalance) {
      return await createResponse(503, {
          error: 'Insufficient forwarder balance',
          currentBalance: ethers.formatEther(balance),
          minBalance: ethers.formatUnits(minBalance, 'ether')
        }, user, usageStatus);
    }

    // Log request information
    console.log(`Relaying ${contractType}.${functionName} for ${request.from}${user ? ` (User: ${user.email})` : ''}`);

    // Parse bigint values from strings
    const parsedRequest = {
      ...request,
      value: BigInt(request.value),
      gas: BigInt(request.gas),
      nonce: BigInt(request.nonce)
    };

    // Verify signature
    const isValid = await forwarderContract.verify(parsedRequest, signature);
    if (!isValid) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid signature' })
      };
    }

    // INCREMENT USAGE COUNTER BEFORE TRANSACTION
    // This ensures we count even failed transactions (prevents abuse)
    let usageInfo = null;
    if (user) {
      try {
        usageInfo = await incrementUsageAndTransactions(user.userId, {
          contractType,
          functionName,
          walletAddress: request.from
        });
        console.log(`Usage updated: ${usageInfo.dailyRequestCount} daily, ${usageInfo.totalTransactionCount} total`);
      } catch (error) {
        console.error('Failed to increment usage counter:', error);
        // Continue anyway - don't fail the transaction for counter issues
      }
    }

    // Submit transaction
    const tx = await forwarderContract.relay(parsedRequest, signature, {
      gasLimit: BigInt(parsedRequest.gas),
      gasPrice: feeData.gasPrice
    });

    console.log(`Transaction sent: ${tx.hash}`);

    // Wait for one confirmation to ensure transaction is in the mempool
    // Note: In production, you might want to handle this asynchronously
    const receipt = await tx.wait(1);
    console.log(`Transaction confirmed: ${receipt.hash} (${contractType}.${functionName})`);

    // Log detailed transaction (audit trail)
    if (user && process.env.LOG_DETAILED_TRANSACTIONS === 'true') {
      try {
        await logDetailedTransaction({
          userId: user.userId,
          userEmail: user.email,
          tier: user.tier,
          txHash: tx.hash,
          contractType,
          functionName,
          gasUsed: receipt.gasUsed?.toString(),
          walletAddress: request.from
        });
      } catch (error) {
        console.error('Failed to log detailed transaction:', error);
        // Don't fail the response for logging issues
      }
    }

    const newBalance = await wallet.provider.getBalance(wallet.address);
    console.log(`Relayer wallet balance: ${ethers.formatEther(newBalance)} POL`);

    // Return transaction hash
    return await createResponse(200, {
      success: true,
      txHash: tx.hash,
      gasUsed: receipt.gasUsed?.toString()
    }, user, usageStatus);
  } catch (error) {
    console.error('Relay error:', error);
    return await createResponse(500, {
      success: false,
      error: 'Internal relay error: ' + error.message
    }, user, usageStatus);
  }
};
