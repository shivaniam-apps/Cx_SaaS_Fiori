import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const routerDir = resolve(projectRoot, 'router');
const require = createRequire(import.meta.url);
const approuter = require('@sap/approuter');

function normalizeHtml5RepoRuntimeVcap(vcapText) {
  if (!vcapText) return vcapText;

  const vcap = JSON.parse(vcapText);
  for (const services of Object.values(vcap)) {
    if (!Array.isArray(services)) continue;

    for (const service of services) {
      const name = service.name || '';
      const uri = service.credentials?.uri || '';
      const isHtml5Runtime =
        name.includes('html5-repo-runtime') ||
        service.label === 'html5-apps-repo' ||
        uri.includes('html5-apps-repo');

      if (!isHtml5Runtime) continue;

      service.tags = Array.from(new Set([
        ...(service.tags || []),
        'html5-apps-repo-rt',
        'html5-apps-rt'
      ]));
    }
  }

  return JSON.stringify(vcap);
}

const env = {
  ...process.env,
  VCAP_SERVICES: normalizeHtml5RepoRuntimeVcap(process.env.VCAP_SERVICES),
  UAA_SERVICE_NAME: 'auth',
  TENANT_HOST_PATTERN: '^(.*).localhost',
  EXTERNAL_REVERSE_PROXY: 'true',
  destinations: JSON.stringify([
    {
      name: 'cx-job-srv-api',
      url: 'http://localhost:4004/',
      forwardAuthToken: true,
      strictSSL: false
    }
  ])
};

Object.assign(process.env, env);
process.chdir(routerDir);

approuter().start({
  workingDir: routerDir,
  xsappConfig: {
    welcomeFile: '/index.html',
    authenticationMethod: 'route',
    logout: {
      logoutEndpoint: '/logout'
    },
    routes: [
      {
        source: '^/user-api(.*)',
        target: '$1',
        service: 'sap-approuter-userapi',
        authenticationType: 'xsuaa'
      },
      {
        source: '^/job/(.*)$',
        target: '/job/$1',
        destination: 'cx-job-srv-api',
        preferLocal: true,
        authenticationType: 'xsuaa'
      },
      {
        source: '^/catalog/(.*)$',
        target: '/catalog/$1',
        destination: 'cx-job-srv-api',
        preferLocal: true,
        authenticationType: 'xsuaa'
      },
      {
        source: '^/(.*)$',
        target: '$1',
        localDir: '../app/adops-client/dist',
        authenticationType: 'xsuaa'
      }
    ]
  }
});
