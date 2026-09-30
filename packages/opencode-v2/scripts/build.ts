import { spawnSync } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..')
const SOURCE = join(PACKAGE_ROOT, 'src/tui.tsx')
const DIST = join(PACKAGE_ROOT, 'dist')
const NEXT = join(PACKAGE_ROOT, 'dist.new')
const PREVIOUS = join(PACKAGE_ROOT, 'dist.old')
const TSC = join(REPO_ROOT, 'node_modules/typescript/bin/tsc')
const TRANSFORM = pathToFileURL(
  join(PACKAGE_ROOT, 'node_modules/@opentui/solid/scripts/solid-transform.js'),
).href

interface SolidTransformModule {
  transformSolidSource(
    code: string,
    options: {
      filename: string
      moduleName: string
      resolvePath: (specifier: string) => string
    },
  ): Promise<string>
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: PACKAGE_ROOT,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`)
  }
}

async function build(): Promise<void> {
  rmSync(NEXT, { recursive: true, force: true })
  rmSync(PREVIOUS, { recursive: true, force: true })
  run(process.execPath, [TSC, '-p', 'tsconfig.build.json', '--outDir', NEXT])

  const transform = (await import(TRANSFORM)) as SolidTransformModule
  const transformed = await transform.transformSolidSource(
    readFileSync(SOURCE, 'utf8'),
    {
      filename: SOURCE,
      moduleName: '@opentui/solid',
      resolvePath: (specifier) =>
        specifier.startsWith('.')
          ? specifier.replace(/\.tsx?$/, '.js')
          : specifier,
    },
  )
  writeFileSync(join(NEXT, 'tui.js'), `${transformed}\n`)

  let movedCurrent = false
  try {
    if (existsSync(DIST)) {
      renameSync(DIST, PREVIOUS)
      movedCurrent = true
    }
    renameSync(NEXT, DIST)
    rmSync(PREVIOUS, { recursive: true, force: true })
  } catch (error) {
    if (!existsSync(DIST) && movedCurrent && existsSync(PREVIOUS)) {
      renameSync(PREVIOUS, DIST)
    }
    throw error
  }
}

build().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.stderr.write(`[opencode-v2 build] ${message}\n`)
  process.exitCode = 1
})
