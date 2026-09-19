import { spawnSync } from 'node:child_process';

function cleanEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (key.startsWith('ZYLOS_GUARDIAN_TEST_')) delete result[key];
  }
  return result;
}

export function processIdentity(helper, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { result: 'inconclusive', pid, reason: 'invalid_pid' };
  }
  const command = spawnSync(helper, ['identity', String(pid)], {
    encoding: 'utf8',
    timeout: 2_000,
    env: cleanEnvironment(),
  });
  if (command.status === 2) {
    return { result: 'gone', pid, command: { status: command.status, signal: command.signal } };
  }
  if (command.status !== 0) {
    return {
      result: 'inconclusive', pid,
      command: {
        status: command.status, signal: command.signal,
        stdout: command.stdout || '', stderr: command.stderr || '', error: command.error?.message || null,
      },
    };
  }
  try {
    return { result: 'present', pid, identity: JSON.parse(command.stdout.trim()) };
  } catch (error) {
    return { result: 'inconclusive', pid, reason: `invalid_identity_json: ${error.message}` };
  }
}

export function captureOriginalIdentities(helper, roles) {
  const result = {};
  for (const [role, pid] of Object.entries(roles)) {
    const observation = processIdentity(helper, pid);
    if (observation.result !== 'present') {
      throw new Error(`Unable to capture ${role} process identity: ${JSON.stringify(observation)}`);
    }
    result[role] = observation.identity;
  }
  return result;
}

export function classifyOriginalIdentities(helper, originals) {
  const result = {};
  for (const [role, original] of Object.entries(originals)) {
    const current = processIdentity(helper, original.pid);
    if (current.result === 'gone') {
      result[role] = current;
    } else if (current.result === 'present') {
      const same = current.identity.startSec === original.startSec &&
        current.identity.startUsec === original.startUsec;
      result[role] = {
        result: same ? 'survivor' : 'pid-reused',
        pid: original.pid,
        original,
        current: current.identity,
      };
    } else {
      result[role] = current;
    }
  }
  return result;
}

export function originalIdentitiesGone(classifications) {
  return Object.values(classifications).every(({ result }) => result === 'gone' || result === 'pid-reused');
}
