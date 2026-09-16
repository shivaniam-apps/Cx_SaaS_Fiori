import { spawn } from 'node:child_process';

// Usage: node scripts/with-env.mjs KEY=value [KEY?=default ...] -- command [args ...]
//
//   KEY=value   always sets KEY (overrides whatever the caller exported)
//   KEY?=value  sets KEY only when it is unset or empty in the caller's
//               environment - the npm scripts use this for PORT so a parallel
//               worktree can run `PORT=4114 npm run srv:sqlite` (or wrap the
//               script in another with-env call, see .claude/launch.json)
//               while a plain `npm run srv:sqlite` still lands on 4104.

const separatorIndex = process.argv.indexOf('--');

if (separatorIndex < 0) {
  console.error('Usage: node scripts/with-env.mjs KEY=value [KEY?=default ...] -- command [args ...]');
  process.exit(1);
}

const env = { ...process.env };

for (const assignment of process.argv.slice(2, separatorIndex)) {
  const defaultOnly = assignment.includes('?=');
  const equalsIndex = assignment.indexOf(defaultOnly ? '?=' : '=');
  if (equalsIndex <= 0) {
    console.error(`Invalid environment assignment: ${assignment}`);
    process.exit(1);
  }
  const key = assignment.slice(0, equalsIndex);
  const value = assignment.slice(equalsIndex + (defaultOnly ? 2 : 1));
  if (defaultOnly && env[key]) continue;
  env[key] = value;
}

const [command, ...args] = process.argv.slice(separatorIndex + 1);

if (!command) {
  console.error('Missing command to execute.');
  process.exit(1);
}

const child = spawn(command, args, {
  env,
  shell: true,
  stdio: 'inherit'
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  }
  process.exit(code ?? 1);
});
