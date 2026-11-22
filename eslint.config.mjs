import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/dist/**',
    '**/coverage/**',
    '**/.turbo/**',
    '**/.next/**',
    '**/next-env.d.ts',
  ]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // NestJS modules are empty classes on purpose: the @Module() decorator carries the config.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  },
  // Plain JavaScript config files (for example postcss.config.mjs) are in no tsconfig project.
  { files: ['**/*.mjs'], extends: [tseslint.configs.disableTypeChecked] },
  prettier,
);
