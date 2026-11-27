// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Modified by leotsaiCode, 2026: settings-based rm allowlist. Tests for this fork.
//
// Run with: claude plugin test <this plugin's folder>
//
// Each test stands in for the engine: HOME and ~/.claude/settings.json come
// from hooks beneath the plugin, and the Bash call "runs" when the plugin calls
// next (the test's own tool.call hook counts it). A held call opens the pane,
// then ends in a deny because nothing beneath answers the hold's clock.

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const HOME = '/Users/tester'
const SETTINGS = `${HOME}/.claude/settings.json`
const SCRATCH = '/private/tmp/claude-502/abc/scratchpad'
const RULES = [
  'Bash(rm -rf /private/tmp/claude-502/*/scratchpad/*)',
  'Bash(rm -f /private/tmp/claude-502/*/scratchpad/*)',
]

type World = { ran: number; held: number }

// settings: a settings.json text, or undefined for a missing file.
function world(on: On, settings: string | undefined): World {
  const w: World = { ran: 0, held: 0 }
  mock.env(on, { HOME })
  if (settings !== undefined) {
    on('fs.read', (_, e) => {
      if (e.path !== SETTINGS) {
        throw new Error(`unexpected read of ${e.path}`)
      }
      return { value: settings }
    })
  }
  on('session.cwd', () => ({ value: '/Users/tester/project' }))
  // Measuring finds nothing (a `cd` folder can't be found); nothing runs.
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.open', () => {
    w.held += 1
    return { value: { isPlaced: false, reason: 'test: no surface' } }
  })
  on('tool.call', () => {
    w.ran += 1
    return { result: {} }
  })
  return w
}

const settingsWith = (allow: unknown[]) => JSON.stringify({ permissions: { allow } })

async function outcome($: any, w: World, command: string): Promise<'ran' | 'held'> {
  const result = await $.tool.call({ tool: 'Bash', command })
  if (w.ran === 1 && w.held === 0 && !('deny' in result)) {
    return 'ran'
  }
  expect(w.ran).toBe(0)
  expect(w.held).toBe(1) // the pane opened: Blast Radius held it
  expect('deny' in result).toBe(true)
  return 'held'
}

const CASES: Array<[string, 'ran' | 'held']> = [
  // allowed
  [`rm -rf ${SCRATCH}/a`, 'ran'],
  [`rm -f ${SCRATCH}/a.txt`, 'ran'],
  [`rm -fr ${SCRATCH}/a`, 'ran'],
  [`rm -r -f ${SCRATCH}/a ${SCRATCH}/b`, 'ran'],
  [`rm -rf /tmp/claude-502/abc/scratchpad/a`, 'ran'],
  [`rm -rf ${SCRATCH}/*`, 'ran'],
  [`rm -rf ${SCRATCH}/./a`, 'ran'],
  [`cd ${SCRATCH} && rm -rf a`, 'ran'],
  [`rm -rf ${SCRATCH}/a && ls`, 'ran'],
  [`ls -la`, 'ran'],
  // escapes and other targets
  [`rm -rf ${SCRATCH}/../../x`, 'held'],
  [`rm -rf ${SCRATCH}/a ~/x`, 'held'],
  [`rm -rf ${SCRATCH}/a && rm -rf build`, 'held'],
  [`rm -rf ${SCRATCH}/a; rm -rf ${HOME}`, 'held'],
  [`rm -rf ${SCRATCH}/a & rm -rf ~`, 'held'],
  [`rm -rf ${SCRATCH}/a/`, 'held'],
  [`rm -rf ${SCRATCH}`, 'held'],
  [`rm -rf /private/tmp/claude-502`, 'held'],
  [`rm -rf ${SCRATCH}/.*`, 'held'],
  [`rm -rf ${SCRATCH}/$(whoami)`, 'held'],
  [`rm -rf ${SCRATCH}/\`whoami\``, 'held'],
  [`rm -rf ${SCRATCH}/$HOME`, 'held'],
  [`rm -rf "${SCRATCH}/a b"`, 'held'],
  [`rm -rf ${SCRATCH}/a 2>/dev/null`, 'held'],
  [`rm -rfv ${SCRATCH}/a`, 'held'],
  [`rm -r ${SCRATCH}/a`, 'held'],
  [`sudo rm -rf ${SCRATCH}/a`, 'held'],
  [`/bin/rm -rf ${SCRATCH}/a`, 'held'],
  [`cd ~ && rm -rf ${SCRATCH.slice(1)}/a`, 'held'],
  [`cd /private/tmp && rm -rf claude-502/abc/scratchpad/../../x`, 'held'],
  [`rm -rf`, 'held'],
  // never allowlisted
  [`rm -rf build`, 'held'],
  [`git reset --hard`, 'held'],
  [`cd ${SCRATCH} && git reset --hard`, 'held'],
  [`rm -rf ${SCRATCH}/a && git clean -fdx`, 'held'],
]

