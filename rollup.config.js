import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import { terser } from 'rollup-plugin-terser';

export default {
  input: 'src/umd-entry.js',
  output: {
    file: 'dist/ar.umd.js',
    format: 'umd',
    name: 'ShoePaoCameraKit',
    sourcemap: false
  },
  plugins: [
    resolve({ browser: true }),
    commonjs(),
    terser()
  ]
};
