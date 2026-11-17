import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetWslNotInstalledLatchForTests,
  latchWslNotInstalled
} from '@orca/process-host/wsl-not-installed-latch'
import { launchProcessSpecOffMainThreadOnWindows } from './process-spec-worker-launch'

describe('launchProcessSpecOffMainThreadOnWindows', () => {
  afterEach(() => _resetWslNotInstalledLatchForTests())

  it('refuses wsl.exe once WSL is known absent, as the in-thread spawn does', () => {
    latchWslNotInstalled()
    expect(() =>
      launchProcessSpecOffMainThreadOnWindows({ program: 'C:\\Windows\\System32\\wsl.exe' })
    ).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })
})
