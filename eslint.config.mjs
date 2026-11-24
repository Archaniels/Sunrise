import tseslint from 'typescript-eslint';

const noCommentsRule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow general comments and linter suppression pragmas',
    },
    schema: [],
    messages: {
      noComments: 'Comments and suppression pragmas are forbidden in Sunrise source files.',
    },
  },
  create(context) {
    return {
      Program() {
        const comments = context.sourceCode.getAllComments();
        for (const comment of comments) {
          context.report({
            loc: comment.loc,
            messageId: 'noComments',
          });
        }
      },
    };
  },
};

const sunrisePlugin = {
  rules: {
    'no-comments': noCommentsRule,
  },
};

const NODE_BUILTIN_MODULES = [
  'fs',
  'path',
  'crypto',
  'child_process',
  'os',
  'http',
  'https',
  'url',
  'net',
  'tls',
  'stream',
  'zlib',
  'worker_threads',
];

const SHARED_FORBIDDEN_PATHS = [
  ...NODE_BUILTIN_MODULES,
  'electron',
  'react',
  'react-dom',
  'pg',
  'fastify',
  'drizzle-orm',
  'pgvector',
];

const RENDERER_FORBIDDEN_PATHS = [
  ...NODE_BUILTIN_MODULES,
  'electron',
  'pg',
  'drizzle-orm',
  'pgvector',
  'fastify',
];

const PRELOAD_FORBIDDEN_PATHS = [
  ...NODE_BUILTIN_MODULES,
  'pg',
  'drizzle-orm',
  'pgvector',
  'fastify',
];

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'out/**', 'build/**', 'coverage/**', '**/*.d.ts'],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    plugins: {
      sunrise: sunrisePlugin,
    },
    rules: {
      complexity: ['error', 10],
      'max-depth': ['error', 3],
      'sunrise/no-comments': 'error',
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      sunrise: sunrisePlugin,
    },
    rules: {
      complexity: ['error', 10],
      'max-depth': ['error', 3],
      'sunrise/no-comments': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': true,
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': true,
        },
      ],
    },
  },
  {
    files: ['packages/shared/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: SHARED_FORBIDDEN_PATHS,
          patterns: [
            'node:*',
            'electron/*',
            'react/*',
            'react-dom/*',
            'drizzle-orm/*',
            '@aws-sdk/*',
          ],
        },
      ],
    },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: RENDERER_FORBIDDEN_PATHS,
          patterns: [
            'node:*',
            'electron/*',
            '../main/*',
            '../../main/*',
            '../preload/*',
            '../../preload/*',
            '@aws-sdk/*',
          ],
        },
      ],
    },
  },
  {
    files: ['apps/desktop/src/preload/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: PRELOAD_FORBIDDEN_PATHS,
          patterns: [
            'node:*',
            '../main/*',
            '../../main/*',
            '../renderer/*',
            '../../renderer/*',
            '@aws-sdk/*',
          ],
        },
      ],
    },
  },
  {
    files: ['apps/desktop/src/main/controllers/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['pg', 'drizzle-orm', 'pgvector'],
          patterns: ['../db/*', '../../db/*', '../renderer/*', '../../renderer/*'],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/controllers/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['pg', 'drizzle-orm', 'pgvector'],
          patterns: ['../db/*', '../../db/*', '@aws-sdk/*'],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/services/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['fastify'],
        },
      ],
    },
  },
];
