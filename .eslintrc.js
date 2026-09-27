module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    browser: true,
    es2021: true,
  },
  ignorePatterns: ['dist', 'node_modules', '*.js', 'out', 'reference_projects'],
  rules: {
    // Strict typescript rules to enforce code quality
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'error',
    'no-empty': 'error',
  },
};
