module.exports = {
  "env": {
    "node": true,
    "es2022": true,
    "jest": true,
    "commonjs": true // Add this line to specify CommonJS environment
  },
  "extends": [
    "eslint:recommended",
    "plugin:jest/recommended"
  ],
  "parserOptions": {
    "ecmaVersion": 2022,
    "sourceType": "script" // Change this from "module" to "script" for CommonJS
  },
  "plugins": [
    "jest"
  ],
  "rules": {
    // Error prevention
    "no-unused-vars": ["warn", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }],
    "no-console": "off",
    "no-constant-condition": ["error", { "checkLoops": false }],
    
    // Style consistency
    "indent": ["error", 2, { "SwitchCase": 1 }],
    "linebreak-style": ["error", "unix"],
    //"quotes": ["error", "single", { "avoidEscape": true }],
    "semi": ["error", "always"],
    "comma-dangle": ["error", "only-multiline"],
    
    // CommonJS specific rules
    //"strict": ["error", "global"], // Enforce 'use strict' in global scope
    
    // Best practices
    "arrow-body-style": ["error", "as-needed"],
    "prefer-const": "error",
    "eqeqeq": ["error", "always", { "null": "ignore" }],
    "curly": ["error", "multi-line"],
    
    // Async
    "require-await": "error",
    
    // Jest specific rules
    "jest/no-disabled-tests": "warn",
    "jest/no-focused-tests": "error",
    "jest/no-identical-title": "error",
    "jest/prefer-to-have-length": "warn",
    "jest/valid-expect": "error"
  }
};
