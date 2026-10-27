/**
 * Built-in project templates for `npm init <name>` / `cell new <name>`.
 * Custom templates that are not built in are fetched as `create-<name>`
 * npm packages and executed through the node runtime (non-interactive).
 */

export interface Template {
  description: string
  files: (projectName: string) => Record<string, string>
}

export const TEMPLATES: Record<string, Template> = {
  'node-app': {
    description: 'Plain Node.js app (CommonJS) with a script and a test',
    files: (name) => ({
      '/package.json': `${JSON.stringify(
        {
          name,
          version: '1.0.0',
          main: 'index.js',
          scripts: {
            start: 'node index.js',
            test: 'node test.js',
          },
          license: 'MIT',
        },
        null,
        2,
      )}\n`,
      '/index.js': `const { greet } = require('./lib/greet')\n\nconsole.log(greet('Cell'))\n`,
      '/lib/greet.js': `function greet(name) {\n  return \`Hello, \${name}! Running on the Cell V8 isolate.\`\n}\n\nmodule.exports = { greet }\n`,
      '/test.js': `const { greet } = require('./lib/greet')\n\nif (!greet('x').includes('Hello')) {\n  console.error('greet is broken')\n  process.exit(1)\n}\nconsole.log('all tests passed')\n`,
      '/.gitignore': 'node_modules/\n',
    }),
  },
  'ts-app': {
    description: 'TypeScript app typechecked live by ts-rust in WASM',
    files: (name) => ({
      '/package.json': `${JSON.stringify(
        {
          name,
          version: '1.0.0',
          scripts: {
            start: 'node src/index.ts',
            test: 'echo "no tests yet"',
          },
          devDependencies: {},
          license: 'MIT',
        },
        null,
        2,
      )}\n`,
      '/tsconfig.json': `{
  "compilerOptions": {
    "strict": true,
    "noEmit": false,
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "lib": ["ES2022"]
  },
  "include": ["src"]
}
`,
      '/src/index.ts': `import { sum } from './math'\n\nconst numbers = [1, 2, 3, 4]\n\nconsole.log('sum of', numbers.join(', '), 'is', sum(numbers))\n`,
      '/src/math.ts': `export function sum(values: number[]): number {\n  return values.reduce((a, b) => a + b, 0)\n}\n`,
      '/.gitignore': 'node_modules/\n',
    }),
  },
}

export function templateNames(): string[] {
  return Object.keys(TEMPLATES)
}