describe('settings rm rules', () => {
  for (const [command, expected] of CASES) {
    test(`${expected}: ${command}`, async ($, on) => {
      const w = world(on, settingsWith(RULES))
      expect(await outcome($, w, command)).toBe(expected)
    })
  }
})

describe('legacy :* rules', () => {
  test('rm -rf <dir>/:* allows a path under it', async ($, on) => {
    const w = world(on, settingsWith(['Bash(rm -rf /private/tmp/claude-502/abc/scratchpad/:*)']))
    expect(await outcome($, w, `rm -rf ${SCRATCH}/a`)).toBe('ran')
  })

  test('rm -rf <dir>/:* never allows the folder itself', async ($, on) => {
    const w = world(on, settingsWith(['Bash(rm -rf /private/tmp/claude-502/abc/scratchpad/:*)']))
    expect(await outcome($, w, `rm -rf ${SCRATCH}`)).toBe('held')
  })
})

describe('rules with no anchored path are ignored', () => {
  const LOOSE = ['Bash(rm *)', 'Bash(rm:*)', 'Bash(rm -rf *)', 'Bash(rm -rf /*)', 'Bash(rm -rf /tm*/x/*)', 'Bash(rm -rf ~/*)', 'Bash(*)']
  for (const command of [`rm -rf ${SCRATCH}/a`, 'rm -rf build', 'rm -rf /etc/x']) {
    test(`held: ${command}`, async ($, on) => {
      const w = world(on, settingsWith(LOOSE))
      expect(await outcome($, w, command)).toBe('held')
    })
  }

  test('a loose rule beside a real one changes nothing', async ($, on) => {
    const w = world(on, settingsWith(['Bash(rm *)', ...RULES]))
    expect(await outcome($, w, 'rm -rf build')).toBe('held')
  })
})

describe('no usable settings', () => {
  test('missing settings file holds', async ($, on) => {
    const w = world(on, undefined)
    expect(await outcome($, w, `rm -rf ${SCRATCH}/a`)).toBe('held')
  })

  test('malformed settings file holds', async ($, on) => {
    const w = world(on, '{ "permissions": { "allow": [ "Bash(rm -rf /private/tmp/claude-502/*/scratchpad/*)" ')
    expect(await outcome($, w, `rm -rf ${SCRATCH}/a`)).toBe('held')
  })

  test('allow that is not a list holds', async ($, on) => {
    const w = world(on, JSON.stringify({ permissions: { allow: 'Bash(rm -rf /private/tmp/claude-502/*/scratchpad/*)' } }))
    expect(await outcome($, w, `rm -rf ${SCRATCH}/a`)).toBe('held')
  })
})

describe('blastRadiusAllow replaces permissions.allow', () => {
  const OTHER = 'Bash(rm -rf /Users/tester/project/build/*)'
  const settings = (blastRadiusAllow: unknown, allow: unknown[]) =>
    JSON.stringify({ blastRadiusAllow, permissions: { allow } })

  test('its rules allow when permissions.allow has none', async ($, on) => {
    const w = world(on, settings(RULES, []))
    expect(await outcome($, w, `rm -rf ${SCRATCH}/a`)).toBe('ran')
  })

  test('permissions.allow rules are ignored once it is set', async ($, on) => {
    const w = world(on, settings(RULES, [OTHER]))
    expect(await outcome($, w, 'rm -rf build/x')).toBe('held')
  })

  test('its own rules still apply beside permissions.allow', async ($, on) => {
    const w = world(on, settings([OTHER], RULES))
    expect(await outcome($, w, 'rm -rf build/x')).toBe('ran')
  })

  test('an empty list turns the allowlist off', async ($, on) => {
    const w = world(on, settings([], RULES))
    expect(await outcome($, w, `rm -rf ${SCRATCH}/a`)).toBe('held')
  })

  test('a value that is not a list falls back to permissions.allow', async ($, on) => {
    const w = world(on, settings('Bash(rm -rf /x/y/*)', RULES))
    expect(await outcome($, w, `rm -rf ${SCRATCH}/a`)).toBe('ran')
  })
})
