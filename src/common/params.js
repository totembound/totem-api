const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const ssmClient = new SSMClient({ region: process.env.AWS_REGION });

// Parameter cache to avoid repeated calls
const paramCache = {};

// Function to get secure parameters from Parameter Store
exports.getParameter = async (paramName) => {
  // Use cache if available
  if (paramCache[paramName]) {
    return paramCache[paramName];
  }
  
  try {
    const command = new GetParameterCommand({
      Name: paramName,
      WithDecryption: true
    });
    
    const response = await ssmClient.send(command);
    
    // Cache the value
    paramCache[paramName] = response.Parameter.Value;
    return response.Parameter.Value;
  }
  catch (error) {
    console.error(`Error retrieving parameter ${paramName}:`, error);
    throw error;
  }
};
