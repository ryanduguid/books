import { child, forceStop } from './mock-electron.mjs';

export function execFile(command, args, options, callback) {
  try {
    if (
      command !== 'taskkill' ||
      JSON.stringify(args) !==
        JSON.stringify(['/PID', String(child.pid), '/T', '/F']) ||
      options.timeout !== 5_000
    ) {
      throw new Error('Unexpected termination command');
    }
    forceStop(-child.pid, 'SIGKILL');
    callback(null, '', '');
  } catch (error) {
    callback(error);
  }
}
