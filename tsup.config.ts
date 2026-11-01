import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  splitting: false,
  dts: { entry: ['src/index.ts'] },
  clean: true,
  esbuildPlugins: [
    {
      name: 'inline-worker',
      setup(build) {
        build.onResolve({ filter: /\?worker&inline$/ }, async (args) => {
          const result = await build.resolve(args.path.split('?')[0], {
            kind: args.kind,
            resolveDir: args.resolveDir,
          });
          return {
            path: result.path,
            errors: result.errors,
            namespace: 'inline-worker',
          };
        });
        build.onLoad({ filter: /.*/, namespace: 'inline-worker' }, async (args) => {
          const result = await build.esbuild.build({
            entryPoints: [args.path],
            bundle: true,
            format: 'iife',
            target: 'es2022',
            minify: true,
            write: false,
          });
          // The data: fallback handles synchronous Worker creation errors only.
          return {
            contents: `const jsContent = ${JSON.stringify(result.outputFiles[0].text)};
const blob = typeof self !== 'undefined' && self.Blob &&
  new Blob([jsContent], { type: 'text/javascript;charset=utf-8' });
export default function WorkerWrapper(options) {
  let objURL;
  try {
    objURL = blob && URL.createObjectURL(blob);
    if (!objURL) throw '';
    const worker = new Worker(objURL, { name: options?.name });
    worker.addEventListener('error', () => URL.revokeObjectURL(objURL));
    return worker;
  } catch (e) {
    return new Worker(
      'data:text/javascript;charset=utf-8,' + encodeURIComponent(jsContent),
      { name: options?.name },
    );
  } finally {
    objURL && URL.revokeObjectURL(objURL);
  }
}`,
            loader: 'js',
          };
        });
      },
    },
  ],
});
