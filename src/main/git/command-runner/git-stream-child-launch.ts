import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { spawnNativeProcess } from '@orca/process-host/native-process-spawn'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import type { ResolvedCommand } from './host-routing/wsl-command-resolution'
import { untranslatedGitOutputEnv } from './git-environment/git-process-env'
import { gitSpawnLaunch, type GitSpawnOptions } from './git-spawn'
import {
  spawnOffMainThreadOnWindows,
  type WorkerThreadChildProcess
} from '../../worker-thread-child-process/worker-thread-child-process'

/** Starts a streamed Git child that Orca doesn't own as a POSIX group, off main on Windows. */
export function launchStreamingGitChild(
  command: ResolvedCommand,
  args: string[],
  spawnOptions: GitSpawnOptions & { stdio: SpawnOptions['stdio'] }
): ChildProcess | WorkerThreadChildProcess {
  const directGit = command.wslMode === 'direct-git'
  const launch = directGit
    ? {
        binary: command.binary,
        args: command.args,
        options: { cwd: command.cwd, env: untranslatedGitOutputEnv(spawnOptions.env) }
      }
    : gitSpawnLaunch(args, spawnOptions)
  const offMainChild = spawnOffMainThreadOnWindows({
    program: launch.binary,
    args: launch.args,
    cwd: typeof launch.options.cwd === 'string' ? launch.options.cwd : undefined,
    env: launch.options.env
  })
  if (offMainChild) {
    // The worker always pipes stdin; close it as the ignored stdin was.
    offMainChild.stdin.end()
    return offMainChild
  }
  if (directGit) {
    const spawnStartedAt = performance.now()
    const child = spawn(command.binary, command.args, {
      cwd: command.cwd,
      env: launch.options.env,
      stdio: spawnOptions.stdio,
      windowsHide: true
    })
    recordSubprocessSpawn(command.binary, command.args, performance.now() - spawnStartedAt)
    return child
  }
  return spawnNativeProcess(
    launch.binary,
    launch.args,
    launch.options,
    undefined,
    recordSubprocessSpawn
  )
}
