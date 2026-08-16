import { spawn } from 'node:child_process';

const separatorIndex = process.argv.indexOf('--');

if (separatorIndex < 0) {
  console.error('Usage: node scripts/without-vcap-services.mjs LABEL [LABEL ...] -- command [args ...]');
  process.exit(1);
}

const labels = process.argv.slice(2, separatorIndex);
const [command, ...args] = process.argv.slice(separatorIndex + 1);

if (!labels.length) {
  console.error('At least one VCAP service label is required.');
  process.exit(1);
}

if (!command) {
  console.error('Missing command to execute.');
  process.exit(1);
}

const env = { ...process.env };

try {
  const services = JSON.parse(env.VCAP_SERVICES || '{}');
  for (const label of labels) delete services[label];
  env.VCAP_SERVICES = JSON.stringify(services);
} catch (error) {
  console.error(`VCAP_SERVICES is not valid JSON: ${error.message}`);
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
