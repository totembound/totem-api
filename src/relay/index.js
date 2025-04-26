const { ethers } = require('ethers');
const FORWARDER_ABI = require('../contracts/TotemTrustedForwarder.abi.json');
const { getParameter } = require('../common/params');

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
    const rpcURl = process.env.RPC_URL || await getParameter(process.env.FORWARDER_RPC_URL_PARAM);
    console.log('Initializing provider with RPC URL:', rpcURl);

    // Get the private key from Parameter Store
    const privateKeyPath = process.env.FORWARDER_PRIVATE_KEY_PARAM;
    const privateKey =  process.env.FORWARDER_PRIVATE_KEY || await getParameter(privateKeyPath);

    provider = new ethers.JsonRpcProvider(rpcURl);
    wallet = new ethers.Wallet(privateKey, provider);
    forwarderContract = new ethers.Contract(contractAddresses.forwarder, FORWARDER_ABI, wallet);

    const balance = await wallet.provider.getBalance(wallet.address);
    console.log(`Relayer wallet balance: ${ethers.formatEther(balance)} POL`);

    if (ethers.formatEther(balance) < 0.1) {
      console.warn('WARNING: Relayer wallet balance is low. Please fund the wallet.');
    }

    return { provider, wallet, forwarderContract };
  }
  catch (error) {
    console.error('Failed to initialize provider:', error);
    throw error;
  }
}

// Main Lambda handler
exports.handler = async (event, context) => {
  // Set up CORS headers
  const headers = {
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key',
    'Access-Control-Allow-Methods': 'POST,GET,OPTIONS'
  };

  // Handle preflight OPTIONS request
  if (event.httpMethod === 'OPTIONS') {
    headers['Access-Control-Max-Age'] = '86400';
    headers['Cache-Control'] = 'public, max-age=86400';
    headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ message: 'CORS preflight response' })
    };
  }

  // Health check
  if (event.resource === '/health' && event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ status: 'healthy' })
    };
  }

  // Initialize provider if not already done
  if (!provider || !wallet || !forwarderContract) {
    try {
      const initialized = await initializeProvider();
      provider = initialized.provider;
      wallet = initialized.wallet;
      forwarderContract = initialized.forwarderContract;
    }
    catch (error) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'Initialization failed',
          message: error.message
        })
      };
    }
  }

  // Parse request body
  let body;
  try {
    body = JSON.parse(event.body);
  }
  catch (error) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: 'Invalid request body',
        message: 'Request body must be valid JSON'
      })
    };
  }

  try {
    const { contractType, functionName, request, signature } = body;

    // Validate request
    if (!request || !signature) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing request or signature' })
      };
    }

    // Validate target contract
    const targetAddress = contractAddresses[contractType];
    if (!targetAddress) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid contract type' })
      };
    }

    if (request.to.toLowerCase() !== targetAddress.toLowerCase()) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Request destination does not match specified contract' })
      };
    }

    // Check gas price
    const feeData = await provider.getFeeData();
    const maxGasPrice = ethers.parseUnits(process.env.MAX_GAS_PRICE || '50', 'gwei');

    if (feeData.gasPrice > maxGasPrice) {
      return {
        statusCode: 503,
        headers,
        body: JSON.stringify({
          error: 'Gas price too high',
          currentGasPrice: ethers.formatUnits(feeData.gasPrice, 'gwei'),
          maxGasPrice: ethers.formatUnits(maxGasPrice, 'gwei')
        })
      };
    }

    // Check wallet balance
    const balance = await wallet.provider.getBalance(wallet.address);
    const minBalance = ethers.parseEther(process.env.MIN_WALLET_BALANCE || '0.1');

    if (balance < minBalance) {
      return {
        statusCode: 503,
        headers,
        body: JSON.stringify({
          error: 'Insufficient forwarder balance',
          currentBalance: ethers.formatEther(balance),
          minBalance: ethers.formatUnits(minBalance, 'ether')
        })
      };
    }

    // Log request information
    console.log(`Relaying ${contractType}.${functionName} for ${request.from}`);

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

    const newBalance = await wallet.provider.getBalance(wallet.address);
    console.log(`Relayer wallet balance: ${ethers.formatEther(newBalance)} POL`);

    // Return transaction hash
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        txHash: tx.hash
      })
    };
  }
  catch (error) {
    console.error('Relay error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'Internal relay error: ' + error.message
      })
    };
  }
};
