import { spawn } from 'node:child_process';

const separatorIndex = process.argv.indexOf('--');

if (separatorIndex < 0) {
  console.error('Usage: node scripts/with-env.mjs KEY=value [KEY=value ...] -- command [args ...]');
  process.exit(1);
}

const env = { ...process.env };

for (const assignment of process.argv.slice(2, separatorIndex)) {
  const equalsIndex = assignment.indexOf('=');
  if (equalsIndex <= 0) {
    console.error(`Invalid environment assignment: ${assignment}`);
    process.exit(1);
  }
  env[assignment.slice(0, equalsIndex)] = assignment.slice(equalsIndex + 1);
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
