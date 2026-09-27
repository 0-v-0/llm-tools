import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import UnoCSS from 'unocss/vite'

export default defineConfig({
	build: {
		target: 'es2023',
		rolldownOptions: {
			input: { index: fileURLToPath(new URL('./index.html', import.meta.url)) },
			output: {
				format: 'es',
				assetFileNames: '[name][extname]',
				entryFileNames: '[name].js',
			},
		},
		outDir: 'dist/client',
	},
	resolve: {
		alias: {
			// cydon 的 browser 字段指向 IIFE 构建（无命名导出），强制用 ESM 构建
			cydon: 'cydon/dist/cydon.js',
		},
	},
	server: {
		proxy: {
			'/api': {
				target: 'http://127.0.0.1:5176',
				changeOrigin: false,
			},
		},
	},
	plugins: [UnoCSS()],
})
