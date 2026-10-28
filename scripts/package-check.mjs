#!/usr/bin/env node
/**
 * Publishability check: build the exact tarball `npm publish` would upload,
 * unpack it elsewhere, and prove the plugin still boots from the unpacked copy.
 * This catches "works in the repo, a file is missing from the package" before a
 * user hits it.
 *
 * Run: node scripts/package-check.mjs
 */
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
function check(name, ok, note) {
  if (ok) { pass += 1; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail += 1; console.log('FAIL  ' + name + (note ? '  (' + note + ')' : '')) }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// 1. the manifest itself has to be publishable.
check('name is set', typeof pkg.name === 'string' && pkg.name.length > 0, pkg.name)
check('version parses', /^\d+\.\d+\.\d+/.test(pkg.version), pkg.version)
check('license declared', typeof pkg.license === 'string', pkg.license)
check('engines.node declared', typeof pkg.engines?.node === 'string', pkg.engines?.node)
check('dsh.bundle.patch declared', pkg.dsh?.bundle?.patch === './cordis.patch.yml', JSON.stringify(pkg.dsh))
check('main points at the entry', pkg.main === 'src/index.js', pkg.main)
check('files[] whitelists the runtime',
  Array.isArray(pkg.files) && ['src', 'skills', 'cordis.patch.yml'].every((f) => pkg.files.includes(f)),
  (pkg.files || []).join(','))
check('no private flag (would block publish)', pkg.private !== true)

// 2. the bundle row has to import the same module name the tarball publishes as.
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const rowName = (patch.match(/^\s*name:\s*'([^']+)'/m) || [])[1]
check('cordis.patch.yml imports the package name', rowName === pkg.name, 'row=' + rowName + ' package=' + pkg.name)

// 3. build the tarball exactly as publish would (this also runs prepack).
const out = execSync('npm pack --json --pack-destination "' + root + '"', { cwd: root, encoding: 'utf8' })
const lines = out.split('\n')
const jsonStart = lines.findIndex((line) => line.trim() === '[')
if (jsonStart < 0) throw new Error('npm pack printed no JSON: ' + out.slice(0, 400))
const info = JSON.parse(lines.slice(jsonStart).join('\n'))[0]
const tarball = join(root, info.filename)
check('npm pack produced a tarball', existsSync(tarball), info.filename + ' (' + info.size + ' bytes)')

const packedNames = (info.files || []).map((f) => f.path)
const required = [
  'package.json',
  'cordis.patch.yml',
  'src/index.js',
  'src/runtime.js',
  'src/tools.js',
  'src/skills.js',
  'src/match.js',
  'src/win/backend.mjs',
  'src/win/win-host.ps1',
  'src/win/decorations.ps1',
  'src/win/ocr.mjs',
  'src/win/ocr-host.ps1',
  'src/overlay/guard.mjs',
  'src/overlay/overlay.ps1',
  'skills/excel.md',
  'scripts/install.ps1',
  'scripts/uninstall.ps1',
]
const missing = required.filter((name) => !packedNames.includes(name))
check('every runtime file is inside the tarball', missing.length === 0,
  missing.length ? 'missing: ' + missing.join(', ') : required.length + ' required files present')
check('tests and notes are not shipped',
  !packedNames.some((name) => name.startsWith('test/') || name.startsWith('notes/')),
  packedNames.length + ' files total')
check('both READMEs ship', packedNames.includes('README.md') && packedNames.includes('README.zh.md'))

// 4. unpack somewhere else and import the packed entry.
const work = mkdtempSync(join(tmpdir(), 'dsh-cu-pack-'))
try {
  execSync('tar -xzf "' + tarball + '" -C "' + work + '"', { stdio: 'ignore' })
  const unpacked = join(work, 'package')
  check('tarball extracts to package/', existsSync(join(unpacked, 'package.json')))
  const mod = await import(pathToFileURL(join(unpacked, 'src/index.js')).href)
  check('the packed entry exports the plugin contract',
    typeof mod.apply === 'function' && mod.name === 'computer-use' && Array.isArray(mod.inject),
    'name=' + mod.name + ' inject=' + JSON.stringify(mod.inject))
  const deco = readFileSync(join(unpacked, 'src/win/decorations.ps1'), 'utf8')
  check('decorations shipped with the mask + pins helpers',
    deco.includes('Add-ScreenshotMask') && deco.includes('pins'))
  const skillFiles = readdirSync(join(unpacked, 'skills'))
  check('all eight built-in skills ship', skillFiles.length >= 8, skillFiles.join(','))
} finally {
  rmSync(work, { recursive: true, force: true })
  rmSync(tarball, { force: true })
}

console.log('')
console.log((fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + ' passed, ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
