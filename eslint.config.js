import globals from 'globals';

/**
 * Scope analysis, and deliberately almost nothing else.
 *
 * WHY THIS EXISTS
 * api/booking/assign.js declared the assignment token inside an if-block and
 * used it outside:
 *
 *     if (!recordOnlyOwnerManualCompleted) {
 *       const token = crypto.randomUUID();
 *     }
 *     ...
 *     const acceptUrl = `${SITE}/...?token=${token}`;   // ReferenceError
 *
 * Every manual assignment threw at runtime — AFTER the assignment committed and
 * BEFORE the email sent. The Easer was assigned, no email ever went out, and the
 * owner was shown a 500. It shipped 2026-07-15 and survived 240 commits, because
 * the file PARSES perfectly: `node --check` passes, the inline-script checker
 * passes, all 46 launch tests pass. Nothing here analysed scope.
 *
 * A hand-rolled regex version of this check produced 48 findings, all of them
 * the identifier appearing inside a string, a regex or a comment. That is why
 * this uses a real parser with real scope resolution instead.
 *
 * WHY THE RULE LIST IS THIS SHORT
 * The job is catching code that throws, not enforcing a style. Every rule below
 * flags something that fails at runtime. Style rules would bury those findings
 * in noise on a 600-file repo and the whole check would get switched off — which
 * is exactly how the original bug survived.
 */
export default [
  {
    // Server code: Node ESM.
    files: ['api/**/*.js', 'scripts/**/*.{js,mjs}'],
    ignores: ['scripts/mobile-visual-audit.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      // THE rule. An identifier that is not defined in any reachable scope.
      'no-undef': 'error',
      // Using a let/const before its declaration is reached — same runtime
      // failure, different shape. `variables: false` so a helper defined near the
      // top of a file may reference a const declared lower down: the function
      // body does not run until after the module has finished evaluating, so
      // that is correct code, and flagging it produced a false positive in
      // scripts/build-flagship-service-pages.mjs. Straight-line TDZ errors are
      // still caught.
      'no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
      // Two declarations of one name: the second silently wins and the first
      // becomes dead, which is how "I fixed it but nothing changed" happens.
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-class-members': 'error',
      // An unreachable return/throw hides code that was meant to run.
      'no-unreachable': 'error',
      // `await` outside an async function, and other constant-condition traps.
      'no-constant-condition': ['error', { checkLoops: false }],
      // Assigning to a const throws in strict mode, which ESM always is.
      'no-const-assign': 'error',
      'no-self-assign': 'error',
      // A case that falls through into money logic is a real defect.
      'no-fallthrough': 'error',
    },
  },
  {
    // Browser code, including the module the dashboards load.
    files: ['assets/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        // Cross-file browser globals. app.js publishes APP and the Supabase
        // client on window; auth.js and api.js consume them. They are real,
        // intentional globals — there is no bundler and no import between these
        // files — so they are declared rather than silently allowed.
        APP: 'readonly',
        supabaseClient: 'readonly',
        AAE_STATUS: 'readonly',
        AAE_RATES: 'readonly',
        AAE_BOOKING_SOURCE: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-redeclare': 'error',
      'no-unreachable': 'error',
    },
  },
  {
    // app.js is where APP is DEFINED (`const APP = {...}`). Declaring it as a
    // global for this file too would make its own declaration a redeclaration.
    // Consumers keep the global; the definer does not.
    files: ['assets/js/app.js'],
    languageOptions: { globals: { APP: 'off' } },
  },
  {
    // Authors code that runs INSIDE a headless browser via page.evaluate(), so
    // its callbacks legitimately reference document/window. Both contexts are in
    // one file; giving it both global sets is honest rather than suppressing it.
    files: ['scripts/mobile-visual-audit.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { 'no-undef': 'error', 'no-const-assign': 'error', 'no-redeclare': 'error' },
  },
  {
    ignores: [
      'node_modules/**',
      'api/migrations/**',
      '_prev_/**',
      '_local_artifacts/**',
      'tmp/**',
      // Generated / vendored browser bundles are not ours to lint.
      'assets/js/sentry-init.js',
    ],
  },
];
