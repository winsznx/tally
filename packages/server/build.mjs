import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Runtime dependencies stay external and are installed next to dist/. The
// workspace @tally/core is a devDependency consumed as TypeScript source, so it
// is bundled in.
await build({
  entryPoints: {
    index: 'src/bin/server.ts',
    migrate: 'src/bin/migrate.ts',
    recheck: 'src/bin/recheck.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  external: Object.keys(pkg.dependencies ?? {}),
  logLevel: 'info',
});
