const { build } = require('esbuild');
Promise.all([
  build({ entryPoints: ['src/extension.js'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: 'dist/extension.cjs' }),
  build({ entryPoints: ['src/board.js', 'src/sidebar.js'], bundle: true, platform: 'browser', outdir: 'dist', minify: true })
]).catch(error => { console.error(error); process.exitCode = 1; });
