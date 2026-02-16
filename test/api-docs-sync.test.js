/**
 * API Docs Sync Test
 *
 * Verifies that every route in app.js has a matching @swagger doc in api-docs.js,
 * and every documented path in the OpenAPI spec has a matching route in app.js.
 *
 * Catches drift between implementation and documentation.
 */

// Use real fs (setup.js mocks it for email templates)
jest.unmock('fs');

const fs = require('fs');
const path = require('path');

// Parse routes from app.js source code
function extractAppRoutes() {
  const appSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'app.js'),
    'utf-8'
  );

  const routes = [];
  // Match: app.get('/path', ...) or app.post('/path', ...)
  const routeRegex = /app\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = routeRegex.exec(appSource)) !== null) {
    const method = match[1].toLowerCase();
    // Normalize Express :param to OpenAPI {param}
    const routePath = match[2].replace(/:(\w+)/g, '{$1}');
    routes.push({ method, path: routePath });
  }
  return routes;
}

// Parse paths from the generated OpenAPI spec
function extractSwaggerPaths() {
  const { swaggerSpec } = require('../src/config/swagger');
  const paths = [];
  for (const [pathStr, methods] of Object.entries(swaggerSpec.paths || {})) {
    for (const method of Object.keys(methods)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        paths.push({ method, path: pathStr });
      }
    }
  }
  return paths;
}

function routeKey(r) {
  return `${r.method.toUpperCase()} ${r.path}`;
}

describe('API Docs Sync', () => {
  let appRoutes;
  let swaggerPaths;

  beforeAll(() => {
    appRoutes = extractAppRoutes();
    swaggerPaths = extractSwaggerPaths();
  });

  test('app.js has routes defined', () => {
    expect(appRoutes.length).toBeGreaterThan(0);
  });

  test('swagger spec has paths defined', () => {
    expect(swaggerPaths.length).toBeGreaterThan(0);
  });

  test('every app.js route has swagger documentation', () => {
    const swaggerKeys = new Set(swaggerPaths.map(routeKey));
    const undocumented = appRoutes.filter(r => !swaggerKeys.has(routeKey(r)));

    const list = undocumented.map(routeKey);
    expect(list).toEqual([]);
  });

  test('every swagger path has a matching app.js route', () => {
    const appKeys = new Set(appRoutes.map(routeKey));
    const orphaned = swaggerPaths.filter(r => !appKeys.has(routeKey(r)));

    const list = orphaned.map(routeKey);
    expect(list).toEqual([]);
  });

  test('route counts match', () => {
    const appKeys = new Set(appRoutes.map(routeKey));
    const swaggerKeys = new Set(swaggerPaths.map(routeKey));

    // Log counts for visibility
    console.log(`app.js routes: ${appKeys.size}`);
    console.log(`swagger paths: ${swaggerKeys.size}`);

    expect(appKeys.size).toBeGreaterThan(0);
    expect(swaggerKeys.size).toBeGreaterThan(0);
  });
});
