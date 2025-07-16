/**
 * Extract client IP address from API Gateway event
 * @param {object} event - API Gateway event object
 * @returns {string|null} - Client IP address or null if not found
 */
function getClientIP(event) {
  // Try different IP sources in order of preference
  
  // API Gateway v2.0 format
  if (event.requestContext?.http?.sourceIp) {
    return event.requestContext.http.sourceIp;
  }
  
  // API Gateway v1.0 format
  if (event.requestContext?.identity?.sourceIp) {
    return event.requestContext.identity.sourceIp;
  }
  
  // Headers fallback
  if (event.headers?.['x-forwarded-for']) {
    return event.headers['x-forwarded-for'].split(',')[0].trim();
  }
  
  if (event.headers?.['x-real-ip']) {
    return event.headers['x-real-ip'];
  }
  
  // CloudFront headers
  if (event.headers?.['cloudfront-viewer-address']) {
    return event.headers['cloudfront-viewer-address'].split(':')[0];
  }
  
  // Debug logging to help identify the issue
  console.warn('Unable to extract client IP. Event structure:', {
    requestContext: event.requestContext ? {
      http: event.requestContext.http,
      identity: event.requestContext.identity
    } : 'missing',
    headers: Object.keys(event.headers || {})
  });
  
  return null;
}

module.exports = { getClientIP };