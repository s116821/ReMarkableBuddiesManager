import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', '.angular/**', 'node_modules/**', 'release/node_modules/**'] },
  { files: ['src/**/*.ts'], extends: [...tseslint.configs.recommended, ...angular.configs.tsRecommended], processor: angular.processInlineTemplates },
  { files: ['src/**/*.html'], extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility] },
  { files: ['**/*.mjs', '**/*.cjs'], languageOptions: { globals: globals.node }, rules: { 'no-unused-vars': 'error', 'no-undef': 'error' } },
  { files: ['tests/hosts.mjs', 'tests/wired-hosts.mjs'], languageOptions: { globals: globals.browser } }
);
