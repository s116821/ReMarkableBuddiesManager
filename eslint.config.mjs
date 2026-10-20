import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', '.angular/**', 'node_modules/**', 'release/fixtures/node_modules/**', '.upstream/**'] },
  { files: ['src/**/*.ts'], extends: [...tseslint.configs.recommended, ...angular.configs.tsRecommended], processor: angular.processInlineTemplates },
  { files: ['src/**/*.html'], extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility] },
  { files: ['**/*.mjs', '**/*.cjs'], languageOptions: { globals: globals.node }, rules: { 'no-unused-vars': 'error', 'no-undef': 'error' } },
  { files: ['tests/memory-forget-hosts.mjs', 'tests/memory-inspection-hosts.mjs', 'tests/saved-mode-hosts.mjs', 'tests/memory-query-hosts.mjs', 'tests/hosts.mjs', 'tests/wired-hosts.mjs', 'tests/owned-hosts.mjs', 'tests/drive-hosts.mjs', 'tests/personalization-hosts.mjs', 'tests/runtime-identity-hosts.mjs'], languageOptions: { globals: globals.browser } }
);
